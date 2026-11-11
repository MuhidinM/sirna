//! Sirna's Rust core: lives in the tray with no window open (plan §4.1).

mod backup;
mod clock;
mod commands;
mod db;
mod hotkey;
mod migrate;
mod notify;
mod secrets;
mod startup;
mod tasks;
mod tray;
mod tx;
mod windows;

use tauri::{Listener, Manager, RunEvent};

/// The argument the autostart entry passes, meaning "start in the tray only".
pub const AUTOSTART_ARG: &str = "--autostart";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // Registered first so a second launch never initialises anything else.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            match startup::second_launch_action(args) {
                startup::SecondLaunch::OpenMain => windows::spawn_open_main(app.clone()),
                startup::SecondLaunch::TestToast => notify::show_check(app),
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![AUTOSTART_ARG]),
        ))
        .plugin(
            tauri_plugin_log::Builder::new()
                // Plan §9: size-based rotation, about 10 MB at most.
                .max_file_size(1_000_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(10))
                .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(hotkey::plugin())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let backups = backup::default_dir(&data_dir);
            app.manage(db::Db::open(
                &data_dir.join("sirna.db"),
                &backups,
                clock::now_ms(),
            )?);
            if let Err(error) = secrets::init() {
                log::error!("could not open Windows Credential Manager: {error}");
            }
            app.manage(hotkey::ActiveHotkey::default());
            app.manage(hotkey::CapturePressedAt::default());
            let saved_key =
                db::setting_string(&app.state::<db::Db>().write.lock(), "capture.hotkey");
            let capture_key = hotkey::register(app.handle(), saved_key);
            tray::create(app.handle(), capture_key.as_deref())?;
            // Any write (capture, Today screen, tray) refreshes the tray menu.
            let handle = app.handle().clone();
            app.listen_any("data-changed", move |_| tray::rebuild(&handle));
            if startup::should_open_main(std::env::args()) {
                windows::spawn_open_main(app.handle().clone());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::capture_commit,
            commands::capture_undo,
            commands::db_query,
            commands::db_tx,
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
