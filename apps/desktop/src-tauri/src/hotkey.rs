//! The global capture hotkey (plan §3.5), acting on key press only.
//!
//! Ctrl+Alt+Space is the first choice, but another app may already own it
//! (on the development machine it is taken). Sirna then tries the next
//! candidate and shows whichever one works in the tray tooltip. A key saved in
//! the `capture.hotkey` setting (e.g. "Ctrl+Alt+K") is tried before them all.

use std::time::Instant;

use parking_lot::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use crate::windows;

/// Tried in order; the first one Windows accepts becomes the capture hotkey.
pub const CANDIDATES: [(Modifiers, Code, &str); 3] = [
    (
        Modifiers::CONTROL.union(Modifiers::ALT),
        Code::Space,
        "Ctrl+Alt+Space",
    ),
    (
        Modifiers::CONTROL.union(Modifiers::ALT),
        Code::KeyJ,
        "Ctrl+Alt+J",
    ),
    (
        Modifiers::CONTROL
            .union(Modifiers::SHIFT)
            .union(Modifiers::ALT),
        Code::Space,
        "Ctrl+Shift+Alt+Space",
    ),
];

/// When the hotkey was last pressed, to time "hotkey to ready to type" (plan §10).
#[derive(Default)]
pub struct CapturePressedAt(pub Mutex<Option<Instant>>);

/// The hotkey that was registered, if any.
#[derive(Default)]
pub struct ActiveHotkey(pub Mutex<Option<(Shortcut, String)>>);

/// The plugin, with a handler that opens the capture box on key press.
pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            let active = app.state::<ActiveHotkey>();
            let is_capture = active
                .0
                .lock()
                .as_ref()
                .is_some_and(|(registered, _)| registered == shortcut);
            if is_capture {
                *app.state::<CapturePressedAt>().0.lock() = Some(Instant::now());
                windows::spawn_open_capture(app.clone());
            }
        })
        .build()
}

/// Reads a key like "Ctrl+Alt+K" or "ctrl+shift+space" into a shortcut.
pub fn parse_key(text: &str) -> Option<Shortcut> {
    let normalised = text.trim().replace(' ', "").to_lowercase();
    if normalised.is_empty() {
        return None;
    }
    normalised.parse::<Shortcut>().ok()
}

/// Registers the saved key if there is one, else the first free candidate.
/// Returns the label of the key in use, or None if every candidate is taken.
pub fn register(app: &AppHandle, saved: Option<String>) -> Option<String> {
    let mut choices: Vec<(Shortcut, String)> = Vec::new();
    if let Some(text) = saved {
        match parse_key(&text) {
            Some(shortcut) => choices.push((shortcut, text.trim().to_string())),
            None => log::warn!("ignoring the saved capture hotkey {text:?}: not a key combination"),
        }
    }
    for (modifiers, code, label) in CANDIDATES {
        choices.push((Shortcut::new(Some(modifiers), code), label.to_string()));
    }
    for (shortcut, label) in choices {
        match app.global_shortcut().register(shortcut) {
            Ok(()) => {
                *app.state::<ActiveHotkey>().0.lock() = Some((shortcut, label.clone()));
                return Some(label);
            }
            Err(error) => log::warn!("could not register {label}: {error}"),
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_saved_keys_in_any_case() {
        let expected = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyK);
        assert_eq!(parse_key("Ctrl+Alt+K"), Some(expected));
        assert_eq!(parse_key(" ctrl + alt + k "), Some(expected));
    }

    #[test]
    fn rejects_text_that_is_not_a_key() {
        assert_eq!(parse_key(""), None);
        assert_eq!(parse_key("banana"), None);
    }
}
