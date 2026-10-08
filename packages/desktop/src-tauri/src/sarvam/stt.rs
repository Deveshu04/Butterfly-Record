//! Saaras speech-to-text: REST for one short file, the batch job API otherwise.

use std::collections::HashMap;
use std::path::Path;
use std::time::Instant;

use reqwest::multipart::{Form, Part};
use reqwest::Body;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio_util::io::ReaderStream;

use super::client::{mime_for, read_json, unexpected, API_TIMEOUT};
use super::jobs::Ctx;
use super::lang;
use crate::error::{Code, IpcError, IpcResult};
use crate::library::paths::check_name;

const MODELS: &[&str] = &["saaras:v4", "saaras:v3"];
const MODES: &[&str] = &["transcribe", "translate", "verbatim", "translit", "codemix"];
const REST_MAX_SECONDS: f64 = 29.0;
const MAX_FILES: usize = 20;
const JOB_PATH: &str = "/speech-to-text/job/v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SttRequest {
    pub task: String,
    pub id: String,
    pub files: Vec<String>,
    pub offsets: Vec<f64>,
    pub duration: f64,
    pub language: String,
    pub model: String,
    pub mode: String,
    pub diarize: bool,
    #[serde(default)]
    pub num_speakers: Option<u32>,
    #[serde(default, skip_serializing)]
    pub resume_job_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Segment {
    pub start: f64,
    pub end: f64,
    pub text: String,
    pub speaker: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SttResult {
    pub language: Option<String>,
    pub segments: Vec<Segment>,
    pub request_ids: Vec<String>,
}

impl SttRequest {
    pub fn validate(&self) -> IpcResult<()> {
        if self.files.is_empty() || self.files.len() > MAX_FILES {
            return Err(IpcError::invalid(
                "Between 1 and 20 audio parts are needed.",
            ));
        }
        if self.offsets.len() != self.files.len() {
            return Err(IpcError::invalid("Each audio part needs an offset."));
        }
        for (i, name) in self.files.iter().enumerate() {
            check_name(name)?;
            if self.files[..i].contains(name) {
                return Err(IpcError::invalid("Audio part names must be unique."));
            }
        }
        let finite = |n: f64| n.is_finite() && n >= 0.0;
        if !finite(self.duration) || !self.offsets.iter().all(|&o| finite(o)) {
            return Err(IpcError::invalid("Invalid duration or offsets."));
        }
        if !MODELS.contains(&self.model.as_str()) {
            return Err(IpcError::invalid("Unknown transcription model."));
        }
        if !MODES.contains(&self.mode.as_str()) {
            return Err(IpcError::invalid("Unknown transcription mode."));
        }
        if self.language != "unknown" && !lang::is_known(&self.language) {
            return Err(IpcError::new(
                Code::Unsupported,
                "Sarvam cannot transcribe this language.",
            ));
        }
        if self.num_speakers.is_some_and(|n| !(1..=20).contains(&n)) {
            return Err(IpcError::invalid("Speakers must be between 1 and 20."));
        }
        Ok(())
    }

    fn uses_rest(&self) -> bool {
        self.files.len() == 1 && self.duration <= REST_MAX_SECONDS && !self.diarize
    }

    /// Length of part `i` on the source timeline, when known.
    fn span(&self, i: usize) -> Option<f64> {
        let end = self.offsets.get(i + 1).copied().unwrap_or(self.duration);
        let span = end - self.offsets[i];
        (span > 0.0).then_some(span)
    }
}

/// One output file (REST response or batch result JSON), parsed defensively.
#[derive(Debug, Default, PartialEq)]
pub struct SttOutput {
    pub request_id: Option<String>,
    pub transcript: String,
    pub language: Option<String>,
    pub chunks: Vec<Segment>,
    pub diarized: Vec<Segment>,
}

fn text(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_owned)
}

fn speaker_id(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(id) => Some(id.clone()),
        Value::Number(id) => Some(id.to_string()),
        _ => None,
    }
}

fn numbers(value: Option<&Value>) -> Vec<f64> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|n| n.as_f64().unwrap_or(f64::NAN))
                .collect()
        })
        .unwrap_or_default()
}

pub fn parse_output(value: &Value) -> SttOutput {
    let timestamps = value.get("timestamps");
    // The batch guide calls the text array `chunks`; the reference and SDK call it `words`.
    let texts = timestamps
        .and_then(|t| {
            t.get("words")
                .filter(|w| w.is_array())
                .or_else(|| t.get("chunks"))
        })
        .and_then(Value::as_array);
    let starts = numbers(timestamps.and_then(|t| t.get("start_time_seconds")));
    let ends = numbers(timestamps.and_then(|t| t.get("end_time_seconds")));
    let chunks = texts
        .map(|texts| {
            texts
                .iter()
                .zip(starts.iter().zip(ends.iter()))
                .map(|(text, (&start, &end))| Segment {
                    start,
                    end,
                    text: text.as_str().unwrap_or_default().to_owned(),
                    speaker: None,
                })
                .collect()
        })
        .unwrap_or_default();
    let diarized = value
        .get("diarized_transcript")
        .and_then(|d| d.get("entries"))
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .map(|entry| Segment {
                    start: entry
                        .get("start_time_seconds")
                        .and_then(Value::as_f64)
                        .unwrap_or(f64::NAN),
                    end: entry
                        .get("end_time_seconds")
                        .and_then(Value::as_f64)
                        .unwrap_or(f64::NAN),
                    text: text(entry.get("transcript")).unwrap_or_default(),
                    speaker: speaker_id(entry.get("speaker_id")),
                })
                .collect()
        })
        .unwrap_or_default();
    SttOutput {
        request_id: text(value.get("request_id")),
        transcript: text(value.get("transcript")).unwrap_or_default(),
        language: text(value.get("language_code")).filter(|code| !code.is_empty()),
        chunks,
        diarized,
    }
}

/// Segments of one part shifted onto the source timeline.
pub fn segments(output: &SttOutput, offset: f64, span: Option<f64>) -> Vec<Segment> {
    let source = if output.diarized.is_empty() {
        &output.chunks
    } else {
        &output.diarized
    };
    if source.is_empty() {
        let text = output.transcript.trim();
        if text.is_empty() {
            return Vec::new();
        }
        return vec![Segment {
            start: offset,
            end: offset + span.unwrap_or(0.0),
            text: text.to_owned(),
            speaker: None,
        }];
    }
    source
        .iter()
        .filter(|s| s.start.is_finite() && s.end.is_finite() && !s.text.trim().is_empty())
        .map(|s| {
            let start = offset + s.start.max(0.0);
            Segment {
                start,
                end: (offset + s.end).max(start),
                text: s.text.trim().to_owned(),
                speaker: s.speaker.clone(),
            }
        })
        .collect()
}

pub struct PartOutput {
    pub offset: f64,
    pub span: Option<f64>,
    pub output: SttOutput,
}

pub fn assemble(parts: &[PartOutput], mode: &str, requested_language: &str) -> SttResult {
    let mut all: Vec<Segment> = parts
        .iter()
        .flat_map(|part| segments(&part.output, part.offset, part.span))
        .collect();
    all.sort_by(|a, b| a.start.total_cmp(&b.start).then(a.end.total_cmp(&b.end)));
    let language = if mode == "translate" {
        Some("en-IN".to_string())
    } else {
        parts
            .iter()
            .find_map(|part| part.output.language.clone())
            .or_else(|| (requested_language != "unknown").then(|| requested_language.to_owned()))
    };
    SttResult {
        language,
        segments: all,
        request_ids: parts
            .iter()
            .filter_map(|part| part.output.request_id.clone())
            .collect(),
    }
}

/// Batch job status, parsed defensively. `state` is lowercased.
#[derive(Debug, Default, PartialEq)]
pub struct JobStatus {
    pub state: String,
    pub error: Option<String>,
    pub files: Vec<FileResult>,
}

#[derive(Debug, PartialEq)]
pub struct FileResult {
    pub input: Option<String>,
    pub output: Option<String>,
    pub ok: bool,
    pub error: Option<String>,
}

fn first_name(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(|item| text(item.get("file_name")))
}

pub fn parse_status(value: &Value) -> JobStatus {
    let files = value
        .get("job_details")
        .and_then(Value::as_array)
        .map(|details| {
            details
                .iter()
                .map(|detail| FileResult {
                    input: first_name(detail.get("inputs")),
                    output: first_name(detail.get("outputs")),
                    ok: detail
                        .get("state")
                        .and_then(Value::as_str)
                        .is_some_and(|state| state.eq_ignore_ascii_case("success")),
                    error: text(detail.get("error_message")).filter(|m| !m.is_empty()),
                })
                .collect()
        })
        .unwrap_or_default();
    JobStatus {
        state: text(value.get("job_state"))
            .unwrap_or_default()
            .to_ascii_lowercase(),
        error: text(value.get("error_message")).filter(|m| !m.is_empty()),
        files,
    }
}

/// `{ name: { file_url } }` (or `{ name: url }`) into a plain map.
pub fn url_map(value: &Value, key: &str) -> HashMap<String, String> {
    value
        .get(key)
        .and_then(Value::as_object)
        .map(|urls| {
            urls.iter()
                .filter_map(|(name, entry)| {
                    let url = match entry {
                        Value::String(url) => Some(url.clone()),
                        other => text(other.get("file_url")),
                    }?;
                    Some((name.clone(), url))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn file_part(path: &Path, name: &str) -> IpcResult<Part> {
    let file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();
    let body = Body::wrap_stream(ReaderStream::new(tokio::fs::File::from_std(file)));
    Part::stream_with_length(body, len)
        .file_name(name.to_owned())
        .mime_str(mime_for(path))
        .map_err(|_| IpcError::invalid("Unsupported audio type."))
}

pub async fn transcribe(
    ctx: &Ctx<'_>,
    session: &Path,
    request: &SttRequest,
) -> IpcResult<SttResult> {
    if request.resume_job_id.is_none() && request.uses_rest() {
        rest(ctx, session, request).await
    } else {
        batch(ctx, session, request).await
    }
}

async fn rest(ctx: &Ctx<'_>, session: &Path, request: &SttRequest) -> IpcResult<SttResult> {
    let name = &request.files[0];
    let path = session.join(name);
    ctx.report("upload", None, "Sending audio to Sarvam");
    let url = ctx.api.url("/speech-to-text");
    let response = ctx
        .api
        .send(false, |http| {
            let form = Form::new()
                .part("file", file_part(&path, name)?)
                .text("model", request.model.clone())
                .text("mode", request.mode.clone())
                .text("language_code", request.language.clone())
                .text("with_timestamps", "true");
            Ok(http.post(&url).multipart(form).timeout(API_TIMEOUT))
        })
        .await?;
    ctx.report("process", None, "Reading the transcript");
    let value: Value = read_json(response).await?;
    let part = PartOutput {
        offset: request.offsets[0],
        span: request.span(0),
        output: parse_output(&value),
    };
    Ok(assemble(&[part], &request.mode, &request.language))
}

async fn start_job(ctx: &Ctx<'_>, session: &Path, request: &SttRequest) -> IpcResult<String> {
    ctx.report("prepare", None, "Creating the transcription job");
    let mut params = json!({
      "model": request.model,
      "mode": request.mode,
      "language_code": request.language,
      "with_timestamps": true,
      "with_diarization": request.diarize,
    });
    if let (true, Some(speakers)) = (request.diarize, request.num_speakers) {
        params["num_speakers"] = json!(speakers);
    }
    let created: Value = ctx
        .api
        .post_json(JOB_PATH, &json!({ "job_parameters": params }))
        .await?;
    let job_id = text(created.get("job_id")).ok_or_else(unexpected)?;

    let uploads: Value = ctx
        .api
        .post_json(
            &format!("{JOB_PATH}/upload-files"),
            &json!({ "job_id": job_id, "files": request.files }),
        )
        .await?;
    let urls = url_map(&uploads, "upload_urls");
    let sizes: Vec<u64> = request
        .files
        .iter()
        .map(|name| std::fs::metadata(session.join(name)).map(|m| m.len()))
        .collect::<Result<_, _>>()?;
    let total: u64 = sizes.iter().sum::<u64>().max(1);
    let mut done = 0u64;
    for (name, size) in request.files.iter().zip(&sizes) {
        let url = urls.get(name).ok_or_else(unexpected)?;
        let path = session.join(name);
        ctx.api
            .upload(url, &path, mime_for(&path), &|sent, _| {
                ctx.report(
                    "upload",
                    Some((done + sent) as f64 / total as f64),
                    "Uploading audio",
                );
            })
            .await?;
        done += size;
    }

    let _: Value = ctx
        .api
        .post_empty(&format!("{JOB_PATH}/{job_id}/start"))
        .await?;
    ctx.persist(session, "stt", &job_id, request)?;
    Ok(job_id)
}

async fn wait_for_job(ctx: &Ctx<'_>, session: &Path, job_id: &str) -> IpcResult<JobStatus> {
    let started = Instant::now();
    loop {
        let value: Value = match ctx
            .api
            .get_json(&format!("{JOB_PATH}/{job_id}/status"))
            .await
        {
            Ok(value) => value,
            Err(error) if error.code == Code::NotFound => {
                ctx.finish(session, job_id);
                return Err(error);
            }
            Err(error) => return Err(error),
        };
        let status = parse_status(&value);
        match status.state.as_str() {
            "completed" | "partiallycompleted" => return Ok(status),
            "failed" => {
                ctx.finish(session, job_id);
                let message = status
                    .error
                    .or_else(|| status.files.iter().find_map(|f| f.error.clone()))
                    .unwrap_or_else(|| "Sarvam could not transcribe this audio.".into());
                return Err(IpcError::new(Code::Api, message));
            }
            "accepted" | "pending" => ctx.report("queued", None, "Waiting for Sarvam"),
            _ => ctx.report("process", None, "Transcribing"),
        }
        if started.elapsed() > ctx.api.timing.job_wait {
            return Err(IpcError::new(
                Code::Network,
                "Sarvam is taking too long. The job will resume next time the app starts.",
            ));
        }
        tokio::time::sleep(ctx.api.timing.stt_poll).await;
    }
}

async fn batch(ctx: &Ctx<'_>, session: &Path, request: &SttRequest) -> IpcResult<SttResult> {
    let job_id = match &request.resume_job_id {
        Some(job_id) => {
            ctx.slot.set(session, job_id);
            job_id.clone()
        }
        None => start_job(ctx, session, request).await?,
    };
    let status = wait_for_job(ctx, session, &job_id).await?;

    let failed: Vec<&FileResult> = status.files.iter().filter(|f| !f.ok).collect();
    if let Some(file) = failed.first() {
        ctx.finish(session, &job_id);
        let part = file.input.as_deref().unwrap_or("audio");
        let reason = file
            .error
            .as_deref()
            .unwrap_or("Sarvam could not transcribe it.");
        return Err(IpcError::new(Code::Api, format!("{part}: {reason}")));
    }
    let pairs: Vec<(String, String)> = status
        .files
        .iter()
        .filter_map(|f| Some((f.input.clone()?, f.output.clone()?)))
        .collect();
    if pairs.len() != request.files.len() {
        ctx.finish(session, &job_id);
        return Err(IpcError::new(
            Code::Api,
            "Sarvam finished the job without a transcript for every part.",
        ));
    }

    ctx.report("download", None, "Downloading the transcript");
    let outputs: Vec<&str> = pairs.iter().map(|(_, out)| out.as_str()).collect();
    let links: Value = ctx
        .api
        .post_json(
            &format!("{JOB_PATH}/download-files"),
            &json!({ "job_id": job_id, "files": outputs }),
        )
        .await?;
    let urls = url_map(&links, "download_urls");
    let mut parts = Vec::with_capacity(pairs.len());
    for (input, output) in &pairs {
        let index = request
            .files
            .iter()
            .position(|name| name == input)
            .ok_or_else(unexpected)?;
        let url = urls.get(output).ok_or_else(unexpected)?;
        let value: Value = ctx.api.fetch_json(url).await?;
        parts.push(PartOutput {
            offset: request.offsets[index],
            span: request.span(index),
            output: parse_output(&value),
        });
    }
    ctx.finish(session, &job_id);
    Ok(assemble(&parts, &request.mode, &request.language))
}

#[cfg(test)]
mod tests {
    use super::*;

    // From the REST reference response example.
    const REST_FIXTURE: &str = r#"{
    "request_id": "20250101_0a1b2c3d",
    "transcript": "नमस्ते, आप कैसे हैं?",
    "language_code": "hi-IN",
    "timestamps": {
      "words": ["chunk text 1", "chunk text 2"],
      "start_time_seconds": [0.01, 2.8],
      "end_time_seconds": [2.5, 4.2]
    },
    "language_probability": 0.95
  }"#;

    // From the batch guide: diarized output, with the guide's `chunks` key.
    const BATCH_FIXTURE: &str = r#"{
    "request_id": "20260130_d8d2c0e6",
    "transcript": "Full transcript text...",
    "language_code": "en-IN",
    "timestamps": {
      "chunks": ["Hello, how can I help you today?", "I have a question."],
      "start_time_seconds": [0.01, 2.8],
      "end_time_seconds": [2.5, 4.2]
    },
    "diarized_transcript": {
      "entries": [
        { "transcript": "Hello, how can I help you today?", "start_time_seconds": 0.01, "end_time_seconds": 2.5, "speaker_id": "0" },
        { "transcript": "I have a question.", "start_time_seconds": 2.8, "end_time_seconds": 4.2, "speaker_id": "1" }
      ]
    },
    "unknown_future_field": { "x": 1 }
  }"#;

    // From the job status reference.
    const STATUS_FIXTURE: &str = r#"{
    "job_id": "uuid",
    "job_state": "Completed",
    "created_at": "2025-01-01T10:00:00Z",
    "updated_at": "2025-01-01T10:05:00Z",
    "storage_container_type": "Azure_V1",
    "total_files": 1,
    "successful_files_count": 1,
    "failed_files_count": 0,
    "error_message": "",
    "job_details": [
      {
        "inputs":  [ { "file_name": "meeting.flac", "file_id": "file-001" } ],
        "outputs": [ { "file_name": "0.json", "file_id": "file-out-001" } ],
        "state": "Success",
        "error_message": null,
        "exception_name": null
      }
    ]
  }"#;

    fn request(files: &[&str], offsets: &[f64], duration: f64) -> SttRequest {
        SttRequest {
            task: "t1".into(),
            id: "01J9Z8Q4X5M2N3P4R5S6T7V8W9".into(),
            files: files.iter().map(|f| f.to_string()).collect(),
            offsets: offsets.to_vec(),
            duration,
            language: "unknown".into(),
            model: "saaras:v4".into(),
            mode: "transcribe".into(),
            diarize: false,
            num_speakers: None,
            resume_job_id: None,
        }
    }

    #[test]
    fn parses_rest_output() {
        let output = parse_output(&serde_json::from_str(REST_FIXTURE).unwrap());
        assert_eq!(output.request_id.as_deref(), Some("20250101_0a1b2c3d"));
        assert_eq!(output.language.as_deref(), Some("hi-IN"));
        assert_eq!(output.chunks.len(), 2);
        assert_eq!(output.chunks[1].text, "chunk text 2");
        let result = assemble(
            &[PartOutput {
                offset: 0.0,
                span: Some(4.5),
                output,
            }],
            "transcribe",
            "unknown",
        );
        assert_eq!(result.language.as_deref(), Some("hi-IN"));
        assert_eq!(result.segments[0].start, 0.01);
        assert_eq!(result.segments[1].end, 4.2);
        assert_eq!(result.request_ids, ["20250101_0a1b2c3d"]);
    }

    #[test]
    fn prefers_diarized_entries_and_applies_offsets() {
        let first = parse_output(&serde_json::from_str(BATCH_FIXTURE).unwrap());
        assert_eq!(first.chunks.len(), 2, "accepts the `chunks` key");
        let second = parse_output(&serde_json::json!({
          "transcript": "Later part",
          "timestamps": { "words": ["Later part"], "start_time_seconds": [1.0], "end_time_seconds": [3.0] }
        }));
        let result = assemble(
            &[
                PartOutput {
                    offset: 7200.0,
                    span: Some(100.0),
                    output: second,
                },
                PartOutput {
                    offset: 0.0,
                    span: Some(7200.0),
                    output: first,
                },
            ],
            "translate",
            "hi-IN",
        );
        assert_eq!(result.language.as_deref(), Some("en-IN"));
        assert_eq!(result.segments.len(), 3);
        assert_eq!(result.segments[0].speaker.as_deref(), Some("0"));
        assert_eq!(result.segments[1].speaker.as_deref(), Some("1"));
        assert_eq!(result.segments[2].start, 7201.0);
        assert_eq!(result.segments[2].speaker, None);
    }

    #[test]
    fn falls_back_to_whole_transcript() {
        let output = parse_output(
            &serde_json::json!({ "transcript": " Just text ", "language_code": null }),
        );
        let segs = segments(&output, 10.0, Some(5.0));
        assert_eq!(
            segs,
            vec![Segment {
                start: 10.0,
                end: 15.0,
                text: "Just text".into(),
                speaker: None
            }]
        );
        let empty = parse_output(&serde_json::json!({ "timestamps": null }));
        assert!(segments(&empty, 0.0, None).is_empty());
    }

    #[test]
    fn tolerates_ragged_and_odd_values() {
        let output = parse_output(&serde_json::json!({
          "timestamps": { "words": ["a", "b", ""], "start_time_seconds": [0.0, "x", 3.0], "end_time_seconds": [1.0, 2.0] },
          "diarized_transcript": { "entries": [] }
        }));
        let segs = segments(&output, 0.0, None);
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0].text, "a");
        let numeric = parse_output(&serde_json::json!({
          "diarized_transcript": { "entries": [{ "transcript": "x", "start_time_seconds": 2.0, "end_time_seconds": 1.0, "speaker_id": 3 }] }
        }));
        let segs = segments(&numeric, 0.0, None);
        assert_eq!(segs[0].speaker.as_deref(), Some("3"));
        assert_eq!(segs[0].end, 2.0, "end never precedes start");
    }

    #[test]
    fn parses_job_status() {
        let status = parse_status(&serde_json::from_str(STATUS_FIXTURE).unwrap());
        assert_eq!(status.state, "completed");
        assert_eq!(status.error, None);
        assert_eq!(
            status.files,
            vec![FileResult {
                input: Some("meeting.flac".into()),
                output: Some("0.json".into()),
                ok: true,
                error: None
            }]
        );
        let failed = parse_status(&serde_json::json!({
          "job_state": "Failed",
          "job_details": [{ "inputs": [{ "file_name": "a.wav" }], "outputs": [], "state": "API Error", "error_message": "bad audio" }]
        }));
        assert_eq!(failed.state, "failed");
        assert!(!failed.files[0].ok);
        assert_eq!(failed.files[0].error.as_deref(), Some("bad audio"));
    }

    #[test]
    fn parses_url_maps() {
        let value = serde_json::json!({
          "job_id": "uuid",
          "upload_urls": { "meeting.flac": { "file_url": "https://blob/meeting.flac?sas", "file_metadata": null } },
          "download_urls": { "0.json": "https://blob/0.json?sas" }
        });
        assert_eq!(
            url_map(&value, "upload_urls")
                .get("meeting.flac")
                .map(String::as_str),
            Some("https://blob/meeting.flac?sas")
        );
        assert_eq!(
            url_map(&value, "download_urls")
                .get("0.json")
                .map(String::as_str),
            Some("https://blob/0.json?sas")
        );
    }

    #[test]
    fn validates_requests() {
        let short = request(&["tmp-stt-0.wav"], &[0.0], 20.0);
        assert!(short.validate().is_ok());
        assert!(short.uses_rest());
        let mut diarized = short.clone();
        diarized.diarize = true;
        assert!(!diarized.uses_rest());
        let long = request(&["a.wav", "b.wav"], &[0.0, 7200.0], 9000.0);
        assert!(long.validate().is_ok());
        assert!(!long.uses_rest());
        assert_eq!(long.span(1), Some(1800.0));
        assert!(request(&["a.wav", "a.wav"], &[0.0, 1.0], 2.0)
            .validate()
            .is_err());
        assert!(request(&["a.wav"], &[], 2.0).validate().is_err());
        assert!(request(&["../a.wav"], &[0.0], 2.0).validate().is_err());
        let mut bad_lang = short.clone();
        bad_lang.language = "fr-FR".into();
        assert_eq!(bad_lang.validate().unwrap_err().code, Code::Unsupported);
        let parsed: SttRequest = serde_json::from_value(serde_json::json!({
          "task": "t", "id": "X", "files": ["a.wav"], "offsets": [0], "duration": 3,
          "language": "hi-IN", "model": "saaras:v3", "mode": "codemix", "diarize": false,
          "numSpeakers": null, "resumeJobId": "job-1"
        }))
        .unwrap();
        assert_eq!(parsed.resume_job_id.as_deref(), Some("job-1"));
        let stored = serde_json::to_value(&parsed).unwrap();
        assert!(stored.get("resumeJobId").is_none());
        assert_eq!(stored["numSpeakers"], Value::Null);
    }
}
