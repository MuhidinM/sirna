//! Commands the webview may call (plan §4.5). Which window may call which is
//! set in `capabilities/*.json` (the capture box gets capture and read only).

use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter, State, WebviewWindow};

use crate::clock;
use crate::db::{self, Db};
use crate::hotkey::CapturePressedAt;
use crate::secrets;
use crate::tx::{self, Op};

/// Tells open windows (and later the tray) which tables changed.
fn emit_changed(app: &AppHandle, tables: Vec<String>) {
    if let Err(error) = app.emit("data-changed", tables) {
        log::warn!("could not emit data-changed: {error}");
    }
}

fn tables_of(ops: &[Op]) -> Vec<String> {
    let mut tables: Vec<String> = ops
        .iter()
        .map(|op| match op {
            Op::Insert { table, .. } | Op::Update { table, .. } | Op::Delete { table, .. } => {
                table.clone()
            }
        })
        .collect();
    tables.sort();
    tables.dedup();
    tables
}

/// Saves a capture exactly as typed, plus the records the parser made from
/// it, in one transaction (plan §5.1 rule 1). The records are logged under
/// `capture:<raw id>` so the whole capture can be undone.
#[tauri::command]
pub fn capture_commit(
    raw_text: String,
    ops: Option<Vec<Op>>,
    parser: Option<String>,
    app: AppHandle,
    db: State<'_, Db>,
) -> Result<i64, String> {
    if raw_text.trim().is_empty() {
        return Err("Nothing to save".into());
    }
    let ops = ops.unwrap_or_default();
    let now = clock::now_ms();
    let raw_id = {
        let mut conn = db.write.lock();
        let txn = conn.transaction().map_err(|error| error.to_string())?;
        let raw_id = db::insert_capture(&txn, &raw_text, now).map_err(|error| error.to_string())?;
        if !ops.is_empty() {
            let context = format!("capture:{raw_id}");
            tx::apply_ops(&txn, "user", Some(&context), &ops, now)
                .map_err(|error| error.to_string())?;
            db::mark_parsed(&txn, raw_id, parser.as_deref(), now)
                .map_err(|error| error.to_string())?;
        }
        txn.commit().map_err(|error| error.to_string())?;
        raw_id
    };
    let mut tables = tables_of(&ops);
    tables.push("core_raw_items".into());
    emit_changed(&app, tables);
    Ok(raw_id)
}

/// Undoes everything a capture created or changed, and marks it ignored.
#[tauri::command]
pub fn capture_undo(raw_id: i64, app: AppHandle, db: State<'_, Db>) -> Result<usize, String> {
    let now = clock::now_ms();
    let undone = {
        let mut conn = db.write.lock();
        let txn = conn.transaction().map_err(|error| error.to_string())?;
        let undone = tx::undo_context(&txn, "user", &format!("capture:{raw_id}"), now)
            .map_err(|error| error.to_string())?;
        db::mark_ignored(&txn, raw_id).map_err(|error| error.to_string())?;
        txn.commit().map_err(|error| error.to_string())?;
        undone
    };
    emit_changed(
        &app,
        vec![
            "core_raw_items".into(),
            "task_items".into(),
            "note_items".into(),
            "money_txns".into(),
        ],
    );
    Ok(undone)
}

/// True when the first statement word, after any comments, is SELECT or WITH.
/// The connection is query_only anyway; this keeps the intent clear.
fn is_read_query(sql: &str) -> bool {
    let mut rest = sql;
    loop {
        rest = rest.trim_start();
        if let Some(after) = rest.strip_prefix("--") {
            rest = after.split_once('\n').map_or("", |(_, tail)| tail);
        } else if let Some(after) = rest.strip_prefix("/*") {
            rest = after.split_once("*/").map_or("", |(_, tail)| tail);
        } else {
            break;
        }
    }
    let first_word = rest
        .split(|c: char| c.is_whitespace() || c == '(')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    first_word == "select" || first_word == "with"
}

#[cfg(test)]
mod tests {
    use super::is_read_query;

    #[test]
    fn reads_are_allowed_after_comments() {
        assert!(is_read_query("SELECT 1"));
        assert!(is_read_query("  with x as (select 1) select * from x"));
        assert!(is_read_query("-- note\n-- more\nSELECT 1"));
        assert!(is_read_query("/* block */ select 1"));
    }

    #[test]
    fn writes_are_refused() {
        assert!(!is_read_query("DELETE FROM task_items"));
        assert!(!is_read_query("-- SELECT\nUPDATE x SET y = 1"));
        assert!(!is_read_query("-- only a comment"));
    }
}

/// Reads through a connection that cannot write.
#[tauri::command]
pub fn db_query(
    sql: String,
    params: Option<Vec<Value>>,
    db: State<'_, Db>,
) -> Result<Vec<Map<String, Value>>, String> {
    if !is_read_query(&sql) {
        return Err("db_query only runs SELECT queries".into());
    }
    let conn = db.read.lock();
    db::query_json(&conn, &sql, &params.unwrap_or_default()).map_err(|error| error.to_string())
}

/// The webview's only way to write: allowlisted ops with an actor (plan §4.5).
#[tauri::command]
pub fn db_tx(
    actor: String,
    context: Option<String>,
    ops: Vec<Op>,
    app: AppHandle,
    db: State<'_, Db>,
) -> Result<Vec<String>, String> {
    let now = clock::now_ms();
    let ids = {
        let mut conn = db.write.lock();
        let txn = conn.transaction().map_err(|error| error.to_string())?;
        let ids = tx::apply_ops(&txn, &actor, context.as_deref(), &ops, now)
            .map_err(|error| error.to_string())?;
        txn.commit().map_err(|error| error.to_string())?;
        ids
    };
    emit_changed(&app, tables_of(&ops));
    Ok(ids)
}

/// The only secret names the webview may touch (plan §4.5).
const SECRET_NAMES: [&str; 2] = ["gemini_api_key", "ical_url"];

fn known_secret(name: &str) -> Result<(), String> {
    if SECRET_NAMES.contains(&name) {
        Ok(())
    } else {
        Err(format!("Unknown secret: {name}"))
    }
}

/// Stores a secret in Credential Manager; an empty value removes it.
/// There is deliberately no command that returns a secret's value.
#[tauri::command]
pub fn secret_set(name: String, value: String) -> Result<(), String> {
    known_secret(&name)?;
    let result = if value.is_empty() {
        secrets::delete(&name)
    } else {
        secrets::set(&name, &value)
    };
    result.map_err(|error| error.to_string())
}

#[tauri::command]
pub fn secret_status(name: String) -> Result<bool, String> {
    known_secret(&name)?;
    secrets::exists(&name).map_err(|error| error.to_string())
}

/// The capture page calls this once it has loaded. Focusing from here moves
/// keyboard focus into the web content: focusing the window at creation only
/// activates the frame, so typed keys went nowhere. Logs the time from the
/// hotkey press, which T-010 records as "hotkey to ready to type".
#[tauri::command]
pub fn capture_ready(
    window: WebviewWindow,
    pressed_at: State<'_, CapturePressedAt>,
) -> Result<(), String> {
    window.set_focus().map_err(|error| error.to_string())?;
    if let Some(pressed) = pressed_at.0.lock().take() {
        log::info!("capture ready in {} ms", pressed.elapsed().as_millis());
    }
    Ok(())
}

/// Closes the calling window (the capture box).
#[tauri::command]
pub fn close_window(window: WebviewWindow) -> Result<(), String> {
    window.close().map_err(|error| error.to_string())
}
