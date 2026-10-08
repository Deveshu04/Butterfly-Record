//! Windows, tray, global shortcut and the quit guard.

pub mod tray;
pub mod webview;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::menu::MenuItem;
use tauri::plugin::TauriPlugin;
use tauri::window::Color;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, RunEvent, State, Theme, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, Window, WindowEvent, Wry,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_global_shortcut::{
    Code as Key, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
};

use crate::error::{IpcError, IpcResult};
use crate::lock;

pub const MAIN: &str = "main";
pub const HUD: &str = "hud";

const RECORD_TOGGLE_EVENT: &str = "record-toggle";
const QUIT_REQUESTED_EVENT: &str = "quit-requested";

const HUD_WIDTH: f64 = 340.0;
const HUD_HEIGHT: f64 = 56.0;
const HUD_BOTTOM_GAP: f64 = 48.0;

const LIGHT_BACKGROUND: Color = Color(0xfa, 0xfa, 0xfa, 0xff);
const DARK_BACKGROUND: Color = Color(0x16, 0x16, 0x16, 0xff);
const HUD_BACKGROUND: Color = Color(0x14, 0x14, 0x14, 0xff);

/// If the frontend has not answered a quit request in this long, a second Quit exits anyway
/// (after asking, while a recording is still being saved).
const QUIT_ANSWER_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Idle,
    Starting,
    Countdown,
    Recording,
    Paused,
    Finalizing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThemePref {
    System,
    Light,
    Dark,
}

impl ThemePref {
    fn window_theme(self) -> Option<Theme> {
        match self {
            ThemePref::System => None,
            ThemePref::Light => Some(Theme::Light),
            ThemePref::Dark => Some(Theme::Dark),
        }
    }
}

pub struct Shell {
    phase: Mutex<Phase>,
    quitting: AtomicBool,
    quit_requested_at: Mutex<Option<Instant>>,
    quit_confirm_open: AtomicBool,
    close_to_tray: AtomicBool,
    theme: Mutex<ThemePref>,
    record_item: Mutex<Option<MenuItem<Wry>>>,
}

impl Shell {
    pub fn new(close_to_tray: bool, theme: ThemePref) -> Self {
        Self {
            phase: Mutex::new(Phase::Idle),
            quitting: AtomicBool::new(false),
            quit_requested_at: Mutex::new(None),
            quit_confirm_open: AtomicBool::new(false),
            close_to_tray: AtomicBool::new(close_to_tray),
            theme: Mutex::new(theme),
            record_item: Mutex::new(None),
        }
    }

    pub fn set_record_item(&self, item: MenuItem<Wry>) {
        *lock(&self.record_item) = Some(item);
    }

    pub(crate) fn is_idle(&self) -> bool {
        *lock(&self.phase) == Phase::Idle
    }
}

pub fn create_main(app: &AppHandle, theme: ThemePref) -> tauri::Result<WebviewWindow> {
    let window = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::default())
        .title("Butterfly Record")
        .inner_size(1200.0, 780.0)
        .min_inner_size(960.0, 640.0)
        .center()
        .visible(false)
        .theme(theme.window_theme())
        .use_https_scheme(true)
        .additional_browser_args(&webview::browser_args())
        .build()?;
    apply_background(&window);
    webview::harden(&window);
    Ok(window)
}

fn apply_background(window: &WebviewWindow) {
    let color = match window.theme() {
        Ok(Theme::Dark) => DARK_BACKGROUND,
        _ => LIGHT_BACKGROUND,
    };
    if let Err(error) = window.set_background_color(Some(color)) {
        log::warn!("could not set the window background: {error}");
    }
}

/// Applies settings Rust acts on: close-to-tray and the window theme.
pub fn apply_settings(app: &AppHandle, close_to_tray: bool, theme: ThemePref) {
    let shell = app.state::<Shell>();
    shell.close_to_tray.store(close_to_tray, Ordering::Relaxed);
    let changed = {
        let mut current = lock(&shell.theme);
        let changed = *current != theme;
        *current = theme;
        changed
    };
    if let (true, Some(main)) = (changed, app.get_webview_window(MAIN)) {
        if let Err(error) = main.set_theme(theme.window_theme()) {
            log::warn!("could not set the window theme: {error}");
        }
        apply_background(&main);
    }
}

pub fn show_main(app: &AppHandle) {
    if let Some(main) = app.get_webview_window(MAIN) {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
    }
}

/// Tray item and Alt+Shift+R. The webview owns the recorder, so Rust only signals.
pub fn toggle_recording(app: &AppHandle) {
    if app.state::<Shell>().is_idle() {
        // A new capture needs the window for the screen picker.
        show_main(app);
    }
    let _ = app.emit(RECORD_TOGGLE_EVENT, ());
}

fn exit_now(app: &AppHandle) {
    app.state::<Shell>().quitting.store(true, Ordering::SeqCst);
    app.exit(0);
}

/// Quits when idle; otherwise asks the frontend to finish the recording first.
pub fn request_quit(app: &AppHandle) {
    let shell = app.state::<Shell>();
    if shell.is_idle() {
        exit_now(app);
        return;
    }
    let overdue =
        lock(&shell.quit_requested_at).is_some_and(|asked| asked.elapsed() > QUIT_ANSWER_TIMEOUT);
    if overdue {
        if *lock(&shell.phase) == Phase::Finalizing {
            confirm_quit_while_saving(app);
        } else {
            exit_now(app);
        }
        return;
    }
    lock(&shell.quit_requested_at).get_or_insert_with(Instant::now);
    show_main(app);
    let _ = app.emit_to(MAIN, QUIT_REQUESTED_EVENT, ());
}

/// Saving a long recording can outlast the timeout, and exiting mid-save leaves it needing recovery.
fn confirm_quit_while_saving(app: &AppHandle) {
    if app
        .state::<Shell>()
        .quit_confirm_open
        .swap(true, Ordering::SeqCst)
    {
        return;
    }
    show_main(app);
    let mut dialog = app
        .dialog()
        .message(
            "Your recording is still being saved. If you quit now, it can be recovered the next time you open Butterfly Record.",
        )
        .title("Butterfly Record")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Quit anyway".into(),
            "Keep saving".into(),
        ));
    if let Some(main) = app.get_webview_window(MAIN) {
        dialog = dialog.parent(&main);
    }
    let app = app.clone();
    dialog.show(move |quit| {
        app.state::<Shell>()
            .quit_confirm_open
            .store(false, Ordering::SeqCst);
        if quit {
            exit_now(&app);
        }
    });
}

pub fn on_window_event(window: &Window, event: &WindowEvent) {
    let app = window.app_handle();
    match (window.label(), event) {
        (MAIN, WindowEvent::CloseRequested { api, .. }) => {
            api.prevent_close();
            if app.state::<Shell>().close_to_tray.load(Ordering::Relaxed) {
                let _ = window.hide();
            } else {
                request_quit(app);
            }
        }
        // The HUD closes only through hud_close.
        (HUD, WindowEvent::CloseRequested { api, .. }) => api.prevent_close(),
        (MAIN, WindowEvent::ThemeChanged(_)) => {
            if let Some(main) = app.get_webview_window(MAIN) {
                apply_background(&main);
            }
        }
        _ => {}
    }
}

pub fn on_run_event(app: &AppHandle, event: RunEvent) {
    if let RunEvent::ExitRequested { api, .. } = event {
        let shell = app.state::<Shell>();
        if !shell.quitting.load(Ordering::SeqCst) && !shell.is_idle() {
            api.prevent_exit();
            request_quit(app);
        }
    }
}

fn record_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::ALT | Modifiers::SHIFT), Key::KeyR)
}

pub fn shortcut_plugin() -> TauriPlugin<Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if event.state() == ShortcutState::Pressed && *shortcut == record_shortcut() {
                toggle_recording(app);
            }
        })
        .build()
}

/// Another app may own Alt+Shift+R; the app works without it.
pub fn register_shortcut(app: &AppHandle) {
    if let Err(error) = app.global_shortcut().register(record_shortcut()) {
        log::warn!("Alt+Shift+R is not available: {error}");
    }
}

fn parse_phase(state: &str) -> IpcResult<Phase> {
    serde_json::from_value(serde_json::Value::String(state.to_owned()))
        .map_err(|_| IpcError::invalid("Unknown recorder state."))
}

#[tauri::command]
pub async fn recorder_set_state(
    app: AppHandle,
    shell: State<'_, Shell>,
    state: String,
) -> IpcResult<()> {
    let phase = parse_phase(&state)?;
    *lock(&shell.phase) = phase;
    if phase == Phase::Idle {
        *lock(&shell.quit_requested_at) = None;
    }
    let (label, enabled) = tray::toggle_label(phase);
    if let Some(item) = lock(&shell.record_item).as_ref() {
        let _ = item.set_text(label);
        let _ = item.set_enabled(enabled);
    }
    if let Some(tray) = app.tray_by_id(tray::TRAY_ID) {
        let _ = tray.set_tooltip(Some(tray::tooltip(phase)));
    }
    Ok(())
}

#[tauri::command]
pub async fn hud_open(app: AppHandle) -> IpcResult<()> {
    let hud = match app.get_webview_window(HUD) {
        Some(hud) => hud,
        None => {
            let hud = WebviewWindowBuilder::new(&app, HUD, WebviewUrl::App("hud.html".into()))
                .title("Butterfly Record controls")
                .inner_size(HUD_WIDTH, HUD_HEIGHT)
                .resizable(false)
                .maximizable(false)
                .minimizable(false)
                .decorations(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .content_protected(true)
                .focused(false)
                .visible(false)
                .use_https_scheme(true)
                .additional_browser_args(&webview::browser_args())
                .background_color(HUD_BACKGROUND)
                .build()?;
            webview::harden(&hud);
            hud
        }
    };
    place_hud(&app, &hud)?;
    show_without_focus(&hud)?;
    Ok(())
}

/// Bottom centre of the monitor holding the main window, just above the work area's bottom edge.
fn place_hud(app: &AppHandle, hud: &WebviewWindow) -> tauri::Result<()> {
    let main_monitor = app
        .get_webview_window(MAIN)
        .and_then(|main| main.current_monitor().ok().flatten());
    let monitor = match main_monitor {
        Some(monitor) => Some(monitor),
        None => hud.primary_monitor()?,
    };
    let Some(monitor) = monitor else {
        return Ok(());
    };
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let width = (HUD_WIDTH * scale).round() as i32;
    let height = (HUD_HEIGHT * scale).round() as i32;
    let gap = (HUD_BOTTOM_GAP * scale).round() as i32;
    let x = area.position.x + (area.size.width as i32 - width) / 2;
    let y = area.position.y + area.size.height as i32 - height - gap;
    hud.set_position(PhysicalPosition::new(x, y))?;
    hud.set_size(tauri::LogicalSize::new(HUD_WIDTH, HUD_HEIGHT))
}

#[cfg(windows)]
fn show_without_focus(window: &WebviewWindow) -> tauri::Result<()> {
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_SHOWNOACTIVATE};
    let hwnd = window.hwnd()?;
    // The HUD must not take focus from the app being recorded.
    let _ = unsafe { ShowWindow(hwnd, SW_SHOWNOACTIVATE) };
    Ok(())
}

#[cfg(not(windows))]
fn show_without_focus(window: &WebviewWindow) -> tauri::Result<()> {
    window.show()
}

#[tauri::command]
pub async fn hud_close(app: AppHandle) -> IpcResult<()> {
    if let Some(hud) = app.get_webview_window(HUD) {
        hud.destroy()?;
    }
    Ok(())
}

#[tauri::command]
pub async fn app_quit(app: AppHandle) -> IpcResult<()> {
    exit_now(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_recorder_states() {
        assert_eq!(parse_phase("idle").unwrap(), Phase::Idle);
        assert_eq!(parse_phase("finalizing").unwrap(), Phase::Finalizing);
        assert!(parse_phase("Recording").is_err());
        assert!(parse_phase("stopped").is_err());
    }

    #[test]
    fn tray_label_follows_phase() {
        assert_eq!(tray::toggle_label(Phase::Idle), ("Start recording", true));
        assert_eq!(tray::toggle_label(Phase::Paused), ("Stop recording", true));
        assert!(!tray::toggle_label(Phase::Finalizing).1);
    }
}
