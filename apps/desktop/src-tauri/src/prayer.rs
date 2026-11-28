//! Salat times from where you are (plan "Salat times from where I am", T-092).
//!
//! Calculated on the PC with the `salah` crate: no internet, no GPS. The
//! location is a city pick (Addis Ababa or Adama) or your own lat/lng. Times
//! are local Addis Ababa time (a fixed +3, like `session::local_minutes`).
//!
//! Each prayer is a set-time anchor: a toast `notify_after_min` after adhan,
//! and a quiet window from then (20 min; Jumu'ah 60 min) that pushes (#203)
//! and runs (#189) respect.

use rusqlite::{Connection, params};
use salah::{Configuration, Coordinates, Datelike, Madhab, Method, NaiveDate, Prayer, PrayerTimes};
use serde::Serialize;
use serde_json::Value;

const MINUTE_MS: i64 = 60_000;
const UTC_OFFSET_MIN: i64 = 180;
/// A prayer toast later than this (the PC slept) is not shown: the moment passed.
pub const LATE_MIN: i64 = 15;
pub const QUIET_MIN: i64 = 20;
pub const JUMUAH_QUIET_MIN: i64 = 60;
pub const DEFAULT_NOTIFY_AFTER_MIN: i64 = 5;

pub const ADDIS: (f64, f64) = (9.03, 38.74);
pub const ADAMA: (f64, f64) = (8.54, 39.27);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Calc {
    /// Muslim World League: Fajr 18°, Isha 17°.
    Mwl,
    /// Egyptian General Authority: Fajr 19.5°, Isha 17.5°.
    Egyptian,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Config {
    pub city: String,
    pub lat: f64,
    pub lng: f64,
    pub calc: Calc,
    pub hanafi: bool,
    /// Minutes added to each time, by name (fajr, sunrise, dhuhr, asr, maghrib, isha).
    pub offsets: [i64; 6],
    /// Jumu'ah in local minutes; None means at Dhuhr.
    pub jumuah: Option<i64>,
    pub notify_after_min: i64,
    pub enabled: bool,
    pub fajr_toast: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            city: "addis".into(),
            lat: ADDIS.0,
            lng: ADDIS.1,
            calc: Calc::Mwl,
            hanafi: false,
            offsets: [0; 6],
            jumuah: None,
            notify_after_min: DEFAULT_NOTIFY_AFTER_MIN,
            enabled: true,
            fajr_toast: true,
        }
    }
}

pub const NAMES: [&str; 6] = ["fajr", "sunrise", "dhuhr", "asr", "maghrib", "isha"];

fn setting(conn: &Connection, key: &str) -> Option<Value> {
    conn.query_row(
        "SELECT value_json FROM core_settings WHERE key = ?1",
        [key],
        |row| row.get::<_, String>(0),
    )
    .ok()
    .and_then(|json| serde_json::from_str(&json).ok())
}

fn number(value: Option<Value>) -> Option<f64> {
    match value? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

/// Reads the prayer settings, with the defaults where a setting is missing or bad.
pub fn config(conn: &Connection) -> Config {
    let mut config = Config::default();
    let city = setting(conn, "prayer.city")
        .and_then(|v| v.as_str().map(str::to_lowercase))
        .unwrap_or_else(|| "addis".into());
    let custom = (
        number(setting(conn, "prayer.lat")),
        number(setting(conn, "prayer.lng")),
    );
    let (lat, lng) = match (city.as_str(), custom) {
        ("adama", _) => ADAMA,
        ("custom", (Some(lat), Some(lng)))
            if (-90.0..=90.0).contains(&lat) && (-180.0..=180.0).contains(&lng) =>
        {
            (lat, lng)
        }
        _ => ADDIS,
    };
    config.city = match city.as_str() {
        "adama" => "adama".into(),
        "custom" if (lat, lng) != ADDIS => "custom".into(),
        _ => "addis".into(),
    };
    config.lat = lat;
    config.lng = lng;
    if setting(conn, "prayer.method").and_then(|v| v.as_str().map(str::to_lowercase))
        == Some("egyptian".into())
    {
        config.calc = Calc::Egyptian;
    }
    config.hanafi = setting(conn, "prayer.asr").and_then(|v| v.as_str().map(str::to_lowercase))
        == Some("hanafi".into());
    if let Some(Value::Object(map)) = setting(conn, "prayer.offsets") {
        for (index, name) in NAMES.iter().enumerate() {
            if let Some(minutes) = map.get(*name).and_then(Value::as_i64) {
                config.offsets[index] = minutes.clamp(-60, 60);
            }
        }
    }
    config.jumuah = setting(conn, "prayer.jumuah")
        .and_then(|v| v.as_str().and_then(crate::session::parse_hhmm))
        .map(i64::from);
    if let Some(minutes) = number(setting(conn, "prayer.notify_after_min")) {
        config.notify_after_min = (minutes as i64).clamp(0, 60);
    }
    config.enabled = setting(conn, "prayer.enabled") != Some(Value::Bool(false));
    config.fajr_toast = setting(conn, "prayer.fajr_toast") != Some(Value::Bool(false));
    config
}

/// One day's times, in local minutes from midnight.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Times {
    pub date: String,
    pub city: String,
    pub fajr: i64,
    pub sunrise: i64,
    pub dhuhr: i64,
    pub asr: i64,
    pub maghrib: i64,
    pub isha: i64,
    /// Fridays only: your Jumu'ah time (Dhuhr unless you set one).
    pub jumuah: Option<i64>,
}

pub fn parse_date(date: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()
}

/// Local midnight of `date`, as epoch ms.
pub fn midnight_ms(date: NaiveDate) -> i64 {
    date.and_hms_opt(0, 0, 0)
        .map_or(0, |at| at.and_utc().timestamp_millis())
        - UTC_OFFSET_MIN * MINUTE_MS
}

/// The local calendar date at `now_ms`.
pub fn local_date(now_ms: i64) -> NaiveDate {
    let days = (now_ms + UTC_OFFSET_MIN * MINUTE_MS).div_euclid(24 * 60 * MINUTE_MS);
    // 1970-01-01 is day 719 163 counted from 0001-01-01.
    i32::try_from(days + 719_163)
        .ok()
        .and_then(NaiveDate::from_num_days_from_ce_opt)
        .unwrap_or_default()
}

pub fn times(date: NaiveDate, config: &Config) -> Times {
    let method = match config.calc {
        Calc::Mwl => Method::MuslimWorldLeague,
        Calc::Egyptian => Method::Egyptian,
    };
    let madhab = if config.hanafi {
        Madhab::Hanafi
    } else {
        Madhab::Shafi
    };
    let parameters = Configuration::with(method, madhab);
    let schedule = PrayerTimes::new(date, Coordinates::new(config.lat, config.lng), parameters);
    let midnight = midnight_ms(date);
    let at = |prayer: Prayer, index: usize| {
        (schedule.time(prayer).timestamp_millis() - midnight).div_euclid(MINUTE_MS)
            + config.offsets[index]
    };
    let dhuhr = at(Prayer::Dhuhr, 2);
    Times {
        date: date.format("%Y-%m-%d").to_string(),
        city: config.city.clone(),
        fajr: at(Prayer::Fajr, 0),
        sunrise: at(Prayer::Sunrise, 1),
        dhuhr,
        asr: at(Prayer::Asr, 3),
        maghrib: at(Prayer::Maghrib, 4),
        isha: at(Prayer::Isha, 5),
        jumuah: (date.weekday() == salah::Weekday::Fri).then(|| config.jumuah.unwrap_or(dhuhr)),
    }
}

/// One prayer as an anchor: its name, adhan time and when the toast is due.
#[derive(Debug, Clone, PartialEq)]
pub struct Anchor {
    pub name: &'static str,
    /// Adhan (or your Jumu'ah time), local minutes.
    pub adhan: i64,
    /// Epoch ms of the toast (adhan + notify_after_min).
    pub notify_at: i64,
    pub quiet_min: i64,
}

/// The five prayers of the day as anchors (Jumu'ah instead of Dhuhr on Friday).
pub fn anchors(date: NaiveDate, config: &Config) -> Vec<Anchor> {
    let day = times(date, config);
    let midnight = midnight_ms(date);
    let anchor = |name: &'static str, adhan: i64, quiet_min: i64| Anchor {
        name,
        adhan,
        notify_at: midnight + (adhan + config.notify_after_min) * MINUTE_MS,
        quiet_min,
    };
    let noon = match day.jumuah {
        Some(at) => anchor("Jumu'ah", at, JUMUAH_QUIET_MIN),
        None => anchor("Dhuhr", day.dhuhr, QUIET_MIN),
    };
    vec![
        anchor("Fajr", day.fajr, QUIET_MIN),
        noon,
        anchor("Asr", day.asr, QUIET_MIN),
        anchor("Maghrib", day.maghrib, QUIET_MIN),
        anchor("Isha", day.isha, QUIET_MIN),
    ]
}

/// Windows (epoch ms, start..end) when pushes stay quiet and a run stops:
/// from each prayer's toast for 20 min (Jumu'ah 60). Empty when prayer times are off.
#[cfg_attr(not(test), allow(dead_code))] // used by pushes (#203) and run caps (#189)
pub fn quiet_windows(date: NaiveDate, config: &Config) -> Vec<(i64, i64)> {
    if !config.enabled {
        return Vec::new();
    }
    anchors(date, config)
        .into_iter()
        .map(|a| (a.notify_at, a.notify_at + a.quiet_min * MINUTE_MS))
        .collect()
}

pub fn hhmm(minutes: i64) -> String {
    let minutes = minutes.rem_euclid(24 * 60);
    format!("{:02}:{:02}", minutes / 60, minutes % 60)
}

/// A prayer toast to show now: its dedupe key and title (`Asr · 15:34`).
#[derive(Debug, Clone, PartialEq)]
pub struct Toast {
    pub key: String,
    pub title: String,
}

fn key(date: NaiveDate, name: &str) -> String {
    let slug: String = name
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect::<String>()
        .to_lowercase();
    format!("prayer:{}:{slug}", date.format("%Y-%m-%d"))
}

/// The prayer toasts due at `now_ms` that haven't been shown today. Pure on
/// the database: core_notifications (keyed by date and prayer) keeps each to
/// once a day, across restarts.
pub fn due(conn: &Connection, config: &Config, now_ms: i64) -> Vec<Toast> {
    if !config.enabled {
        return Vec::new();
    }
    let date = local_date(now_ms);
    anchors(date, config)
        .into_iter()
        .filter(|a| a.name != "Fajr" || config.fajr_toast)
        .filter(|a| now_ms >= a.notify_at && now_ms < a.notify_at + LATE_MIN * MINUTE_MS)
        .map(|a| Toast {
            key: key(date, a.name),
            title: format!("{} · {}", a.name, hhmm(a.adhan)),
        })
        .filter(|toast| {
            conn.query_row(
                "SELECT 1 FROM core_notifications WHERE key = ?1",
                [&toast.key],
                |_| Ok(()),
            )
            .is_err()
        })
        .collect()
}

/// Records a prayer toast as shown, so it never shows twice.
pub fn record(conn: &Connection, toast: &Toast, now_ms: i64) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO core_notifications (key, kind, fired_at) VALUES (?1, 'prayer', ?2)",
        params![toast.key, now_ms],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{db, migrate};

    fn open_db() -> Connection {
        let mut conn = Connection::open_in_memory().expect("open");
        db::configure(&conn).expect("pragmas");
        migrate::run(&mut conn, migrate::MIGRATIONS, 0).expect("migrate");
        conn
    }

    fn set(conn: &Connection, key: &str, json: &str) {
        conn.execute(
            "INSERT INTO core_settings (key, value_json, updated_at) VALUES (?1, ?2, 0)
             ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json",
            params![key, json],
        )
        .expect("setting");
    }

    fn date(text: &str) -> NaiveDate {
        parse_date(text).expect("date")
    }

    fn near(actual: i64, expected: &str) {
        let want = i64::from(crate::session::parse_hhmm(expected).expect("hh:mm"));
        assert!(
            (actual - want).abs() <= 2,
            "{} is not within 2 min of {expected}",
            hhmm(actual)
        );
    }

    #[test]
    fn addis_ababa_matches_islamicfinder() {
        // 2026-11-28, Muslim World League, Shafi'i (plan: checked against IslamicFinder).
        let day = times(date("2026-11-28"), &Config::default());
        near(day.fajr, "05:10");
        near(day.sunrise, "06:23");
        near(day.dhuhr, "12:14");
        near(day.asr, "15:34");
        near(day.maghrib, "18:04");
        near(day.isha, "19:13");
        assert_eq!(day.jumuah, None, "a Saturday");
    }

    #[test]
    fn adama_is_about_two_minutes_earlier() {
        let conn = open_db();
        set(&conn, "prayer.city", "\"adama\"");
        let config = config(&conn);
        assert_eq!((config.lat, config.lng), ADAMA);
        let addis = times(date("2026-11-28"), &Config::default());
        let adama = times(date("2026-11-28"), &config);
        let shift = addis.dhuhr - adama.dhuhr;
        assert!((1..=3).contains(&shift), "Dhuhr shift {shift}");
        assert!((addis.maghrib - adama.maghrib).abs() <= 3);
    }

    #[test]
    fn custom_location_and_bad_values_fall_back() {
        let conn = open_db();
        set(&conn, "prayer.city", "\"custom\"");
        set(&conn, "prayer.lat", "9.0");
        set(&conn, "prayer.lng", "38.0");
        assert_eq!((config(&conn).lat, config(&conn).lng), (9.0, 38.0));
        set(&conn, "prayer.lat", "\"north\"");
        assert_eq!(config(&conn).city, "addis");
        assert_eq!((config(&conn).lat, config(&conn).lng), ADDIS);
    }

    #[test]
    fn offsets_method_and_asr_apply() {
        let conn = open_db();
        let base = times(date("2026-11-28"), &config(&conn));
        set(&conn, "prayer.offsets", r#"{"fajr": 2, "isha": -3}"#);
        let shifted = times(date("2026-11-28"), &config(&conn));
        assert_eq!(shifted.fajr, base.fajr + 2);
        assert_eq!(shifted.isha, base.isha - 3);
        assert_eq!(shifted.dhuhr, base.dhuhr);

        set(&conn, "prayer.offsets", "{}");
        set(&conn, "prayer.method", "\"egyptian\"");
        set(&conn, "prayer.asr", "\"hanafi\"");
        let other = times(date("2026-11-28"), &config(&conn));
        // Egyptian Fajr (19.5°) is earlier; Hanafi Asr is later.
        assert!(other.fajr < base.fajr);
        assert!(other.asr > base.asr + 30);
    }

    #[test]
    fn friday_has_jumuah_at_dhuhr_or_your_time() {
        let friday = date("2026-11-27");
        let day = times(friday, &Config::default());
        assert_eq!(day.jumuah, Some(day.dhuhr));
        let anchors = anchors(friday, &Config::default());
        assert_eq!(anchors[1].name, "Jumu'ah");
        assert!(!anchors.iter().any(|a| a.name == "Dhuhr"));

        let conn = open_db();
        set(&conn, "prayer.jumuah", "\"12:30\"");
        assert_eq!(times(friday, &config(&conn)).jumuah, Some(12 * 60 + 30));
    }

    fn at(date_text: &str, hhmm_text: &str) -> i64 {
        midnight_ms(date(date_text))
            + i64::from(crate::session::parse_hhmm(hhmm_text).expect("hh:mm")) * MINUTE_MS
    }

    #[test]
    fn local_date_follows_addis_midnight() {
        assert_eq!(local_date(at("2026-11-28", "00:10")), date("2026-11-28"));
        assert_eq!(local_date(at("2026-11-27", "23:50")), date("2026-11-27"));
    }

    #[test]
    fn each_prayer_toasts_once_a_day_after_notify_minutes() {
        let conn = open_db();
        let config = Config::default();
        let asr = times(date("2026-11-28"), &config).asr;
        let notify = midnight_ms(date("2026-11-28")) + (asr + 5) * MINUTE_MS;

        assert!(due(&conn, &config, notify - MINUTE_MS).is_empty());
        let shown = due(&conn, &config, notify);
        assert_eq!(shown.len(), 1);
        assert_eq!(shown[0].title, format!("Asr · {}", hhmm(asr)));
        assert_eq!(shown[0].key, "prayer:2026-11-28:asr");
        record(&conn, &shown[0], notify).expect("record");
        // A restart re-reads core_notifications: no second toast.
        assert!(due(&conn, &config, notify + MINUTE_MS).is_empty());
        // Too late (the PC slept through it): nothing.
        assert!(due(&open_db(), &config, notify + LATE_MIN * MINUTE_MS).is_empty());
    }

    #[test]
    fn fajr_toast_and_prayer_times_can_be_turned_off() {
        let conn = open_db();
        let fajr = times(date("2026-11-28"), &Config::default()).fajr;
        let notify = midnight_ms(date("2026-11-28")) + (fajr + 5) * MINUTE_MS;
        assert_eq!(due(&conn, &config(&conn), notify).len(), 1);
        set(&conn, "prayer.fajr_toast", "false");
        assert!(due(&conn, &config(&conn), notify).is_empty());
        set(&conn, "prayer.fajr_toast", "true");
        set(&conn, "prayer.enabled", "false");
        assert!(due(&conn, &config(&conn), notify).is_empty());
        assert!(quiet_windows(date("2026-11-28"), &config(&conn)).is_empty());
    }

    #[test]
    fn friday_noon_toast_is_jumuah() {
        let conn = open_db();
        set(&conn, "prayer.jumuah", "\"12:30\"");
        set(&conn, "prayer.notify_after_min", "10");
        let toasts = due(&conn, &config(&conn), at("2026-11-27", "12:40"));
        assert_eq!(toasts.len(), 1);
        assert_eq!(toasts[0].title, "Jumu'ah · 12:30");
        assert_eq!(toasts[0].key, "prayer:2026-11-27:jumuah");
    }

    #[test]
    fn quiet_windows_start_at_the_toast() {
        let config = Config::default();
        let saturday = quiet_windows(date("2026-11-28"), &config);
        assert_eq!(saturday.len(), 5);
        let day = times(date("2026-11-28"), &config);
        let midnight = midnight_ms(date("2026-11-28"));
        assert_eq!(
            saturday[1],
            (
                midnight + (day.dhuhr + 5) * MINUTE_MS,
                midnight + (day.dhuhr + 25) * MINUTE_MS
            )
        );
        let friday = quiet_windows(date("2026-11-27"), &config);
        let (start, end) = friday[1];
        assert_eq!(end - start, JUMUAH_QUIET_MIN * MINUTE_MS);
    }
}
