//! Commands the webview may call (plan §4.5). Per-window scoping arrives with
//! the IPC work in T-013.

use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{State, WebviewWindow};

use crate::db::{self, Db};
use crate::hotkey::CapturePressedAt;
use crate::secrets;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// Saves a capture exactly as typed. Parsing comes later (T-014); saving never
/// waits on it.
#[tauri::command]
pub fn capture_commit(raw_text: String, db: State<'_, Db>) -> Result<i64, String> {
    if raw_text.trim().is_empty() {
        return Err("Nothing to save".into());
    }
    let conn = db.write.lock();
    db::insert_capture(&conn, &raw_text, now_ms()).map_err(|error| error.to_string())
}

/// The only secret names the webview may touch (plan §4.5).
const SECRET_NAMES: [&str; 2] = ["gemini_api_key", "ical_url"];

fn known_secret(name: &str) -> Result<(), String> {
    if SECRET_NAMES.contains(&name) {
        Ok(())
    } else {
        Err(format!("Unknown secret: {name}"))
    }
}

/// Stores a secret in Credential Manager; an empty value removes it.
/// There is deliberately no command that returns a secret's value.
#[tauri::command]
pub fn secret_set(name: String, value: String) -> Result<(), String> {
    known_secret(&name)?;
    let result = if value.is_empty() {
        secrets::delete(&name)
    } else {
        secrets::set(&name, &value)
    };
    result.map_err(|error| error.to_string())
}

#[tauri::command]
pub fn secret_status(name: String) -> Result<bool, String> {
    known_secret(&name)?;
    secrets::exists(&name).map_err(|error| error.to_string())
}

/// The capture page calls this once it has loaded. Focusing from here moves
/// keyboard focus into the web content: focusing the window at creation only
/// activates the frame, so typed keys went nowhere. Logs the time from the
/// hotkey press, which T-010 records as "hotkey to ready to type".
#[tauri::command]
pub fn capture_ready(
    window: WebviewWindow,
    pressed_at: State<'_, CapturePressedAt>,
) -> Result<(), String> {
    window.set_focus().map_err(|error| error.to_string())?;
    if let Some(pressed) = pressed_at.0.lock().take() {
        eprintln!("capture ready in {} ms", pressed.elapsed().as_millis());
    }
    Ok(())
}

/// Closes the calling window (the capture box).
#[tauri::command]
pub fn close_window(window: WebviewWindow) -> Result<(), String> {
    window.close().map_err(|error| error.to_string())
}
