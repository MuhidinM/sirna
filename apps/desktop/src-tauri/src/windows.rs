//! Window creation. Windows are built on demand and destroyed on close, so no
//! webview exists while Sirna sits in the tray (plan §4.1, §4.3).

use tauri::window::Color;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

pub const MAIN_LABEL: &str = "main";
pub const CAPTURE_LABEL: &str = "capture";

/// The theme's background, so a new window never flashes white.
const BACKGROUND: Color = Color(0x12, 0x12, 0x12, 0xff);

/// Building a window inside a sync command or an event handler deadlocks on
/// Windows, so every caller (tray, single-instance, toasts, hotkey) goes
/// through an async spawn.
pub fn spawn_open_main(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = open_main(&app) {
            eprintln!("could not open the main window: {error}");
        }
    });
}

pub fn spawn_open_capture(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = open_capture(&app) {
            eprintln!("could not open the capture box: {error}");
        }
    });
}

fn open_main(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        window.unminimize()?;
        window.show()?;
        return window.set_focus();
    }
    WebviewWindowBuilder::new(app, MAIN_LABEL, WebviewUrl::App("index.html".into()))
        .title("Sirna")
        .inner_size(1040.0, 720.0)
        .min_inner_size(720.0, 480.0)
        .background_color(BACKGROUND)
        .build()?;
    Ok(())
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
            .inner_size(560.0, 72.0)
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
