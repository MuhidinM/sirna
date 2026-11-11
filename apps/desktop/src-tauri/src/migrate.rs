//! Forward-only migrations with checksums (plan §5.3).
//!
//! - Each `NNNN_name.sql` file runs once, in its own transaction.
//! - `core_migrations` records a checksum per file; an edited file that was
//!   already applied stops start-up (a development error, never silently ignored).
//! - `PRAGMA user_version` holds the highest number, and Sirna refuses a database
//!   written by a newer version of itself.
//! - The caller backs the file up before any pending migration runs.

use rusqlite::{Connection, params};

include!(concat!(env!("OUT_DIR"), "/migrations.rs"));

#[derive(Debug, PartialEq, Eq)]
pub enum MigrateError {
    BadName(String),
    Edited { name: String },
    NewerDatabase { database: i64, app: i64 },
    Sql(String),
}

impl std::fmt::Display for MigrateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BadName(name) => {
                write!(f, "migration file name must start with a number: {name}")
            }
            Self::Edited { name } => write!(
                f,
                "migration {name} was changed after it was applied; add a new migration instead"
            ),
            Self::NewerDatabase { database, app } => write!(
                f,
                "this database is from a newer Sirna (schema {database}, this app knows {app})"
            ),
            Self::Sql(message) => write!(f, "migration failed: {message}"),
        }
    }
}

impl std::error::Error for MigrateError {}

impl From<rusqlite::Error> for MigrateError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sql(error.to_string())
    }
}

/// FNV-1a over the file's bytes: enough to notice an edited file.
pub fn checksum(sql: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in sql.replace("\r\n", "\n").bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{hash:016x}")
}

fn number(name: &str) -> Result<i64, MigrateError> {
    name.split('_')
        .next()
        .and_then(|prefix| prefix.parse().ok())
        .ok_or_else(|| MigrateError::BadName(name.to_string()))
}

/// Names of migrations not yet applied, in order.
pub fn pending(
    conn: &Connection,
    migrations: &[(&str, &str)],
) -> Result<Vec<String>, MigrateError> {
    ensure_table(conn)?;
    let mut out = Vec::new();
    for (name, _) in migrations {
        let applied: bool = conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM core_migrations WHERE name = ?1)",
            [name],
            |row| row.get(0),
        )?;
        if !applied {
            out.push((*name).to_string());
        }
    }
    Ok(out)
}

fn ensure_table(conn: &Connection) -> Result<(), MigrateError> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS core_migrations (
           name       TEXT PRIMARY KEY,
           checksum   TEXT NOT NULL,
           applied_at INTEGER NOT NULL
         )",
    )?;
    Ok(())
}

/// Applies every pending migration. Returns the names it applied.
pub fn run(
    conn: &mut Connection,
    migrations: &[(&str, &str)],
    now_ms: i64,
) -> Result<Vec<String>, MigrateError> {
    ensure_table(conn)?;

    let highest = migrations
        .iter()
        .map(|(name, _)| number(name))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .max()
        .unwrap_or(0);
    let database: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if database > highest {
        return Err(MigrateError::NewerDatabase {
            database,
            app: highest,
        });
    }

    let mut applied = Vec::new();
    for (name, sql) in migrations {
        let stored: Option<String> = conn
            .query_row(
                "SELECT checksum FROM core_migrations WHERE name = ?1",
                [name],
                |row| row.get(0),
            )
            .ok();
        let sum = checksum(sql);
        match stored {
            Some(previous) if previous == sum => continue,
            Some(_) => {
                return Err(MigrateError::Edited {
                    name: (*name).to_string(),
                });
            }
            None => {}
        }
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.execute(
            "INSERT INTO core_migrations (name, checksum, applied_at) VALUES (?1, ?2, ?3)",
            params![name, sum, now_ms],
        )?;
        tx.pragma_update(None, "user_version", number(name)?)?;
        tx.commit()?;
        applied.push((*name).to_string());
    }
    Ok(applied)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIRST: (&str, &str) = ("0001_first", "CREATE TABLE a (id INTEGER PRIMARY KEY);");
    const SECOND: (&str, &str) = ("0002_second", "CREATE TABLE b (id INTEGER PRIMARY KEY);");

    fn db() -> Connection {
        Connection::open_in_memory().expect("open")
    }

    fn version(conn: &Connection) -> i64 {
        conn.pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("version")
    }

    #[test]
    fn applies_in_order_once() {
        let mut conn = db();
        assert_eq!(
            run(&mut conn, &[FIRST, SECOND], 1).expect("run"),
            ["0001_first", "0002_second"]
        );
        assert_eq!(version(&conn), 2);
        assert!(
            run(&mut conn, &[FIRST, SECOND], 2)
                .expect("again")
                .is_empty()
        );
    }

    #[test]
    fn adds_new_migrations_later() {
        let mut conn = db();
        run(&mut conn, &[FIRST], 1).expect("first");
        assert_eq!(
            pending(&conn, &[FIRST, SECOND]).expect("pending"),
            ["0002_second"]
        );
        assert_eq!(
            run(&mut conn, &[FIRST, SECOND], 2).expect("second"),
            ["0002_second"]
        );
    }

    #[test]
    fn stops_on_an_edited_migration() {
        let mut conn = db();
        run(&mut conn, &[FIRST], 1).expect("first");
        let edited = (
            "0001_first",
            "CREATE TABLE a (id INTEGER PRIMARY KEY, x TEXT);",
        );
        assert_eq!(
            run(&mut conn, &[edited], 2),
            Err(MigrateError::Edited {
                name: "0001_first".into()
            })
        );
    }

    #[test]
    fn line_endings_do_not_count_as_edits() {
        assert_eq!(checksum("a;\nb;\n"), checksum("a;\r\nb;\r\n"));
    }

    #[test]
    fn refuses_a_newer_database() {
        let mut conn = db();
        conn.pragma_update(None, "user_version", 9)
            .expect("set version");
        assert_eq!(
            run(&mut conn, &[FIRST], 1),
            Err(MigrateError::NewerDatabase {
                database: 9,
                app: 1
            })
        );
    }

    #[test]
    fn a_failing_migration_leaves_nothing_behind() {
        let mut conn = db();
        let broken = (
            "0001_broken",
            "CREATE TABLE ok (id INTEGER); THIS IS NOT SQL;",
        );
        assert!(matches!(
            run(&mut conn, &[broken], 1),
            Err(MigrateError::Sql(_))
        ));
        let tables: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name = 'ok'",
                [],
                |row| row.get(0),
            )
            .expect("count");
        assert_eq!(tables, 0);
        assert_eq!(version(&conn), 0);
    }

    #[test]
    fn the_shipped_migrations_apply_cleanly() {
        let mut conn = db();
        let applied = run(&mut conn, MIGRATIONS, 1).expect("shipped migrations");
        assert_eq!(applied.len(), MIGRATIONS.len());
        assert!(!MIGRATIONS.is_empty());
    }

    #[test]
    fn shipped_migration_numbers_are_unique_and_contiguous() {
        let numbers: Vec<i64> = MIGRATIONS
            .iter()
            .map(|(name, _)| number(name).expect("number"))
            .collect();
        let expected: Vec<i64> = (1..=i64::try_from(numbers.len()).expect("len")).collect();
        assert_eq!(numbers, expected);
    }
}
