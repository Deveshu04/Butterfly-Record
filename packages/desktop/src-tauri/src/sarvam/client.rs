//! HTTP plumbing for Sarvam: auth, retries, error mapping, storage uploads and downloads.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::TryStreamExt;
use reqwest::header::{CONTENT_LENGTH, CONTENT_TYPE};
use reqwest::{Body, Client, RequestBuilder, Response};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio_util::io::ReaderStream;

use crate::error::{Code, IpcError, IpcResult};
use crate::fsio::create_temp;

pub const BASE_URL: &str = "https://api.sarvam.ai";
pub const BASE_URL_ENV: &str = "BUTTERFLY_RECORD_SARVAM_BASE_URL";
const KEY_HEADER: &str = "api-subscription-key";

const MAX_ATTEMPTS: u32 = 5;
const MAX_BACKOFF: Duration = Duration::from_secs(60);
pub const API_TIMEOUT: Duration = Duration::from_secs(120);
const PROGRESS_INTERVAL: Duration = Duration::from_millis(500);

pub fn http_client() -> reqwest::Result<Client> {
    Client::builder()
        .user_agent(concat!("ButterflyRecord/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(30))
        .build()
}

pub fn base_url() -> String {
    std::env::var(BASE_URL_ENV)
        .ok()
        .map(|url| url.trim().trim_end_matches('/').to_string())
        .filter(|url| url.starts_with("https://") || url.starts_with("http://"))
        .unwrap_or_else(|| BASE_URL.to_string())
}

#[derive(Debug, Clone, Copy)]
pub struct Timing {
    pub stt_poll: Duration,
    pub dub_poll: Duration,
    pub backoff: Duration,
    /// Longest wait for a remote job to finish before giving up (the job stays resumable).
    pub job_wait: Duration,
    /// Longest wait for dubbing exports after the job completes.
    pub export_wait: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            stt_poll: Duration::from_secs(5),
            dub_poll: Duration::from_secs(10),
            backoff: Duration::from_secs(1),
            job_wait: Duration::from_secs(6 * 60 * 60),
            export_wait: Duration::from_secs(60 * 60),
        }
    }
}

/// A Sarvam error body, from either the documented `{error: {...}}` envelope or a bare `{detail}`.
#[derive(Debug, Default, PartialEq)]
pub struct Failure {
    pub code: Option<String>,
    pub message: Option<String>,
    pub request_id: Option<String>,
}

fn text_of(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

pub fn parse_failure(body: &str) -> Failure {
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return Failure::default();
    };
    let mut failure = Failure {
        request_id: text_of(value.get("request_id")),
        ..Failure::default()
    };
    match value.get("error") {
        Some(error @ Value::Object(_)) => {
            failure.code = text_of(error.get("code"));
            failure.message = text_of(error.get("message"));
            failure.request_id = text_of(error.get("request_id")).or(failure.request_id);
        }
        Some(Value::String(message)) => failure.message = Some(message.clone()),
        _ => {}
    }
    if failure.message.is_none() {
        failure.message = match value.get("detail") {
            Some(Value::String(detail)) => Some(detail.clone()),
            Some(Value::Array(items)) => items.first().and_then(|item| text_of(item.get("msg"))),
            Some(detail @ Value::Object(_)) => text_of(detail.get("message")),
            _ => text_of(value.get("message")),
        };
    }
    failure
}

fn default_message(code: Code, status: u16) -> String {
    match code {
        Code::Quota => "Your Sarvam account is out of credits.".into(),
        Code::InvalidKey => "Sarvam rejected the API key.".into(),
        Code::RateLimited => "Sarvam is limiting requests right now. Try again in a minute.".into(),
        Code::TooLarge => "The file is too large for Sarvam.".into(),
        Code::Unsupported => "Sarvam does not support this file.".into(),
        Code::NotFound => "Sarvam could not find that job.".into(),
        _ => format!("Sarvam returned an error (HTTP {status})."),
    }
}

/// Maps a failed Sarvam API response to an `IpcError`.
pub fn status_error(status: u16, failure: Failure) -> IpcError {
    let code = match (status, failure.code.as_deref()) {
        (_, Some("insufficient_quota_error")) => Code::Quota,
        (_, Some("invalid_api_key_error" | "authentication_error")) | (401 | 403, _) => {
            Code::InvalidKey
        }
        (429, _) | (_, Some("rate_limit_exceeded_error")) => Code::RateLimited,
        (413, _) => Code::TooLarge,
        (415, _) => Code::Unsupported,
        (404, _) | (_, Some("not_found_error")) => Code::NotFound,
        _ => Code::Api,
    };
    let message = failure
        .message
        .unwrap_or_else(|| default_message(code, status));
    IpcError::new(code, message)
        .with_status(status)
        .with_request_id(failure.request_id)
}

/// Storage (signed URL) failures carry no Sarvam semantics: a 403 means the link expired.
fn storage_error(status: u16) -> IpcError {
    let (code, message) = match status {
        401 | 403 => (
            Code::Api,
            "The storage link expired. Start the job again.".to_string(),
        ),
        404 => (
            Code::NotFound,
            "The file is no longer available on Sarvam's storage.".to_string(),
        ),
        413 => (
            Code::TooLarge,
            "The file is too large to upload.".to_string(),
        ),
        _ => (
            Code::Api,
            format!("Sarvam's storage returned an error (HTTP {status})."),
        ),
    };
    IpcError::new(code, message).with_status(status)
}

fn retryable(status: u16, failure: &Failure) -> bool {
    match status {
        429 => failure.code.as_deref() != Some("insufficient_quota_error"),
        500 | 503 => true,
        _ => false,
    }
}

pub fn network_error(error: reqwest::Error) -> IpcError {
    let message = if error.is_timeout() {
        "Sarvam did not respond in time."
    } else if error.is_connect() {
        "Could not connect to Sarvam. Check your internet connection."
    } else {
        "The connection to Sarvam failed."
    };
    log::warn!("sarvam transport error: {}", error.without_url());
    IpcError::new(Code::Network, message)
}

pub fn unexpected() -> IpcError {
    IpcError::new(Code::Api, "Sarvam sent a response the app could not read.")
}

pub fn backoff(base: Duration, attempt: u32) -> Duration {
    base.saturating_mul(1 << attempt.saturating_sub(1).min(16))
        .min(MAX_BACKOFF)
}

pub async fn read_json<T: DeserializeOwned>(response: Response) -> IpcResult<T> {
    let bytes = response.bytes().await.map_err(network_error)?;
    serde_json::from_slice(&bytes).map_err(|error| {
        log::warn!("unreadable Sarvam response: {error}");
        unexpected()
    })
}

pub fn mime_for(path: &Path) -> &'static str {
    match crate::library::paths::extension_of(path).as_deref() {
        Some("wav") => "audio/wav",
        Some("mp3") => "audio/mpeg",
        Some("m4a") => "audio/mp4",
        Some("aac") => "audio/aac",
        Some("ogg" | "opus") => "audio/ogg",
        Some("flac") => "audio/flac",
        Some("webm") => "video/webm",
        Some("mp4" | "m4v") => "video/mp4",
        Some("mov") => "video/quicktime",
        Some("mkv") => "video/x-matroska",
        _ => "application/octet-stream",
    }
}

/// Deletes a scratch download unless it was kept (also on cancellation, when the future is dropped).
struct TempFile {
    path: PathBuf,
    keep: bool,
}

impl Drop for TempFile {
    fn drop(&mut self) {
        if !self.keep {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

pub struct Api {
    http: Client,
    base: String,
    key: String,
    pub timing: Timing,
}

impl Api {
    pub fn new(http: Client, base: String, key: String, timing: Timing) -> Self {
        Self {
            http,
            base,
            key,
            timing,
        }
    }

    pub fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    async fn send_with(
        &self,
        authed: bool,
        idempotent: bool,
        make: impl Fn(&Client) -> IpcResult<RequestBuilder>,
    ) -> IpcResult<Response> {
        let mut attempt = 1;
        loop {
            let mut request = make(&self.http)?;
            if authed {
                request = request.header(KEY_HEADER, &self.key);
            }
            match request.send().await {
                Ok(response) if response.status().is_success() => return Ok(response),
                Ok(response) => {
                    let status = response.status().as_u16();
                    let path = response.url().path().to_owned();
                    let body = response.text().await.unwrap_or_default();
                    let failure = if authed {
                        parse_failure(&body)
                    } else {
                        Failure::default()
                    };
                    log::warn!(
                        "sarvam {path} returned {status} {}",
                        failure.code.as_deref().unwrap_or("")
                    );
                    if attempt >= MAX_ATTEMPTS || !retryable(status, &failure) {
                        return Err(if authed {
                            status_error(status, failure)
                        } else {
                            storage_error(status)
                        });
                    }
                }
                Err(error) => {
                    let transient = error.is_connect() || error.is_timeout() || error.is_request();
                    if !(idempotent && transient) || attempt >= MAX_ATTEMPTS {
                        return Err(network_error(error));
                    }
                }
            }
            tokio::time::sleep(backoff(self.timing.backoff, attempt)).await;
            attempt += 1;
        }
    }

    /// An authenticated Sarvam API call. Retries 429 (not quota), 500 and 503; transport
    /// failures are retried only for idempotent requests.
    pub async fn send(
        &self,
        idempotent: bool,
        make: impl Fn(&Client) -> IpcResult<RequestBuilder>,
    ) -> IpcResult<Response> {
        self.send_with(true, idempotent, make).await
    }

    pub async fn post_json<T, B>(&self, path: &str, body: &B) -> IpcResult<T>
    where
        T: DeserializeOwned,
        B: Serialize + Sync + ?Sized,
    {
        self.post_json_with(path, body, API_TIMEOUT).await
    }

    pub async fn post_json_with<T, B>(
        &self,
        path: &str,
        body: &B,
        timeout: Duration,
    ) -> IpcResult<T>
    where
        T: DeserializeOwned,
        B: Serialize + Sync + ?Sized,
    {
        let url = self.url(path);
        let response = self
            .send(false, |http| {
                Ok(http.post(&url).json(body).timeout(timeout))
            })
            .await?;
        read_json(response).await
    }

    /// POST without a body (job start endpoints).
    pub async fn post_empty<T: DeserializeOwned>(&self, path: &str) -> IpcResult<T> {
        let url = self.url(path);
        let response = self
            .send(false, |http| {
                Ok(http
                    .post(&url)
                    .header(CONTENT_LENGTH, 0)
                    .timeout(API_TIMEOUT))
            })
            .await?;
        read_json(response).await
    }

    pub async fn get_json<T: DeserializeOwned>(&self, path: &str) -> IpcResult<T> {
        let url = self.url(path);
        let response = self
            .send(true, |http| Ok(http.get(&url).timeout(API_TIMEOUT)))
            .await?;
        read_json(response).await
    }

    /// GET JSON from a signed storage URL (no API key).
    pub async fn fetch_json<T: DeserializeOwned>(&self, url: &str) -> IpcResult<T> {
        let response = self
            .send_with(false, true, |http| Ok(http.get(url).timeout(API_TIMEOUT)))
            .await?;
        read_json(response).await
    }

    /// PUTs a file to a signed blob URL (no API key), streamed from disk with an explicit
    /// Content-Length because Azure rejects chunked uploads.
    pub async fn upload(
        &self,
        url: &str,
        path: &Path,
        content_type: &str,
        progress: &(dyn Fn(u64, u64) + Send + Sync),
    ) -> IpcResult<()> {
        let total = Arc::new(AtomicU64::new(0));
        let sent = Arc::new(AtomicU64::new(0));
        let send = self.send_with(false, true, |http| {
            let file = std::fs::File::open(path)?;
            let len = file.metadata()?.len();
            total.store(len, Ordering::Relaxed);
            sent.store(0, Ordering::Relaxed);
            let counter = Arc::clone(&sent);
            let stream = ReaderStream::with_capacity(tokio::fs::File::from_std(file), 256 * 1024)
                .inspect_ok(move |chunk| {
                    counter.fetch_add(chunk.len() as u64, Ordering::Relaxed);
                });
            Ok(http
                .put(url)
                .header("x-ms-blob-type", "BlockBlob")
                .header(CONTENT_TYPE, content_type)
                .header(CONTENT_LENGTH, len)
                .body(Body::wrap_stream(stream)))
        });
        tokio::pin!(send);
        let mut ticker = tokio::time::interval(PROGRESS_INTERVAL);
        loop {
            tokio::select! {
              result = &mut send => {
                result?;
                let total = total.load(Ordering::Relaxed);
                progress(total, total);
                return Ok(());
              }
              _ = ticker.tick() => {
                let total = total.load(Ordering::Relaxed);
                progress(sent.load(Ordering::Relaxed).min(total), total);
              }
            }
        }
    }

    /// Streams a signed URL into `dest` (replacing it) through a scratch file. Returns the byte count.
    pub async fn download(
        &self,
        url: &str,
        dest: &Path,
        progress: &(dyn Fn(u64, Option<u64>) + Send + Sync),
    ) -> IpcResult<u64> {
        let response = self
            .send_with(false, true, |http| Ok(http.get(url)))
            .await?;
        let total = response.content_length();
        let dir = dest
            .parent()
            .ok_or_else(|| IpcError::invalid("Invalid download target."))?;
        let (path, file) = create_temp(dir)?;
        let mut scratch = TempFile { path, keep: false };
        let mut file = tokio::fs::File::from_std(file);
        let mut stream = response.bytes_stream();
        let mut received = 0u64;
        let mut reported = Instant::now();
        while let Some(chunk) = stream.try_next().await.map_err(network_error)? {
            file.write_all(&chunk).await?;
            received += chunk.len() as u64;
            if reported.elapsed() >= PROGRESS_INTERVAL {
                progress(received, total);
                reported = Instant::now();
            }
        }
        file.sync_all().await?;
        drop(file);
        tokio::fs::rename(&scratch.path, dest).await?;
        scratch.keep = true;
        progress(received, total);
        Ok(received)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_error_envelopes() {
        let documented = r#"{"error":{"message":"Invalid or missing authentication credentials","code":"invalid_api_key_error","request_id":"20261007_cad21e3a"}}"#;
        assert_eq!(
            parse_failure(documented),
            Failure {
                code: Some("invalid_api_key_error".into()),
                message: Some("Invalid or missing authentication credentials".into()),
                request_id: Some("20261007_cad21e3a".into()),
            }
        );
        let fastapi = r#"{"detail": "Missing authentication credentials"}"#;
        assert_eq!(
            parse_failure(fastapi).message.as_deref(),
            Some("Missing authentication credentials")
        );
        let validation = r#"{"detail":[{"loc":["body","src_lang"],"msg":"Input should be 'en-IN'","type":"enum"}]}"#;
        assert_eq!(
            parse_failure(validation).message.as_deref(),
            Some("Input should be 'en-IN'")
        );
        assert_eq!(
            parse_failure("<html>Bad gateway</html>"),
            Failure::default()
        );
    }

    fn failure(code: &str) -> Failure {
        Failure {
            code: Some(code.into()),
            message: None,
            request_id: Some("rid".into()),
        }
    }

    #[test]
    fn maps_statuses_to_codes() {
        assert_eq!(
            status_error(403, failure("invalid_api_key_error")).code,
            Code::InvalidKey
        );
        assert_eq!(status_error(401, Failure::default()).code, Code::InvalidKey);
        assert_eq!(
            status_error(429, failure("insufficient_quota_error")).code,
            Code::Quota
        );
        assert_eq!(
            status_error(429, failure("rate_limit_exceeded_error")).code,
            Code::RateLimited
        );
        assert_eq!(status_error(413, Failure::default()).code, Code::TooLarge);
        assert_eq!(
            status_error(404, failure("not_found_error")).code,
            Code::NotFound
        );
        assert_eq!(
            status_error(422, failure("unprocessable_entity_error")).code,
            Code::Api
        );
        assert_eq!(
            status_error(500, failure("internal_server_error")).code,
            Code::Api
        );
        let mapped = status_error(403, failure("invalid_api_key_error"));
        assert_eq!(mapped.status, Some(403));
        assert_eq!(mapped.request_id.as_deref(), Some("rid"));
        assert_eq!(mapped.message, "Sarvam rejected the API key.");
        assert_eq!(storage_error(403).code, Code::Api);
    }

    #[test]
    fn retries_only_transient_statuses() {
        assert!(retryable(429, &failure("rate_limit_exceeded_error")));
        assert!(!retryable(429, &failure("insufficient_quota_error")));
        assert!(retryable(500, &Failure::default()));
        assert!(retryable(503, &Failure::default()));
        for status in [400, 403, 404, 422, 502] {
            assert!(!retryable(status, &Failure::default()), "{status}");
        }
    }

    #[test]
    fn backoff_doubles_and_caps() {
        let base = Duration::from_secs(1);
        assert_eq!(backoff(base, 1), Duration::from_secs(1));
        assert_eq!(backoff(base, 2), Duration::from_secs(2));
        assert_eq!(backoff(base, 4), Duration::from_secs(8));
        assert_eq!(backoff(base, 9), Duration::from_secs(60));
    }
}
