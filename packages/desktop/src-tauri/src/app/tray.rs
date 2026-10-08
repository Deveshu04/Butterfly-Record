use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use super::{request_quit, show_main, toggle_recording, Phase};
use crate::library::Library;
use crate::platform;

pub const TRAY_ID: &str = "main";

/// Builds the tray and returns the record item so its label can follow the recorder.
pub fn build(app: &AppHandle) -> tauri::Result<MenuItem<Wry>> {
    let open = MenuItem::with_id(app, "open", "Open Butterfly Record", true, None::<&str>)?;
    let (label, enabled) = toggle_label(Phase::Idle);
    let toggle = MenuItem::with_id(app, "record-toggle", label, enabled, None::<&str>)?;
    let folder = MenuItem::with_id(
        app,
        "open-folder",
        "Open recordings folder",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &toggle,
            &folder,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip(tooltip(Phase::Idle))
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "record-toggle" => toggle_recording(app),
            "open-folder" => open_library_folder(app),
            "quit" => request_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(toggle)
}

pub fn toggle_label(phase: Phase) -> (&'static str, bool) {
    match phase {
        Phase::Idle => ("Start recording", true),
        Phase::Finalizing => ("Saving recording...", false),
        _ => ("Stop recording", true),
    }
}

pub fn tooltip(phase: Phase) -> &'static str {
    match phase {
        Phase::Idle => "Butterfly Record",
        Phase::Starting | Phase::Countdown => "Butterfly Record: starting",
        Phase::Recording => "Butterfly Record: recording",
        Phase::Paused => "Butterfly Record: paused",
        Phase::Finalizing => "Butterfly Record: saving",
    }
}

fn open_library_folder(app: &AppHandle) {
    let root = app.state::<Library>().root();
    tauri::async_runtime::spawn_blocking(move || {
        let opened = std::fs::create_dir_all(&root).and_then(|()| platform::open(&root));
        if let Err(error) = opened {
            log::warn!("could not open the library folder: {error}");
        }
    });
}
