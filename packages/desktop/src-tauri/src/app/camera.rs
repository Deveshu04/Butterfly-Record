//! The floating camera overlay window.

use serde::{Deserialize, Serialize};
use tauri::window::Color;
use tauri::{
    AppHandle, LogicalSize, Manager, Monitor, PhysicalPosition, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::error::{IpcError, IpcResult};

use super::{show_without_focus, webview, MAIN};

pub const CAMERA: &str = "camera";

/// Inset from the work area's edges when the overlay is placed by corner, in logical pixels.
const MARGIN: f64 = 24.0;
/// Only the clipped video drawn by the page is visible; the window itself is not.
const BACKGROUND: Color = Color(0, 0, 0, 0);

/// Top-left of the overlay in physical screen pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Placement {
    x: i32,
    y: i32,
}

/// Where the overlay sits on its monitor, as fractions of the work area: 0 at the left or
/// top edge, 1 at the right or bottom. A window capture cannot be told where the recorded
/// window is on screen, so this is how the drawn camera follows the overlay the user sees.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Anchor {
    x: f64,
    y: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Corner {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

/// A rectangle in physical screen pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Rect {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

#[tauri::command]
pub async fn camera_open(
    app: AppHandle,
    width: f64,
    height: f64,
    x: Option<i32>,
    y: Option<i32>,
    corner: String,
    protected: bool,
) -> IpcResult<Placement> {
    let corner = parse_corner(&corner)?;
    let window = match app.get_webview_window(CAMERA) {
        Some(window) => {
            window.set_content_protected(protected)?;
            window
        }
        None => build(&app, width, height, protected)?,
    };
    let placement = place(&app, &window, width, height, x, y, corner)?;
    window.set_size(LogicalSize::new(width, height))?;
    show_without_focus(&window)?;
    Ok(placement)
}

#[tauri::command]
pub async fn camera_close(app: AppHandle) -> IpcResult<()> {
    if let Some(window) = app.get_webview_window(CAMERA) {
        window.destroy()?;
    }
    Ok(())
}

#[tauri::command]
pub async fn camera_set_visible(app: AppHandle, visible: bool) -> IpcResult<()> {
    let Some(window) = app.get_webview_window(CAMERA) else {
        return Ok(());
    };
    if visible {
        show_without_focus(&window)?;
    } else {
        window.hide()?;
    }
    Ok(())
}

#[tauri::command]
pub async fn camera_set_size(app: AppHandle, width: f64, height: f64) -> IpcResult<()> {
    if let Some(window) = app.get_webview_window(CAMERA) {
        window.set_size(LogicalSize::new(width, height))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn camera_set_protected(app: AppHandle, protected: bool) -> IpcResult<()> {
    if let Some(window) = app.get_webview_window(CAMERA) {
        window.set_content_protected(protected)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn camera_reset_position(app: AppHandle, corner: String) -> IpcResult<Placement> {
    let corner = parse_corner(&corner)?;
    let window = app
        .get_webview_window(CAMERA)
        .ok_or_else(|| IpcError::not_found("The camera overlay is not open."))?;
    let size = window
        .inner_size()?
        .to_logical::<f64>(window.scale_factor()?);
    place(&app, &window, size.width, size.height, None, None, corner)
}

/// Null when the overlay is closed or on no monitor, which leaves the caller to place the
/// drawn camera by corner instead.
#[tauri::command]
pub async fn camera_anchor(app: AppHandle) -> IpcResult<Option<Anchor>> {
    let Some(window) = app.get_webview_window(CAMERA) else {
        return Ok(None);
    };
    let position = window.outer_position()?;
    let size = window.outer_size()?;
    let rect = Rect {
        x: position.x,
        y: position.y,
        width: size.width as i32,
        height: size.height as i32,
    };
    let areas = work_areas(&app);
    Ok(anchor_in(rect, &areas))
}

/// The work area holding most of the overlay decides the fractions, so an overlay straddling
/// two monitors is measured against the one it is mostly on.
fn anchor_in(rect: Rect, areas: &[Rect]) -> Option<Anchor> {
    let area = areas
        .iter()
        .copied()
        .max_by_key(|area| overlap(rect, *area))
        .filter(|area| overlap(rect, *area) > 0 && area.width > 0 && area.height > 0)?;
    Some(Anchor {
        x: fraction(rect.x + rect.width / 2 - area.x, area.width),
        y: fraction(rect.y + rect.height / 2 - area.y, area.height),
    })
}

fn fraction(offset: i32, span: i32) -> f64 {
    (f64::from(offset) / f64::from(span)).clamp(0.0, 1.0)
}

fn build(
    app: &AppHandle,
    width: f64,
    height: f64,
    protected: bool,
) -> tauri::Result<WebviewWindow> {
    let window = WebviewWindowBuilder::new(app, CAMERA, WebviewUrl::App("camera.html".into()))
        .title("Butterfly Record camera")
        .inner_size(width, height)
        .resizable(true)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .shadow(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .content_protected(protected)
        .focused(false)
        .visible(false)
        .use_https_scheme(true)
        .additional_browser_args(&webview::browser_args())
        .background_color(BACKGROUND)
        .build()?;
    webview::harden(&window);
    Ok(window)
}

/// Moves the overlay to the stored position when it is still usable, else to `corner`.
fn place(
    app: &AppHandle,
    window: &WebviewWindow,
    width: f64,
    height: f64,
    x: Option<i32>,
    y: Option<i32>,
    corner: Corner,
) -> IpcResult<Placement> {
    let target = stored_position(app, width, height, x, y)
        .or_else(|| corner_placement(app, width, height, corner));
    match target {
        Some(placement) => {
            window.set_position(PhysicalPosition::new(placement.x, placement.y))?;
            Ok(placement)
        }
        None => {
            let current = window.outer_position()?;
            Ok(Placement {
                x: current.x,
                y: current.y,
            })
        }
    }
}

fn stored_position(
    app: &AppHandle,
    width: f64,
    height: f64,
    x: Option<i32>,
    y: Option<i32>,
) -> Option<Placement> {
    let (x, y) = (x?, y?);
    let scale = app
        .monitor_from_point(f64::from(x), f64::from(y))
        .ok()
        .flatten()
        .or_else(|| main_monitor(app))
        .map_or(1.0, |monitor| monitor.scale_factor());
    let rect = Rect {
        x,
        y,
        width: physical(width, scale),
        height: physical(height, scale),
    };
    mostly_visible(rect, &work_areas(app)).then_some(Placement { x, y })
}

/// The chosen corner of the work area of the monitor that holds the main window.
fn corner_placement(app: &AppHandle, width: f64, height: f64, corner: Corner) -> Option<Placement> {
    let monitor = main_monitor(app)?;
    let scale = monitor.scale_factor();
    let (x, y) = corner_position(
        work_area(&monitor),
        physical(width, scale),
        physical(height, scale),
        corner,
        physical(MARGIN, scale),
    );
    Some(Placement { x, y })
}

fn main_monitor(app: &AppHandle) -> Option<Monitor> {
    app.get_webview_window(MAIN)
        .and_then(|main| main.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())
}

fn work_areas(app: &AppHandle) -> Vec<Rect> {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(work_area)
        .collect()
}

fn work_area(monitor: &Monitor) -> Rect {
    let area = monitor.work_area();
    Rect {
        x: area.position.x,
        y: area.position.y,
        width: area.size.width as i32,
        height: area.size.height as i32,
    }
}

fn physical(logical: f64, scale: f64) -> i32 {
    (logical * scale).round() as i32
}

fn parse_corner(corner: &str) -> IpcResult<Corner> {
    serde_json::from_value(serde_json::Value::String(corner.to_owned()))
        .map_err(|_| IpcError::invalid("Unknown camera corner."))
}

/// Physical pixels covered by both rectangles.
fn overlap(a: Rect, b: Rect) -> i64 {
    let width = (a.x + a.width).min(b.x + b.width) - a.x.max(b.x);
    let height = (a.y + a.height).min(b.y + b.height) - a.y.max(b.y);
    if width <= 0 || height <= 0 {
        0
    } else {
        i64::from(width) * i64::from(height)
    }
}

/// Whether at least half of `rect` lands on one work area. A position saved on a monitor that
/// has since been unplugged fails this, and the caller places the overlay by corner instead.
fn mostly_visible(rect: Rect, areas: &[Rect]) -> bool {
    let total = i64::from(rect.width) * i64::from(rect.height);
    total > 0 && areas.iter().any(|area| overlap(rect, *area) * 2 >= total)
}

/// Top-left for `corner` of `area`, inset by `margin` and kept inside the area.
fn corner_position(area: Rect, width: i32, height: i32, corner: Corner, margin: i32) -> (i32, i32) {
    let right = area.x + area.width - width - margin;
    let bottom = area.y + area.height - height - margin;
    let (x, y) = match corner {
        Corner::TopLeft => (area.x + margin, area.y + margin),
        Corner::TopRight => (right, area.y + margin),
        Corner::BottomLeft => (area.x + margin, bottom),
        Corner::BottomRight => (right, bottom),
    };
    (
        inside(x, area.x, area.width - width),
        inside(y, area.y, area.height - height),
    )
}

/// Keeps `value` within `start..=start + span`; an overlay wider than the area sits at `start`.
fn inside(value: i32, start: i32, span: i32) -> i32 {
    value.clamp(start, start + span.max(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PRIMARY: Rect = Rect {
        x: 0,
        y: 0,
        width: 1920,
        height: 1040,
    };
    const SECOND: Rect = Rect {
        x: 1920,
        y: 0,
        width: 1920,
        height: 1040,
    };

    #[test]
    fn measures_where_the_overlay_sits_on_its_monitor() {
        let areas = [PRIMARY, SECOND];
        // Centred on the primary monitor.
        let middle = Rect {
            x: 840,
            y: 400,
            width: 240,
            height: 240,
        };
        let anchor = anchor_in(middle, &areas).unwrap();
        assert!((anchor.x - 0.5).abs() < 0.01, "{anchor:?}");
        assert!((anchor.y - 0.5).abs() < 0.01, "{anchor:?}");

        // Bottom-right of the second monitor reads the same as bottom-right of the first:
        // the fractions are per monitor, never across the whole desktop.
        let corner = Rect {
            x: 1920 + 1656,
            y: 776,
            width: 240,
            height: 240,
        };
        let far = anchor_in(corner, &areas).unwrap();
        assert!(far.x > 0.9 && far.y > 0.85, "{far:?}");

        // Straddling the two, mostly on the second.
        let straddling = Rect {
            x: 1860,
            y: 400,
            width: 240,
            height: 240,
        };
        let split = anchor_in(straddling, &areas).unwrap();
        assert!(split.x < 0.05, "{split:?}");

        assert_eq!(anchor_in(middle, &[]), None);
        let offscreen = Rect {
            x: -5000,
            y: -5000,
            width: 240,
            height: 240,
        };
        assert_eq!(anchor_in(offscreen, &areas), None);
    }

    #[test]
    fn keeps_fractions_inside_the_unit_range() {
        assert_eq!(fraction(-50, 1920), 0.0);
        assert_eq!(fraction(5000, 1920), 1.0);
        assert!((fraction(960, 1920) - 0.5).abs() < f64::EPSILON);
    }

    fn overlay(x: i32, y: i32) -> Rect {
        Rect {
            x,
            y,
            width: 240,
            height: 240,
        }
    }

    #[test]
    fn parses_corners() {
        assert_eq!(parse_corner("top-left").unwrap(), Corner::TopLeft);
        assert_eq!(parse_corner("bottom-right").unwrap(), Corner::BottomRight);
        assert!(parse_corner("bottomRight").is_err());
        assert!(parse_corner("centre").is_err());
    }

    #[test]
    fn keeps_a_position_that_is_still_on_screen() {
        assert!(mostly_visible(overlay(1600, 760), &[PRIMARY]));
        // Exactly half hangs over the right edge, which still counts as visible.
        assert!(mostly_visible(overlay(1800, 700), &[PRIMARY]));
        assert!(mostly_visible(overlay(2000, 100), &[PRIMARY, SECOND]));
    }

    #[test]
    fn drops_a_position_whose_monitor_is_gone() {
        assert!(!mostly_visible(overlay(2000, 100), &[PRIMARY]));
        assert!(!mostly_visible(overlay(400, 300), &[]));
        // Mostly under the taskbar, which the work area excludes.
        assert!(!mostly_visible(overlay(400, 980), &[PRIMARY]));
    }

    #[test]
    fn places_in_every_corner() {
        let at = |corner| corner_position(PRIMARY, 240, 240, corner, 24);
        assert_eq!(at(Corner::TopLeft), (24, 24));
        assert_eq!(at(Corner::TopRight), (1656, 24));
        assert_eq!(at(Corner::BottomLeft), (24, 776));
        assert_eq!(at(Corner::BottomRight), (1656, 776));
    }

    #[test]
    fn places_on_a_monitor_left_of_the_primary() {
        let area = Rect {
            x: -1280,
            y: -200,
            width: 1280,
            height: 1000,
        };
        assert_eq!(
            corner_position(area, 240, 240, Corner::TopLeft, 24),
            (-1256, -176)
        );
        assert_eq!(
            corner_position(area, 240, 240, Corner::BottomRight, 24),
            (-264, 536)
        );
    }

    #[test]
    fn the_margin_follows_the_scale_factor() {
        let scale = 1.5;
        let width = physical(240.0, scale);
        let height = physical(135.0, scale);
        let margin = physical(MARGIN, scale);
        assert_eq!((width, height, margin), (360, 203, 36));
        let area = Rect {
            x: 1920,
            y: 0,
            width: 2560,
            height: 1392,
        };
        assert_eq!(
            corner_position(area, width, height, Corner::BottomRight, margin),
            (4084, 1153)
        );
        assert_eq!(
            corner_position(area, width, height, Corner::TopLeft, margin),
            (1956, 36)
        );
    }

    #[test]
    fn clamps_an_overlay_larger_than_the_work_area() {
        let area = Rect {
            x: 100,
            y: 50,
            width: 300,
            height: 300,
        };
        for corner in [
            Corner::TopLeft,
            Corner::TopRight,
            Corner::BottomLeft,
            Corner::BottomRight,
        ] {
            assert_eq!(corner_position(area, 400, 400, corner, 24), (100, 50));
        }
        // A margin that no longer fits still leaves the overlay against the edges.
        assert_eq!(
            corner_position(area, 300, 300, Corner::BottomRight, 24),
            (100, 50)
        );
    }
}
