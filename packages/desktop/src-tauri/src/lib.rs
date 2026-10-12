mod app;
mod error;
mod fsio;
mod keystore;
mod library;
mod platform;
mod recording;
mod sarvam;
mod settings;

use std::sync::{Mutex, MutexGuard, PoisonError};

use tauri::{Manager, Wry};
use tauri_plugin_log::RotationStrategy;

use app::Shell;
use fsio::Files;
use library::paths::LIBRARY_FOLDER;
use library::Library;
use recording::Recorders;
use sarvam::Sarvam;
use settings::Settings;

/// Locks a mutex, recovering the data if a panicking thread poisoned it.
pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn logger() -> tauri::plugin::TauriPlugin<Wry> {
    let level = if cfg!(debug_assertions) {
        log::LevelFilter::Debug
    } else {
        log::LevelFilter::Info
    };
    // HTTP internals log headers at trace level; keep them quiet so nothing sensitive is written.
    tauri_plugin_log::Builder::new()
        .level(level)
        .level_for("hyper", log::LevelFilter::Warn)
        .level_for("hyper_util", log::LevelFilter::Warn)
        .level_for("reqwest", log::LevelFilter::Warn)
        .level_for("native_tls", log::LevelFilter::Warn)
        .level_for("tao", log::LevelFilter::Warn)
        .level_for("wry", log::LevelFilter::Warn)
        .max_file_size(1_000_000)
        .rotation_strategy(RotationStrategy::KeepSome(3))
        .build()
}

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    let paths = app.path();
    let config_dir = match settings::config_dir_override() {
        Some(dir) => dir,
        None => paths.app_config_dir()?,
    };
    let videos = paths
        .video_dir()
        .or_else(|_| paths.home_dir().map(|home| home.join("Videos")))?;
    library::access::init(paths);

    let library = Library::load(videos.join(LIBRARY_FOLDER), config_dir.join("library.json"));
    let root = library.root();
    if root.is_dir() {
        library::allow_asset_dir(&handle, &root);
    }
    let settings = Settings::new(config_dir.join("settings.json"));
    let stored = settings.read();
    let theme = settings::theme(&stored);

    app.manage(Shell::new(settings::close_to_tray(&stored), theme));
    app.manage(library);
    app.manage(settings);
    app.manage(Files::default());
    app.manage(Recorders::default());
    app.manage(Sarvam::new()?);

    app::create_main(&handle, theme)?;
    let record_item = app::tray::build(&handle)?;
    app.state::<Shell>().set_record_item(record_item);
    app::register_shortcut(&handle);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let built = tauri::Builder::default()
        // Must be first: a second launch focuses this instance before anything else initializes.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            app::show_main(app)
        }))
        .plugin(logger())
        .plugin(tauri_plugin_dialog::init())
        .plugin(app::shortcut_plugin())
        .invoke_handler(tauri::generate_handler![
            library::library_info,
            library::library_set_root,
            library::library_use_home_root,
            library::library_check_access,
            library::access::open_windows_security,
            library::library_list,
            library::session_create,
            library::library_trash,
            library::session_discard,
            library::media_rename,
            library::reveal_path,
            library::open_path,
            library::pick_folder,
            library::pick_import_files,
            library::pick_save_path,
            fsio::sidecar_read_text,
            fsio::sidecar_write_text,
            fsio::sidecar_write_bytes,
            fsio::sidecar_remove,
            fsio::fs_open,
            fsio::fs_read,
            fsio::fs_close,
            fsio::fs_create,
            fsio::fs_write,
            fsio::fs_commit,
            fsio::fs_discard,
            fsio::fs_uncommit,
            recording::rec_open,
            recording::rec_write,
            recording::rec_flush,
            recording::rec_close,
            recording::rec_abort,
            settings::settings_get,
            settings::settings_set,
            app::recorder_set_state,
            app::hud_open,
            app::hud_close,
            app::camera::camera_open,
            app::camera::camera_close,
            app::camera::camera_set_visible,
            app::camera::camera_set_size,
            app::camera::camera_set_protected,
            app::camera::camera_reset_position,
            app::camera::camera_anchor,
            app::app_quit,
            keystore::sarvam_key_status,
            keystore::sarvam_key_set,
            keystore::sarvam_key_clear,
            sarvam::sarvam_key_test,
            sarvam::sarvam_transcribe,
            sarvam::sarvam_translate,
            sarvam::sarvam_tts,
            sarvam::sarvam_dub,
            sarvam::sarvam_summarize,
            sarvam::sarvam_cancel,
            sarvam::sarvam_pending_jobs,
        ])
        .setup(setup)
        .on_window_event(app::on_window_event)
        .build(tauri::generate_context!());

    match built {
        Ok(app) => app.run(app::on_run_event),
        Err(error) => {
            log::error!("startup failed: {error}");
            platform::fatal_dialog(&format!("Butterfly Record could not start.\n\n{error}"));
            std::process::exit(1);
        }
    }
}
