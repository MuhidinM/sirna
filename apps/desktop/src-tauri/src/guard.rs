//! The burnout guard (plan §3.7): a daily focus cap and a hard stop. Neither
//! blocks you; they make stopping the default and continuing a second tap.
//!
//! * Cap (default 4 h of focus outside job blocks): one toast when reached;
//!   later sessions are allowed and marked `overrun`.
//! * Hard stop (default 22:30): one toast; until 03:00 the tray shows
//!   "Stopped for today" and a new session needs a second tap.

use rusqlite::Connection;
use tauri::{AppHandle, Manager};

use crate::{clock, db::Db, notify, review, session, tasks};

pub const DEFAULT_CAP_MIN: i64 = 4 * 60;
const CAP_TOASTED_KEY: &str = "guard.cap_toasted";
const STOP_TOASTED_KEY: &str = "guard.stop_toasted";

/// Pure: past the hard stop and before the day ends at 03:00.
pub fn stopped(local_min: u32, hard_stop_min: u32) -> bool {
    review::logical_minutes(local_min) >= review::logical_minutes(hard_stop_min)
}

/// Pure: whether this many focused minutes today reach the cap.
pub fn at_cap(focused_min: i64, cap_min: i64) -> bool {
    cap_min > 0 && focused_min >= cap_min
}

/// Focused minutes today, outside job (fixed) blocks. ?1 day start, ?2 now.
pub const FOCUSED_TODAY_SQL: &str = "
  SELECT COALESCE(SUM(MAX(0, (COALESCE(f.ended_at, ?2) - f.started_at - f.paused_ms) / 60000)), 0)
  FROM focus_sessions AS f
  LEFT JOIN day_blocks AS b ON b.id = f.block_id
  WHERE f.kind = 'focus' AND f.started_at >= ?1 AND COALESCE(b.kind, '') != 'fixed'";

pub fn focused_today(conn: &Connection, now_ms: i64) -> i64 {
    let (_, day_start) = tasks::logical_day(now_ms);
    conn.query_row(FOCUSED_TODAY_SQL, [day_start, now_ms], |row| row.get(0))
        .unwrap_or(0)
}

fn cap_min(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT value_json FROM core_settings WHERE key = 'focus.daily_cap_min'",
        [],
        |row| row.get::<_, String>(0),
    )
    .ok()
    .and_then(|json| json.trim().parse().ok())
    .unwrap_or(DEFAULT_CAP_MIN)
}

fn hard_stop_min(conn: &Connection) -> u32 {
    crate::db::setting_string(conn, "day.hard_stop")
        .and_then(|text| session::parse_hhmm(&text))
        .unwrap_or(review::DEFAULT_HARD_STOP_MIN)
}

/// Past the hard stop now (for the tray and for starting focus).
pub fn stopped_now(conn: &Connection, now_ms: i64) -> bool {
    stopped(session::local_minutes(now_ms), hard_stop_min(conn))
}

/// Records a once-a-day flag; true when it was not set yet today.
fn first_today(conn: &Connection, key: &str, date: &str) -> bool {
    if crate::db::setting_string(conn, key).as_deref() == Some(date) {
        return false;
    }
    // A plain marker, like the brief's: not user data, so no audit row.
    let _ = conn.execute(
        "INSERT INTO core_settings (key, value_json, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
        rusqlite::params![key, format!("\"{date}\""), clock::now_ms()],
    );
    true
}

/// After a focus session is saved: mark it overrun past the cap.
pub fn after_start(app: &AppHandle, session_id: &str) {
    let db = app.state::<Db>();
    let conn = db.write.lock();
    let now = clock::now_ms();
    let started_min = focused_today(&conn, now);
    if at_cap(started_min, cap_min(&conn)) {
        let _ = conn.execute(
            "UPDATE focus_sessions SET overrun = 1 WHERE id = ?1",
            [session_id],
        );
        log::info!("focus: session {session_id} is past the daily cap");
    }
}

/// After a session completes: the cap toast, once a day.
pub fn after_complete(app: &AppHandle) {
    let now = clock::now_ms();
    let (date, _) = tasks::logical_day(now);
    let (reached, cap) = {
        let db = app.state::<Db>();
        let conn = db.write.lock();
        let cap = cap_min(&conn);
        let reached =
            at_cap(focused_today(&conn, now), cap) && first_today(&conn, CAP_TOASTED_KEY, &date);
        (reached, cap)
    };
    if reached {
        let hours = cap as f64 / 60.0;
        let text = if cap % 60 == 0 {
            format!("That's {} h. Stop here; tomorrow is planned.", cap / 60)
        } else {
            format!("That's {hours:.1} h. Stop here; tomorrow is planned.")
        };
        if let Err(error) = notify::show(app, "Daily focus cap", &text, &[], |_| {}) {
            log::warn!("could not show the cap toast: {error}");
        }
    }
}

/// Once a minute (session thread): the hard stop toast, once a day.
pub fn tick(app: &AppHandle) {
    let now = clock::now_ms();
    let (date, _) = tasks::logical_day(now);
    let toast = {
        let db = app.state::<Db>();
        let conn = db.write.lock();
        stopped_now(&conn, now) && first_today(&conn, STOP_TOASTED_KEY, &date)
    };
    if toast {
        if let Err(error) = notify::show(
            app,
            "Hard stop. Good day.",
            "New focus sessions need a second tap until 03:00.",
            &[],
            |_| {},
        ) {
            log::warn!("could not show the hard stop toast: {error}");
        }
        crate::tray::rebuild(app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const STOP: u32 = 22 * 60 + 30;

    #[test]
    fn stopped_from_hard_stop_until_three() {
        assert!(!stopped(22 * 60 + 29, STOP));
        assert!(stopped(22 * 60 + 30, STOP));
        assert!(stopped(2 * 60 + 59, STOP));
        assert!(!stopped(3 * 60, STOP));
        assert!(!stopped(12 * 60, STOP));
    }

    #[test]
    fn cap_at_four_hours() {
        assert!(!at_cap(239, 240));
        assert!(at_cap(240, 240));
        assert!(!at_cap(1000, 0), "a cap of 0 means no cap");
    }

    fn db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::configure(&conn).unwrap();
        crate::migrate::run(&mut conn, crate::migrate::MIGRATIONS, 0).unwrap();
        conn
    }

    #[test]
    fn counts_focus_outside_job_blocks() {
        let conn = db();
        // 2026-11-11 12:00 Addis = 09:00 UTC.
        let noon = 1_794_387_600_000_i64;
        let min = 60_000;
        conn.execute_batch(&format!(
            "INSERT INTO day_blocks (id, logical_date, start_at, end_at, kind, title, created_at, updated_at)
               VALUES ('job', '2026-11-11', 0, 1, 'fixed', 'Job A', 0, 0),
                      ('code', '2026-11-11', 0, 1, 'area', 'Coding', 0, 0);
             INSERT INTO focus_sessions (id, block_id, kind, started_at, planned_min, paused_ms, ended_at) VALUES
               ('a', 'code', 'focus', {a}, 50, 0, {a_end}),
               ('b', NULL, 'focus', {b}, 25, {pause}, {b_end}),
               ('c', 'job', 'focus', {b}, 25, 0, {b_end}),
               ('d', NULL, 'break', {b}, 5, 0, {b_end}),
               ('e', NULL, 'focus', {yesterday}, 25, 0, {yesterday_end});",
            a = noon - 120 * min,
            a_end = noon - 70 * min,
            b = noon - 60 * min,
            b_end = noon - 30 * min,
            pause = 5 * min,
            yesterday = noon - 24 * 60 * min,
            yesterday_end = noon - 24 * 60 * min + 25 * min,
        ))
        .unwrap();
        // 50 + (30 - 5) = 75; the job-block session, the break and yesterday don't count.
        assert_eq!(focused_today(&conn, noon), 75);
    }

    #[test]
    fn flags_once_a_day() {
        let conn = db();
        assert!(first_today(&conn, CAP_TOASTED_KEY, "2026-11-11"));
        assert!(!first_today(&conn, CAP_TOASTED_KEY, "2026-11-11"));
        assert!(first_today(&conn, CAP_TOASTED_KEY, "2026-11-12"));
    }
}
