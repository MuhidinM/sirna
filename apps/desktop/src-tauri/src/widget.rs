//! The desktop mini widget (plan §3.16; R-WID-01): a small frameless window
//! with Now, the timer and the top 3. Off by default. While it is off no
//! webview exists; turning it off destroys the window.
//!
//! * Its position is saved when you move it and restored next time (only if
//!   that spot is still on a screen).
//! * It hides while a full-screen app, game or presentation is in front, and
//!   comes back after.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::Duration;

use rusqlite::Connection;
use tauri::{AppHandle, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::{clock, db::Db};

pub const WIDGET_LABEL: &str = "widget";
pub const ENABLED_KEY: &str = "widget.enabled";
const POSITION_KEY: &str = "widget.position";
const WIDTH: f64 = 280.0;
const HEIGHT: f64 = 300.0;
/// Moves arrive many times a second while dragging; save once it rests.
const SAVE_AFTER: Duration = Duration::from_millis(600);
const FULLSCREEN_CHECK: Duration = Duration::from_secs(2);

/// `true` only when you turned it on (the value is JSON `true`).
pub fn enabled(conn: &Connection) -> bool {
    conn.query_row(
        "SELECT value_json FROM core_settings WHERE key = ?1",
        [ENABLED_KEY],
        |row| row.get::<_, String>(0),
    )
    .map(|value| value.trim() == "true")
    .unwrap_or(false)
}

/// The saved position, as `{"x":…,"y":…}` in physical pixels.
pub fn read_position(json: &str) -> Option<(i32, i32)> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    let x = i32::try_from(value.get("x")?.as_i64()?).ok()?;
    let y = i32::try_from(value.get("y")?.as_i64()?).ok()?;
    Some((x, y))
}

fn saved_position(conn: &Connection) -> Option<(i32, i32)> {
    conn.query_row(
        "SELECT value_json FROM core_settings WHERE key = ?1",
        [POSITION_KEY],
        |row| row.get::<_, String>(0),
    )
    .ok()
    .and_then(|json| read_position(&json))
}

fn save_position(conn: &Connection, (x, y): (i32, i32)) {
    if let Err(error) = conn.execute(
        "INSERT INTO core_settings (key, value_json, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
        rusqlite::params![
            POSITION_KEY,
            serde_json::json!({ "x": x, "y": y }).to_string(),
            clock::now_ms()
        ],
    ) {
        log::warn!("widget: could not save its position: {error}");
    }
}

/// A point is usable when its top-left corner area lies on some monitor.
pub fn on_a_screen(point: (i32, i32), screens: &[(i32, i32, u32, u32)]) -> bool {
    let (x, y) = point;
    screens.iter().any(|&(left, top, width, height)| {
        let right = left.saturating_add(i32::try_from(width).unwrap_or(i32::MAX));
        let bottom = top.saturating_add(i32::try_from(height).unwrap_or(i32::MAX));
        // At least 40 px of the widget's header must be reachable.
        x >= left && x + 40 <= right && y >= top && y + 40 <= bottom
    })
}

/// Opens or closes the widget to match the setting.
pub fn apply(app: &AppHandle) {
    let on = enabled(&app.state::<Db>().write.lock());
    let open = app.get_webview_window(WIDGET_LABEL);
    match (on, open) {
        (true, None) => spawn_open(app.clone()),
        (false, Some(window)) => {
            if let Err(error) = window.destroy() {
                log::warn!("widget: could not close: {error}");
            }
        }
        _ => {}
    }
}

/// Building a window from a sync context deadlocks on Windows (windows.rs).
fn spawn_open(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = open(&app) {
            log::error!("could not open the widget: {error}");
        }
    });
}

/// One open at a time, so two quick switches can't build it twice.
static OPENING: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn is_on(app: &AppHandle) -> bool {
    enabled(&app.state::<Db>().write.lock())
}

fn open(app: &AppHandle) -> tauri::Result<()> {
    let _one = OPENING
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // The switch may have been turned off again before this ran.
    if app.get_webview_window(WIDGET_LABEL).is_some() || !is_on(app) {
        return Ok(());
    }
    let window =
        WebviewWindowBuilder::new(app, WIDGET_LABEL, WebviewUrl::App("widget.html".into()))
            .title("Sirna widget")
            .inner_size(WIDTH, HEIGHT)
            .resizable(false)
            .decorations(false)
            // No taskbar button to bring it back, so it can't be minimized.
            .minimizable(false)
            .skip_taskbar(true)
            .always_on_top(false)
            .focused(false)
            .visible(false)
            .background_color(crate::windows::BACKGROUND)
            .build()?;

    let screens: Vec<(i32, i32, u32, u32)> = window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            (
                m.position().x,
                m.position().y,
                m.size().width,
                m.size().height,
            )
        })
        .collect();
    let saved = saved_position(&app.state::<Db>().write.lock());
    match saved.filter(|point| on_a_screen(*point, &screens)) {
        Some((x, y)) => window.set_position(PhysicalPosition::new(x, y))?,
        // First time (or that screen is gone): top right of the main screen.
        None => {
            if let Some(monitor) = window.primary_monitor()? {
                let scale = monitor.scale_factor();
                let x = monitor.position().x + monitor.size().width as i32
                    - ((WIDTH + 24.0) * scale) as i32;
                let y = monitor.position().y + (24.0 * scale) as i32;
                window.set_position(PhysicalPosition::new(x, y))?;
            }
        }
    }
    // Turned off while it was being built: don't show it.
    if !is_on(app) {
        return window.destroy();
    }
    window.show()?;

    // Save the position once a drag rests: one worker keeps the latest point.
    let (moved, latest) = mpsc::channel::<(i32, i32)>();
    let saver = app.clone();
    std::thread::spawn(move || {
        let mut pending = None;
        loop {
            match latest.recv_timeout(SAVE_AFTER) {
                Ok(point) => pending = Some(point),
                Err(RecvTimeoutError::Timeout) => {
                    if let Some(point) = pending.take() {
                        save_position(&saver.state::<Db>().write.lock(), point);
                    }
                }
                Err(RecvTimeoutError::Disconnected) => {
                    if let Some(point) = pending {
                        save_position(&saver.state::<Db>().write.lock(), point);
                    }
                    break;
                }
            }
        }
    });
    let closed = Arc::new(AtomicBool::new(false));
    let closed_flag = closed.clone();
    let moved = std::sync::Mutex::new(Some(moved));
    window.on_window_event(move |event| match event {
        // A minimized window sits at -32000: not a place to remember.
        WindowEvent::Moved(position) if position.x > -30000 && position.y > -30000 => {
            if let Some(sender) = moved.lock().ok().and_then(|guard| guard.clone()) {
                let _ = sender.send((position.x, position.y));
            }
        }
        WindowEvent::Destroyed => {
            closed_flag.store(true, Ordering::SeqCst);
            // Dropping the sender ends the save worker (after a last save).
            if let Ok(mut guard) = moved.lock() {
                guard.take();
            }
        }
        _ => {}
    });

    // Hide behind a full-screen app; show again after.
    let watcher = window.clone();
    std::thread::spawn(move || {
        let mut hidden = false;
        while !closed.load(Ordering::SeqCst) {
            let busy = crate::session::fullscreen();
            if busy != hidden {
                let result = if busy { watcher.hide() } else { watcher.show() };
                if result.is_err() {
                    break;
                }
                hidden = busy;
            }
            std::thread::sleep(FULLSCREEN_CHECK);
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_saved_position() {
        assert_eq!(read_position(r#"{"x":-1200,"y":40}"#), Some((-1200, 40)));
        assert_eq!(read_position(r#"{"x":"a","y":40}"#), None);
        assert_eq!(read_position("null"), None);
        assert_eq!(read_position("not json"), None);
    }

    #[test]
    fn keeps_the_widget_on_a_screen() {
        let screens = [(0, 0, 1920, 1080), (-1280, 0, 1280, 1024)];
        assert!(on_a_screen((100, 100), &screens));
        assert!(on_a_screen((-1200, 500), &screens));
        assert!(!on_a_screen((3000, 100), &screens));
        assert!(!on_a_screen((1900, 100), &screens));
        assert!(!on_a_screen((100, -50), &screens));
    }

    #[test]
    fn off_unless_turned_on() {
        let conn = Connection::open_in_memory().expect("db");
        conn.execute_batch(
            "CREATE TABLE core_settings (key TEXT PRIMARY KEY, value_json TEXT, updated_at INTEGER)",
        )
        .expect("table");
        assert!(!enabled(&conn));
        conn.execute(
            "INSERT INTO core_settings VALUES ('widget.enabled', 'false', 0)",
            [],
        )
        .expect("off");
        assert!(!enabled(&conn));
        conn.execute("UPDATE core_settings SET value_json = 'true'", [])
            .expect("on");
        assert!(enabled(&conn));
    }
}
