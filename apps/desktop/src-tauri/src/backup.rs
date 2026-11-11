//! Checked copies of the database (plan §5.3). T-032 adds the daily schedule
//! and retention; for now this runs before migrations.

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

    conn.execute("VACUUM INTO ?1", [temp.to_string_lossy()])?;

    let result: String = {
        let copy = Connection::open_with_flags(&temp, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        copy.query_row("PRAGMA quick_check", [], |row| row.get(0))?
    };
    if result != "ok" {
        let _ = std::fs::remove_file(&temp);
        return Err(BackupError::CorruptCopy(result));
    }
    std::fs::rename(&temp, &final_path)?;
    Ok(final_path)
}

#[cfg(test)]
mod tests {
    use super::*;

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
