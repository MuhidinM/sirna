//! Checked copies of the database (plan §5.3): one before every migration and
//! one a day (T-032), 14 daily copies kept. Restore steps: docs/smoke.md.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};

/// Backups go to another partition when there is one (D:), so a mistake on
/// the data folder doesn't take them too. Otherwise next to the data.
pub fn default_dir(data_dir: &Path) -> PathBuf {
    let second_drive = Path::new("D:\\");
    if cfg!(windows) && second_drive.exists() && !data_dir.starts_with(second_drive) {
        second_drive.join("Sirna").join("backups")
    } else {
        data_dir.join("backups")
    }
}

#[derive(Debug)]
pub enum BackupError {
    Io(std::io::Error),
    Sql(rusqlite::Error),
    CorruptCopy(String),
}

impl std::fmt::Display for BackupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(f, "backup failed: {error}"),
            Self::Sql(error) => write!(f, "backup failed: {error}"),
            Self::CorruptCopy(result) => write!(f, "backup copy failed its check: {result}"),
        }
    }
}

impl std::error::Error for BackupError {}

impl From<std::io::Error> for BackupError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<rusqlite::Error> for BackupError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sql(error)
    }
}

/// Writes a consistent copy with `VACUUM INTO` to a temporary name, checks it
/// with `PRAGMA quick_check`, then renames it into place. A copy that fails
/// the check is deleted, so it can never replace a good backup.
pub fn checked_copy(
    conn: &Connection,
    dir: &Path,
    file_name: &str,
) -> Result<PathBuf, BackupError> {
    std::fs::create_dir_all(dir)?;
    let temp = dir.join(format!("{file_name}.tmp"));
    let final_path = dir.join(file_name);
    let _ = std::fs::remove_file(&temp);

    // Any failure removes the partial copy, so a full disk isn't kept full.
    let checked = (|| -> Result<String, BackupError> {
        conn.execute("VACUUM INTO ?1", [temp.to_string_lossy()])?;
        let copy = Connection::open_with_flags(&temp, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        Ok(copy.query_row("PRAGMA quick_check", [], |row| row.get(0))?)
    })();
    let result = match checked {
        Ok(result) => result,
        Err(error) => {
            let _ = std::fs::remove_file(&temp);
            return Err(error);
        }
    };
    if result != "ok" {
        let _ = std::fs::remove_file(&temp);
        return Err(BackupError::CorruptCopy(result));
    }
    std::fs::rename(&temp, &final_path)?;
    Ok(final_path)
}

/// Daily copies kept (plan §5.3: 14 on D:).
pub const KEEP_DAILY: usize = 14;
/// Copies made before a migration, kept as well.
pub const KEEP_PRE_MIGRATION: usize = 5;
/// Records the logical date of the last daily copy.
const LAST_KEY: &str = "backup.last";

/// Where the backups go, decided at start-up.
pub struct BackupDir(pub PathBuf);

/// "sirna-2026-11-11.db": sorts by date as plain text.
pub fn daily_name(date: &str) -> String {
    format!("sirna-{date}.db")
}

/// The files to delete: daily copies past the newest `keep_daily`, and
/// pre-migration copies past the newest `keep_pre`. Anything else in the
/// folder is never touched.
pub fn to_prune(names: &[String], keep_daily: usize, keep_pre: usize) -> Vec<String> {
    let pick = |is_ours: fn(&str) -> bool, keep: usize| {
        let mut matching: Vec<&String> = names.iter().filter(|name| is_ours(name)).collect();
        // Both name styles sort by age as text (a date, or epoch ms of equal width).
        matching.sort();
        matching.reverse();
        matching.into_iter().skip(keep).cloned().collect::<Vec<_>>()
    };
    let mut prune = pick(is_daily_name, keep_daily);
    prune.extend(pick(is_pre_migration_name, keep_pre));
    prune
}

/// Exactly `sirna-YYYY-MM-DD.db`: a file you dropped there is never pruned.
fn is_daily_name(name: &str) -> bool {
    name.strip_prefix("sirna-")
        .and_then(|rest| rest.strip_suffix(".db"))
        .is_some_and(|date| {
            date.len() == 10
                && date.char_indices().all(|(i, c)| {
                    if i == 4 || i == 7 {
                        c == '-'
                    } else {
                        c.is_ascii_digit()
                    }
                })
        })
}

/// Exactly `pre-migration-<epoch ms>.db` (13 digits until the year 2286).
fn is_pre_migration_name(name: &str) -> bool {
    name.strip_prefix("pre-migration-")
        .and_then(|rest| rest.strip_suffix(".db"))
        .is_some_and(|ms| ms.len() == 13 && ms.chars().all(|c| c.is_ascii_digit()))
}

/// Once a logical day (from the minute tick): a checked copy, then pruning.
/// A failed copy is logged and tried again next minute; good copies are
/// never deleted to make room for a failed one.
pub fn daily(conn: &Connection, dir: &Path, today: &str, now_ms: i64) {
    if crate::db::setting_string(conn, LAST_KEY).as_deref() == Some(today) {
        return;
    }
    // After a failure (full disk, missing drive) wait an hour, not a minute:
    // each try copies the whole database under the write lock.
    let failed_at = LAST_FAILURE.load(std::sync::atomic::Ordering::Relaxed);
    if failed_at != 0 && now_ms - failed_at < RETRY_AFTER_MS {
        return;
    }
    match checked_copy(conn, dir, &daily_name(today)) {
        Ok(path) => {
            log::info!("daily backup: {}", path.display());
            let _ = conn.execute(
                "INSERT INTO core_settings (key, value_json, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
                rusqlite::params![LAST_KEY, serde_json::Value::from(today).to_string(), now_ms],
            );
            LAST_FAILURE.store(0, std::sync::atomic::Ordering::Relaxed);
            prune(dir);
        }
        Err(error) => {
            LAST_FAILURE.store(now_ms, std::sync::atomic::Ordering::Relaxed);
            log::error!("daily backup failed (next try in an hour): {error}");
        }
    }
}

/// When the last daily copy failed (0 = it didn't); in memory, so a restart
/// tries again straight away.
static LAST_FAILURE: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);
const RETRY_AFTER_MS: i64 = 60 * 60 * 1000;

fn prune(dir: &Path) {
    let names: Vec<String> = match std::fs::read_dir(dir) {
        Ok(entries) => entries
            .filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().into_string().ok())
            .collect(),
        Err(error) => {
            log::warn!("could not list backups: {error}");
            return;
        }
    };
    for name in to_prune(&names, KEEP_DAILY, KEEP_PRE_MIGRATION) {
        if let Err(error) = std::fs::remove_file(dir.join(&name)) {
            log::warn!("could not remove old backup {name}: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_newest_fourteen_days_and_five_migrations() {
        let mut names: Vec<String> = (1..=20)
            .map(|d| daily_name(&format!("2026-11-{d:02}")))
            .collect();
        names.extend((0..7).map(|i| format!("pre-migration-17943{i}0000000.db")));
        names.push("notes.txt".into());
        names.push("sirna-2026-11-21.db.tmp".into());
        // Files you put there yourself are never counted or deleted.
        names.push("sirna-before-restore.db".into());
        names.push("sirna-2026-11-01 - Copy.db".into());
        names.push("pre-migration-old.db".into());
        let prune = to_prune(&names, KEEP_DAILY, KEEP_PRE_MIGRATION);
        let mut expected: Vec<String> = (1..=6)
            .rev()
            .map(|d| daily_name(&format!("2026-11-{d:02}")))
            .collect();
        expected.extend(
            [
                "pre-migration-1794310000000.db",
                "pre-migration-1794300000000.db",
            ]
            .map(String::from),
        );
        assert_eq!(prune, expected);
    }

    #[test]
    fn makes_one_checked_copy_a_day() {
        let dir = std::env::temp_dir().join(format!("sirna-daily-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut conn = Connection::open_in_memory().expect("open");
        crate::db::configure(&conn).expect("pragmas");
        crate::migrate::run(&mut conn, crate::migrate::MIGRATIONS, 0).expect("migrate");

        daily(&conn, &dir, "2026-11-11", 0);
        assert!(dir.join("sirna-2026-11-11.db").exists());
        // Same day: no second copy, even if the file is gone.
        std::fs::remove_file(dir.join("sirna-2026-11-11.db")).expect("remove");
        daily(&conn, &dir, "2026-11-11", 1);
        assert!(!dir.join("sirna-2026-11-11.db").exists());
        daily(&conn, &dir, "2026-11-12", 2);
        let copy = Connection::open(dir.join("sirna-2026-11-12.db")).expect("open copy");
        let areas: i64 = copy
            .query_row("SELECT count(*) FROM area_items", [], |row| row.get(0))
            .expect("restored data reads");
        assert!(areas > 0);
        drop(copy);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn copies_and_checks_a_database() {
        let dir = std::env::temp_dir().join(format!("sirna-backup-test-{}", std::process::id()));
        let conn = Connection::open_in_memory().expect("open");
        conn.execute_batch("CREATE TABLE t (x TEXT); INSERT INTO t VALUES ('kept');")
            .expect("seed");

        let path = checked_copy(&conn, &dir, "copy.db").expect("backup");

        let copy = Connection::open(&path).expect("open copy");
        let value: String = copy
            .query_row("SELECT x FROM t", [], |row| row.get(0))
            .expect("read");
        assert_eq!(value, "kept");
        assert!(!dir.join("copy.db.tmp").exists());
        drop(copy);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn keeps_backups_off_the_data_drive() {
        let dir = default_dir(Path::new("C:\\Users\\me\\AppData\\Roaming\\dev.sirna.app"));
        if Path::new("D:\\").exists() {
            assert_eq!(dir, Path::new("D:\\Sirna\\backups"));
        } else {
            assert!(dir.ends_with("backups"));
        }
    }
}
