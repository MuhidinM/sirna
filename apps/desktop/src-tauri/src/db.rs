//! The SQLite file, owned by Rust (ADR-0002). One write connection behind a
//! parking_lot mutex: a panic while holding it does not poison later calls.

use std::path::Path;

use parking_lot::Mutex;
use rusqlite::{Connection, params};

/// The first schema file. T-012 replaces this with the migration runner.
const CORE_RAW_ITEMS_SQL: &str =
    include_str!("../../src/kernel/migrations/0001_core_raw_items.sql");

pub struct Db {
    pub write: Mutex<Connection>,
}

impl Db {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        prepare(&conn)?;
        Ok(Self {
            write: Mutex::new(conn),
        })
    }
}

/// Pragmas from plan §5.1, then the schema.
pub fn prepare(conn: &Connection) -> rusqlite::Result<()> {
    // auto_vacuum only takes effect before the first table exists.
    conn.pragma_update(None, "auto_vacuum", "INCREMENTAL")?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "FULL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "busy_timeout", 5000)?;
    conn.execute_batch(CORE_RAW_ITEMS_SQL)
}

/// Stores a capture exactly as typed and returns its row id.
pub fn insert_capture(conn: &Connection, body: &str, received_at_ms: i64) -> rusqlite::Result<i64> {
    conn.execute(
        "INSERT INTO core_raw_items (source, received_at, body) VALUES ('capture', ?1, ?2)",
        params![received_at_ms, body],
    )?;
    Ok(conn.last_insert_rowid())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        prepare(&conn).expect("prepare schema");
        conn
    }

    #[test]
    fn stores_a_capture_unchanged() {
        let conn = memory_db();
        let body = "  lunch 120 #food  ";
        let id = insert_capture(&conn, body, 1_762_848_000_000).expect("insert");
        let (source, stored, status): (String, String, String) = conn
            .query_row(
                "SELECT source, body, parse_status FROM core_raw_items WHERE id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read back");
        assert_eq!(source, "capture");
        assert_eq!(stored, body);
        assert_eq!(status, "new");
    }

    #[test]
    fn the_same_text_twice_is_two_rows() {
        let conn = memory_db();
        let first = insert_capture(&conn, "call bank", 1).expect("first");
        let second = insert_capture(&conn, "call bank", 2).expect("second");
        assert_ne!(first, second);
    }

    #[test]
    fn foreign_keys_are_on() {
        let conn = memory_db();
        let on: i64 = conn
            .pragma_query_value(None, "foreign_keys", |row| row.get(0))
            .expect("pragma");
        assert_eq!(on, 1);
    }
}
