//! The morning brief finds you (plan §3.4): it opens at the first unlock or
//! logon after wake time, before 13:00. If you were already at the desk before
//! wake time, a "Brief ready" toast comes at 07:30. A full-screen app or a
//! presentation gets the toast instead of a window.
//!
//! Lock state is polled every 2 seconds (one cheap Win32 call) rather than
//! hooking WM_WTSSESSION_CHANGE, which needs a window that the tray-only app
//! does not have.

use std::time::{Duration, Instant};

use parking_lot::Mutex;
use rusqlite::Connection;
use tauri::{AppHandle, Manager};

use crate::{clock, db::Db, notify, tasks, windows};

/// After 13:00 nothing pops; Today still shows the brief.
pub const CUTOFF_MIN: u32 = 13 * 60;
/// When the toast comes if no unlock opened the brief.
pub const TOAST_MIN: u32 = 7 * 60 + 30;
pub const DEFAULT_WAKE_MIN: u32 = 6 * 60;
/// The logical date the brief last opened or toasted.
pub const SHOWN_KEY: &str = "brief.shown";

const POLL: Duration = Duration::from_secs(2);
const TICK_EVERY: u32 = 30; // polls, so once a minute

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    /// Session unlock, or logon (the autostart launch).
    Unlock,
    /// The once-a-minute check while the session is unlocked.
    Tick,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BriefAction {
    Nothing,
    Open,
    Toast,
}

/// Pure decision, tested below. `busy` means full screen or presentation mode.
pub fn decide(
    trigger: Trigger,
    local_min: u32,
    wake_min: u32,
    shown_today: bool,
    busy: bool,
) -> BriefAction {
    if shown_today || local_min < wake_min || local_min >= CUTOFF_MIN {
        return BriefAction::Nothing;
    }
    match trigger {
        Trigger::Unlock if busy => BriefAction::Toast,
        Trigger::Unlock => BriefAction::Open,
        Trigger::Tick if local_min >= TOAST_MIN => BriefAction::Toast,
        Trigger::Tick => BriefAction::Nothing,
    }
}

/// Minutes after local midnight in Addis Ababa (UTC+3, no daylight saving).
pub fn local_minutes(now_ms: i64) -> u32 {
    let minutes = now_ms.div_euclid(60_000) + 180;
    minutes.rem_euclid(24 * 60) as u32
}

/// "06:30" → 390.
pub fn parse_hhmm(text: &str) -> Option<u32> {
    let (h, m) = text.split_once(':')?;
    let (h, m): (u32, u32) = (h.trim().parse().ok()?, m.trim().parse().ok()?);
    (h < 24 && m < 60).then_some(h * 60 + m)
}

fn wake_min(conn: &Connection) -> u32 {
    crate::db::setting_string(conn, "day.wake")
        .and_then(|text| parse_hhmm(&text))
        .unwrap_or(DEFAULT_WAKE_MIN)
}

fn shown_on(conn: &Connection, date: &str) -> bool {
    crate::db::setting_string(conn, SHOWN_KEY).as_deref() == Some(date)
}

fn mark_shown(conn: &mut Connection, date: &str, now_ms: i64) -> Result<(), String> {
    let txn = conn.transaction().map_err(|error| error.to_string())?;
    let mut values = serde_json::Map::new();
    values.insert(
        "value_json".into(),
        serde_json::Value::from(format!("\"{date}\"")),
    );
    let op = crate::tx::Op::Upsert {
        table: "core_settings".into(),
        id: SHOWN_KEY.into(),
        values,
    };
    crate::tx::apply_ops(&txn, "system", Some("brief"), &[op], now_ms)
        .map_err(|error| error.to_string())?;
    txn.commit().map_err(|error| error.to_string())
}

/// When the brief was asked for, so `brief_ready` can log how long it took.
#[derive(Default)]
pub struct BriefRequestedAt(pub Mutex<Option<Instant>>);

fn handle(app: &AppHandle, trigger: Trigger) {
    let now = clock::now_ms();
    let (date, _) = tasks::logical_day(now);
    let action = {
        let db = app.state::<Db>();
        let conn = db.write.lock();
        decide(
            trigger,
            local_minutes(now),
            wake_min(&conn),
            shown_on(&conn, &date),
            platform::busy(),
        )
    };
    if action == BriefAction::Nothing {
        return;
    }
    if let Err(error) = mark_shown(&mut app.state::<Db>().write.lock(), &date, now) {
        log::warn!("could not record the brief: {error}");
    }
    match action {
        BriefAction::Open => {
            log::info!("brief: opening on {trigger:?}");
            *app.state::<BriefRequestedAt>().0.lock() = Some(Instant::now());
            windows::spawn_open_main(app.clone());
        }
        BriefAction::Toast => {
            log::info!("brief: toast on {trigger:?}");
            show_toast(app);
        }
        BriefAction::Nothing => {}
    }
}

fn show_toast(app: &AppHandle) {
    let handle = app.clone();
    let buttons = [
        notify::Button {
            label: "Open",
            action: "open",
        },
        notify::Button {
            label: "Later",
            action: "later",
        },
    ];
    let result = notify::show(
        app,
        "Your morning brief is ready",
        "Today's plan, top 3 and how the week is going.",
        &buttons,
        move |action| {
            if action.as_deref() != Some("later") {
                windows::spawn_open_main(handle.clone());
            }
        },
    );
    if let Err(error) = result {
        log::error!("could not show the brief toast: {error}");
    }
}

/// Watches the session. `logon` is true for the autostart launch, which counts
/// as the first unlock of the day.
pub fn start(app: AppHandle, logon: bool) {
    app.manage(BriefRequestedAt::default());
    std::thread::Builder::new()
        .name("session".into())
        .spawn(move || {
            if logon && !platform::locked() {
                handle(&app, Trigger::Unlock);
            }
            let mut was_locked = platform::locked();
            let mut polls = 0u32;
            loop {
                std::thread::sleep(POLL);
                let locked = platform::locked();
                if was_locked && !locked {
                    handle(&app, Trigger::Unlock);
                    crate::review::tick(&app);
                }
                was_locked = locked;
                polls += 1;
                if polls >= TICK_EVERY {
                    polls = 0;
                    if !locked {
                        handle(&app, Trigger::Tick);
                        crate::review::tick(&app);
                    }
                }
            }
        })
        .expect("could not start the session thread");
}

/// What the brief's CHECK lines report (R-NOT-03).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Checks {
    pub notifications_muted: bool,
    pub autostart_off: bool,
}

pub fn checks(app: &AppHandle) -> Checks {
    use tauri_plugin_autostart::ManagerExt;
    let registered = app.autolaunch().is_enabled().unwrap_or(false);
    let name = app.package_info().name.clone();
    Checks {
        notifications_muted: platform::toasts_off(&notify::app_id(app)),
        autostart_off: !registered || platform::startup_disabled(&name),
    }
}

#[cfg(windows)]
mod platform {
    use windows_sys::Win32::System::Registry::{
        HKEY_CURRENT_USER, RRF_RT_REG_BINARY, RRF_RT_REG_DWORD, RegGetValueW,
    };
    use windows_sys::Win32::System::StationsAndDesktops::{
        CloseDesktop, DESKTOP_SWITCHDESKTOP, OpenInputDesktop,
    };
    use windows_sys::Win32::UI::Shell::{
        QUNS_BUSY, QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN,
        SHQueryUserNotificationState,
    };

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// The input desktop can't be opened while the lock screen is up.
    pub fn locked() -> bool {
        // SAFETY: plain Win32 calls; the handle is closed when non-null.
        unsafe {
            let desktop = OpenInputDesktop(0, 0, DESKTOP_SWITCHDESKTOP);
            if desktop.is_null() {
                return true;
            }
            CloseDesktop(desktop);
            false
        }
    }

    /// Full-screen app, game or presentation: toast instead of a window.
    pub fn busy() -> bool {
        let mut state = 0;
        // SAFETY: writes one enum value into `state`.
        let ok = unsafe { SHQueryUserNotificationState(&mut state) } == 0;
        ok && matches!(
            state,
            QUNS_BUSY | QUNS_RUNNING_D3D_FULL_SCREEN | QUNS_PRESENTATION_MODE
        )
    }

    fn dword(key: &str, value: &str) -> Option<u32> {
        let (key, value) = (wide(key), wide(value));
        let mut data = 0u32;
        let mut size = 4u32;
        // SAFETY: data and size describe a 4-byte buffer.
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                value.as_ptr(),
                RRF_RT_REG_DWORD,
                std::ptr::null_mut(),
                (&mut data as *mut u32).cast(),
                &mut size,
            )
        };
        (status == 0).then_some(data)
    }

    /// All toasts off, or Sirna's switch off, in Settings > Notifications.
    pub fn toasts_off(app_id: &str) -> bool {
        let all = dword(
            r"Software\Microsoft\Windows\CurrentVersion\PushNotifications",
            "ToastEnabled",
        );
        let ours = dword(
            &format!(r"Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\{app_id}"),
            "Enabled",
        );
        all == Some(0) || ours == Some(0)
    }

    /// Turned off in Task Manager > Startup apps (odd first byte = disabled).
    pub fn startup_disabled(name: &str) -> bool {
        let key = wide(r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run");
        let value = wide(name);
        let mut data = [0u8; 12];
        let mut size = data.len() as u32;
        // SAFETY: data and size describe a 12-byte buffer.
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                value.as_ptr(),
                RRF_RT_REG_BINARY,
                std::ptr::null_mut(),
                data.as_mut_ptr().cast(),
                &mut size,
            )
        };
        status == 0 && data[0] & 1 == 1
    }
}

#[cfg(not(windows))]
mod platform {
    pub fn locked() -> bool {
        false
    }
    pub fn busy() -> bool {
        false
    }
    pub fn toasts_off(_app_id: &str) -> bool {
        false
    }
    pub fn startup_disabled(_name: &str) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WAKE: u32 = 6 * 60;

    #[test]
    fn unlock_after_wake_opens_the_brief() {
        assert_eq!(
            decide(Trigger::Unlock, 6 * 60 + 40, WAKE, false, false),
            BriefAction::Open
        );
    }

    #[test]
    fn full_screen_gets_the_toast() {
        assert_eq!(
            decide(Trigger::Unlock, 9 * 60, WAKE, false, true),
            BriefAction::Toast
        );
    }

    #[test]
    fn once_a_day() {
        assert_eq!(
            decide(Trigger::Unlock, 9 * 60, WAKE, true, false),
            BriefAction::Nothing
        );
    }

    #[test]
    fn nothing_before_wake_or_after_13() {
        assert_eq!(
            decide(Trigger::Unlock, 5 * 60, WAKE, false, false),
            BriefAction::Nothing
        );
        assert_eq!(
            decide(Trigger::Unlock, 13 * 60, WAKE, false, false),
            BriefAction::Nothing
        );
        assert_eq!(
            decide(Trigger::Tick, 13 * 60 + 1, WAKE, false, false),
            BriefAction::Nothing
        );
    }

    #[test]
    fn already_at_the_desk_gets_a_toast_at_0730() {
        assert_eq!(
            decide(Trigger::Tick, 7 * 60 + 29, WAKE, false, false),
            BriefAction::Nothing
        );
        assert_eq!(
            decide(Trigger::Tick, 7 * 60 + 30, WAKE, false, false),
            BriefAction::Toast
        );
    }

    #[test]
    fn late_wake_moves_the_toast() {
        let wake = 8 * 60;
        assert_eq!(
            decide(Trigger::Tick, 7 * 60 + 45, wake, false, false),
            BriefAction::Nothing
        );
        assert_eq!(
            decide(Trigger::Tick, 8 * 60, wake, false, false),
            BriefAction::Toast
        );
    }

    #[test]
    fn local_minutes_is_addis_time() {
        // 2026-11-11 03:30 UTC is 06:30 in Addis Ababa.
        assert_eq!(local_minutes(1_794_367_800_000), 6 * 60 + 30);
    }

    #[test]
    fn parses_setup_times() {
        assert_eq!(parse_hhmm("06:30"), Some(390));
        assert_eq!(parse_hhmm("24:00"), None);
        assert_eq!(parse_hhmm("junk"), None);
    }

    #[test]
    fn records_the_day_it_showed() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::configure(&conn).unwrap();
        crate::migrate::run(&mut conn, crate::migrate::MIGRATIONS, 0).unwrap();
        assert!(!shown_on(&conn, "2026-11-11"));
        mark_shown(&mut conn, "2026-11-11", 0).unwrap();
        assert!(shown_on(&conn, "2026-11-11"));
        assert!(!shown_on(&conn, "2026-11-12"));
    }
}
