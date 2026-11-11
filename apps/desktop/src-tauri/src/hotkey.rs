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
    // A key without Ctrl, Alt or Win would swallow normal typing in every app.
    normalised.parse::<Shortcut>().ok().filter(|shortcut| {
        shortcut
            .mods
            .intersects(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SUPER)
    })
}

/// Registers the saved key if there is one, else the first free candidate.
/// Returns the label of the key in use, or None if every candidate is taken.
pub fn register(app: &AppHandle, saved: Option<String>) -> Option<String> {
    let mut choices: Vec<(Shortcut, String)> = Vec::new();
    // An empty saved key means "use the defaults" (cleared in Settings).
    if let Some(text) = saved.filter(|text| !text.trim().is_empty()) {
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

/// The label of the capture key in use, if any.
pub fn current(app: &AppHandle) -> Option<String> {
    app.state::<ActiveHotkey>()
        .0
        .lock()
        .as_ref()
        .map(|(_, label)| label.clone())
}

/// Switches the capture key at run time. A chosen key is registered before
/// the old one is let go, so a key another app owns leaves the old one in
/// place. `None` goes back to the first free default.
pub fn switch(app: &AppHandle, choice: Option<(Shortcut, String)>) -> Result<String, String> {
    let active = app.state::<ActiveHotkey>();
    let old = active.0.lock().clone();
    let release = |old: Option<(Shortcut, String)>| {
        if let Some((shortcut, label)) = old
            && let Err(error) = app.global_shortcut().unregister(shortcut)
        {
            log::warn!("could not release {label}: {error}");
        }
    };
    match choice {
        Some((shortcut, label)) => {
            if old
                .as_ref()
                .is_some_and(|(current, _)| *current == shortcut)
            {
                *active.0.lock() = Some((shortcut, label.clone()));
                return Ok(label);
            }
            if let Err(error) = app.global_shortcut().register(shortcut) {
                log::warn!("could not register {label}: {error}");
                let still = old.map_or("no key".to_string(), |(_, label)| label);
                return Err(format!(
                    "{label} is taken by another app; still using {still}."
                ));
            }
            *active.0.lock() = Some((shortcut, label.clone()));
            release(old);
            Ok(label)
        }
        None => {
            active.0.lock().take();
            release(old);
            register(app, None)
                .ok_or_else(|| "Every capture key is taken by other apps.".to_string())
        }
    }
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

    #[test]
    fn rejects_keys_that_would_swallow_typing() {
        assert_eq!(parse_key("K"), None);
        assert_eq!(parse_key("Space"), None);
        assert_eq!(parse_key("Shift+A"), None);
        assert!(parse_key("Ctrl+K").is_some());
        assert!(parse_key("Alt+Shift+K").is_some());
    }
}
