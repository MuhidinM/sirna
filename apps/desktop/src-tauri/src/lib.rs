//! Sirna's Rust core: lives in the tray with no window open (plan §4.1).

mod commands;
mod db;
mod hotkey;
mod secrets;
mod startup;
mod tray;
mod windows;

use tauri::{Manager, RunEvent};

/// The argument the autostart entry passes, meaning "start in the tray only".
pub const AUTOSTART_ARG: &str = "--autostart";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // Registered first so a second launch never initialises anything else.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            windows::spawn_open_main(app.clone());
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![AUTOSTART_ARG]),
        ))
        .plugin(hotkey::plugin())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            app.manage(db::Db::open(&data_dir.join("sirna.db"))?);
            if let Err(error) = secrets::init() {
                eprintln!("could not open Windows Credential Manager: {error}");
            }
            app.manage(hotkey::ActiveHotkey::default());
            app.manage(hotkey::CapturePressedAt::default());
            let capture_key = hotkey::register(app.handle());
            tray::create(app.handle(), capture_key)?;
            if startup::should_open_main(std::env::args()) {
                windows::spawn_open_main(app.handle().clone());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::capture_commit,
            commands::capture_ready,
            commands::close_window,
            commands::secret_set,
            commands::secret_status
        ])
        .build(tauri::generate_context!())
        .expect("error while building Sirna");

    app.run(|_app, event| {
        if let RunEvent::ExitRequested { code, api, .. } = event {
            // code is None when the last window closed: stay in the tray.
            // Tray Quit calls app.exit(0), which sets a code and is let through.
            if startup::keep_running_on_exit_request(code) {
                api.prevent_exit();
            }
        }
    });
}
