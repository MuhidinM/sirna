//! Away mode (plan §3.11): `away till mon` pauses the brief, the night review
//! and block toasts until that day. Your own reminders still fire. Coming back
//! needs nothing: the day you set starts with a fresh plan as usual.

use rusqlite::Connection;

/// The logical date you are back (YYYY-MM-DD); away while today is before it.
pub const AWAY_KEY: &str = "away.until";

/// Pure: away on `today` when the return date is later.
pub fn is_away_on(until: Option<&str>, today: &str) -> bool {
    until.is_some_and(|until| until > today)
}

pub fn is_away(conn: &Connection, today: &str) -> bool {
    is_away_on(crate::db::setting_string(conn, AWAY_KEY).as_deref(), today)
}

/// A YYYY-MM-DD date, checked by shape and range (not by calendar).
pub fn valid_date(text: &str) -> bool {
    let parts: Vec<&str> = text.split('-').collect();
    matches!(parts.as_slice(), [y, m, d]
        if y.len() == 4 && m.len() == 2 && d.len() == 2
            && y.chars().chain(m.chars()).chain(d.chars()).all(|c| c.is_ascii_digit())
            && (1..=12).contains(&m.parse::<u32>().unwrap_or(0))
            && (1..=31).contains(&d.parse::<u32>().unwrap_or(0)))
}

/// The return date to store: the given date if it is after today, else
/// tomorrow (`away` alone means "not today").
pub fn return_date(until: Option<&str>, today: &str, tomorrow: &str) -> String {
    match until {
        Some(date) if valid_date(date) && date > today => date.to_string(),
        _ => tomorrow.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn away_until_the_return_day() {
        assert!(is_away_on(Some("2026-11-16"), "2026-11-11"));
        assert!(is_away_on(Some("2026-11-16"), "2026-11-15"));
        assert!(
            !is_away_on(Some("2026-11-16"), "2026-11-16"),
            "back that day"
        );
        assert!(!is_away_on(None, "2026-11-11"));
    }

    #[test]
    fn undoing_the_capture_ends_away() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::configure(&conn).unwrap();
        crate::migrate::run(&mut conn, crate::migrate::MIGRATIONS, 0).unwrap();
        let set = |conn: &mut Connection, date: &str, context: &str| {
            let txn = conn.transaction().unwrap();
            let mut values = serde_json::Map::new();
            values.insert(
                "value_json".into(),
                serde_json::Value::from(serde_json::Value::from(date).to_string()),
            );
            let op = crate::tx::Op::Upsert {
                table: "core_settings".into(),
                id: AWAY_KEY.into(),
                values,
            };
            crate::tx::apply_ops(&txn, "user", Some(context), &[op], 1).unwrap();
            txn.commit().unwrap();
        };
        // Away till the 16th, from capture 7 (the way set_away logs it).
        set(&mut conn, "2026-11-16", "capture:7");
        assert!(is_away(&conn, "2026-11-11"));
        let txn = conn.transaction().unwrap();
        crate::tx::undo_context(&txn, "user", "capture:7", 2).unwrap();
        txn.commit().unwrap();
        assert!(!is_away(&conn, "2026-11-11"));

        // An earlier away survives undoing a later change to it.
        set(&mut conn, "2026-11-13", "away");
        set(&mut conn, "2026-11-20", "capture:8");
        let txn = conn.transaction().unwrap();
        crate::tx::undo_context(&txn, "user", "capture:8", 3).unwrap();
        txn.commit().unwrap();
        assert_eq!(
            crate::db::setting_string(&conn, AWAY_KEY).as_deref(),
            Some("2026-11-13")
        );
    }

    #[test]
    fn return_dates() {
        assert_eq!(
            return_date(Some("2026-11-16"), "2026-11-11", "2026-11-12"),
            "2026-11-16"
        );
        assert_eq!(return_date(None, "2026-11-11", "2026-11-12"), "2026-11-12");
        assert_eq!(
            return_date(Some("2026-11-11"), "2026-11-11", "2026-11-12"),
            "2026-11-12"
        );
        assert_eq!(
            return_date(Some("junk"), "2026-11-11", "2026-11-12"),
            "2026-11-12"
        );
        assert!(!valid_date("2026-13-01"));
        assert!(!valid_date("2026-1-01"));
        assert!(valid_date("2027-01-31"));
    }
}
