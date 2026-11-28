//! Window creation. Windows are built on demand and destroyed on close, so no
//! webview exists while Sirna sits in the tray (plan §4.1, §4.3).

use tauri::window::Color;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

pub const MAIN_LABEL: &str = "main";
pub const CAPTURE_LABEL: &str = "capture";
pub const SETUP_LABEL: &str = "setup";

/// The Night frame (docs/design.md), so a new window never flashes white.
pub const BACKGROUND: Color = Color(0x0e, 0x0e, 0x0e, 0xff);

/// Building a window inside a sync command or an event handler deadlocks on
/// Windows, so every caller (tray, single-instance, toasts, hotkey) goes
/// through an async spawn.
pub fn spawn_open_main(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = open_main(&app) {
            log::error!("could not open the main window: {error}");
        }
    });
}

pub fn spawn_open_capture(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = open_capture(&app) {
            log::error!("could not open the capture box: {error}");
        }
    });
}

/// The focus set-up sheet for a block (plan §3.6a). A second request while it
/// is open retargets it to the newer block.
pub fn spawn_open_setup(app: AppHandle, block_id: Option<String>) {
    *app.state::<crate::kit::PendingSetup>().0.lock() = Some(block_id);
    tauri::async_runtime::spawn(async move {
        if let Err(error) = open_setup(&app) {
            log::error!("could not open the focus set-up: {error}");
        }
    });
}

/// The set-up sheet's size (src/setup/setup.css says the same).
pub const SETUP_WIDTH: f64 = 480.0;
pub const SETUP_HEIGHT: f64 = 360.0;

fn open_setup(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(SETUP_LABEL) {
        // Already open: reload so it shows the newer block.
        window.eval("location.reload()")?;
        window.show()?;
        return window.set_focus();
    }
    let window = WebviewWindowBuilder::new(app, SETUP_LABEL, WebviewUrl::App("setup.html".into()))
        .title("Sirna focus")
        .inner_size(SETUP_WIDTH, SETUP_HEIGHT)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .center()
        .focused(true)
        .background_color(BACKGROUND)
        .build()?;
    let closing = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Focused(false) = event {
            let _ = closing.close();
        }
    });
    Ok(())
}

fn open_main(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        window.unminimize()?;
        window.show()?;
        return window.set_focus();
    }
    let window = WebviewWindowBuilder::new(app, MAIN_LABEL, WebviewUrl::App("index.html".into()))
        .title("Sirna")
        // Tauri's own file-drop handler would swallow HTML drag and drop
        // (the project board), and Sirna takes no dropped files.
        .disable_drag_drop_handler()
        .inner_size(1040.0, 720.0)
        .min_inner_size(720.0, 480.0)
        .background_color(BACKGROUND)
        .build()?;
    let theme = {
        let db = app.state::<crate::db::Db>();
        let conn = db.read.lock();
        crate::db::setting_string(&conn, "ui.theme")
    };
    paint_title_bar(&window, theme.as_deref().unwrap_or("night"));
    Ok(())
}

/// The title bar's colours for a theme, as Windows COLORREFs (0x00BBGGRR):
/// the frame colour and its ink (src/theme/tokens.css), so the bar reads as
/// part of the app.
pub fn title_bar_colors(theme: &str) -> (u32, u32) {
    let colorref = |r: u32, g: u32, b: u32| r | (g << 8) | (b << 16);
    match theme {
        "forest" => (colorref(0x0f, 0x2a, 0x17), colorref(0xfe, 0xf4, 0xdc)),
        _ => (colorref(0x0e, 0x0e, 0x0e), colorref(0xf4, 0xf2, 0xec)),
    }
}

/// Paints the native title bar (min, max, close stay native) in the theme's
/// colours. Windows 11 only; older Windows ignores the colour attributes.
pub fn paint_title_bar(window: &tauri::WebviewWindow, theme: &str) {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Graphics::Dwm::{
            DWMWA_BORDER_COLOR, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR,
            DWMWA_USE_IMMERSIVE_DARK_MODE, DwmSetWindowAttribute,
        };
        let Ok(hwnd) = window.hwnd() else {
            return;
        };
        let hwnd = hwnd.0 as _;
        let (frame, ink) = title_bar_colors(theme);
        let dark: i32 = 1;
        let set = |attribute: i32, value: *const u32| {
            // SAFETY: a live window handle and a pointer to a 4-byte value.
            unsafe { DwmSetWindowAttribute(hwnd, attribute as u32, value.cast(), 4) };
        };
        set(DWMWA_USE_IMMERSIVE_DARK_MODE, (&dark as *const i32).cast());
        set(DWMWA_CAPTION_COLOR, &frame);
        set(DWMWA_BORDER_COLOR, &frame);
        set(DWMWA_TEXT_COLOR, &ink);
    }
    #[cfg(not(windows))]
    let _ = (window, theme);
}

/// The capture bar's size: thin and long (src/capture/capture.css matches it).
pub const CAPTURE_WIDTH: f64 = 680.0;
pub const CAPTURE_HEIGHT: f64 = 52.0;
/// Smart capture rows under the bar (capture.css matches): a 6 px gap, a
/// panel with 6 px padding, 28 px a row and a 24 px line of keys.
pub const CAPTURE_ROW_HEIGHT: f64 = 28.0;
pub const CAPTURE_MAX_ROWS: u32 = 6;
const CAPTURE_PANEL_EXTRA: f64 = 6.0 + 2.0 * 6.0 + 24.0;

/// The capture window's height with `rows` rows showing (at most six).
pub fn capture_height(rows: u32) -> f64 {
    match rows.min(CAPTURE_MAX_ROWS) {
        0 => CAPTURE_HEIGHT,
        rows => CAPTURE_HEIGHT + CAPTURE_PANEL_EXTRA + f64::from(rows) * CAPTURE_ROW_HEIGHT,
    }
}

/// The capture box: small, frameless, on top, not in the taskbar. It closes
/// when it loses focus. Whether to keep it warm instead is decided in T-010.
fn open_capture(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(CAPTURE_LABEL) {
        window.show()?;
        return window.set_focus();
    }
    let window =
        WebviewWindowBuilder::new(app, CAPTURE_LABEL, WebviewUrl::App("capture.html".into()))
            .title("Sirna capture")
            .inner_size(CAPTURE_WIDTH, CAPTURE_HEIGHT)
            .resizable(false)
            .decorations(false)
            // Only the rounded bar shows: no square window behind it, no system shadow.
            .transparent(true)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .center()
            .focused(true)
            .background_color(Color(0, 0, 0, 0))
            .build()?;
    let closing = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Focused(false) = event {
            let _ = closing.close();
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_capture_box_grows_for_at_most_six_rows() {
        assert_eq!(capture_height(0), CAPTURE_HEIGHT);
        assert_eq!(capture_height(1), 52.0 + 42.0 + 28.0);
        assert_eq!(capture_height(6), 52.0 + 42.0 + 6.0 * 28.0);
        assert_eq!(capture_height(60), capture_height(6));
    }
}
