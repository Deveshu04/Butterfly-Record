//! End-to-end batch transcription against a local stand-in for Sarvam and its blob storage.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};

use super::client::{http_client, Api, Timing};
use super::jobs::{Ctx, JobSlot, JobStore};
use super::stt::{transcribe, SttRequest};
use crate::error::Code;
use crate::library::paths::JOBS;

#[derive(Debug, Clone)]
struct Seen {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Seen {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

struct Server {
    base: String,
    seen: Arc<Mutex<Vec<Seen>>>,
}

fn read_request(stream: &TcpStream) -> Option<Seen> {
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_owned();
    let path = parts.next()?.to_owned();
    let mut headers = Vec::new();
    loop {
        let mut header = String::new();
        reader.read_line(&mut header).ok()?;
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        let (key, value) = header.split_once(':')?;
        headers.push((key.trim().to_owned(), value.trim().to_owned()));
    }
    let length = headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.parse::<usize>().ok())
        .unwrap_or(0);
    let mut body = vec![0; length];
    reader.read_exact(&mut body).ok()?;
    Some(Seen {
        method,
        path,
        headers,
        body,
    })
}

fn respond(mut stream: TcpStream, status: u16, body: &Value) {
    let body = if body.is_null() {
        String::new()
    } else {
        body.to_string()
    };
    let reply = format!(
    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
    body.len()
  );
    let _ = stream.write_all(reply.as_bytes());
}

fn part_output(index: usize) -> Value {
    match index {
        0 => json!({
          "request_id": "req-0",
          "transcript": "Hello, how can I help you today? I have a question.",
          "language_code": "en-IN",
          "timestamps": {
            "words": ["Hello, how can I help you today?", "I have a question."],
            "start_time_seconds": [0.01, 2.8],
            "end_time_seconds": [2.5, 4.2]
          },
          "diarized_transcript": {
            "entries": [
              { "transcript": "Hello, how can I help you today?", "start_time_seconds": 0.01, "end_time_seconds": 2.5, "speaker_id": "0" },
              { "transcript": "I have a question.", "start_time_seconds": 2.8, "end_time_seconds": 4.2, "speaker_id": "1" }
            ]
          }
        }),
        _ => json!({
          "request_id": "req-1",
          "transcript": "Sure.",
          "language_code": "en-IN",
          "diarized_transcript": {
            "entries": [
              { "transcript": "Sure.", "start_time_seconds": 1.5, "end_time_seconds": 2.0, "speaker_id": "0" }
            ]
          }
        }),
    }
}

fn start_server(files: Vec<String>) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let polls = Arc::new(AtomicUsize::new(0));
    let starts = Arc::new(AtomicUsize::new(0));
    let server_base = base.clone();
    let server_seen = Arc::clone(&seen);
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { break };
            let Some(request) = read_request(&stream) else {
                continue;
            };
            server_seen.lock().unwrap().push(request.clone());
            let job = "/speech-to-text/job/v1";
            let (status, body) = match (request.method.as_str(), request.path.as_str()) {
                ("POST", path) if path == job => (
                    202,
                    json!({ "job_id": "job-1", "job_state": "Accepted", "storage_container_type": "Azure_V1", "job_parameters": {} }),
                ),
                ("POST", path) if path == format!("{job}/upload-files") => {
                    let urls: serde_json::Map<String, Value> = files
                        .iter()
                        .map(|name| {
                            let url = format!("{server_base}/blob/{name}?sig=secret");
                            (
                                name.clone(),
                                json!({ "file_url": url, "file_metadata": null }),
                            )
                        })
                        .collect();
                    (
                        200,
                        json!({ "job_id": "job-1", "job_state": "Accepted", "upload_urls": urls }),
                    )
                }
                ("PUT", path) if path.starts_with("/blob/") => (201, Value::Null),
                ("POST", path) if path == format!("{job}/job-1/start") => {
                    // The first start hits a transient 503 to exercise the retry.
                    if starts.fetch_add(1, Ordering::SeqCst) == 0 {
                        (
                            503,
                            json!({ "error": { "message": "Overloaded", "code": "internal_server_error" } }),
                        )
                    } else {
                        (200, json!({ "job_id": "job-1", "job_state": "Running" }))
                    }
                }
                ("GET", path) if path == format!("{job}/job-1/status") => {
                    if polls.fetch_add(1, Ordering::SeqCst) == 0 {
                        (
                            200,
                            json!({ "job_id": "job-1", "job_state": "Running", "job_details": [] }),
                        )
                    } else {
                        let details: Vec<Value> = files
              .iter()
              .enumerate()
              .map(|(i, name)| {
                json!({
                  "inputs": [{ "file_name": name, "file_id": format!("in-{i}") }],
                  "outputs": [{ "file_name": format!("{i}.json"), "file_id": format!("out-{i}") }],
                  "state": "Success",
                  "error_message": null
                })
              })
              .collect();
                        (
                            200,
                            json!({ "job_id": "job-1", "job_state": "Completed", "error_message": "", "job_details": details, "new_field": true }),
                        )
                    }
                }
                ("POST", path) if path == format!("{job}/download-files") => {
                    let urls: serde_json::Map<String, Value> = (0..files.len())
                        .map(|i| {
                            let url = format!("{server_base}/out/{i}.json?sig=secret");
                            (format!("{i}.json"), json!({ "file_url": url }))
                        })
                        .collect();
                    (200, json!({ "job_id": "job-1", "download_urls": urls }))
                }
                ("GET", path) if path.starts_with("/out/") => {
                    let index = path
                        .trim_start_matches("/out/")
                        .split('.')
                        .next()
                        .and_then(|i| i.parse().ok())
                        .unwrap_or(0);
                    (200, part_output(index))
                }
                _ => (
                    404,
                    json!({ "error": { "message": "nope", "code": "not_found_error" } }),
                ),
            };
            respond(stream, status, &body);
        }
    });
    Server { base, seen }
}

fn session_dir() -> PathBuf {
    let dir = std::env::temp_dir()
        .join(format!("br-stt-e2e-{}", std::process::id()))
        .join("01J9Z8Q4X5M2N3P4R5S6T7V8W9");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn fast_timing() -> Timing {
    Timing {
        stt_poll: Duration::from_millis(1),
        dub_poll: Duration::from_millis(1),
        backoff: Duration::from_millis(1),
        job_wait: Duration::from_secs(30),
        export_wait: Duration::from_secs(30),
    }
}

#[test]
fn batch_transcription_end_to_end() {
    let files = vec!["part-0.wav".to_string(), "part-1.wav".to_string()];
    let dir = session_dir();
    std::fs::write(dir.join(&files[0]), vec![7u8; 100_000]).unwrap();
    std::fs::write(dir.join(&files[1]), vec![9u8; 5_000]).unwrap();
    let server = start_server(files.clone());

    let api = Api::new(
        http_client().unwrap(),
        server.base.clone(),
        "sk_test_key".into(),
        fast_timing(),
    );
    let stages = Mutex::new(Vec::<String>::new());
    let progress = |stage: &str, _: Option<f64>, _: &str| stages.lock().unwrap().push(stage.into());
    let store = JobStore::default();
    let slot = JobSlot::default();
    let ctx = Ctx {
        api: &api,
        progress: &progress,
        jobs: &store,
        slot: &slot,
    };
    let request = SttRequest {
        task: "task-1".into(),
        id: "01J9Z8Q4X5M2N3P4R5S6T7V8W9".into(),
        files: files.clone(),
        offsets: vec![0.0, 7200.0],
        duration: 7300.0,
        language: "unknown".into(),
        model: "saaras:v4".into(),
        mode: "transcribe".into(),
        diarize: true,
        num_speakers: Some(2),
        resume_job_id: None,
    };

    let result = tauri::async_runtime::block_on(transcribe(&ctx, &dir, &request)).unwrap();

    assert_eq!(result.language.as_deref(), Some("en-IN"));
    assert_eq!(result.request_ids, ["req-0", "req-1"]);
    let texts: Vec<(&str, f64, Option<&str>)> = result
        .segments
        .iter()
        .map(|s| (s.text.as_str(), s.start, s.speaker.as_deref()))
        .collect();
    assert_eq!(
        texts,
        vec![
            ("Hello, how can I help you today?", 0.01, Some("0")),
            ("I have a question.", 2.8, Some("1")),
            ("Sure.", 7201.5, Some("0")),
        ]
    );
    assert!(!dir.join(JOBS).exists(), "finished jobs are forgotten");

    let seen = server.seen.lock().unwrap().clone();
    let create = seen
        .iter()
        .find(|r| r.path == "/speech-to-text/job/v1")
        .unwrap();
    let params: Value = serde_json::from_slice(&create.body).unwrap();
    assert_eq!(params["job_parameters"]["with_diarization"], true);
    assert_eq!(params["job_parameters"]["with_timestamps"], true);
    assert_eq!(params["job_parameters"]["num_speakers"], 2);
    assert_eq!(create.header("api-subscription-key"), Some("sk_test_key"));

    let puts: Vec<&Seen> = seen.iter().filter(|r| r.method == "PUT").collect();
    assert_eq!(puts.len(), 2);
    for put in &puts {
        assert_eq!(put.header("x-ms-blob-type"), Some("BlockBlob"));
        assert_eq!(put.header("content-type"), Some("audio/wav"));
        assert_eq!(
            put.header("transfer-encoding"),
            None,
            "uploads are not chunked"
        );
        assert_eq!(
            put.header("api-subscription-key"),
            None,
            "no key on storage"
        );
        let expected = if put.path.contains("part-0") {
            100_000
        } else {
            5_000
        };
        assert_eq!(
            put.header("content-length"),
            Some(expected.to_string().as_str())
        );
        assert_eq!(put.body.len(), expected);
    }
    let starts = seen.iter().filter(|r| r.path.ends_with("/start")).count();
    assert_eq!(starts, 2, "a 503 is retried");
    assert!(seen
        .iter()
        .filter(|r| r.path.starts_with("/out/"))
        .all(|r| r.header("api-subscription-key").is_none()));

    let stages = stages.lock().unwrap();
    for stage in ["prepare", "upload", "process", "download"] {
        assert!(stages.iter().any(|s| s == stage), "missing stage {stage}");
    }
    let _ = std::fs::remove_dir_all(dir.parent().unwrap());
}

#[test]
fn quota_errors_are_not_retried() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&hits);
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { break };
            if read_request(&stream).is_some() {
                counter.fetch_add(1, Ordering::SeqCst);
                respond(
                    stream,
                    429,
                    &json!({ "error": { "message": "Out of credits", "code": "insufficient_quota_error", "request_id": "r-9" } }),
                );
            }
        }
    });
    let api = Api::new(http_client().unwrap(), base, "k".into(), fast_timing());
    let error = tauri::async_runtime::block_on(
        api.post_json::<Value, _>("/text-lid", &json!({ "input": "Hello" })),
    )
    .unwrap_err();
    assert_eq!(error.code, Code::Quota);
    assert_eq!(error.status, Some(429));
    assert_eq!(error.request_id.as_deref(), Some("r-9"));
    assert_eq!(hits.load(Ordering::SeqCst), 1);
}
