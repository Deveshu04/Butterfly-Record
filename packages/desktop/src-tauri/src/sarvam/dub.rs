//! Sarvam Dubbing: create, upload, start, follow live-status, then collect every requested export.

use std::path::Path;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::client::{mime_for, unexpected};
use super::jobs::Ctx;
use super::lang;
use crate::error::{Code, IpcError, IpcResult};
use crate::fsio::ReadTarget;
use crate::library::paths::extension_of;

const EXPORT_TYPES: &[&str] = &["video", "audio", "srt"];
const AUDIO_EXTENSIONS: &[&str] = &["wav", "mp3", "m4a", "aac", "ogg", "opus", "flac"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DubRequest {
    pub task: String,
    pub id: String,
    pub upload: ReadTarget,
    pub source_language: String,
    pub target_languages: Vec<String>,
    pub num_speakers: i32,
    pub exports: Vec<String>,
    #[serde(default, skip_serializing)]
    pub resume_job_id: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DubOutput {
    pub language: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub sidecar_name: String,
    pub bytes: u64,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct DubFailure {
    pub language: String,
    pub message: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DubResult {
    pub job_id: String,
    pub outputs: Vec<DubOutput>,
    pub failed: Vec<DubFailure>,
}

impl DubRequest {
    pub fn validate(&self) -> IpcResult<()> {
        let unsupported = || {
            IpcError::new(
                Code::Unsupported,
                "Sarvam Dubbing does not support this language.",
            )
        };
        lang::to_dubbing(&self.source_language).ok_or_else(unsupported)?;
        if self.target_languages.is_empty() {
            return Err(IpcError::invalid("Choose at least one language."));
        }
        for (i, target) in self.target_languages.iter().enumerate() {
            lang::to_dubbing(target).ok_or_else(unsupported)?;
            if *target == self.source_language || self.target_languages[..i].contains(target) {
                return Err(IpcError::invalid(
                    "Target languages must differ from the source and from each other.",
                ));
            }
        }
        if !(self.num_speakers == -1 || (1..=10).contains(&self.num_speakers)) {
            return Err(IpcError::invalid("Speakers must be 1 to 10, or automatic."));
        }
        if self.exports.is_empty()
            || !self
                .exports
                .iter()
                .all(|e| EXPORT_TYPES.contains(&e.as_str()))
        {
            return Err(IpcError::invalid(
                "Choose video, audio or subtitles to export.",
            ));
        }
        Ok(())
    }
}

pub fn is_audio_only(path: &Path) -> bool {
    extension_of(path).is_some_and(|ext| AUDIO_EXTENSIONS.contains(&ext.as_str()))
}

/// Export types to wait for: Sarvam renders `video` as `audio` for audio-only uploads.
pub fn wanted_exports(exports: &[String], audio_only: bool) -> Vec<String> {
    let mut wanted: Vec<String> = Vec::new();
    for export in exports {
        let kind = if audio_only && export == "video" {
            "audio"
        } else {
            export.as_str()
        };
        if !wanted.iter().any(|w| w == kind) {
            wanted.push(kind.to_owned());
        }
    }
    wanted
}

/// `data` when the reply is wrapped in `{status, message, data}`, else the reply itself.
fn data(value: &Value) -> &Value {
    value.get("data").filter(|d| d.is_object()).unwrap_or(value)
}

fn text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
}

#[derive(Debug, Default, PartialEq)]
pub struct LiveStatus {
    pub status: String,
    pub progress: Option<f64>,
    pub step: Option<String>,
    pub error: Option<String>,
    /// (canonical language, status) from `export` (one language) or `exports` (several).
    pub languages: Vec<(String, String)>,
}

pub fn parse_live_status(value: &Value) -> LiveStatus {
    let data = data(value);
    let entries: Vec<&Value> = match (data.get("exports"), data.get("export")) {
        (Some(Value::Array(items)), _) => items.iter().collect(),
        (_, Some(Value::Array(items))) => items.iter().collect(),
        (_, Some(item @ Value::Object(_))) => vec![item],
        (Some(item @ Value::Object(_)), _) => vec![item],
        _ => Vec::new(),
    };
    LiveStatus {
        status: text(data.get("status"))
            .unwrap_or_default()
            .to_ascii_lowercase(),
        progress: data
            .get("progress")
            .and_then(Value::as_f64)
            .map(|p| p / 100.0),
        step: text(data.get("current_step_label")).or_else(|| text(data.get("current_step"))),
        error: text(data.get("error_message")),
        languages: entries
            .into_iter()
            .filter_map(|entry| {
                let language = text(entry.get("target_language"))?;
                let status = text(entry.get("status"))
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                Some((lang::from_dubbing(&language), status))
            })
            .collect(),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExportItem {
    pub language: String,
    pub kind: String,
    pub status: String,
    pub stale: bool,
    pub url: Option<String>,
}

pub fn parse_exports(value: &Value) -> Vec<ExportItem> {
    let data = data(value);
    let items = data
        .get("exports")
        .and_then(Value::as_array)
        .or_else(|| data.as_array());
    items
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some(ExportItem {
                        language: lang::from_dubbing(&text(item.get("target_language"))?),
                        kind: text(item.get("export_type"))?.to_ascii_lowercase(),
                        status: text(item.get("status"))
                            .unwrap_or_default()
                            .to_ascii_lowercase(),
                        stale: item
                            .get("is_stale")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        url: text(item.get("download_url")),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Debug, Default, PartialEq)]
pub struct Settled {
    pub ready: Vec<(String, String, String)>,
    pub failed: Vec<(String, String)>,
    pub pending: Vec<(String, String)>,
}

/// Sorts every (language, type) into ready (with URL), failed or still pending.
pub fn settle(
    targets: &[String],
    wanted: &[String],
    failed_languages: &[String],
    items: &[ExportItem],
) -> Settled {
    let mut settled = Settled::default();
    for language in targets {
        if failed_languages.contains(language) {
            settled.failed.push((
                language.clone(),
                "Sarvam could not dub this language.".into(),
            ));
            continue;
        }
        for kind in wanted {
            let matching: Vec<&ExportItem> = items
                .iter()
                .filter(|item| &item.language == language && &item.kind == kind)
                .collect();
            let ready = matching
                .iter()
                .filter(|item| item.status == "completed")
                .filter_map(|item| Some((item.stale, item.url.clone()?)))
                .min_by_key(|(stale, _)| *stale);
            let in_flight = matching.iter().any(|item| item.status != "failed");
            match ready {
                Some((_, url)) => settled.ready.push((language.clone(), kind.clone(), url)),
                None if !matching.is_empty() && !in_flight => settled
                    .failed
                    .push((language.clone(), format!("The {kind} export failed."))),
                None => settled.pending.push((language.clone(), kind.clone())),
            }
        }
    }
    settled
}

/// File extension for a downloaded export, from its URL when recognisable.
pub fn export_extension(kind: &str, url: &str) -> &'static str {
    let from_url = reqwest::Url::parse(url)
        .ok()
        .and_then(|url| extension_of(Path::new(url.path())));
    let (known, fallback): (&[&'static str], &'static str) = match kind {
        "video" => (&["mp4", "mov", "mkv", "webm"], "mp4"),
        "audio" => (&["wav", "mp3", "m4a"], "wav"),
        "mp3" => (&["mp3"], "mp3"),
        _ => (&["srt"], "srt"),
    };
    from_url
        .and_then(|ext| known.iter().find(|k| **k == ext).copied())
        .unwrap_or(fallback)
}

pub async fn dub(
    ctx: &Ctx<'_>,
    session: &Path,
    upload: &Path,
    request: &DubRequest,
) -> IpcResult<DubResult> {
    let job_id = match &request.resume_job_id {
        Some(job_id) => {
            ctx.slot.set(session, job_id);
            job_id.clone()
        }
        None => start_job(ctx, session, upload, request).await?,
    };
    let live = wait_for_job(ctx, session, &job_id).await?;
    let failed_languages: Vec<String> = live
        .languages
        .iter()
        .filter(|(_, status)| status == "failed")
        .map(|(language, _)| language.clone())
        .collect();

    ctx.report("export", None, "Preparing the dubbed files");
    let wanted = wanted_exports(&request.exports, is_audio_only(upload));
    let started = Instant::now();
    let settled = loop {
        let value: Value = ctx
            .api
            .get_json(&format!("/dubbing/jobs/{job_id}/export-status?limit=100"))
            .await?;
        let settled = settle(
            &request.target_languages,
            &wanted,
            &failed_languages,
            &parse_exports(&value),
        );
        if settled.pending.is_empty() || started.elapsed() > ctx.api.timing.export_wait {
            break settled;
        }
        tokio::time::sleep(ctx.api.timing.dub_poll).await;
    };

    let mut outputs = Vec::with_capacity(settled.ready.len());
    let count = settled.ready.len();
    for (i, (language, kind, url)) in settled.ready.iter().enumerate() {
        let sidecar_name = format!("dub.{language}.{}", export_extension(kind, url));
        let label = lang::name(language).unwrap_or(language.as_str());
        let message = format!("Downloading {label} ({kind})");
        let bytes = ctx
            .api
            .download(url, &session.join(&sidecar_name), &|received, total| {
                let part = total
                    .map(|t| received as f64 / t.max(1) as f64)
                    .unwrap_or(0.0);
                ctx.report("download", Some((i as f64 + part) / count as f64), &message);
            })
            .await?;
        outputs.push(DubOutput {
            language: language.clone(),
            kind: kind.clone(),
            sidecar_name,
            bytes,
        });
    }
    let mut failed: Vec<DubFailure> = settled
        .failed
        .into_iter()
        .map(|(language, message)| DubFailure { language, message })
        .collect();
    failed.extend(
        settled
            .pending
            .into_iter()
            .map(|(language, kind)| DubFailure {
                language,
                message: format!("The {kind} export did not finish in time."),
            }),
    );
    ctx.finish(session, &job_id);
    Ok(DubResult {
        job_id,
        outputs,
        failed,
    })
}

async fn start_job(
    ctx: &Ctx<'_>,
    session: &Path,
    upload: &Path,
    request: &DubRequest,
) -> IpcResult<String> {
    ctx.report("prepare", None, "Creating the dubbing job");
    let to_api = |code: &str| lang::to_dubbing(code).map(str::to_owned);
    let targets: Vec<String> = request
        .target_languages
        .iter()
        .filter_map(|code| to_api(code))
        .collect();
    let created: Value = ctx
        .api
        .post_json(
            "/dubbing/jobs",
            &json!({
              "src_lang": to_api(&request.source_language),
              "target_langs": targets,
              "export_options": request.exports,
              "num_speakers": request.num_speakers,
              "disable_watermark": true,
              "editor_flow": false,
            }),
        )
        .await?;
    let created = data(&created);
    let job_id = text(created.get("job_id")).ok_or_else(unexpected)?;
    let upload_url = text(created.get("upload_url")).ok_or_else(unexpected)?;

    let what = if is_audio_only(upload) {
        "Uploading audio"
    } else {
        "Uploading video"
    };
    ctx.api
        .upload(&upload_url, upload, mime_for(upload), &|sent, total| {
            ctx.report("upload", Some(sent as f64 / total.max(1) as f64), what);
        })
        .await?;
    let _: Value = ctx
        .api
        .post_empty(&format!("/dubbing/jobs/{job_id}/start"))
        .await?;
    ctx.persist(session, "dub", &job_id, request)?;
    Ok(job_id)
}

async fn wait_for_job(ctx: &Ctx<'_>, session: &Path, job_id: &str) -> IpcResult<LiveStatus> {
    let started = Instant::now();
    loop {
        let value: Value = match ctx
            .api
            .get_json(&format!("/dubbing/jobs/{job_id}/live-status"))
            .await
        {
            Ok(value) => value,
            Err(error) if error.code == Code::NotFound => {
                ctx.finish(session, job_id);
                return Err(error);
            }
            Err(error) => return Err(error),
        };
        let live = parse_live_status(&value);
        match live.status.as_str() {
            "completed" | "partial_failure" => return Ok(live),
            "failed" | "deleted" => {
                ctx.finish(session, job_id);
                let message = live
                    .error
                    .unwrap_or_else(|| "Sarvam could not dub this video.".into());
                return Err(IpcError::new(Code::Api, message));
            }
            "queued" | "not_started" => ctx.report("queued", live.progress, "Waiting for Sarvam"),
            _ => ctx.report(
                "process",
                live.progress,
                live.step.as_deref().unwrap_or("Dubbing"),
            ),
        }
        if started.elapsed() > ctx.api.timing.job_wait {
            return Err(IpcError::new(
                Code::Network,
                "Sarvam is taking too long. The job will resume next time the app starts.",
            ));
        }
        tokio::time::sleep(ctx.api.timing.dub_poll).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn live_status_handles_export_and_exports() {
        let single = serde_json::json!({
          "status": "success",
          "data": {
            "job_id": "j1", "status": "in_progress", "progress": 42, "current_step": "tts",
            "current_step_label": "Generating speech",
            "export": { "target_language": "or-IN", "status": "in_progress", "dubbed_video_url": null }
          }
        });
        let live = parse_live_status(&single);
        assert_eq!(live.status, "in_progress");
        assert_eq!(live.progress, Some(0.42));
        assert_eq!(live.step.as_deref(), Some("Generating speech"));
        assert_eq!(
            live.languages,
            vec![("od-IN".to_string(), "in_progress".to_string())]
        );

        let multi = serde_json::json!({
          "data": {
            "status": "partial_failure", "progress": 100,
            "exports": [
              { "target_language": "hi-IN", "status": "completed", "dubbed_video_url": "https://x/hi.mp4", "duration": 60 },
              { "target_language": "ta-IN", "status": "failed" }
            ]
          }
        });
        let live = parse_live_status(&multi);
        assert_eq!(live.status, "partial_failure");
        assert_eq!(live.languages.len(), 2);
        assert_eq!(
            live.languages[1],
            ("ta-IN".to_string(), "failed".to_string())
        );

        let bare = parse_live_status(
            &serde_json::json!({ "status": "queued", "export": null, "exports": null }),
        );
        assert_eq!(bare.status, "queued");
        assert!(bare.languages.is_empty());
    }

    #[test]
    fn export_status_and_settling() {
        let value = serde_json::json!({
          "data": {
            "exports": [
              { "id": "e1", "target_language": "hi-IN", "export_type": "audio", "status": "completed", "is_stale": false, "download_url": "https://blob/hi.wav?sig" },
              { "id": "e2", "target_language": "hi-IN", "export_type": "srt", "status": "in_progress", "is_stale": false },
              { "id": "e3", "target_language": "or-IN", "export_type": "audio", "status": "completed", "is_stale": false },
              { "id": "e4", "target_language": "or-IN", "export_type": "srt", "status": "failed" },
              { "id": "e5", "target_language": "hi-IN", "export_type": "mp3", "status": "completed", "download_url": "https://blob/hi.mp3" }
            ]
          }
        });
        let items = parse_exports(&value);
        assert_eq!(items.len(), 5);
        assert_eq!(items[2].language, "od-IN");
        assert_eq!(items[2].url, None, "download_url is absent until done");

        let targets = strings(&["hi-IN", "od-IN", "ta-IN"]);
        let wanted = wanted_exports(&strings(&["video", "srt"]), true);
        assert_eq!(wanted, strings(&["audio", "srt"]));
        let settled = settle(&targets, &wanted, &strings(&["ta-IN"]), &items);
        assert_eq!(
            settled.ready,
            vec![(
                "hi-IN".to_string(),
                "audio".to_string(),
                "https://blob/hi.wav?sig".to_string()
            )]
        );
        assert_eq!(
            settled.pending,
            vec![
                ("hi-IN".to_string(), "srt".to_string()),
                ("od-IN".to_string(), "audio".to_string())
            ]
        );
        assert_eq!(settled.failed.len(), 2);
        assert_eq!(settled.failed[0].0, "od-IN");
        assert_eq!(settled.failed[1].0, "ta-IN");

        let top_level = parse_exports(&serde_json::json!({ "exports": [
          { "target_language": "hi-IN", "export_type": "VIDEO", "status": "Completed", "download_url": "https://blob/v.mp4" }
        ]}));
        assert_eq!(top_level[0].kind, "video");
        assert_eq!(top_level[0].status, "completed");
    }

    #[test]
    fn prefers_fresh_exports() {
        let item = |stale: bool, url: &str| ExportItem {
            language: "hi-IN".into(),
            kind: "video".into(),
            status: "completed".into(),
            stale,
            url: Some(url.into()),
        };
        let items = vec![item(true, "https://old"), item(false, "https://new")];
        let settled = settle(&strings(&["hi-IN"]), &strings(&["video"]), &[], &items);
        assert_eq!(settled.ready[0].2, "https://new");
    }

    #[test]
    fn picks_extensions() {
        assert_eq!(
            export_extension("video", "https://blob/x/out.mov?sig=1"),
            "mov"
        );
        assert_eq!(export_extension("video", "https://blob/x/out?sig=1"), "mp4");
        assert_eq!(export_extension("audio", "https://blob/x/out.mp4"), "wav");
        assert_eq!(export_extension("srt", "not a url"), "srt");
    }

    #[test]
    fn validates_requests() {
        let request: DubRequest = serde_json::from_value(serde_json::json!({
      "task": "t", "id": "01J9Z8Q4X5M2N3P4R5S6T7V8W9",
      "upload": { "kind": "sidecar", "id": "01J9Z8Q4X5M2N3P4R5S6T7V8W9", "name": "tmp-dub-source.wav" },
      "sourceLanguage": "en-IN", "targetLanguages": ["od-IN", "hi-IN"],
      "numSpeakers": -1, "exports": ["video", "srt"]
    }))
    .unwrap();
        assert!(request.validate().is_ok());
        let mut same = request.clone();
        same.target_languages = strings(&["en-IN"]);
        assert!(same.validate().is_err());
        let mut unsupported = request.clone();
        unsupported.target_languages = strings(&["ur-IN"]);
        assert_eq!(unsupported.validate().unwrap_err().code, Code::Unsupported);
        let mut speakers = request.clone();
        speakers.num_speakers = 11;
        assert!(speakers.validate().is_err());
        let mut exports = request.clone();
        exports.exports = strings(&["mp3"]);
        assert!(exports.validate().is_err());
        let stored = serde_json::to_value(&request).unwrap();
        assert_eq!(stored["upload"]["kind"], "sidecar");
        assert!(stored.get("resumeJobId").is_none());
    }
}
