//! Window creation. Windows are built on demand and destroyed on close, so no
//! webview exists while Sirna sits in the tray (plan §4.1, §4.3).

use tauri::window::Color;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub const MAIN_LABEL: &str = "main";

/// The theme's background, so a new window never flashes white.
const BACKGROUND: Color = Color(0x12, 0x12, 0x12, 0xff);

/// Opens (or focuses) the main window from any context.
///
/// Building a window inside a sync command or an event handler deadlocks on
/// Windows, so every caller (tray, single-instance, toasts, hotkey) goes
/// through this async spawn.
pub fn spawn_open_main(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = open_main(&app) {
            eprintln!("could not open the main window: {error}");
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
