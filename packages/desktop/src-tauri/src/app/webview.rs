use tauri::WebviewWindow;

pub const WEBVIEW_ARGS_ENV: &str = "BUTTERFLY_RECORD_WEBVIEW_ARGS";

// Passing any arguments replaces wry's defaults, so they are restated here.
const WRY_DEFAULT_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";
// Keep capture, timers and encoding at full speed while the window is hidden or covered.
const KEEP_RUNNING_ARGS: &str = "--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows";

/// Native context menu entries that survive; the page opens the menu only on text.
#[cfg(windows)]
const MENU_ITEMS: &[&str] = &["undo", "redo", "cut", "copy", "paste", "selectAll"];

/// Browser arguments for every webview. They must be identical across windows, because
/// WebView2 refuses a second environment with different arguments on the same profile.
pub fn browser_args() -> String {
    let mut args = format!("{WRY_DEFAULT_ARGS} {KEEP_RUNNING_ARGS}");
    if let Ok(extra) = std::env::var(WEBVIEW_ARGS_ENV) {
        let extra = extra.trim();
        if !extra.is_empty() {
            args.push(' ');
            args.push_str(extra);
        }
    }
    args
}

/// Makes the webview behave like part of a desktop app: no browser accelerator keys
/// (reload, print, find, zoom, devtools), a context menu limited to editing commands, and
/// microphone access for the app's own pages without a browser permission prompt.
pub fn harden(window: &WebviewWindow) {
    #[cfg(windows)]
    {
        let origin = app_origin(window);
        let applied = window.with_webview(move |webview| {
            if let Err(error) = unsafe { configure(&webview.controller(), origin) } {
                log::warn!("could not restrict the webview: {error}");
            }
        });
        if let Err(error) = applied {
            log::warn!("could not reach the webview: {error}");
        }
    }
    #[cfg(not(windows))]
    let _ = window;
}

/// Origin of the app's own pages: the dev server under `tauri dev`, else the bundled assets
/// (served over https because every window uses `use_https_scheme`).
#[cfg(windows)]
fn app_origin(window: &WebviewWindow) -> String {
    use tauri::Manager;
    match window.config().build.dev_url.as_ref() {
        Some(url) if tauri::is_dev() => url.origin().ascii_serialization(),
        _ => "https://tauri.localhost".to_owned(),
    }
}

#[cfg(windows)]
unsafe fn configure(
    controller: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller,
    origin: String,
) -> windows::core::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Settings3, ICoreWebView2_11, COREWEBVIEW2_PERMISSION_KIND,
        COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    };
    use webview2_com::{
        take_pwstr, ContextMenuRequestedEventHandler, PermissionRequestedEventHandler,
    };
    use windows::core::{Interface, PWSTR};

    let webview = controller.CoreWebView2()?;
    webview
        .Settings()?
        .cast::<ICoreWebView2Settings3>()?
        .SetAreBrowserAcceleratorKeysEnabled(false)?;

    // The handlers live as long as the webview, so their tokens are never needed.
    let mut token = 0;
    webview.add_PermissionRequested(
        &PermissionRequestedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
            args.PermissionKind(&mut kind)?;
            if kind != COREWEBVIEW2_PERMISSION_KIND_MICROPHONE {
                return Ok(());
            }
            let mut uri = PWSTR::null();
            args.Uri(&mut uri)?;
            let requested = tauri::Url::parse(&take_pwstr(uri))
                .map(|url| url.origin().ascii_serialization())
                .unwrap_or_default();
            if requested == origin {
                args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
            } else {
                log::warn!("microphone request from {requested} left to the user");
            }
            Ok(())
        })),
        &mut token,
    )?;

    webview
        .cast::<ICoreWebView2_11>()?
        .add_ContextMenuRequested(
            &ContextMenuRequestedEventHandler::create(Box::new(|_, args| {
                let Some(args) = args else { return Ok(()) };
                if limit_menu(&args.MenuItems()?)? == 0 {
                    args.SetHandled(true)?;
                }
                Ok(())
            })),
            &mut token,
        )
}

/// Drops every entry not in `MENU_ITEMS` and tidies the separators; returns what is left.
#[cfg(windows)]
unsafe fn limit_menu(
    items: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2ContextMenuItemCollection,
) -> windows::core::Result<u32> {
    use webview2_com::take_pwstr;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND, COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR,
    };
    use windows::core::PWSTR;

    let mut count = 0;
    items.Count(&mut count)?;
    let mut index = 0;
    // Treating the start as a separator drops leading and doubled separators in one pass.
    let mut after_separator = true;
    while index < count {
        let item = items.GetValueAtIndex(index)?;
        let mut kind = COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND::default();
        item.Kind(&mut kind)?;
        let separator = kind == COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR;
        let keep = if separator {
            !after_separator
        } else {
            let mut name = PWSTR::null();
            item.Name(&mut name)?;
            MENU_ITEMS.contains(&take_pwstr(name).as_str())
        };
        if keep {
            after_separator = separator;
            index += 1;
        } else {
            items.RemoveValueAtIndex(index)?;
            count -= 1;
        }
    }
    if after_separator && count > 0 {
        count -= 1;
        items.RemoveValueAtIndex(count)?;
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_wry_defaults() {
        let args = browser_args();
        assert!(args.starts_with(WRY_DEFAULT_ARGS));
        assert!(args.contains("--disable-backgrounding-occluded-windows"));
    }
}
