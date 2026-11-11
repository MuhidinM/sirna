//! Task reads and writes the tray needs with no window open (plan §4.1).

use rusqlite::Connection;
use serde_json::{Map, Value};

use crate::tx::{self, Op};

/// Shared with the Today screen, so the tray and the screen agree.
const TODAY_TOP_SQL: &str = include_str!("../../src/features/tasks/queries/today_top.sql");

const LAST_CAPTURE_SQL: &str = "SELECT id, body FROM core_raw_items
     WHERE source = 'capture' AND parse_status NOT IN ('ignored', 'new')
     ORDER BY id DESC LIMIT 1";

const HOUR_MS: i64 = 60 * 60 * 1000;
const DAY_MS: i64 = 24 * HOUR_MS;
/// Africa/Addis_Ababa is UTC+3 all year; the logical day starts at 03:00 local.
const UTC_OFFSET_MS: i64 = 3 * HOUR_MS;
const DAY_START_MS: i64 = 3 * HOUR_MS;

/// The logical date (YYYY-MM-DD) and the UTC ms when that logical day began.
pub fn logical_day(now_ms: i64) -> (String, i64) {
    let shifted = now_ms + UTC_OFFSET_MS - DAY_START_MS;
    let day_index = shifted.div_euclid(DAY_MS);
    let start = day_index * DAY_MS - UTC_OFFSET_MS + DAY_START_MS;
    (civil_date(day_index), start)
}

/// Days since 1970-01-01 to a calendar date (Howard Hinnant's algorithm).
fn civil_date(days: i64) -> String {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

#[derive(Debug, PartialEq)]
pub struct TopTask {
    pub id: String,
    pub title: String,
    pub done: bool,
}

pub fn today_top(conn: &Connection, now_ms: i64) -> rusqlite::Result<Vec<TopTask>> {
    let (date, start) = logical_day(now_ms);
    let mut statement = conn.prepare(TODAY_TOP_SQL)?;
    let rows = statement.query_map(rusqlite::params![date, start], |row| {
        Ok(TopTask {
            id: row.get(0)?,
            title: row.get(1)?,
            done: row.get::<_, String>(2)? == "done",
        })
    })?;
    rows.collect()
}

/// Marks a task done, or back to todo if it was done.
pub fn toggle_done(conn: &Connection, id: &str, now_ms: i64) -> Result<bool, tx::TxError> {
    let status: String = conn
        .query_row("SELECT status FROM task_items WHERE id = ?1", [id], |row| {
            row.get(0)
        })
        .map_err(|error| tx::TxError::Sql(error.to_string()))?;
    let done = status != "done";
    let mut values = Map::new();
    values.insert(
        "status".into(),
        Value::from(if done { "done" } else { "todo" }),
    );
    values.insert(
        "completed_at".into(),
        if done {
            Value::from(now_ms)
        } else {
            Value::Null
        },
    );
    let op = Op::Update {
        table: "task_items".into(),
        id: id.into(),
        values,
    };
    tx::apply_ops(conn, "user", Some("tray"), &[op], now_ms)?;
    Ok(done)
}

pub fn last_capture(conn: &Connection) -> Option<(i64, String)> {
    conn.query_row(LAST_CAPTURE_SQL, [], |row| Ok((row.get(0)?, row.get(1)?)))
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{db, migrate};

    const NOON_11_NOV: i64 = 1_794_387_600_000; // 2026-11-11 12:00 in Addis Ababa

    fn conn() -> Connection {
        let mut conn = Connection::open_in_memory().expect("open");
        db::configure(&conn).expect("pragmas");
        migrate::run(&mut conn, migrate::MIGRATIONS, 0).expect("migrate");
        conn
    }

    fn add(conn: &Connection, id: &str, due: &str) {
        conn.execute(
            "INSERT INTO task_items (id, title, status, due_date, created_at, updated_at)
             VALUES (?1, ?1, 'todo', ?2, 0, 0)",
            [id, due],
        )
        .expect("insert");
    }

    #[test]
    fn logical_day_starts_at_three_local() {
        assert_eq!(logical_day(NOON_11_NOV).0, "2026-11-11");
        // 02:59 local on 12 Nov still belongs to 11 Nov.
        assert_eq!(
            logical_day(NOON_11_NOV + 14 * HOUR_MS + 59 * 60_000).0,
            "2026-11-11"
        );
        assert_eq!(logical_day(NOON_11_NOV + 15 * HOUR_MS).0, "2026-11-12");
        assert_eq!(logical_day(NOON_11_NOV).1, NOON_11_NOV - 9 * HOUR_MS);
    }

    #[test]
    fn civil_dates_cross_year_and_leap_days() {
        assert_eq!(civil_date(0), "1970-01-01");
        assert_eq!(civil_date(20_513), "2026-03-01");
        assert_eq!(civil_date(19_782), "2024-02-29");
    }

    #[test]
    fn tray_shows_todays_top_and_toggles_done() {
        let conn = conn();
        add(&conn, "a", "2026-11-11");
        add(&conn, "b", "2026-11-20");
        let top = today_top(&conn, NOON_11_NOV).expect("top");
        assert_eq!(
            top,
            vec![TopTask {
                id: "a".into(),
                title: "a".into(),
                done: false
            }]
        );

        assert!(toggle_done(&conn, "a", NOON_11_NOV).expect("toggle"));
        assert!(today_top(&conn, NOON_11_NOV).expect("top")[0].done);
        assert!(!toggle_done(&conn, "a", NOON_11_NOV).expect("toggle back"));
    }

    #[test]
    fn last_capture_skips_undone_ones() {
        let conn = conn();
        conn.execute_batch(
            "INSERT INTO core_raw_items (source, received_at, body, parse_status) VALUES
               ('capture', 1, 'lunch 120', 'parsed'),
               ('capture', 2, 'oops', 'ignored');",
        )
        .expect("seed");
        assert_eq!(last_capture(&conn), Some((1, "lunch 120".into())));
    }
}
