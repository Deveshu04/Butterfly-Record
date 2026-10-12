//! Append-only `source.part` sink the recorder streams encoded chunks into.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::ipc::Request;
use tauri::State;

use crate::error::{blocking, IpcError, IpcResult};
use crate::fsio::{header, raw_body};
use crate::library::access::write_error;
use crate::library::paths::{check_id, SOURCE_PART};
use crate::library::Library;
use crate::lock;

struct Sink {
    file: File,
    path: PathBuf,
    written: u64,
}

#[derive(Default, Clone)]
pub struct Recorders(Arc<Mutex<HashMap<String, Arc<Mutex<Sink>>>>>);

impl Recorders {
    pub fn is_open(&self, id: &str) -> bool {
        lock(&self.0).contains_key(id)
    }

    pub fn any_open(&self) -> bool {
        !lock(&self.0).is_empty()
    }

    fn get(&self, id: &str) -> IpcResult<Arc<Mutex<Sink>>> {
        lock(&self.0)
            .get(id)
            .cloned()
            .ok_or_else(|| IpcError::invalid("No recording is open for this id."))
    }

    fn take(&self, id: &str) -> Option<Arc<Mutex<Sink>>> {
        lock(&self.0).remove(id)
    }
}

#[tauri::command]
pub async fn rec_open(
    library: State<'_, Library>,
    recorders: State<'_, Recorders>,
    id: String,
) -> IpcResult<()> {
    let session = library.existing_session(&id)?;
    let sink = blocking(move || {
        let path = session.join(SOURCE_PART);
        let file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&path)
            .map_err(|error| write_error(error, &path))?;
        Ok(Sink {
            file,
            path,
            written: 0,
        })
    })
    .await?;
    lock(&recorders.0).insert(id, Arc::new(Mutex::new(sink)));
    Ok(())
}

/// Chunks must be awaited one at a time by the caller; each call appends in arrival order.
#[tauri::command]
pub async fn rec_write(recorders: State<'_, Recorders>, request: Request<'_>) -> IpcResult<u64> {
    let id = header(&request, "x-id")?;
    check_id(id)?;
    let sink = recorders.get(id)?;
    let bytes = raw_body(&request)?;
    blocking(move || {
        let mut sink = lock(&sink);
        sink.file.write_all(&bytes)?;
        sink.written += bytes.len() as u64;
        Ok(sink.written)
    })
    .await
}

#[tauri::command]
pub async fn rec_flush(recorders: State<'_, Recorders>, id: String) -> IpcResult<()> {
    let sink = recorders.get(&id)?;
    blocking(move || Ok(lock(&sink).file.sync_data()?)).await
}

#[tauri::command]
pub async fn rec_close(recorders: State<'_, Recorders>, id: String) -> IpcResult<u64> {
    let sink = recorders.get(&id)?;
    let size = blocking(move || {
        let sink = lock(&sink);
        sink.file.sync_all()?;
        Ok(sink.file.metadata()?.len())
    })
    .await?;
    recorders.take(&id);
    Ok(size)
}

#[tauri::command]
pub async fn rec_abort(recorders: State<'_, Recorders>, id: String) -> IpcResult<()> {
    let Some(sink) = recorders.take(&id) else {
        return Ok(());
    };
    blocking(move || {
        let path = lock(&sink).path.clone();
        drop(sink);
        match fs::remove_file(&path) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error.into()),
            _ => Ok(()),
        }
    })
    .await
}
