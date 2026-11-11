//! Window creation. Windows are built on demand and destroyed on close, so no
//! webview exists while Sirna sits in the tray (plan §4.1, §4.3).

use tauri::window::Color;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

pub const MAIN_LABEL: &str = "main";
pub const CAPTURE_LABEL: &str = "capture";
pub const SETUP_LABEL: &str = "setup";

/// The theme's background, so a new window never flashes white.
const BACKGROUND: Color = Color(0x12, 0x12, 0x12, 0xff);

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

fn open_setup(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(SETUP_LABEL) {
        // Already open: reload so it shows the newer block.
        window.eval("location.reload()")?;
        window.show()?;
        return window.set_focus();
    }
    let window = WebviewWindowBuilder::new(app, SETUP_LABEL, WebviewUrl::App("setup.html".into()))
        .title("Sirna focus")
        .inner_size(480.0, 300.0)
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
    WebviewWindowBuilder::new(app, MAIN_LABEL, WebviewUrl::App("index.html".into()))
        .title("Sirna")
        // Tauri's own file-drop handler would swallow HTML drag and drop
        // (the project board), and Sirna takes no dropped files.
        .disable_drag_drop_handler()
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
