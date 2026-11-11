//! The tray icon and its native menu: no webview needed (plan §4.1).

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Error};

use crate::windows;

const OPEN_ID: &str = "open";
const QUIT_ID: &str = "quit";

/// The tooltip names the capture hotkey, so a fallback key is never a surprise.
pub fn tooltip(capture_key: Option<&str>) -> String {
    match capture_key {
        Some(key) => format!("Sirna · {key} to capture"),
        None => "Sirna · no capture hotkey (all taken)".to_string(),
    }
}

pub fn create(app: &AppHandle, capture_key: Option<&str>) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, OPEN_ID, "Open Sirna", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, QUIT_ID, "Quit", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &separator, &quit])?;

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| Error::AssetNotFound("default window icon".into()))?;

    TrayIconBuilder::with_id("sirna")
        .icon(icon)
        .tooltip(tooltip(capture_key))
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            OPEN_ID => windows::spawn_open_main(app.clone()),
            QUIT_ID => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::tooltip;

    #[test]
    fn tooltip_names_the_capture_key() {
        assert_eq!(tooltip(Some("Ctrl+Alt+J")), "Sirna · Ctrl+Alt+J to capture");
    }

    #[test]
    fn tooltip_says_when_no_key_is_free() {
        assert!(tooltip(None).contains("no capture hotkey"));
    }
}
