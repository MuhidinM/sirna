//! The SQLite file, owned by Rust (ADR-0002). One write connection behind a
//! parking_lot mutex: a panic while holding it does not poison later calls.

use std::path::Path;

use parking_lot::Mutex;
use rusqlite::{Connection, params};

use crate::{backup, migrate};

pub struct Db {
    pub write: Mutex<Connection>,
}

impl Db {
    /// Opens the database, backs it up if migrations are pending, and migrates it.
    pub fn open(
        path: &Path,
        backup_dir: &Path,
        now_ms: i64,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let mut conn = Connection::open(path)?;
        configure(&conn)?;
        let pending = migrate::pending(&conn, migrate::MIGRATIONS)?;
        if !pending.is_empty() && has_user_tables(&conn)? {
            let name = format!("pre-migration-{now_ms}.db");
            let copy = backup::checked_copy(&conn, backup_dir, &name)?;
            log::info!(
                "backed up before {} migration(s): {}",
                pending.len(),
                copy.display()
            );
        }
        let applied = migrate::run(&mut conn, migrate::MIGRATIONS, now_ms)?;
        if !applied.is_empty() {
            log::info!("applied migrations: {}", applied.join(", "));
        }
        Ok(Self {
            write: Mutex::new(conn),
        })
    }
}

/// Pragmas from plan §5.1.
pub fn configure(conn: &Connection) -> rusqlite::Result<()> {
    // auto_vacuum only takes effect before the first table exists.
    conn.pragma_update(None, "auto_vacuum", "INCREMENTAL")?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "FULL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "busy_timeout", 5000)
}

fn has_user_tables(conn: &Connection) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM sqlite_master
                        WHERE type = 'table' AND name NOT IN ('core_migrations', 'sqlite_sequence'))",
        [],
        |row| row.get(0),
    )
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
        let mut conn = Connection::open_in_memory().expect("open in-memory db");
        configure(&conn).expect("pragmas");
        migrate::run(&mut conn, migrate::MIGRATIONS, 0).expect("migrate");
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

    #[test]
    fn opening_backs_up_before_migrating_an_existing_file() {
        let dir = std::env::temp_dir().join(format!("sirna-db-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("sirna.db");
        // A database from before the migration runner: a table but no core_migrations.
        Connection::open(&path)
            .and_then(|conn| conn.execute_batch("CREATE TABLE legacy (x INTEGER);"))
            .expect("legacy db");

        let backups = dir.join("backups");
        Db::open(&path, &backups, 42).expect("open");

        assert!(backups.join("pre-migration-42.db").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
