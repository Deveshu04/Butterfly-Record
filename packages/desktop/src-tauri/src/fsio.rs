//! Atomic writes, sidecar files and the random-access handles mediabunny reads and writes through.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::State;

use crate::error::{blocking, IpcError, IpcResult};
use crate::library::access::{move_error, write_error};
use crate::library::paths::{
    check_export_ext, check_name, is_openable_file, is_within, parse_user_path, path_key,
    relative_to, safe_base_name, SOURCE_PART,
};
use crate::library::{move_unique, Library};
use crate::lock;

const MAX_READ: u64 = 64 * 1024 * 1024;

static TMP_SEQ: AtomicU64 = AtomicU64::new(1);

const TMP_PREFIX: &str = "tmp-";
const TMP_SUFFIX: &str = ".partial";

/// Creates a fresh scratch file `tmp-<pid>-<n>.partial` in `dir`.
pub fn create_temp(dir: &Path) -> io::Result<(PathBuf, File)> {
    loop {
        let n = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let path = dir.join(format!(
            "{TMP_PREFIX}{}-{n}{TMP_SUFFIX}",
            std::process::id()
        ));
        match OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
}

/// A `create_temp` file left by another process, i.e. one that was killed mid-write. Only one
/// instance runs at a time, so no live writer can own it.
pub fn is_stale_temp(name: &str) -> bool {
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    name.strip_prefix(TMP_PREFIX)
        .and_then(|rest| rest.strip_suffix(TMP_SUFFIX))
        .and_then(|rest| rest.split_once('-'))
        .is_some_and(|(pid, n)| {
            digits(pid)
                && digits(n)
                && pid
                    .parse::<u32>()
                    .is_ok_and(|pid| pid != std::process::id())
        })
}

/// Write to a scratch file, sync, then rename over `path`.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
    let (tmp, mut file) = create_temp(dir)?;
    let written = file.write_all(bytes).and_then(|()| file.sync_all());
    drop(file);
    let result = written.and_then(|()| fs::rename(&tmp, path));
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

#[cfg(windows)]
fn read_some_at(file: &File, buf: &mut [u8], offset: u64) -> io::Result<usize> {
    std::os::windows::fs::FileExt::seek_read(file, buf, offset)
}

#[cfg(unix)]
fn read_some_at(file: &File, buf: &mut [u8], offset: u64) -> io::Result<usize> {
    std::os::unix::fs::FileExt::read_at(file, buf, offset)
}

#[cfg(windows)]
fn write_some_at(file: &File, buf: &[u8], offset: u64) -> io::Result<usize> {
    std::os::windows::fs::FileExt::seek_write(file, buf, offset)
}

#[cfg(unix)]
fn write_some_at(file: &File, buf: &[u8], offset: u64) -> io::Result<usize> {
    std::os::unix::fs::FileExt::write_at(file, buf, offset)
}

/// Reads up to `buf.len()` bytes at `offset`; shorter only at end of file.
pub fn read_at(file: &File, mut offset: u64, buf: &mut [u8]) -> io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        match read_some_at(file, &mut buf[filled..], offset) {
            Ok(0) => break,
            Ok(n) => {
                filled += n;
                offset += n as u64;
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Ok(filled)
}

pub fn write_all_at(file: &File, mut offset: u64, mut buf: &[u8]) -> io::Result<()> {
    while !buf.is_empty() {
        match write_some_at(file, buf, offset) {
            Ok(0) => return Err(io::Error::from(io::ErrorKind::WriteZero)),
            Ok(n) => {
                buf = &buf[n..];
                offset += n as u64;
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

pub fn header<'a>(request: &'a Request<'_>, name: &str) -> IpcResult<&'a str> {
    request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| IpcError::invalid(format!("Missing {name} header.")))
}

pub fn header_num<T: std::str::FromStr>(request: &Request<'_>, name: &str) -> IpcResult<T> {
    header(request, name)?
        .parse()
        .map_err(|_| IpcError::invalid(format!("Invalid {name} header.")))
}

/// The raw request body (binary invoke); copied so it can move to a blocking task.
pub fn raw_body(request: &Request<'_>) -> IpcResult<Vec<u8>> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes.clone()),
        InvokeBody::Json(_) => Err(IpcError::invalid("Expected a binary body.")),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ReadTarget {
    Part { id: String },
    Media { id: String },
    Sidecar { id: String, name: String },
    Path { path: String },
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum WriteTarget {
    Media {
        id: String,
        base_name: String,
        ext: String,
    },
    Output {
        id: String,
        base_name: String,
        ext: String,
    },
    Sidecar {
        id: String,
        name: String,
    },
    Path {
        path: String,
    },
}

pub fn resolve_read(library: &Library, target: &ReadTarget) -> IpcResult<PathBuf> {
    match target {
        ReadTarget::Part { id } => Ok(library.session_dir(id)?.join(SOURCE_PART)),
        ReadTarget::Media { id } => library.resolve_media(id),
        ReadTarget::Sidecar { id, name } => library.sidecar(id, name),
        ReadTarget::Path { path } => {
            let path = parse_user_path(path)?;
            if library.can_read(&path) {
                Ok(path)
            } else {
                Err(IpcError::forbidden(
                    "That file was not opened through the app.",
                ))
            }
        }
    }
}

enum Dest {
    /// A new file in the library root, uniquified at commit.
    Library {
        dir: PathBuf,
        base: String,
        ext: String,
    },
    Replace(PathBuf),
}

struct Writer {
    file: File,
    partial: PathBuf,
    dest: Dest,
    root: PathBuf,
}

#[derive(Default, Clone)]
pub struct Files(Arc<FilesInner>);

#[derive(Default)]
struct FilesInner {
    next: AtomicU32,
    readers: Mutex<HashMap<u32, Arc<File>>>,
    writers: Mutex<HashMap<u32, Arc<Writer>>>,
    /// New library files from `fs_commit`, by `path_key`; only these may be uncommitted.
    committed: Mutex<HashSet<String>>,
}

impl Files {
    fn next_handle(&self) -> u32 {
        self.0.next.fetch_add(1, Ordering::Relaxed) + 1
    }

    fn reader(&self, handle: u32) -> IpcResult<Arc<File>> {
        lock(&self.0.readers)
            .get(&handle)
            .cloned()
            .ok_or_else(|| IpcError::invalid("Unknown file handle."))
    }

    pub fn has_writers(&self) -> bool {
        !lock(&self.0.writers).is_empty()
    }

    fn writer(&self, handle: u32) -> IpcResult<Arc<Writer>> {
        lock(&self.0.writers)
            .get(&handle)
            .cloned()
            .ok_or_else(|| IpcError::invalid("Unknown file handle."))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    handle: u32,
    size: u64,
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Created {
    handle: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Committed {
    path: String,
    rel_path: Option<String>,
    bytes: u64,
}

#[tauri::command]
pub async fn fs_open(
    library: State<'_, Library>,
    files: State<'_, Files>,
    target: ReadTarget,
) -> IpcResult<Opened> {
    let library = library.inner().clone();
    let (path, file) = blocking(move || {
        let path = resolve_read(&library, &target)?;
        let file = File::open(&path)?;
        Ok((path, file))
    })
    .await?;
    let size = file.metadata()?.len();
    let handle = files.next_handle();
    lock(&files.0.readers).insert(handle, Arc::new(file));
    Ok(Opened {
        handle,
        size,
        path: path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub async fn fs_read(
    files: State<'_, Files>,
    handle: u32,
    offset: u64,
    length: u64,
) -> IpcResult<Response> {
    if length > MAX_READ {
        return Err(IpcError::invalid("Read length is too large."));
    }
    let file = files.reader(handle)?;
    let bytes = blocking(move || {
        let mut buf = vec![0; length as usize];
        let n = read_at(&file, offset, &mut buf)?;
        buf.truncate(n);
        Ok(buf)
    })
    .await?;
    Ok(Response::new(bytes))
}

#[tauri::command]
pub async fn fs_close(files: State<'_, Files>, handle: u32) -> IpcResult<()> {
    lock(&files.0.readers).remove(&handle);
    Ok(())
}

#[tauri::command]
pub async fn fs_create(
    library: State<'_, Library>,
    files: State<'_, Files>,
    target: WriteTarget,
) -> IpcResult<Created> {
    let library = library.inner().clone();
    let writer = blocking(move || create_writer(&library, target)).await?;
    let handle = files.next_handle();
    lock(&files.0.writers).insert(handle, Arc::new(writer));
    Ok(Created { handle })
}

fn create_writer(library: &Library, target: WriteTarget) -> IpcResult<Writer> {
    let root = library.root();
    match target {
        WriteTarget::Media { id, base_name, ext } | WriteTarget::Output { id, base_name, ext } => {
            let ext = check_export_ext(&ext)?;
            let session = library.existing_session(&id)?;
            let (partial, file) =
                create_temp(&session).map_err(|error| write_error(error, &session))?;
            Ok(Writer {
                file,
                partial,
                dest: Dest::Library {
                    dir: root.clone(),
                    base: safe_base_name(&base_name),
                    ext,
                },
                root,
            })
        }
        WriteTarget::Sidecar { id, name } => {
            check_name(&name)?;
            let session = library.existing_session(&id)?;
            let (partial, file) =
                create_temp(&session).map_err(|error| write_error(error, &session))?;
            Ok(Writer {
                file,
                partial,
                dest: Dest::Replace(session.join(name)),
                root,
            })
        }
        WriteTarget::Path { path } => {
            let path = parse_user_path(&path)?;
            if !library.can_write(&path) {
                return Err(IpcError::forbidden(
                    "Choose where to save in the save dialog first.",
                ));
            }
            if !is_openable_file(&path) {
                return Err(IpcError::forbidden(
                    "Only videos and captions can be saved.",
                ));
            }
            let mut partial = path.clone().into_os_string();
            partial.push(".partial");
            let partial = PathBuf::from(partial);
            let file = OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(true)
                .open(&partial)
                .map_err(|error| write_error(error, &partial))?;
            Ok(Writer {
                file,
                partial,
                dest: Dest::Replace(path),
                root,
            })
        }
    }
}

#[tauri::command]
pub async fn fs_write(files: State<'_, Files>, request: Request<'_>) -> IpcResult<()> {
    let handle: u32 = header_num(&request, "x-handle")?;
    let position: u64 = header_num(&request, "x-position")?;
    let bytes = raw_body(&request)?;
    let writer = files.writer(handle)?;
    blocking(move || Ok(write_all_at(&writer.file, position, &bytes)?)).await
}

#[tauri::command]
pub async fn fs_commit(files: State<'_, Files>, handle: u32) -> IpcResult<Committed> {
    let writer = lock(&files.0.writers)
        .remove(&handle)
        .ok_or_else(|| IpcError::invalid("Unknown file handle."))?;
    let writer = match Arc::try_unwrap(writer) {
        Ok(writer) => writer,
        Err(shared) => {
            lock(&files.0.writers).insert(handle, shared);
            return Err(IpcError::busy("A write to this file is still in progress."));
        }
    };
    let files = files.inner().clone();
    blocking(move || {
        let Writer {
            file,
            partial,
            dest,
            root,
        } = writer;
        let committed = (|| {
            file.sync_all()?;
            let bytes = file.metadata()?.len();
            drop(file);
            let path = match dest {
                Dest::Library { dir, base, ext } => {
                    let path = move_unique(&partial, &dir, &base, &ext)?;
                    lock(&files.0.committed).insert(path_key(&path));
                    path
                }
                Dest::Replace(path) => {
                    fs::rename(&partial, &path)
                        .map_err(|error| move_error(error, &partial, &path))?;
                    path
                }
            };
            Ok::<_, IpcError>(Committed {
                rel_path: relative_to(&path, &root),
                path: path.to_string_lossy().into_owned(),
                bytes,
            })
        })();
        if committed.is_err() {
            let _ = fs::remove_file(&partial);
        }
        committed
    })
    .await
}

/// Deletes a file this run committed into the library for item `id`, when the manifest update
/// that should reference it failed. A file the manifest does reference, or any other path, is
/// refused.
#[tauri::command]
pub async fn fs_uncommit(
    library: State<'_, Library>,
    files: State<'_, Files>,
    id: String,
    path: String,
) -> IpcResult<()> {
    let path = parse_user_path(&path)?;
    let key = path_key(&path);
    let refused = || IpcError::forbidden("Only a file the app has just saved can be removed.");
    if !is_within(&path, &library.root()) || !lock(&files.0.committed).contains(&key) {
        return Err(refused());
    }
    let library = library.inner().clone();
    blocking(move || {
        if library.references(&id, &path)? {
            return Err(refused());
        }
        match fs::remove_file(&path) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error.into()),
            _ => Ok(()),
        }
    })
    .await?;
    lock(&files.0.committed).remove(&key);
    Ok(())
}

#[tauri::command]
pub async fn fs_discard(files: State<'_, Files>, handle: u32) -> IpcResult<()> {
    let Some(writer) = lock(&files.0.writers).remove(&handle) else {
        return Ok(());
    };
    let partial = writer.partial.clone();
    drop(writer);
    blocking(move || match fs::remove_file(&partial) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error.into()),
        _ => Ok(()),
    })
    .await
}

#[tauri::command]
pub async fn sidecar_read_text(
    library: State<'_, Library>,
    id: String,
    name: String,
) -> IpcResult<Option<String>> {
    let path = library.sidecar(&id, &name)?;
    blocking(move || match fs::read(&path) {
        Ok(bytes) => String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| IpcError::invalid("The file is not UTF-8 text.")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    })
    .await
}

fn write_sidecar(library: &Library, id: &str, name: &str, bytes: &[u8]) -> IpcResult<()> {
    check_name(name)?;
    let path = library.existing_session(id)?.join(name);
    write_atomic(&path, bytes).map_err(|error| write_error(error, &path))
}

#[tauri::command]
pub async fn sidecar_write_text(
    library: State<'_, Library>,
    id: String,
    name: String,
    text: String,
) -> IpcResult<()> {
    let library = library.inner().clone();
    blocking(move || write_sidecar(&library, &id, &name, text.as_bytes())).await
}

#[tauri::command]
pub async fn sidecar_write_bytes(
    library: State<'_, Library>,
    request: Request<'_>,
) -> IpcResult<()> {
    let id = header(&request, "x-id")?.to_owned();
    let name = header(&request, "x-name")?.to_owned();
    let bytes = raw_body(&request)?;
    let library = library.inner().clone();
    blocking(move || write_sidecar(&library, &id, &name, &bytes)).await
}

#[tauri::command]
pub async fn sidecar_remove(
    library: State<'_, Library>,
    id: String,
    name: String,
) -> IpcResult<()> {
    let path = library.sidecar(&id, &name)?;
    blocking(move || match fs::remove_file(&path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error.into()),
        _ => Ok(()),
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("br-fsio-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn atomic_write_replaces_and_leaves_no_scratch() {
        let dir = scratch("atomic");
        let target = dir.join("manifest.json");
        write_atomic(&target, b"one").unwrap();
        write_atomic(&target, b"two").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"two");
        let names: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .collect();
        assert_eq!(names.len(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn positioned_io_round_trips() {
        let dir = scratch("positioned");
        let (path, file) = create_temp(&dir).unwrap();
        write_all_at(&file, 4, b"5678").unwrap();
        write_all_at(&file, 0, b"1234").unwrap();
        let mut buf = [0u8; 16];
        let n = read_at(&file, 2, &mut buf).unwrap();
        assert_eq!(&buf[..n], b"345678");
        drop(file);
        fs::remove_file(path).unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn recognises_stale_scratch_files() {
        let own = std::process::id();
        let other = own.wrapping_add(1);
        assert!(is_stale_temp(&format!("tmp-{other}-3.partial")));
        assert!(!is_stale_temp(&format!("tmp-{own}-3.partial")));
        for name in [
            "tmp-3.partial",
            "tmp-stt-1.webm",
            "tmp-dub-source.wav",
            "tmp-+5-1.partial",
            "tmp-5-.partial",
            "tmp-5-1.partial.json",
            "manifest.json",
        ] {
            assert!(!is_stale_temp(name), "{name}");
        }
        let dir = scratch("stale");
        let (path, file) = create_temp(&dir).unwrap();
        let name = path.file_name().unwrap().to_str().unwrap();
        assert!(!is_stale_temp(name));
        drop(file);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn targets_deserialize() {
        let target: WriteTarget = serde_json::from_str(
      r#"{ "kind": "media", "id": "01J9Z8Q4X5M2N3P4R5S6T7V8W9", "baseName": "Demo", "ext": "webm" }"#,
    )
    .unwrap();
        assert!(matches!(target, WriteTarget::Media { ref base_name, .. } if base_name == "Demo"));
        let read: ReadTarget =
            serde_json::from_str(r#"{ "kind": "sidecar", "id": "X", "name": "a.wav" }"#).unwrap();
        assert!(matches!(read, ReadTarget::Sidecar { ref name, .. } if name == "a.wav"));
    }
}
