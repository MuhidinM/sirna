//! Do not disturb during focus (plan §3.6a, ADR-0007). Windows 11 has no
//! documented API; this uses the undocumented `QuietHoursSettings` COM server
//! (hosted by WpnUserService) that the system's own bell uses. Tested on build
//! 26300 (T-029): PriorityOnly on, then back to Unrestricted, both confirmed
//! through the WNF quiet-hours state.
//!
//! Rules:
//! * On only when you had it off, so your own choice is never overridden.
//! * Off again when the focus session ends, before the break toast (which
//!   Do not disturb would hide), and only if it is still what Sirna set.
//! * The original is saved in the database first, so a crash is undone at
//!   the next start.
//! * Any COM failure (a future Windows build) means nothing happens and the
//!   kit's "Do not disturb on (Win+N)" tick is the fallback.

use rusqlite::Connection;
use tauri::{AppHandle, Manager};

use crate::{clock, db::Db};

pub const UNRESTRICTED: &str = "Microsoft.QuietHoursProfile.Unrestricted";
pub const PRIORITY_ONLY: &str = "Microsoft.QuietHoursProfile.PriorityOnly";
/// The profile to put back; present only while Sirna has DND on.
const RESTORE_KEY: &str = "dnd.restore";
/// `"off"` turns the feature off.
const ENABLED_KEY: &str = "focus.dnd";

#[derive(Debug, PartialEq)]
pub enum Action {
    Nothing,
    /// Save the current profile, then switch to PriorityOnly.
    TurnOn,
    /// Put this profile back.
    Restore(String),
    /// The user changed it meanwhile: leave Windows alone, forget the save.
    Forget,
}

/// Pure decision. `current` is None when the profile can't be read.
pub fn decide(focusing: bool, enabled: bool, saved: Option<&str>, current: Option<&str>) -> Action {
    match (focusing, saved) {
        (true, None) if enabled && current == Some(UNRESTRICTED) => Action::TurnOn,
        (false, Some(original)) if current == Some(PRIORITY_ONLY) => {
            Action::Restore(original.to_string())
        }
        // Unreadable: keep the save and try again later, never forget blind.
        (false, Some(_)) if current.is_none() => Action::Nothing,
        (false, Some(_)) => Action::Forget,
        _ => Action::Nothing,
    }
}

fn saved(conn: &Connection) -> Option<String> {
    crate::db::setting_string(conn, RESTORE_KEY)
}

fn enabled(conn: &Connection) -> bool {
    crate::db::setting_string(conn, ENABLED_KEY).as_deref() != Some("off")
}

fn save(conn: &Connection, profile: Option<&str>) {
    let result = match profile {
        Some(profile) => conn.execute(
            "INSERT INTO core_settings (key, value_json, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
            rusqlite::params![
                RESTORE_KEY,
                serde_json::Value::from(profile).to_string(),
                clock::now_ms()
            ],
        ),
        None => conn.execute("DELETE FROM core_settings WHERE key = ?1", [RESTORE_KEY]),
    };
    if let Err(error) = result {
        log::warn!("dnd: could not record the original profile: {error}");
    }
}

/// How many times a restore is tried right away before waiting for the next
/// minute tick.
const RESTORE_TRIES: u32 = 3;

/// Brings Windows in line with the timer: on while focusing, restored after.
/// Cheap when nothing changes (no COM call unless there may be work to do).
/// `focusing` is read under the lock, so the last sync to run always sees
/// the timer's current state, whatever order queued syncs wake in.
pub fn sync(app: &AppHandle, focusing: impl FnOnce() -> bool) {
    // One sync at a time: two quick timer changes must not interleave writes.
    static SYNC: parking_lot::Mutex<()> = parking_lot::Mutex::new(());
    let _one_at_a_time = SYNC.lock();
    let focusing = focusing();
    let (saved, enabled) = {
        let db = app.state::<Db>();
        let conn = db.write.lock();
        (saved(&conn), enabled(&conn))
    };
    // Nothing to turn on or restore: skip the COM round trip.
    if (focusing && (saved.is_some() || !enabled)) || (!focusing && saved.is_none()) {
        return;
    }
    let current = match platform::get_profile() {
        Ok(profile) => Some(profile),
        Err(error) => {
            log::warn!("dnd: could not read the profile: {error}");
            None
        }
    };
    let action = decide(focusing, enabled, saved.as_deref(), current.as_deref());
    let db = app.state::<Db>();
    match action {
        Action::Nothing => {}
        Action::TurnOn => {
            // Crash insurance first, then the switch.
            save(&db.write.lock(), current.as_deref());
            match platform::set_profile(PRIORITY_ONLY) {
                Ok(()) => log::info!("dnd: on for focus"),
                // Nothing reached Windows: nothing to undo.
                Err(SetError::NotSent(error)) => {
                    log::warn!("dnd: could not turn it on: {error}");
                    save(&db.write.lock(), None);
                }
                // Sent but not confirmed yet: it may still land, so keep the
                // save; the session-end sync restores or forgets it.
                Err(SetError::Unconfirmed(error)) => {
                    log::warn!("dnd: turning on not confirmed yet: {error}");
                }
            }
        }
        Action::Restore(original) => {
            for attempt in 1..=RESTORE_TRIES {
                match platform::set_profile(&original) {
                    Ok(()) => {
                        log::info!("dnd: restored {original}");
                        save(&db.write.lock(), None);
                        return;
                    }
                    Err(error) => log::warn!(
                        "dnd: restore {original}, try {attempt} of {RESTORE_TRIES}: {}",
                        error.message()
                    ),
                }
            }
            // Keep the save: the minute tick and the next start try again.
        }
        Action::Forget => {
            log::info!("dnd: changed by you during focus; left as it is");
            save(&db.write.lock(), None);
        }
    }
}

/// Why a switch did not complete.
#[derive(Debug)]
pub enum SetError {
    /// Windows never got the request: nothing changed.
    NotSent(String),
    /// Sent, but Windows had not applied it within 3 s; it may still land.
    Unconfirmed(String),
}

impl SetError {
    pub fn message(&self) -> &str {
        match self {
            SetError::NotSent(message) | SetError::Unconfirmed(message) => message,
        }
    }
}

/// The WNF level Windows shows for a profile, when known.
pub fn level(profile: &str) -> Option<u32> {
    match profile.rsplit('.').next() {
        Some("Unrestricted") => Some(0),
        Some("PriorityOnly") => Some(1),
        Some("AlarmsOnly") => Some(2),
        _ => None,
    }
}

/// Whether the COM route answers on this Windows build (for the sheet).
pub fn available() -> bool {
    platform::get_profile().is_ok()
}

#[cfg(windows)]
mod platform {
    use std::ffi::c_void;

    use windows_sys::Win32::System::Com::{
        CLSCTX_LOCAL_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
        CoTaskMemFree, CoUninitialize,
    };
    use windows_sys::core::{GUID, HRESULT};

    const CLSID_QUIET_HOURS_SETTINGS: GUID =
        GUID::from_u128(0xF53321FA_34F8_4B7F_B9A3_361877CB94CF);
    const IID_IQUIET_HOURS_SETTINGS: GUID = GUID::from_u128(0x6BFF4732_81EC_4FFB_AE67_B6C1BC29631F);

    /// IUnknown, then get_UserSelectedProfile (slot 3) and put_UserSelectedProfile (slot 4).
    #[repr(C)]
    struct Vtbl {
        query_interface: usize,
        add_ref: usize,
        release: unsafe extern "system" fn(*mut c_void) -> u32,
        get_profile: unsafe extern "system" fn(*mut c_void, *mut *mut u16) -> HRESULT,
        put_profile: unsafe extern "system" fn(*mut c_void, *const u16) -> HRESULT,
    }

    /// Runs `f` with the COM object on a fresh single-threaded apartment, as
    /// the server expects, and joins. Each call takes a few milliseconds.
    fn with_settings<T: Send + 'static>(
        f: impl FnOnce(*mut c_void, &Vtbl) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        std::thread::spawn(move || {
            // SAFETY: COM is initialised and uninitialised on this thread only;
            // the object pointer is released before uninitialising.
            unsafe {
                let init = CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32);
                if init < 0 {
                    return Err(format!("CoInitializeEx 0x{init:08X}"));
                }
                let mut object: *mut c_void = std::ptr::null_mut();
                let created = CoCreateInstance(
                    &CLSID_QUIET_HOURS_SETTINGS,
                    std::ptr::null_mut(),
                    CLSCTX_LOCAL_SERVER,
                    &IID_IQUIET_HOURS_SETTINGS,
                    &mut object,
                );
                let result = if created < 0 || object.is_null() {
                    Err(format!("CoCreateInstance 0x{created:08X}"))
                } else {
                    let vtbl = &**(object as *mut *const Vtbl);
                    let result = f(object, vtbl);
                    (vtbl.release)(object);
                    result
                };
                CoUninitialize();
                result
            }
        })
        .join()
        .map_err(|_| "the COM thread panicked".to_string())?
    }

    pub fn get_profile() -> Result<String, String> {
        with_settings(|object, vtbl| {
            let mut text: *mut u16 = std::ptr::null_mut();
            // SAFETY: slot 3 writes a CoTaskMemAlloc'd, NUL-terminated string.
            unsafe {
                let hr = (vtbl.get_profile)(object, &mut text);
                if hr < 0 || text.is_null() {
                    return Err(format!("get_UserSelectedProfile 0x{hr:08X}"));
                }
                let mut length = 0;
                while *text.add(length) != 0 {
                    length += 1;
                }
                let profile = String::from_utf16_lossy(std::slice::from_raw_parts(text, length));
                CoTaskMemFree(text as *const c_void);
                Ok(profile)
            }
        })
    }

    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn NtQueryWnfStateData(
            state_name: *const u64,
            type_id: *const c_void,
            explicit_scope: *const c_void,
            change_stamp: *mut u32,
            buffer: *mut c_void,
            buffer_size: *mut u32,
        ) -> i32;
    }

    /// WNF_SHEL_QUIETHOURS_ACTIVE_PROFILE_CHANGED: what Windows actually
    /// applied. 0 off, 1 priority only, 2 alarms only.
    const WNF_QUIET_HOURS: u64 = 0x0D83_063E_A3BF_1C75;

    pub fn applied_level() -> Option<u32> {
        let mut buffer = [0u8; 16];
        let mut size = buffer.len() as u32;
        let mut stamp = 0u32;
        // SAFETY: every pointer is to a local of the stated size.
        let status = unsafe {
            NtQueryWnfStateData(
                &WNF_QUIET_HOURS,
                std::ptr::null(),
                std::ptr::null(),
                &mut stamp,
                buffer.as_mut_ptr().cast(),
                &mut size,
            )
        };
        (status >= 0 && size >= 4)
            .then(|| u32::from_le_bytes([buffer[0], buffer[1], buffer[2], buffer[3]]))
    }

    fn put(profile: &str) -> Result<(), String> {
        let wide: Vec<u16> = profile.encode_utf16().chain(std::iter::once(0)).collect();
        with_settings(move |object, vtbl| {
            // SAFETY: `wide` is NUL-terminated and outlives the call.
            let hr = unsafe { (vtbl.put_profile)(object, wide.as_ptr()) };
            if hr < 0 {
                Err(format!("put_UserSelectedProfile 0x{hr:08X}"))
            } else {
                Ok(())
            }
        })
    }

    /// Sets the profile and waits until Windows has applied it. The change is
    /// applied asynchronously: two quick writes can land out of order (seen
    /// in T-029), and the read-back alone can report a value that then
    /// reverts. So success means the WNF state shows the new level too.
    pub fn set_profile(profile: &str) -> Result<(), super::SetError> {
        let expected = super::level(profile);
        put(profile).map_err(super::SetError::NotSent)?;
        for _ in 0..30 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            let applied = applied_level();
            if (expected.is_none() || applied == expected)
                && get_profile().ok().as_deref() == Some(profile)
            {
                return Ok(());
            }
        }
        Err(super::SetError::Unconfirmed(format!(
            "{profile} not applied after 3 s (WNF {:?})",
            applied_level()
        )))
    }
}

#[cfg(not(windows))]
mod platform {
    pub fn get_profile() -> Result<String, String> {
        Err("not Windows".into())
    }
    pub fn set_profile(_profile: &str) -> Result<(), super::SetError> {
        Err(super::SetError::NotSent("not Windows".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn turns_on_only_when_you_had_it_off() {
        assert_eq!(decide(true, true, None, Some(UNRESTRICTED)), Action::TurnOn);
        assert_eq!(
            decide(true, true, None, Some(PRIORITY_ONLY)),
            Action::Nothing,
            "already on: yours, leave it"
        );
        assert_eq!(
            decide(
                true,
                true,
                None,
                Some("Microsoft.QuietHoursProfile.AlarmsOnly")
            ),
            Action::Nothing
        );
        assert_eq!(
            decide(true, true, None, None),
            Action::Nothing,
            "unreadable"
        );
        assert_eq!(
            decide(true, false, None, Some(UNRESTRICTED)),
            Action::Nothing,
            "turned off"
        );
    }

    #[test]
    fn restores_what_it_saved_when_focus_ends() {
        assert_eq!(
            decide(false, true, Some(UNRESTRICTED), Some(PRIORITY_ONLY)),
            Action::Restore(UNRESTRICTED.into())
        );
        // Restores even if the feature was switched off mid-session.
        assert_eq!(
            decide(false, false, Some(UNRESTRICTED), Some(PRIORITY_ONLY)),
            Action::Restore(UNRESTRICTED.into())
        );
    }

    #[test]
    fn keeps_the_save_when_the_profile_cant_be_read() {
        assert_eq!(
            decide(false, true, Some(UNRESTRICTED), None),
            Action::Nothing
        );
    }

    #[test]
    fn leaves_your_change_alone() {
        assert_eq!(
            decide(false, true, Some(UNRESTRICTED), Some(UNRESTRICTED)),
            Action::Forget
        );
        assert_eq!(
            decide(
                false,
                true,
                Some(UNRESTRICTED),
                Some("Microsoft.QuietHoursProfile.AlarmsOnly")
            ),
            Action::Forget
        );
    }

    #[test]
    fn nothing_to_do_while_on_or_idle() {
        assert_eq!(
            decide(true, true, Some(UNRESTRICTED), Some(PRIORITY_ONLY)),
            Action::Nothing
        );
        assert_eq!(
            decide(false, true, None, Some(UNRESTRICTED)),
            Action::Nothing
        );
    }

    #[test]
    fn remembers_the_original_until_restored() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::configure(&conn).unwrap();
        crate::migrate::run(&mut conn, crate::migrate::MIGRATIONS, 0).unwrap();
        assert_eq!(saved(&conn), None);
        save(&conn, Some(UNRESTRICTED));
        assert_eq!(saved(&conn).as_deref(), Some(UNRESTRICTED));
        save(&conn, None);
        assert_eq!(saved(&conn), None);
        assert!(enabled(&conn));
    }

    /// Live check against Windows; changes the setting for a moment, then
    /// restores it. Run with `cargo test dnd::tests::live -- --ignored`.
    #[test]
    #[ignore]
    fn live_round_trip() {
        let before = platform::get_profile().expect("read");
        assert_eq!(
            before, UNRESTRICTED,
            "turn Do not disturb off before running"
        );
        let on = platform::set_profile(PRIORITY_ONLY);
        // Always try to restore, even if switching on failed.
        let restored = platform::set_profile(&before);
        on.expect("on");
        restored.expect("restore");
        // The race seen in T-029 showed up only afterwards: check again later.
        std::thread::sleep(std::time::Duration::from_secs(2));
        assert_eq!(platform::get_profile().expect("read later"), before);
        assert_eq!(platform::applied_level(), Some(0), "Windows applied off");
    }

    #[test]
    fn knows_the_levels() {
        assert_eq!(level(UNRESTRICTED), Some(0));
        assert_eq!(level(PRIORITY_ONLY), Some(1));
        assert_eq!(level("Microsoft.QuietHoursProfile.AlarmsOnly"), Some(2));
        assert_eq!(level("something new"), None);
    }
}
