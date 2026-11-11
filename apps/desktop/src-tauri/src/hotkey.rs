//! The global capture hotkey (plan §3.5), acting on key press only.
//!
//! Ctrl+Alt+Space is the first choice, but another app may already own it
//! (on the development machine it is taken). Sirna then tries the next
//! candidate and shows whichever one works in the tray tooltip. A setting to
//! pick your own arrives with the capture window work (T-015).

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
pub struct ActiveHotkey(pub Mutex<Option<(Shortcut, &'static str)>>);

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

/// Registers the first free candidate and returns its label, or None if every
/// candidate is taken.
pub fn register(app: &AppHandle) -> Option<&'static str> {
    for (modifiers, code, label) in CANDIDATES {
        let shortcut = Shortcut::new(Some(modifiers), code);
        match app.global_shortcut().register(shortcut) {
            Ok(()) => {
                *app.state::<ActiveHotkey>().0.lock() = Some((shortcut, label));
                return Some(label);
            }
            Err(error) => eprintln!("could not register {label}: {error}"),
        }
    }
    None
}
