//! `jobs.json` in each session: remote jobs that were started and not yet collected, so they resume after a restart.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::client::Api;
use crate::error::IpcResult;
use crate::fsio::write_atomic;
use crate::library::paths::JOBS;
use crate::lock;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PendingJob {
    pub id: String,
    pub kind: String,
    pub job_id: String,
    pub created_at: String,
    pub request: Value,
}

/// Serializes read-modify-write cycles on every session's `jobs.json`.
#[derive(Default)]
pub struct JobStore(Mutex<()>);

fn read(path: &Path) -> Vec<PendingJob> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|error| {
            log::warn!("ignoring unreadable {}: {error}", path.display());
            Vec::new()
        }),
        Err(_) => Vec::new(),
    }
}

fn write(path: &Path, jobs: &[PendingJob]) -> io::Result<()> {
    if jobs.is_empty() {
        return match fs::remove_file(path) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        };
    }
    let bytes = serde_json::to_vec_pretty(jobs).map_err(io::Error::other)?;
    write_atomic(path, &bytes)
}

impl JobStore {
    pub fn add(&self, session: &Path, job: PendingJob) -> IpcResult<()> {
        let _serial = lock(&self.0);
        let path = session.join(JOBS);
        let mut jobs = read(&path);
        jobs.retain(|existing| existing.job_id != job.job_id);
        jobs.push(job);
        Ok(write(&path, &jobs)?)
    }

    pub fn remove(&self, session: &Path, job_id: &str) -> IpcResult<()> {
        let _serial = lock(&self.0);
        let path = session.join(JOBS);
        let mut jobs = read(&path);
        let before = jobs.len();
        jobs.retain(|existing| existing.job_id != job_id);
        if jobs.len() == before {
            return Ok(());
        }
        Ok(write(&path, &jobs)?)
    }

    pub fn list(&self, session: &Path) -> Vec<PendingJob> {
        let _serial = lock(&self.0);
        read(&session.join(JOBS))
    }
}

/// The remote job a running task is attached to, so cancellation can forget it.
#[derive(Default)]
pub struct JobSlot(Mutex<Option<(PathBuf, String)>>);

impl JobSlot {
    pub fn set(&self, session: &Path, job_id: &str) {
        *lock(&self.0) = Some((session.to_path_buf(), job_id.to_owned()));
    }

    pub fn clear(&self) {
        *lock(&self.0) = None;
    }

    pub fn take(&self) -> Option<(PathBuf, String)> {
        lock(&self.0).take()
    }
}

pub type ProgressFn<'a> = dyn Fn(&str, Option<f64>, &str) + Send + Sync + 'a;

/// Everything a Sarvam flow needs; free of Tauri types so flows run in tests.
pub struct Ctx<'a> {
    pub api: &'a Api,
    pub progress: &'a ProgressFn<'a>,
    pub jobs: &'a JobStore,
    pub slot: &'a JobSlot,
}

impl Ctx<'_> {
    pub fn report(&self, stage: &str, fraction: Option<f64>, message: &str) {
        (self.progress)(stage, fraction.map(|f| f.clamp(0.0, 1.0)), message);
    }

    /// Records a started remote job.
    pub fn persist(
        &self,
        session: &Path,
        kind: &str,
        job_id: &str,
        request: &impl Serialize,
    ) -> IpcResult<()> {
        let id = session
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        self.jobs.add(
            session,
            PendingJob {
                id,
                kind: kind.to_owned(),
                job_id: job_id.to_owned(),
                created_at: iso_now(),
                request: serde_json::to_value(request)?,
            },
        )?;
        self.slot.set(session, job_id);
        Ok(())
    }

    /// Forgets a remote job that reached a final state.
    pub fn finish(&self, session: &Path, job_id: &str) {
        if let Err(error) = self.jobs.remove(session, job_id) {
            log::warn!("could not update jobs.json: {error}");
        }
        self.slot.clear();
    }
}

pub fn iso_now() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    iso_from_unix(secs)
}

fn iso_from_unix(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Civil-from-days (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_utc_timestamps() {
        assert_eq!(iso_from_unix(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso_from_unix(1_700_000_000), "2023-11-14T22:13:20Z");
        assert_eq!(iso_from_unix(951_782_400), "2000-02-29T00:00:00Z");
    }

    #[test]
    fn store_adds_and_removes() {
        let dir = std::env::temp_dir().join(format!("br-jobs-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let store = JobStore::default();
        let job = |job_id: &str| PendingJob {
            id: "S".into(),
            kind: "stt".into(),
            job_id: job_id.into(),
            created_at: iso_now(),
            request: serde_json::json!({ "task": "t" }),
        };
        store.add(&dir, job("a")).unwrap();
        store.add(&dir, job("b")).unwrap();
        store.add(&dir, job("a")).unwrap();
        let ids: Vec<String> = store.list(&dir).into_iter().map(|j| j.job_id).collect();
        assert_eq!(ids, ["b", "a"]);
        store.remove(&dir, "a").unwrap();
        store.remove(&dir, "b").unwrap();
        assert!(!dir.join(JOBS).exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
