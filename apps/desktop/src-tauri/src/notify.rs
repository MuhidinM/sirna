//! Windows toasts with buttons that Rust handles with no window open (plan §8).
//!
//! Built on tauri-winrt-notification rather than tauri-plugin-notification:
//! the plugin ignores schedules on desktop and only reports clicks while the
//! toast is on screen.

use tauri::AppHandle;
use tauri_winrt_notification::{Toast, ToastDismissalReason};

use crate::windows;

/// A toast button: its label and the action string Windows hands back.
pub struct Button {
    pub label: &'static str,
    pub action: &'static str,
}

/// The app id Windows uses to brand and route toasts. The installed build's
/// Start-menu shortcut carries the bundle identifier; a dev build has no
/// shortcut, so it borrows PowerShell's id (toasts then show "Windows PowerShell").
pub fn app_id(app: &AppHandle) -> String {
    if cfg!(debug_assertions) {
        Toast::POWERSHELL_APP_ID.to_string()
    } else {
        app.config().identifier.clone()
    }
}

/// Shows a toast. `on_action` receives the clicked button's action, or None
/// when the body was clicked.
pub fn show<F>(
    app: &AppHandle,
    title: &str,
    body: &str,
    buttons: &[Button],
    on_action: F,
) -> tauri_winrt_notification::Result<()>
where
    F: Fn(Option<String>) + Send + 'static,
{
    let mut toast = Toast::new(&app_id(app)).title(title).text1(body);
    for button in buttons {
        toast = toast.add_button(button.label, button.action);
    }
    toast
        .on_activated(move |action| {
            on_action(action);
            Ok(())
        })
        .on_dismissed(|reason| {
            log::info!("toast dismissed: {}", dismissal_label(reason));
            Ok(())
        })
        .show()
}

fn dismissal_label(reason: Option<ToastDismissalReason>) -> &'static str {
    match reason {
        Some(ToastDismissalReason::UserCanceled) => "user",
        Some(ToastDismissalReason::ApplicationHidden) => "app",
        Some(ToastDismissalReason::TimedOut) => "timed out",
        _ => "unknown",
    }
}

/// The M0 check toast (tray → Test notification): proves both buttons reach
/// Rust with no window open, in the installed build. T-017 replaces it with
/// real reminders.
pub fn show_check(app: &AppHandle) {
    let handle = app.clone();
    let buttons = [
        Button {
            label: "Open Sirna",
            action: "open",
        },
        Button {
            label: "Got it",
            action: "ok",
        },
    ];
    let result = show(
        app,
        "Sirna is running",
        "Notifications work. Pick a button to test it.",
        &buttons,
        move |action| {
            log::info!("toast action: {}", action.as_deref().unwrap_or("body"));
            if action.as_deref() == Some("open") || action.is_none() {
                windows::spawn_open_main(handle.clone());
            }
        },
    );
    if let Err(error) = result {
        log::error!("could not show the check toast: {error}");
    }
}
