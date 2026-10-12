//! Whether the app may write to a folder and, when it may not, why. Controlled folder access
//! refuses writes from apps it does not know in the user's Documents, Pictures, Videos, Music,
//! Desktop and Favorites, and Windows reports that refusal as "file not found".

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::Serialize;
use tauri::path::PathResolver;
use tauri::Runtime;

use super::create_app_dir;
use super::paths::{is_within, APP_DIR};
use crate::error::{Code, IpcError, IpcResult};
use crate::platform;

const ERROR_PATH_NOT_FOUND: i32 = 3;
const CHECK_FILE: &str = "tmp-write-check";

#[derive(Debug, Clone)]
pub struct KnownFolder {
    pub name: String,
    pub path: PathBuf,
}

static PROTECTED: OnceLock<Vec<KnownFolder>> = OnceLock::new();

/// Looks the protected folders up rather than assuming them: OneDrive backup and a folder's
/// Location tab both move them.
pub fn init<R: Runtime>(paths: &PathResolver<R>) {
    let user = [
        ("Documents", paths.document_dir()),
        ("Pictures", paths.picture_dir()),
        ("Videos", paths.video_dir()),
        ("Music", paths.audio_dir()),
        ("Desktop", paths.desktop_dir()),
        (
            "Favorites",
            paths.home_dir().map(|home| home.join("Favorites")),
        ),
    ];
    let mut folders: Vec<KnownFolder> = user
        .into_iter()
        .filter_map(|(name, path)| {
            Some(KnownFolder {
                name: name.into(),
                path: path.ok()?,
            })
        })
        .collect();
    if let Ok(public) = paths.public_dir() {
        for name in ["Documents", "Pictures", "Videos", "Music", "Desktop"] {
            folders.push(KnownFolder {
                name: format!("Public {name}"),
                path: public.join(name),
            });
        }
    }
    let _ = PROTECTED.set(folders);
}

fn protected() -> &'static [KnownFolder] {
    PROTECTED.get().map_or(&[], Vec::as_slice)
}

fn find_folder<'a>(folders: &'a [KnownFolder], path: &Path) -> Option<&'a KnownFolder> {
    folders.iter().find(|folder| is_within(path, &folder.path))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Reason {
    Ok,
    Blocked,
    Denied,
    Missing,
    Other,
}

/// Why creating or writing something failed, given whether the folder it was created in
/// exists and whether that lies in a protected folder.
fn classify(error: &io::Error, parent_exists: bool, protected: bool) -> Reason {
    if !parent_exists {
        return Reason::Missing;
    }
    match error.kind() {
        // A folder on the way disappeared, which is not a refusal.
        io::ErrorKind::NotFound if error.raw_os_error() == Some(ERROR_PATH_NOT_FOUND) => {
            Reason::Other
        }
        // Creating something in a folder that exists cannot miss; a file-system filter refused it.
        io::ErrorKind::NotFound => Reason::Blocked,
        io::ErrorKind::PermissionDenied if protected => Reason::Blocked,
        io::ErrorKind::PermissionDenied => Reason::Denied,
        _ => Reason::Other,
    }
}

/// The existing folder that the first missing part of `path` is created in.
fn existing_parent(path: &Path) -> Option<&Path> {
    let first_missing = path
        .ancestors()
        .take_while(|ancestor| !ancestor.exists())
        .last()
        .unwrap_or(path);
    first_missing.parent().filter(|parent| parent.is_dir())
}

fn blocked_detail(folder: Option<&KnownFolder>, dir: &Path) -> String {
    match folder {
        Some(folder) => format!(
            "Windows Security is blocking Butterfly Record from saving to your {} folder (Controlled folder access).",
            folder.name
        ),
        None => format!(
            "Windows is blocking Butterfly Record from saving to {}. Controlled folder access or another security app may be protecting it.",
            dir.display()
        ),
    }
}

fn blocked_error(folder: Option<&KnownFolder>, dir: &Path) -> IpcError {
    let remedy = match folder {
        Some(folder) => format!(
            "Allow Butterfly Record in Windows Security, or use a folder outside {}.",
            folder.name
        ),
        None => "Allow Butterfly Record there, or use another folder.".to_string(),
    };
    IpcError::new(
        Code::Blocked,
        format!("{} {remedy}", blocked_detail(folder, dir)),
    )
}

/// `error` from creating or writing `path` (or a file in it): `blocked` when Windows refused a
/// write to a folder that exists, otherwise the usual mapping.
pub fn write_error(error: io::Error, path: &Path) -> IpcError {
    write_error_in(protected(), error, path)
}

fn write_error_in(folders: &[KnownFolder], error: io::Error, path: &Path) -> IpcError {
    let folder = find_folder(folders, path);
    match existing_parent(path) {
        Some(dir) if classify(&error, true, folder.is_some()) == Reason::Blocked => {
            blocked_error(folder, dir)
        }
        _ => error.into(),
    }
}

/// `write_error` for a move or rename: a source that has gone is missing, not refused.
pub fn move_error(error: io::Error, from: &Path, to: &Path) -> IpcError {
    if from.exists() {
        write_error(error, to)
    } else {
        error.into()
    }
}

/// Why the library folder cannot be used: a sentence for the probe result, and the error the
/// commands that switch folders reject with.
#[derive(Debug)]
pub struct Refusal {
    reason: Reason,
    detail: String,
    error: IpcError,
}

impl From<Refusal> for IpcError {
    fn from(refusal: Refusal) -> Self {
        refusal.error
    }
}

fn refusal(folders: &[KnownFolder], cause: io::Error, path: &Path, root: &Path) -> Refusal {
    let folder = find_folder(folders, path);
    let parent = existing_parent(path);
    let reason = classify(&cause, parent.is_some(), folder.is_some());
    let dir = parent.unwrap_or(root);
    let (detail, error) = match reason {
        Reason::Blocked => (blocked_detail(folder, dir), blocked_error(folder, dir)),
        Reason::Denied => {
            let detail = format!(
                "Windows does not allow Butterfly Record to save in {}.",
                dir.display()
            );
            let error = IpcError::forbidden(format!("{detail} Choose another folder."));
            (detail, error)
        }
        Reason::Missing => {
            let detail = format!(
                "{} is not available. Connect the drive it is on, or choose another folder.",
                root.display()
            );
            (detail.clone(), IpcError::not_found(detail))
        }
        Reason::Ok | Reason::Other => (
            format!(
                "Butterfly Record could not save in {}: {cause}",
                root.display()
            ),
            cause.into(),
        ),
    };
    Refusal {
        reason,
        detail,
        error,
    }
}

/// Creates `root` and its hidden app-data folder when missing, then writes and deletes a file
/// there: the first steps every recording and import takes.
pub fn probe(root: &Path) -> Result<(), Refusal> {
    probe_in(protected(), root)
}

fn probe_in(folders: &[KnownFolder], root: &Path) -> Result<(), Refusal> {
    let refused = |cause: io::Error, path: &Path| refusal(folders, cause, path, root);
    let app_dir = root.join(APP_DIR);
    create_app_dir(&app_dir).map_err(|cause| refused(cause, &app_dir))?;
    let check = app_dir.join(CHECK_FILE);
    OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&check)
        .and_then(|mut file| file.write_all(b"ok"))
        .and_then(|()| fs::remove_file(&check))
        .map_err(|cause| refused(cause, &check))
}

/// What `library_check_access` reports about the library folder.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Access {
    ok: bool,
    root: String,
    reason: Reason,
    detail: String,
    /// The folder lies in one that Controlled folder access protects by default.
    protected_folder: bool,
    folder_name: Option<String>,
    /// A library location outside the protected folders.
    home_root: Option<String>,
    /// This program, to allow it in Windows Security.
    exe_path: Option<String>,
}

impl Access {
    pub fn new(root: &Path, checked: Result<(), Refusal>, home_root: Option<PathBuf>) -> Self {
        let lossy = |path: &Path| path.to_string_lossy().into_owned();
        let folder = find_folder(protected(), root);
        let (reason, detail) = match checked {
            Ok(()) => (Reason::Ok, String::new()),
            Err(refusal) => (refusal.reason, refusal.detail),
        };
        Self {
            ok: reason == Reason::Ok,
            root: lossy(root),
            reason,
            detail,
            protected_folder: folder.is_some(),
            folder_name: folder.map(|folder| folder.name.clone()),
            home_root: home_root.as_deref().map(lossy),
            exe_path: std::env::current_exe().ok().as_deref().map(lossy),
        }
    }
}

#[tauri::command]
pub async fn open_windows_security() -> IpcResult<()> {
    platform::open_ransomware_protection()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("br-access-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn videos(path: &Path) -> Vec<KnownFolder> {
        vec![KnownFolder {
            name: "Videos".into(),
            path: path.to_path_buf(),
        }]
    }

    /// A drive letter with nothing mounted on it.
    fn missing_drive() -> Option<PathBuf> {
        ('D'..='Z')
            .rev()
            .map(|letter| PathBuf::from(format!(r"{letter}:\")))
            .find(|drive| !drive.exists())
    }

    #[test]
    fn classifies_refusals() {
        let not_found = io::Error::from_raw_os_error(2);
        let path_not_found = io::Error::from_raw_os_error(3);
        let denied = io::Error::from_raw_os_error(5);
        let disk_full = io::Error::from_raw_os_error(112);
        assert_eq!(classify(&not_found, true, true), Reason::Blocked);
        assert_eq!(classify(&not_found, true, false), Reason::Blocked);
        assert_eq!(classify(&denied, true, true), Reason::Blocked);
        assert_eq!(classify(&denied, true, false), Reason::Denied);
        assert_eq!(classify(&path_not_found, true, true), Reason::Other);
        assert_eq!(classify(&disk_full, true, true), Reason::Other);
        assert_eq!(classify(&not_found, false, true), Reason::Missing);
        assert_eq!(classify(&denied, false, false), Reason::Missing);
    }

    #[test]
    fn finds_the_folder_a_create_starts_in() {
        let base = scratch("parent");
        let deep = base.join(r"Butterfly Record\.butterfly\01J9Z8Q4X5M2N3P4R5S6T7V8W9");
        assert_eq!(existing_parent(&deep), Some(base.as_path()));
        assert_eq!(existing_parent(&base), base.parent());
        if let Some(drive) = missing_drive() {
            assert_eq!(
                existing_parent(&drive.join(r"Videos\Butterfly Record")),
                None
            );
        }
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn maps_refused_writes_to_blocked() {
        let base = scratch("map");
        let folders = videos(&base);
        let session = base.join(r"Butterfly Record\.butterfly\01J9Z8Q4X5M2N3P4R5S6T7V8W9");

        let blocked = write_error_in(&folders, io::Error::from_raw_os_error(2), &session);
        assert_eq!(blocked.code, Code::Blocked);
        assert!(blocked
            .message
            .contains("your Videos folder (Controlled folder access)"));

        let denied = write_error_in(&folders, io::Error::from_raw_os_error(5), &session);
        assert_eq!(denied.code, Code::Blocked);

        let elsewhere = write_error_in(&[], io::Error::from_raw_os_error(2), &session);
        assert_eq!(elsewhere.code, Code::Blocked);
        assert!(elsewhere.message.contains(&base.display().to_string()));
        let acl = write_error_in(&[], io::Error::from_raw_os_error(5), &session);
        assert_eq!(acl.code, Code::Forbidden);

        let vanished = write_error_in(&folders, io::Error::from_raw_os_error(3), &session);
        assert_eq!(vanished.code, Code::NotFound);
        let full = write_error_in(&folders, io::Error::from_raw_os_error(112), &session);
        assert_eq!(full.code, Code::DiskFull);

        let gone = base.join("tmp-1-1.partial");
        let moved = move_error(io::Error::from_raw_os_error(2), &gone, &base.join("a.webm"));
        assert_eq!(moved.code, Code::NotFound);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn probes_a_writable_folder() {
        let base = scratch("probe");
        let root = base.join("Butterfly Record");
        probe_in(&videos(&base), &root).unwrap();
        let app_dir = root.join(APP_DIR);
        assert!(app_dir.is_dir());
        assert_eq!(fs::read_dir(&app_dir).unwrap().count(), 0);
        probe_in(&[], &root).unwrap();
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn probes_a_missing_drive() {
        let Some(drive) = missing_drive() else {
            return;
        };
        let root = drive.join(r"Videos\Butterfly Record");
        let refused = probe_in(&[], &root).unwrap_err();
        assert_eq!(refused.reason, Reason::Missing);
        assert!(refused.detail.contains("is not available"));
        assert_eq!(IpcError::from(refused).code, Code::NotFound);
    }

    #[test]
    fn reports_access_for_the_interface() {
        let base = scratch("report");
        let refused = refusal(
            &videos(&base),
            io::Error::from_raw_os_error(2),
            &base.join("Butterfly Record"),
            &base.join("Butterfly Record"),
        );
        assert_eq!(refused.reason, Reason::Blocked);
        let access = Access::new(&base.join("Butterfly Record"), Err(refused), None);
        let json = serde_json::to_value(&access).unwrap();
        assert_eq!(json["ok"], false);
        assert_eq!(json["reason"], "blocked");
        assert_eq!(
            json["detail"],
            "Windows Security is blocking Butterfly Record from saving to your Videos folder (Controlled folder access)."
        );
        assert!(json["exePath"].is_string());
        assert!(json["homeRoot"].is_null());
        let ok = serde_json::to_value(Access::new(&base, Ok(()), Some(base.clone()))).unwrap();
        assert_eq!(ok["ok"], true);
        assert_eq!(ok["reason"], "ok");
        assert_eq!(ok["detail"], "");
        let _ = fs::remove_dir_all(&base);
    }

    /// Denies "create folders" on a real folder, as an access-control list would.
    #[cfg(windows)]
    #[test]
    fn probes_a_folder_the_acl_denies() {
        struct Deny(PathBuf);
        impl Drop for Deny {
            fn drop(&mut self) {
                let _ = std::process::Command::new("icacls")
                    .arg(&self.0)
                    .args(["/remove:d", "*S-1-1-0"])
                    .output();
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let guard = Deny(scratch("acl"));
        let denied = std::process::Command::new("icacls")
            .arg(&guard.0)
            .args(["/deny", "*S-1-1-0:(WD,AD)"])
            .output();
        if !denied.is_ok_and(|output| output.status.success()) {
            eprintln!("icacls unavailable; skipped");
            return;
        }
        let root = guard.0.join("Butterfly Record");
        let refused = probe_in(&[], &root).unwrap_err();
        assert_eq!(refused.reason, Reason::Denied);
        assert_eq!(IpcError::from(refused).code, Code::Forbidden);
        let refused = probe_in(&videos(&guard.0), &root).unwrap_err();
        assert_eq!(refused.reason, Reason::Blocked);
        assert_eq!(IpcError::from(refused).code, Code::Blocked);
        assert!(!root.exists());
    }
}
