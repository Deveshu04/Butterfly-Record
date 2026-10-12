//! Pictures chosen as the camera background. Each is copied into the app's config folder, so
//! it keeps working after the original is moved or deleted; only the latest copy is kept.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::ipc::Response;
use tauri::{AppHandle, State};

use crate::error::{blocking, Code, IpcError, IpcResult};
use crate::fsio::write_atomic;
use crate::library;

const PREFIX: &str = "background-";
const EXTENSIONS: [&str; 5] = ["jpg", "jpeg", "png", "webp", "bmp"];
/// Far beyond any photo; refuses files that would only be slow to copy and decode.
const MAX_BYTES: u64 = 40 * 1024 * 1024;

#[derive(Clone)]
pub struct Backgrounds {
    dir: PathBuf,
}

impl Backgrounds {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    /// Copies `source` in under a new name and removes the earlier copies.
    fn store(&self, source: &Path, stamp: u128) -> IpcResult<String> {
        let ext = picture_extension(source)
            .ok_or_else(|| IpcError::invalid("Choose a JPEG, PNG, WebP or BMP picture."))?;
        if fs::metadata(source)?.len() > MAX_BYTES {
            return Err(IpcError::new(
                Code::TooLarge,
                "That picture is too large. Choose one under 40 MB.",
            ));
        }
        let bytes = fs::read(source)?;
        fs::create_dir_all(&self.dir)?;
        let name = format!("{PREFIX}{stamp}.{ext}");
        write_atomic(&self.dir.join(&name), &bytes)?;
        self.prune(&name);
        Ok(name)
    }

    fn prune(&self, keep: &str) {
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if name != keep && is_background_name(name) {
                if let Err(error) = fs::remove_file(entry.path()) {
                    log::warn!("could not remove an old camera background: {error}");
                }
            }
        }
    }

    fn read(&self, name: &str) -> IpcResult<Vec<u8>> {
        if !is_background_name(name) {
            return Err(IpcError::invalid("Unknown background picture."));
        }
        fs::read(self.dir.join(name)).map_err(|error| match error.kind() {
            io::ErrorKind::NotFound => {
                IpcError::not_found("The background picture is missing. Choose it again.")
            }
            _ => error.into(),
        })
    }
}

fn picture_extension(path: &Path) -> Option<String> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    EXTENSIONS.contains(&ext.as_str()).then_some(ext)
}

/// Only names this module hands out are ever read, so no other file can be asked for.
fn is_background_name(name: &str) -> bool {
    let Some((stamp, ext)) = name
        .strip_prefix(PREFIX)
        .and_then(|rest| rest.split_once('.'))
    else {
        return false;
    };
    (1..=20).contains(&stamp.len())
        && stamp.bytes().all(|byte| byte.is_ascii_digit())
        && EXTENSIONS.contains(&ext)
}

#[tauri::command]
pub async fn camera_background_pick(
    app: AppHandle,
    backgrounds: State<'_, Backgrounds>,
) -> IpcResult<Option<String>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    library::dialog(&app)
        .set_title("Choose a background picture")
        .add_filter("Pictures", &EXTENSIONS)
        .pick_file(move |picked| {
            let _ = tx.send(picked);
        });
    let Some(picked) = rx.await.ok().flatten() else {
        return Ok(None);
    };
    let source = library::into_path(picked)?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis());
    let backgrounds = backgrounds.inner().clone();
    blocking(move || backgrounds.store(&source, stamp))
        .await
        .map(Some)
}

#[tauri::command]
pub async fn camera_background_read(
    backgrounds: State<'_, Backgrounds>,
    name: String,
) -> IpcResult<Response> {
    let backgrounds = backgrounds.inner().clone();
    let bytes = blocking(move || backgrounds.read(&name)).await?;
    Ok(Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("br-backgrounds-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn recognises_only_its_own_names() {
        for name in [
            "background-1.jpg",
            "background-1791817788575.webp",
            "background-7.bmp",
        ] {
            assert!(is_background_name(name), "{name}");
        }
        for name in [
            "background-.jpg",
            "background-12.gif",
            "background-12.JPG",
            "background-1a.png",
            "background-1.png.exe",
            "..\\background-1.png",
            "background-123456789012345678901.png",
            "settings.json",
        ] {
            assert!(!is_background_name(name), "{name}");
        }
    }

    #[test]
    fn copies_the_picture_and_keeps_only_the_latest() {
        let dir = scratch("store");
        let originals = dir.join("originals");
        fs::create_dir_all(&originals).unwrap();
        let first = originals.join("Holiday.JPG");
        let second = originals.join("office.png");
        fs::write(&first, b"first").unwrap();
        fs::write(&second, b"second").unwrap();
        fs::write(dir.join("unrelated.txt"), b"keep").unwrap();

        let backgrounds = Backgrounds::new(dir.join("backgrounds"));
        let one = backgrounds.store(&first, 1).unwrap();
        assert_eq!(one, "background-1.jpg");
        fs::remove_file(&first).unwrap();
        assert_eq!(backgrounds.read(&one).unwrap(), b"first");

        let two = backgrounds.store(&second, 2).unwrap();
        assert_eq!(backgrounds.read(&two).unwrap(), b"second");
        assert_eq!(backgrounds.read(&one).unwrap_err().code, Code::NotFound);
        assert!(dir.join("unrelated.txt").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_other_files() {
        let dir = scratch("refuse");
        let text = dir.join("notes.txt");
        fs::write(&text, b"text").unwrap();
        let backgrounds = Backgrounds::new(dir.join("backgrounds"));
        assert_eq!(
            backgrounds.store(&text, 1).unwrap_err().code,
            Code::InvalidArgument
        );
        assert_eq!(
            backgrounds.read("../notes.txt").unwrap_err().code,
            Code::InvalidArgument
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
