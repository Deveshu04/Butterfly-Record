//! Sarvam commands. All HTTP happens here so the API key never reaches the webview.

pub mod chat;
pub mod client;
pub mod dub;
pub mod jobs;
pub mod lang;
pub mod stt;
pub mod translate;
pub mod tts;

use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter, State};
use tokio_util::sync::CancellationToken;

use crate::error::{blocking, Code, IpcError, IpcResult};
use crate::fsio::resolve_read;
use crate::keystore;
use crate::library::paths::is_ulid;
use crate::library::Library;
use crate::lock;
use client::{Api, Timing};
use jobs::{Ctx, JobSlot, JobStore, PendingJob};

const PROGRESS_EVENT: &str = "sarvam-progress";

#[derive(Clone)]
pub struct Sarvam(Arc<SarvamInner>);

struct SarvamInner {
    http: reqwest::Client,
    base: String,
    tasks: Mutex<HashMap<String, CancellationToken>>,
    jobs: JobStore,
}

/// Unregisters a task when its command finishes or is dropped.
struct Registered<'a> {
    sarvam: &'a Sarvam,
    task: &'a str,
}

impl Drop for Registered<'_> {
    fn drop(&mut self) {
        lock(&self.sarvam.0.tasks).remove(self.task);
    }
}

impl Sarvam {
    pub fn new() -> reqwest::Result<Self> {
        Ok(Self(Arc::new(SarvamInner {
            http: client::http_client()?,
            base: client::base_url(),
            tasks: Mutex::default(),
            jobs: JobStore::default(),
        })))
    }

    fn api(&self, key: String) -> Api {
        Api::new(
            self.0.http.clone(),
            self.0.base.clone(),
            key,
            Timing::default(),
        )
    }

    /// Runs `work` under a cancellable task id; `sarvam_cancel` drops it mid-flight.
    async fn run<T>(&self, task: &str, work: impl Future<Output = IpcResult<T>>) -> IpcResult<T> {
        let token = {
            let mut tasks = lock(&self.0.tasks);
            if tasks.contains_key(task) {
                return Err(IpcError::busy("That task is already running."));
            }
            let token = CancellationToken::new();
            tasks.insert(task.to_owned(), token.clone());
            token
        };
        let _registered = Registered { sarvam: self, task };
        token
            .run_until_cancelled(work)
            .await
            .unwrap_or_else(|| Err(IpcError::cancelled()))
    }

    /// A cancelled task leaves the remote job running, but the user no longer wants its result.
    fn forget_if_cancelled<T>(&self, result: &IpcResult<T>, slot: &JobSlot) {
        if let (Err(error), Some((session, job_id))) = (result, slot.take()) {
            if error.code == Code::Cancelled {
                if let Err(error) = self.0.jobs.remove(&session, &job_id) {
                    log::warn!("could not update jobs.json: {error}");
                }
            }
        }
    }
}

#[derive(Clone, Serialize)]
struct ProgressEvent<'a> {
    task: &'a str,
    stage: &'a str,
    fraction: Option<f64>,
    message: &'a str,
}

fn emitter(app: AppHandle, task: String) -> impl Fn(&str, Option<f64>, &str) + Send + Sync {
    move |stage, fraction, message| {
        let event = ProgressEvent {
            task: &task,
            stage,
            fraction,
            message,
        };
        if let Err(error) = app.emit(PROGRESS_EVENT, event) {
            log::warn!("could not emit progress: {error}");
        }
    }
}

/// Accepts the request object either as the invoke arguments or wrapped as `{ request }`.
fn json_args<T: DeserializeOwned>(request: &Request<'_>) -> IpcResult<T> {
    let InvokeBody::Json(value) = request.body() else {
        return Err(IpcError::invalid("Expected JSON arguments."));
    };
    let value = match value.get("request") {
        Some(inner) if inner.is_object() => inner.clone(),
        _ => value.clone(),
    };
    serde_json::from_value(value)
        .map_err(|error| IpcError::invalid(format!("Invalid request: {error}")))
}

fn check_task(task: &str) -> IpcResult<()> {
    if task.is_empty() || task.len() > 100 {
        return Err(IpcError::invalid("Invalid task id."));
    }
    Ok(())
}

#[derive(Serialize)]
pub struct KeyTest {
    ok: bool,
    message: String,
}

#[tauri::command]
pub async fn sarvam_key_test(sarvam: State<'_, Sarvam>) -> IpcResult<KeyTest> {
    let api = sarvam.api(keystore::require().await?);
    let (ok, message) = match api
        .post_json::<Value, _>("/text-lid", &json!({ "input": "Hello" }))
        .await
    {
        Ok(_) => (true, "Your Sarvam key works.".to_string()),
        Err(error) => match error.code {
            Code::InvalidKey => (false, "Sarvam rejected this key.".to_string()),
            Code::Quota => (
                true,
                "Your key works, but the Sarvam account is out of credits.".to_string(),
            ),
            Code::Network => return Err(error),
            _ => (false, error.message),
        },
    };
    Ok(KeyTest { ok, message })
}

#[tauri::command]
pub async fn sarvam_transcribe(
    app: AppHandle,
    library: State<'_, Library>,
    sarvam: State<'_, Sarvam>,
    request: Request<'_>,
) -> IpcResult<stt::SttResult> {
    let request: stt::SttRequest = json_args(&request)?;
    check_task(&request.task)?;
    request.validate()?;
    let session = library.existing_session(&request.id)?;
    let api = sarvam.api(keystore::require().await?);
    let progress = emitter(app, request.task.clone());
    let slot = JobSlot::default();
    let ctx = Ctx {
        api: &api,
        progress: &progress,
        jobs: &sarvam.0.jobs,
        slot: &slot,
    };
    let result = sarvam
        .run(&request.task, stt::transcribe(&ctx, &session, &request))
        .await;
    sarvam.forget_if_cancelled(&result, &slot);
    result
}

#[tauri::command]
pub async fn sarvam_translate(
    app: AppHandle,
    sarvam: State<'_, Sarvam>,
    request: Request<'_>,
) -> IpcResult<Vec<String>> {
    let request: translate::TranslateRequest = json_args(&request)?;
    check_task(&request.task)?;
    let api = sarvam.api(keystore::require().await?);
    let progress = emitter(app, request.task.clone());
    let slot = JobSlot::default();
    let ctx = Ctx {
        api: &api,
        progress: &progress,
        jobs: &sarvam.0.jobs,
        slot: &slot,
    };
    sarvam
        .run(&request.task, translate::translate(&ctx, &request))
        .await
}

#[tauri::command]
pub async fn sarvam_tts(sarvam: State<'_, Sarvam>, request: Request<'_>) -> IpcResult<Response> {
    let request: tts::TtsRequest = json_args(&request)?;
    request.validate()?;
    let api = sarvam.api(keystore::require().await?);
    let wav = tts::synthesize(&api, &request).await?;
    Ok(Response::new(wav))
}

#[tauri::command]
pub async fn sarvam_dub(
    app: AppHandle,
    library: State<'_, Library>,
    sarvam: State<'_, Sarvam>,
    request: Request<'_>,
) -> IpcResult<dub::DubResult> {
    let request: dub::DubRequest = json_args(&request)?;
    check_task(&request.task)?;
    request.validate()?;
    let session = library.existing_session(&request.id)?;
    let upload = match (
        &request.resume_job_id,
        resolve_read(&library, &request.upload),
    ) {
        (_, Ok(path)) if path.is_file() => path,
        (Some(_), Ok(path)) => path,
        (Some(_), Err(_)) => PathBuf::new(),
        (None, Ok(_)) => return Err(IpcError::not_found("The file to dub no longer exists.")),
        (None, Err(error)) => return Err(error),
    };
    let api = sarvam.api(keystore::require().await?);
    let progress = emitter(app, request.task.clone());
    let slot = JobSlot::default();
    let ctx = Ctx {
        api: &api,
        progress: &progress,
        jobs: &sarvam.0.jobs,
        slot: &slot,
    };
    let result = sarvam
        .run(&request.task, dub::dub(&ctx, &session, &upload, &request))
        .await;
    sarvam.forget_if_cancelled(&result, &slot);
    result
}

#[tauri::command]
pub async fn sarvam_summarize(
    sarvam: State<'_, Sarvam>,
    text: String,
    language: Option<String>,
) -> IpcResult<chat::Summary> {
    let api = sarvam.api(keystore::require().await?);
    chat::summarize(&api, &text, language.as_deref()).await
}

#[tauri::command]
pub async fn sarvam_cancel(sarvam: State<'_, Sarvam>, task: String) -> IpcResult<()> {
    if let Some(token) = lock(&sarvam.0.tasks).get(&task) {
        token.cancel();
    }
    Ok(())
}

#[tauri::command]
pub async fn sarvam_pending_jobs(
    library: State<'_, Library>,
    sarvam: State<'_, Sarvam>,
) -> IpcResult<Vec<PendingJob>> {
    let app_dir = library.app_dir();
    let sarvam = sarvam.inner().clone();
    blocking(move || {
        let entries = match std::fs::read_dir(&app_dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };
        let mut pending = Vec::new();
        for entry in entries.flatten() {
            let is_session = entry.file_name().to_str().is_some_and(is_ulid)
                && entry.file_type().is_ok_and(|kind| kind.is_dir());
            if is_session {
                pending.extend(sarvam.0.jobs.list(&entry.path()));
            }
        }
        pending.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        Ok(pending)
    })
    .await
}

#[cfg(test)]
mod tests;
