pub mod access;
pub mod paths;

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::app::Shell;
use crate::error::{blocking, Code, IpcError, IpcResult};
use crate::fsio::Files;
use crate::recording::Recorders;
use crate::{fsio, lock, platform, settings};
use access::{move_error, write_error, Access};
use paths::{
    check_export_ext, check_id, check_name, extension_of, is_media_path, is_openable_file, is_ulid,
    is_within, parse_relative, parse_user_path, path_key, relative_to, safe_base_name, unique_name,
    APP_DIR, LIBRARY_FOLDER, MANIFEST, MEDIA_EXTENSIONS, SOURCE_PART,
};

pub const LIBRARY_DIR_ENV: &str = "BUTTERFLY_RECORD_LIBRARY_DIR";
const TEST_IMPORT_ENV: &str = "BUTTERFLY_RECORD_TEST_IMPORT";
const IMPORTS_FILE: &str = "imports.json";

/// The library root plus the in-memory allowlists for paths that came from dialogs.
#[derive(Clone)]
pub struct Library(Arc<Inner>);

struct Inner {
    root: RwLock<PathBuf>,
    default_root: PathBuf,
    config_file: PathBuf,
    /// Set by the env override; the root is then never persisted.
    pinned: bool,
    readable: Mutex<HashSet<String>>,
    writable: Mutex<HashSet<String>>,
    picked_folders: Mutex<HashSet<String>>,
    /// Files picked in the import dialog, by `path_key`. Kept outside the library folder so a
    /// manifest someone else drops into a shared folder cannot point the app at other files.
    imports: Mutex<BTreeMap<String, PathBuf>>,
}

#[derive(Serialize, Deserialize, Default)]
struct LibraryConfig {
    root: Option<PathBuf>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryInfo {
    root: String,
    default_root: String,
    free_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryItem {
    id: String,
    manifest: Option<Value>,
    media_path: Option<String>,
    media_bytes: Option<u64>,
    part_bytes: Option<u64>,
    sidecar: Vec<String>,
    session_dir: String,
}

impl Library {
    pub fn load(video_default: PathBuf, config_file: PathBuf) -> Self {
        let env_root = std::env::var_os(LIBRARY_DIR_ENV)
            .filter(|value| !value.is_empty())
            .and_then(|value| std::path::absolute(PathBuf::from(value)).ok());
        let (root, default_root, pinned) = match env_root {
            Some(root) => (root.clone(), root, true),
            None => {
                let saved = fs::read(&config_file)
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<LibraryConfig>(&bytes).ok())
                    .and_then(|config| config.root)
                    .filter(|root| root.is_absolute());
                (
                    saved.unwrap_or_else(|| video_default.clone()),
                    video_default,
                    false,
                )
            }
        };
        Self::new(root, default_root, config_file, pinned)
    }

    fn new(root: PathBuf, default_root: PathBuf, config_file: PathBuf, pinned: bool) -> Self {
        let imports = fs::read(config_file.with_file_name(IMPORTS_FILE))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Vec<PathBuf>>(&bytes).ok())
            .unwrap_or_default()
            .into_iter()
            .map(|path| (path_key(&path), path))
            .collect();
        Self(Arc::new(Inner {
            root: RwLock::new(root),
            default_root,
            config_file,
            pinned,
            readable: Mutex::default(),
            writable: Mutex::default(),
            picked_folders: Mutex::default(),
            imports: Mutex::new(imports),
        }))
    }

    pub fn root(&self) -> PathBuf {
        self.0
            .root
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn set_root(&self, root: PathBuf) {
        *self
            .0
            .root
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = root;
    }

    pub fn app_dir(&self) -> PathBuf {
        self.root().join(APP_DIR)
    }

    /// Creates the root and the hidden `.butterfly` folder when missing.
    pub fn ensure_app_dir(&self) -> IpcResult<PathBuf> {
        let app_dir = self.app_dir();
        create_app_dir(&app_dir).map_err(|error| write_error(error, &app_dir))?;
        Ok(app_dir)
    }

    /// The session folder path for `id` (not created).
    pub fn session_dir(&self, id: &str) -> IpcResult<PathBuf> {
        check_id(id)?;
        Ok(self.app_dir().join(id))
    }

    /// The session folder for `id`, which must already exist.
    pub fn existing_session(&self, id: &str) -> IpcResult<PathBuf> {
        let dir = self.session_dir(id)?;
        if dir.is_dir() {
            Ok(dir)
        } else {
            Err(IpcError::not_found("This library item no longer exists."))
        }
    }

    pub fn sidecar(&self, id: &str, name: &str) -> IpcResult<PathBuf> {
        check_name(name)?;
        Ok(self.session_dir(id)?.join(name))
    }

    pub fn read_manifest(&self, id: &str) -> IpcResult<Value> {
        let bytes = fs::read(self.session_dir(id)?.join(MANIFEST))?;
        Ok(serde_json::from_slice(&bytes)?)
    }

    /// Absolute media file of a library item, resolved from its manifest.
    pub fn resolve_media(&self, id: &str) -> IpcResult<PathBuf> {
        let manifest = self.read_manifest(id)?;
        self.media(&self.root(), &manifest)
            .map(|(path, _)| path)
            .ok_or_else(|| IpcError::not_found("This item has no media file yet."))
    }

    /// `media_of`, trusting only external paths the user imported.
    fn media(&self, root: &Path, manifest: &Value) -> Option<(PathBuf, bool)> {
        media_of(root, manifest, |path| {
            lock(&self.0.imports).contains_key(&path_key(path))
        })
    }

    /// Whether item `id`'s manifest points at `path`, as its media or one of its outputs.
    /// An unreadable manifest references nothing.
    pub fn references(&self, id: &str, path: &Path) -> IpcResult<bool> {
        check_id(id)?;
        let Ok(manifest) = self.read_manifest(id) else {
            return Ok(false);
        };
        let root = self.root();
        let key = path_key(path);
        let media = self
            .media(&root, &manifest)
            .is_some_and(|(media, _)| path_key(&media) == key);
        let output = manifest
            .get("outputs")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|output| output.get("path")?.as_str())
            .filter_map(|raw| match parse_relative(raw) {
                Some(relative) => Some(root.join(relative)),
                None => parse_user_path(raw).ok(),
            })
            .any(|output| path_key(&output) == key);
        Ok(media || output)
    }

    fn remember_imports(&self, paths: &[PathBuf]) -> IpcResult<()> {
        let mut imports = lock(&self.0.imports);
        let mut updated = imports.clone();
        for path in paths {
            updated.insert(path_key(path), path.clone());
        }
        if updated.len() == imports.len() {
            return Ok(());
        }
        let file = self.0.config_file.with_file_name(IMPORTS_FILE);
        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent)?;
        }
        let list: Vec<&PathBuf> = updated.values().collect();
        fsio::write_atomic(&file, &serde_json::to_vec_pretty(&list)?)?;
        *imports = updated;
        Ok(())
    }

    pub fn allow_read(&self, path: &Path) {
        lock(&self.0.readable).insert(path_key(path));
    }

    pub fn allow_write(&self, path: &Path) {
        lock(&self.0.writable).insert(path_key(path));
    }

    pub fn can_read(&self, path: &Path) -> bool {
        is_within(path, &self.root()) || lock(&self.0.readable).contains(&path_key(path))
    }

    pub fn can_write(&self, path: &Path) -> bool {
        lock(&self.0.writable).contains(&path_key(path))
    }

    fn info(&self) -> LibraryInfo {
        let root = self.root();
        LibraryInfo {
            free_bytes: platform::free_bytes(&root),
            root: root.to_string_lossy().into_owned(),
            default_root: self.0.default_root.to_string_lossy().into_owned(),
        }
    }

    fn persist_root(&self, root: &Path) -> IpcResult<()> {
        if self.0.pinned {
            return Ok(());
        }
        if let Some(parent) = self.0.config_file.parent() {
            fs::create_dir_all(parent)?;
        }
        let config = LibraryConfig {
            root: Some(root.to_path_buf()),
        };
        fsio::write_atomic(&self.0.config_file, &serde_json::to_vec_pretty(&config)?)?;
        Ok(())
    }
}

fn create_app_dir(app_dir: &Path) -> io::Result<()> {
    if !app_dir.is_dir() {
        fs::create_dir_all(app_dir)?;
        if let Err(error) = platform::set_hidden(app_dir) {
            log::warn!("could not hide the app data folder: {error}");
        }
    }
    Ok(())
}

/// `manifest.media` resolved to an absolute path, plus whether it is external.
fn media_of(
    root: &Path,
    manifest: &Value,
    imported: impl Fn(&Path) -> bool,
) -> Option<(PathBuf, bool)> {
    let media = manifest.get("media")?;
    let raw = media.get("path")?.as_str()?;
    let external = media
        .get("external")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if external {
        let path = parse_user_path(raw).ok()?;
        (is_media_path(&path) && imported(&path)).then_some((path, true))
    } else {
        Some((root.join(parse_relative(raw)?), false))
    }
}

pub fn allow_asset_dir(app: &AppHandle, dir: &Path) {
    if let Err(error) = app.asset_protocol_scope().allow_directory(dir, true) {
        log::warn!("asset scope: {error}");
    }
}

fn allow_asset_file(app: &AppHandle, file: &Path) {
    if let Err(error) = app.asset_protocol_scope().allow_file(file) {
        log::warn!("asset scope: {error}");
    }
}

fn file_len(path: &Path) -> Option<u64> {
    fs::metadata(path)
        .ok()
        .filter(|meta| meta.is_file())
        .map(|meta| meta.len())
}

/// File names in a session folder. Removes scratch files a killed earlier run left behind,
/// which can be as large as a whole recording.
fn sidecar_names(dir: &Path) -> Vec<String> {
    let Ok(files) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names = Vec::new();
    for file in files.flatten() {
        if !file.file_type().is_ok_and(|kind| kind.is_file()) {
            continue;
        }
        let Ok(name) = file.file_name().into_string() else {
            continue;
        };
        if fsio::is_stale_temp(&name) && fs::remove_file(file.path()).is_ok() {
            continue;
        }
        names.push(name);
    }
    names.sort();
    names
}

fn list_items(library: &Library, root: &Path) -> io::Result<Vec<(LibraryItem, Option<PathBuf>)>> {
    let entries = match fs::read_dir(root.join(APP_DIR)) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut items = Vec::new();
    for entry in entries.flatten() {
        let Ok(id) = entry.file_name().into_string() else {
            continue;
        };
        if !is_ulid(&id) || !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let dir = entry.path();
        let manifest = fs::read(dir.join(MANIFEST))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .filter(Value::is_object);
        let media = manifest.as_ref().and_then(|m| library.media(root, m));
        let (media_path, media_bytes, external) = match media {
            Some((path, external)) => match file_len(&path) {
                Some(len) => (Some(path), Some(len), external),
                None => (None, None, false),
            },
            None => (None, None, false),
        };
        let sidecar = sidecar_names(&dir);
        let external_path = media_path.clone().filter(|_| external);
        items.push((
            LibraryItem {
                manifest,
                media_path: media_path.map(|p| p.to_string_lossy().into_owned()),
                media_bytes,
                part_bytes: file_len(&dir.join(SOURCE_PART)),
                sidecar,
                session_dir: dir.to_string_lossy().into_owned(),
                id,
            },
            external_path,
        ));
    }
    items.sort_by(|a, b| b.0.id.cmp(&a.0.id));
    Ok(items)
}

#[tauri::command]
pub async fn library_info(library: State<'_, Library>) -> IpcResult<LibraryInfo> {
    let library = library.inner().clone();
    blocking(move || Ok(library.info())).await
}

fn ensure_idle(shell: &Shell, recorders: &Recorders, files: &Files) -> IpcResult<()> {
    // Open sessions resolve their files against the root; switching it would split them.
    if !shell.is_idle() || recorders.any_open() || files.has_writers() {
        return Err(IpcError::busy(
            "Finish the recording or the running task before changing the library folder.",
        ));
    }
    Ok(())
}

/// Makes `root` the library folder once a test write there succeeds, so a folder Windows
/// will not let the app write to is refused up front. `create` allows a folder not made yet.
async fn switch_root(
    app: &AppHandle,
    library: Library,
    root: PathBuf,
    create: bool,
) -> IpcResult<LibraryInfo> {
    let info = blocking({
        let root = root.clone();
        move || {
            if !create && !root.is_dir() {
                return Err(IpcError::not_found("That folder no longer exists."));
            }
            access::probe(&root)?;
            library.persist_root(&root)?;
            library.set_root(root);
            Ok(library.info())
        }
    })
    .await?;
    allow_asset_dir(app, &root);
    Ok(info)
}

fn home_root(app: &AppHandle) -> IpcResult<PathBuf> {
    Ok(app.path().home_dir()?.join(LIBRARY_FOLDER))
}

#[tauri::command]
pub async fn library_set_root(
    app: AppHandle,
    library: State<'_, Library>,
    shell: State<'_, Shell>,
    recorders: State<'_, Recorders>,
    files: State<'_, Files>,
    path: String,
) -> IpcResult<LibraryInfo> {
    ensure_idle(&shell, &recorders, &files)?;
    let root = parse_user_path(&path)?;
    if !lock(&library.0.picked_folders).contains(&path_key(&root)) {
        return Err(IpcError::forbidden(
            "Choose the folder in the folder picker first.",
        ));
    }
    switch_root(&app, library.inner().clone(), root, false).await
}

/// Moves the library to `%USERPROFILE%\Butterfly Record`, which Controlled folder access does
/// not protect by default.
#[tauri::command]
pub async fn library_use_home_root(
    app: AppHandle,
    library: State<'_, Library>,
    shell: State<'_, Shell>,
    recorders: State<'_, Recorders>,
    files: State<'_, Files>,
) -> IpcResult<LibraryInfo> {
    ensure_idle(&shell, &recorders, &files)?;
    let root = home_root(&app)?;
    switch_root(&app, library.inner().clone(), root, true).await
}

#[tauri::command]
pub async fn library_check_access(
    app: AppHandle,
    library: State<'_, Library>,
) -> IpcResult<Access> {
    let root = library.root();
    let checked = blocking({
        let root = root.clone();
        move || Ok(access::probe(&root))
    })
    .await?;
    if checked.is_ok() {
        allow_asset_dir(&app, &root);
    }
    Ok(Access::new(&root, checked, home_root(&app).ok()))
}

#[tauri::command]
pub async fn library_list(
    app: AppHandle,
    library: State<'_, Library>,
) -> IpcResult<Vec<LibraryItem>> {
    let library = library.inner().clone();
    let root = library.root();
    let items = blocking({
        let library = library.clone();
        let root = root.clone();
        move || Ok(list_items(&library, &root)?)
    })
    .await?;
    if root.is_dir() {
        allow_asset_dir(&app, &root);
    }
    Ok(items
        .into_iter()
        .map(|(item, external)| {
            if let Some(path) = external {
                library.allow_read(&path);
                allow_asset_file(&app, &path);
            }
            item
        })
        .collect())
}

#[tauri::command]
pub async fn session_create(library: State<'_, Library>, id: String) -> IpcResult<String> {
    let library = library.inner().clone();
    blocking(move || {
        let dir = library.session_dir(&id)?;
        library.ensure_app_dir()?;
        fs::create_dir_all(&dir).map_err(|error| write_error(error, &dir))?;
        Ok(dir.to_string_lossy().into_owned())
    })
    .await
}

#[tauri::command]
pub async fn library_trash(
    library: State<'_, Library>,
    recorders: State<'_, Recorders>,
    id: String,
) -> IpcResult<()> {
    check_id(&id)?;
    if recorders.is_open(&id) {
        return Err(IpcError::busy("This recording is still in progress."));
    }
    let library = library.inner().clone();
    blocking(move || {
        let dir = library.session_dir(&id)?;
        let media = library
            .read_manifest(&id)
            .ok()
            .and_then(|manifest| library.media(&library.root(), &manifest))
            .and_then(|(media, external)| (!external && media.is_file()).then_some(media));
        // The video goes first and alone: trashing the folder while the video stays behind
        // (open in a player, say) would leave a file the library no longer knows about.
        if let Some(media) = media {
            platform::ensure_deletable(&media)?;
            trash::delete(&media).map_err(|error| {
                trash_error(error, "Could not move the video to the Recycle Bin.")
            })?;
        }
        if dir.is_dir() {
            trash::delete(&dir).map_err(|error| {
                trash_error(
                    error,
                    "Could not move the recording's data to the Recycle Bin.",
                )
            })?;
        }
        Ok(())
    })
    .await
}

/// Deletes the folder of a take that never became a video (cancelled or empty), which would
/// otherwise sit in the Recycle Bin under an opaque id.
#[tauri::command]
pub async fn session_discard(
    library: State<'_, Library>,
    recorders: State<'_, Recorders>,
    id: String,
) -> IpcResult<()> {
    check_id(&id)?;
    if recorders.is_open(&id) {
        return Err(IpcError::busy("This recording is still in progress."));
    }
    let library = library.inner().clone();
    blocking(move || discard_session(&library, &id)).await
}

fn discard_session(library: &Library, id: &str) -> IpcResult<()> {
    let dir = library.session_dir(id)?;
    match fs::read(dir.join(MANIFEST)) {
        Ok(bytes) => {
            let manifest: Value = serde_json::from_slice(&bytes)
                .map_err(|_| IpcError::invalid("This item's details could not be read."))?;
            if manifest.get("media").is_some_and(|media| !media.is_null()) {
                return Err(IpcError::invalid(
                    "This recording was saved. Delete it from the library instead.",
                ));
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    match fs::remove_dir_all(&dir) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error.into()),
        _ => Ok(()),
    }
}

fn trash_error(error: trash::Error, message: &str) -> IpcError {
    log::warn!("trash: {error}");
    IpcError::new(Code::Io, message)
}

#[tauri::command]
pub async fn media_rename(
    library: State<'_, Library>,
    id: String,
    base_name: String,
) -> IpcResult<String> {
    let library = library.inner().clone();
    blocking(move || rename_media(&library, &id, &base_name)).await
}

fn rename_media(library: &Library, id: &str, base_name: &str) -> IpcResult<String> {
    let root = library.root();
    let manifest_path = library.existing_session(id)?.join(MANIFEST);
    let mut manifest: Value = serde_json::from_slice(&fs::read(&manifest_path)?)?;
    let (current, external) = library
        .media(&root, &manifest)
        .ok_or_else(|| IpcError::not_found("This item has no media file yet."))?;
    if external {
        return Err(IpcError::invalid("Imported files keep their own name."));
    }
    if !current.is_file() {
        return Err(IpcError::not_found("The video file is missing."));
    }
    let dir = current
        .parent()
        .ok_or_else(|| IpcError::invalid("Invalid media path."))?
        .to_path_buf();
    let ext = extension_of(&current).unwrap_or_else(|| "webm".into());
    let base = safe_base_name(base_name);
    let wanted = format!("{base}.{ext}");
    let current_name = current
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();

    let renamed = if current_name == wanted {
        current.clone()
    } else if current_name.eq_ignore_ascii_case(&wanted) {
        let target = dir.join(&wanted);
        fs::rename(&current, &target).map_err(|error| move_error(error, &current, &target))?;
        target
    } else {
        move_unique(&current, &dir, &base, &ext)?
    };

    let rel = relative_to(&renamed, &root)
        .ok_or_else(|| IpcError::invalid("The media file is outside the library folder."))?;
    if renamed != current {
        manifest["media"]["path"] = Value::String(rel.clone());
        let written = serde_json::to_vec_pretty(&manifest)
            .map_err(IpcError::from)
            .and_then(|bytes| {
                fsio::write_atomic(&manifest_path, &bytes)
                    .map_err(|error| write_error(error, &manifest_path))
            });
        if let Err(error) = written {
            let _ = fs::rename(&renamed, &current);
            return Err(error);
        }
    }
    Ok(rel)
}

/// Moves `from` into `dir` as "base.ext", "base (2).ext", ... never replacing a file.
pub fn move_unique(from: &Path, dir: &Path, base: &str, ext: &str) -> IpcResult<PathBuf> {
    let mut start = 1;
    loop {
        let (name, n) = unique_name(base, ext, start, |name| dir.join(name).exists());
        let target = dir.join(name);
        match platform::move_no_replace(from, &target) {
            Ok(()) => return Ok(target),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => start = n + 1,
            Err(error) => return Err(move_error(error, from, &target)),
        }
    }
}

fn checked_existing(library: &Library, path: &str) -> IpcResult<PathBuf> {
    let path = parse_user_path(path)?;
    if !library.can_read(&path) {
        return Err(IpcError::forbidden("That location is outside the library."));
    }
    if !path.exists() {
        return Err(IpcError::not_found("The file no longer exists."));
    }
    Ok(path)
}

#[tauri::command]
pub async fn reveal_path(library: State<'_, Library>, path: String) -> IpcResult<()> {
    let path = checked_existing(&library, &path)?;
    platform::reveal(&path)?;
    Ok(())
}

#[tauri::command]
pub async fn open_path(library: State<'_, Library>, path: String) -> IpcResult<()> {
    let path = checked_existing(&library, &path)?;
    if !path.is_dir() && !is_openable_file(&path) {
        return Err(IpcError::forbidden(
            "Only folders, videos and captions can be opened.",
        ));
    }
    platform::open(&path)?;
    Ok(())
}

pub fn dialog(app: &AppHandle) -> tauri_plugin_dialog::FileDialogBuilder<tauri::Wry> {
    let builder = app.dialog().file();
    match app.get_webview_window("main") {
        Some(main) => builder.set_parent(&main),
        None => builder,
    }
}

pub fn into_path(path: tauri_plugin_dialog::FilePath) -> IpcResult<PathBuf> {
    path.into_path()
        .map_err(|error| IpcError::new(Code::Io, error.to_string()))
}

#[tauri::command]
pub async fn pick_folder(app: AppHandle, library: State<'_, Library>) -> IpcResult<Option<String>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut builder = dialog(&app).set_title("Choose a folder for recordings");
    let root = library.root();
    if root.is_dir() {
        builder = builder.set_directory(root);
    }
    builder.pick_folder(move |picked| {
        let _ = tx.send(picked);
    });
    let Some(picked) = rx.await.ok().flatten() else {
        return Ok(None);
    };
    let path = into_path(picked)?;
    lock(&library.0.picked_folders).insert(path_key(&path));
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Automated tests cannot drive the native file dialog; this lists the "picked" files instead.
/// Honoured only with a test config dir, so a real install's import list is never touched.
fn test_import_paths() -> Option<IpcResult<Vec<PathBuf>>> {
    settings::config_dir_override()?;
    let raw = std::env::var(TEST_IMPORT_ENV)
        .ok()
        .filter(|raw| !raw.is_empty())?;
    Some(raw.split(';').map(parse_user_path).collect())
}

#[tauri::command]
pub async fn pick_import_files(
    app: AppHandle,
    library: State<'_, Library>,
) -> IpcResult<Vec<String>> {
    let picked = match test_import_paths() {
        Some(paths) => paths?,
        None => {
            let (tx, rx) = tokio::sync::oneshot::channel();
            dialog(&app)
                .set_title("Import video or audio")
                .add_filter("Video and audio", MEDIA_EXTENSIONS)
                .pick_files(move |picked| {
                    let _ = tx.send(picked);
                });
            rx.await
                .ok()
                .flatten()
                .unwrap_or_default()
                .into_iter()
                .map(into_path)
                .collect::<IpcResult<Vec<_>>>()?
        }
    };
    let accepted: Vec<PathBuf> = picked
        .into_iter()
        .filter(|path| is_media_path(path))
        .map(|path| std::path::absolute(&path).unwrap_or(path))
        .collect();
    if !accepted.is_empty() {
        let library = library.inner().clone();
        let accepted = accepted.clone();
        blocking(move || library.remember_imports(&accepted)).await?;
    }
    Ok(accepted
        .into_iter()
        .map(|path| {
            library.allow_read(&path);
            allow_asset_file(&app, &path);
            path.to_string_lossy().into_owned()
        })
        .collect())
}

#[tauri::command]
pub async fn pick_save_path(
    app: AppHandle,
    library: State<'_, Library>,
    default_name: String,
    extensions: Vec<String>,
) -> IpcResult<Option<String>> {
    if extensions.is_empty() || extensions.len() > 10 {
        return Err(IpcError::invalid("Invalid file types."));
    }
    let extensions = extensions
        .iter()
        .map(|ext| check_export_ext(ext))
        .collect::<IpcResult<Vec<_>>>()?;
    let label = extensions
        .iter()
        .map(|ext| ext.to_uppercase())
        .collect::<Vec<_>>()
        .join(", ");
    let ext_refs: Vec<&str> = extensions.iter().map(String::as_str).collect();
    let (tx, rx) = tokio::sync::oneshot::channel();
    dialog(&app)
        .set_title("Save as")
        .set_file_name(safe_base_name(&default_name))
        .add_filter(label, &ext_refs)
        .save_file(move |picked| {
            let _ = tx.send(picked);
        });
    let Some(picked) = rx.await.ok().flatten() else {
        return Ok(None);
    };
    let mut path = into_path(picked)?;
    let has_allowed_ext = extension_of(&path).is_some_and(|ext| extensions.contains(&ext));
    if !has_allowed_ext {
        let mut name = path.file_name().unwrap_or_default().to_os_string();
        name.push(format!(".{}", extensions[0]));
        path.set_file_name(name);
    }
    library.allow_write(&path);
    library.allow_read(&path);
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("br-lib-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn resolves_media_from_manifest() {
        let root = Path::new(r"C:\Videos\Butterfly Record");
        let all = |_: &Path| true;
        let internal = json!({ "media": { "path": "Demo.webm", "external": false } });
        assert_eq!(
            media_of(root, &internal, all),
            Some((root.join("Demo.webm"), false))
        );
        let external = json!({ "media": { "path": r"D:\Clips\talk.mp4", "external": true } });
        assert_eq!(
            media_of(root, &external, all),
            Some((PathBuf::from(r"D:\Clips\talk.mp4"), true))
        );
        assert_eq!(media_of(root, &external, |_| false), None);
        let escape = json!({ "media": { "path": r"..\..\secret.webm", "external": false } });
        assert_eq!(media_of(root, &escape, all), None);
        let not_media = json!({ "media": { "path": r"C:\Windows\win.ini", "external": true } });
        assert_eq!(media_of(root, &not_media, all), None);
        assert_eq!(media_of(root, &json!({ "media": null }), all), None);
    }

    #[test]
    fn trusts_only_imported_external_media() {
        let config = scratch("imports");
        let root = config.join("library");
        let library = Library::new(
            root.clone(),
            root.clone(),
            config.join("library.json"),
            true,
        );
        let picked = [PathBuf::from(r"D:\Clips\talk.mp4")];
        let planted = json!({ "media": { "path": r"\\host\share\a.mp4", "external": true } });
        let imported = json!({ "media": { "path": r"d:\clips\TALK.mp4", "external": true } });
        assert_eq!(library.media(&root, &planted), None);
        assert_eq!(library.media(&root, &imported), None);

        library.remember_imports(&picked).unwrap();
        assert_eq!(
            library.media(&root, &imported),
            Some((PathBuf::from(r"d:\clips\TALK.mp4"), true))
        );
        assert_eq!(library.media(&root, &planted), None);

        let reloaded = Library::new(
            root.clone(),
            root.clone(),
            config.join("library.json"),
            true,
        );
        assert!(reloaded.media(&root, &imported).is_some());
        assert_eq!(reloaded.media(&root, &planted), None);
        let _ = fs::remove_dir_all(&config);
    }

    #[test]
    fn lists_and_renames_items() {
        let root = std::env::temp_dir().join(format!("br-lib-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let library = Library::new(root.clone(), root.clone(), root.join("library.json"), true);
        let older = "01J9Z8Q4X5M2N3P4R5S6T7V8W0";
        let newer = "01J9Z8Q4X5M2N3P4R5S6T7V8W9";
        for id in [older, newer] {
            library.ensure_app_dir().unwrap();
            fs::create_dir_all(library.session_dir(id).unwrap()).unwrap();
        }
        fs::write(root.join("Demo.webm"), b"webm").unwrap();
        fs::write(root.join("Talk.webm"), b"taken").unwrap();
        let manifest = json!({ "id": newer, "media": { "path": "Demo.webm", "external": false } });
        fs::write(
            library.sidecar(newer, MANIFEST).unwrap(),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        fs::write(library.sidecar(older, SOURCE_PART).unwrap(), b"part").unwrap();
        let stale = format!("tmp-{}-7.partial", std::process::id().wrapping_add(1));
        let live = format!("tmp-{}-7.partial", std::process::id());
        fs::write(library.sidecar(older, &stale).unwrap(), b"x").unwrap();
        fs::write(library.sidecar(older, &live).unwrap(), b"x").unwrap();

        let items = list_items(&library, &root).unwrap();
        let ids: Vec<&str> = items.iter().map(|(item, _)| item.id.as_str()).collect();
        assert_eq!(ids, [newer, older]);
        assert_eq!(items[0].0.media_bytes, Some(4));
        assert_eq!(items[0].0.sidecar, vec![MANIFEST.to_string()]);
        assert_eq!(items[1].0.part_bytes, Some(4));
        assert!(items[1].0.manifest.is_none());
        assert_eq!(
            items[1].0.sidecar,
            vec![SOURCE_PART.to_string(), live.clone()]
        );
        assert!(!library.sidecar(older, &stale).unwrap().exists());
        assert!(library.sidecar(older, &live).unwrap().exists());

        let rel = rename_media(&library, newer, "Talk").unwrap();
        assert_eq!(rel, "Talk (2).webm");
        assert!(root.join("Talk (2).webm").is_file());
        assert!(!root.join("Demo.webm").exists());
        let saved = library.read_manifest(newer).unwrap();
        assert_eq!(saved["media"]["path"], "Talk (2).webm");
        assert_eq!(saved["id"], newer);

        let same = rename_media(&library, newer, "talk (2)").unwrap();
        assert_eq!(same, "talk (2).webm");
        assert!(root.join("talk (2).webm").is_file());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn discards_only_unsaved_sessions() {
        let root = scratch("discard");
        let library = Library::new(root.clone(), root.clone(), root.join("library.json"), true);
        library.ensure_app_dir().unwrap();
        let empty = "01J9Z8Q4X5M2N3P4R5S6T7V8W1";
        let unsaved = "01J9Z8Q4X5M2N3P4R5S6T7V8W2";
        let saved = "01J9Z8Q4X5M2N3P4R5S6T7V8W3";
        for id in [empty, unsaved, saved] {
            fs::create_dir_all(library.session_dir(id).unwrap()).unwrap();
        }
        let write = |id: &str, manifest: Value| {
            fs::write(
                library.sidecar(id, MANIFEST).unwrap(),
                serde_json::to_vec(&manifest).unwrap(),
            )
            .unwrap();
        };
        write(unsaved, json!({ "id": unsaved, "media": null }));
        fs::write(library.sidecar(unsaved, SOURCE_PART).unwrap(), b"part").unwrap();
        write(
            saved,
            json!({ "id": saved, "media": { "path": "Demo.webm", "external": false } }),
        );

        discard_session(&library, empty).unwrap();
        discard_session(&library, unsaved).unwrap();
        assert!(!library.session_dir(empty).unwrap().exists());
        assert!(!library.session_dir(unsaved).unwrap().exists());
        assert!(discard_session(&library, saved).is_err());
        assert!(library.sidecar(saved, MANIFEST).unwrap().is_file());
        assert!(library.references(saved, &root.join("demo.WEBM")).unwrap());
        assert!(!library
            .references(saved, &root.join("Demo (2).webm"))
            .unwrap());
        assert!(!library
            .references(unsaved, &root.join("Demo.webm"))
            .unwrap());
        discard_session(&library, empty).unwrap();
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn allowlist_checks() {
        let root = PathBuf::from(r"C:\Videos\Butterfly Record");
        let library = Library::new(root.clone(), root.clone(), root.join("library.json"), true);
        assert!(library.can_read(&root.join(r".butterfly\X\poster.jpg")));
        let outside = PathBuf::from(r"D:\Clips\talk.mp4");
        assert!(!library.can_read(&outside));
        library.allow_read(&outside);
        assert!(library.can_read(Path::new(r"d:\clips\TALK.mp4")));
        assert!(!library.can_write(&outside));
        library.allow_write(Path::new(r"D:\Out\a.srt"));
        assert!(library.can_write(Path::new(r"D:\out\A.SRT")));
    }
}
