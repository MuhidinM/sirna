//! The SQLite file, owned by Rust (ADR-0002). One write connection behind a
//! parking_lot mutex: a panic while holding it does not poison later calls.

use std::path::Path;

use parking_lot::Mutex;
use rusqlite::{Connection, OpenFlags, params};

use crate::{backup, migrate};

pub struct Db {
    pub write: Mutex<Connection>,
    /// A second connection that cannot write (query_only), for db_query.
    pub read: Mutex<Connection>,
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
        let read = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        read.pragma_update(None, "query_only", "ON")?;
        read.pragma_update(None, "busy_timeout", 5000)?;
        Ok(Self {
            write: Mutex::new(conn),
            read: Mutex::new(read),
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

/// Runs a read-only query and returns the rows as JSON objects.
pub fn query_json(
    conn: &Connection,
    sql: &str,
    params: &[serde_json::Value],
) -> rusqlite::Result<Vec<serde_json::Map<String, serde_json::Value>>> {
    let mut statement = conn.prepare(sql)?;
    let names: Vec<String> = statement
        .column_names()
        .map(|name| (*name).to_string())
        .collect();
    let bound: Vec<rusqlite::types::Value> = params
        .iter()
        .map(|value| match value {
            serde_json::Value::Null => rusqlite::types::Value::Null,
            serde_json::Value::Bool(flag) => rusqlite::types::Value::Integer(i64::from(*flag)),
            serde_json::Value::Number(number) => number
                .as_i64()
                .map(rusqlite::types::Value::Integer)
                .unwrap_or_else(|| rusqlite::types::Value::Real(number.as_f64().unwrap_or(0.0))),
            other => rusqlite::types::Value::Text(match other {
                serde_json::Value::String(text) => text.clone(),
                _ => other.to_string(),
            }),
        })
        .collect();
    let rows = statement.query_map(rusqlite::params_from_iter(bound), |row| {
        let mut object = serde_json::Map::new();
        for (index, name) in names.iter().enumerate() {
            object.insert(name.clone(), crate::tx::to_json(row.get_ref(index)?));
        }
        Ok(object)
    })?;
    rows.collect()
}

/// Stores a capture exactly as typed and returns its row id.
pub fn insert_capture(conn: &Connection, body: &str, received_at_ms: i64) -> rusqlite::Result<i64> {
    conn.execute(
        "INSERT INTO core_raw_items (source, received_at, body) VALUES ('capture', ?1, ?2)",
        params![received_at_ms, body],
    )?;
    Ok(conn.last_insert_rowid())
}

/// A setting stored as a JSON string (`"Ctrl+Alt+K"`), if present.
pub fn setting_string(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value_json FROM core_settings WHERE key = ?1",
        [key],
        |row| row.get::<_, String>(0),
    )
    .ok()
    .and_then(|json| serde_json::from_str::<String>(&json).ok())
}

/// Records that a parser turned a raw item into records.
pub fn mark_parsed(
    conn: &Connection,
    raw_id: i64,
    parser: Option<&str>,
    at_ms: i64,
) -> rusqlite::Result<()> {
    let (parser_id, parser_version) = match parser.and_then(|value| value.split_once('@')) {
        Some((id, version)) => (Some(id), version.parse::<i64>().ok()),
        None => (parser, None),
    };
    conn.execute(
        "UPDATE core_raw_items SET parse_status = 'parsed', parser_id = ?2, parser_version = ?3, parsed_at = ?4
         WHERE id = ?1",
        params![raw_id, parser_id, parser_version, at_ms],
    )?;
    Ok(())
}

/// Marks an undone capture so re-parsing skips it.
pub fn mark_ignored(conn: &Connection, raw_id: i64) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE core_raw_items SET parse_status = 'ignored' WHERE id = ?1",
        [raw_id],
    )?;
    Ok(())
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
