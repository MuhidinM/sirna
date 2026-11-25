//! Commands the webview may call (plan §4.5). Which window may call which is
//! set in `capabilities/*.json` (the capture box gets capture and read only).

use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

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
            Op::Insert { table, .. }
            | Op::Update { table, .. }
            | Op::Delete { table, .. }
            | Op::Upsert { table, .. } => table.clone(),
        })
        .collect();
    tables.sort();
    tables.dedup();
    tables
}

/// A capture may only add tasks, notes and money, and tick or skip a block
/// (`gym done`, plan §3.5: its status and nothing else). Anything else
/// (deletes, settings) goes through db_tx, which the capture window can't call.
pub fn capture_ops_allowed(ops: &[Op]) -> bool {
    ops.iter().all(|op| match op {
        Op::Insert { table, .. } => matches!(
            table.as_str(),
            "task_items"
                | "note_items"
                | "money_txns"
                | "money_loans"
                | "project_items"
                | "savings_entries"
        ),
        Op::Update { table, values, .. } => {
            table == "day_blocks"
                && !values.is_empty()
                && values.iter().all(|(key, value)| {
                    key == "status" && matches!(value.as_str(), Some("done" | "skipped"))
                })
        }
        _ => false,
    })
}

/// What a capture's undo or fix can change, for `data-changed`.
pub const CAPTURE_TABLES: [&str; 5] = [
    "core_raw_items",
    "task_items",
    "note_items",
    "money_txns",
    "day_blocks",
];

/// Stores the raw line and its records inside an open transaction.
fn store_capture(
    txn: &rusqlite::Transaction<'_>,
    raw_text: &str,
    ops: &[Op],
    parser: Option<&str>,
    now: i64,
) -> Result<i64, String> {
    let raw_id = db::insert_capture(txn, raw_text, now).map_err(|error| error.to_string())?;
    if !ops.is_empty() {
        let context = format!("capture:{raw_id}");
        tx::apply_ops(txn, "user", Some(&context), ops, now).map_err(|error| error.to_string())?;
        db::mark_parsed(txn, raw_id, parser, now).map_err(|error| error.to_string())?;
    }
    Ok(raw_id)
}

fn check_capture(raw_text: &str, ops: &[Op]) -> Result<(), String> {
    if raw_text.trim().is_empty() {
        return Err("Nothing to save".into());
    }
    if !capture_ops_allowed(ops) {
        return Err("A capture can only add tasks, notes, money, ideas or savings".into());
    }
    Ok(())
}

/// Saves a capture exactly as typed, plus the records the parser made from
/// it, in one transaction (plan §5.1 rule 1). The records are logged under
/// `capture:<raw id>` so the whole capture can be undone.
#[tauri::command]
pub fn capture_commit(
    raw_text: String,
    ops: Option<Vec<Op>>,
    parser: Option<String>,
    refused: Option<String>,
    app: AppHandle,
    db: State<'_, Db>,
) -> Result<i64, String> {
    let ops = ops.unwrap_or_default();
    check_capture(&raw_text, &ops)?;
    let now = clock::now_ms();
    let raw_id = {
        let mut conn = db.write.lock();
        let txn = conn.transaction().map_err(|error| error.to_string())?;
        let raw_id = store_capture(&txn, &raw_text, &ops, parser.as_deref(), now)?;
        // Refused (a take-out bigger than the goal holds): kept, marked failed.
        if let (true, Some(why)) = (ops.is_empty(), refused.as_deref()) {
            db::mark_refused(&txn, raw_id, why).map_err(|error| error.to_string())?;
        }
        txn.commit().map_err(|error| error.to_string())?;
        raw_id
    };
    let mut tables = tables_of(&ops);
    tables.push("core_raw_items".into());
    emit_changed(&app, tables);
    Ok(raw_id)
}

/// Fixing a capture (Up arrow): undo the old one and save the new one in one
/// transaction, so a failed save never leaves the old capture undone.
#[tauri::command]
pub fn capture_replace(
    raw_id: i64,
    raw_text: String,
    ops: Option<Vec<Op>>,
    parser: Option<String>,
    app: AppHandle,
    db: State<'_, Db>,
) -> Result<i64, String> {
    let ops = ops.unwrap_or_default();
    check_capture(&raw_text, &ops)?;
    let now = clock::now_ms();
    let new_id = {
        let mut conn = db.write.lock();
        let txn = conn.transaction().map_err(|error| error.to_string())?;
        let new_id = replace_in(&txn, raw_id, &raw_text, &ops, parser.as_deref(), now)?;
        txn.commit().map_err(|error| error.to_string())?;
        new_id
    };
    emit_changed(&app, CAPTURE_TABLES.map(String::from).to_vec());
    Ok(new_id)
}

/// The fix itself, inside an open transaction: undo the old capture, save the
/// new one, and carry the old task's project, parent and steps over to the
/// new task (time-first §2: "read chapter 5" → "read chapter 6" keeps its
/// project). The links are read before the undo, since undoing an earlier fix
/// takes back the links it carried. They are logged under the new capture
/// with only the carried columns as "before", so undoing it puts back the
/// links and nothing else: later edits to the steps stay.
fn replace_in(
    txn: &rusqlite::Transaction<'_>,
    raw_id: i64,
    raw_text: &str,
    ops: &[Op],
    parser: Option<&str>,
    now: i64,
) -> Result<i64, String> {
    let old_context = format!("capture:{raw_id}");
    if let Some(blocked) = undo_blocked(txn, raw_id, "fix")? {
        return Err(blocked);
    }
    let links = match captured_task(txn, &old_context)? {
        Some(old) => Some(task_links(txn, &old)?),
        None => None,
    };
    tx::undo_context(txn, "user", &old_context, now).map_err(|error| error.to_string())?;
    db::mark_ignored(txn, raw_id).map_err(|error| error.to_string())?;
    let new_id = store_capture(txn, raw_text, ops, parser, now)?;
    let carried = links.map_or_else(Vec::new, |links| carry_task_links(&links, ops));
    if !carried.is_empty() {
        let context = format!("capture:{new_id}");
        let logged_before: i64 = txn
            .query_row(
                "SELECT COALESCE(MAX(id), 0) FROM core_activity",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        tx::apply_ops(txn, "user", Some(&context), &carried, now)
            .map_err(|error| error.to_string())?;
        keep_only_carried_columns(txn, &context, logged_before, &carried)?;
    }
    Ok(new_id)
}

/// Trims the "before" of each carried update to the columns it set, so undo
/// restores those columns only (undo restores whatever a snapshot holds).
fn keep_only_carried_columns(
    conn: &rusqlite::Connection,
    context: &str,
    after_id: i64,
    carried: &[Op],
) -> Result<(), String> {
    let rows: Vec<(i64, String, Option<String>)> = {
        let mut statement = conn
            .prepare(
                "SELECT id, entity_id, before_json FROM core_activity
                 WHERE context = ?1 AND id > ?2 AND action = 'update' AND entity_type = 'task_items'",
            )
            .map_err(|error| error.to_string())?;
        statement
            .query_map(rusqlite::params![context, after_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .and_then(Iterator::collect)
            .map_err(|error| error.to_string())?
    };
    for (row_id, entity_id, before) in rows {
        let Some(Op::Update { values, .. }) = carried
            .iter()
            .find(|op| matches!(op, Op::Update { id, .. } if *id == entity_id))
        else {
            continue;
        };
        let Some(Value::Object(before)) = before.and_then(|text| serde_json::from_str(&text).ok())
        else {
            continue;
        };
        let trimmed: Map<String, Value> = values
            .keys()
            .map(|name| {
                (
                    name.clone(),
                    before.get(name).cloned().unwrap_or(Value::Null),
                )
            })
            .collect();
        conn.execute(
            "UPDATE core_activity SET before_json = ?1 WHERE id = ?2",
            rusqlite::params![Value::Object(trimmed).to_string(), row_id],
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// The one task a capture made, when it made exactly one.
fn captured_task(conn: &rusqlite::Connection, context: &str) -> Result<Option<String>, String> {
    let mut statement = conn
        .prepare(
            "SELECT entity_id FROM core_activity
             WHERE context = ?1 AND entity_type = 'task_items' AND action = 'insert'",
        )
        .map_err(|error| error.to_string())?;
    let ids: Vec<String> = statement
        .query_map([context], |row| row.get(0))
        .and_then(Iterator::collect)
        .map_err(|error| error.to_string())?;
    Ok(if ids.len() == 1 {
        ids.into_iter().next()
    } else {
        None
    })
}

/// A task's project, parent, step number and steps, as they are now.
struct TaskLinks {
    project: Option<String>,
    parent: Option<String>,
    step: Option<i64>,
    steps: Vec<String>,
}

fn task_links(conn: &rusqlite::Connection, id: &str) -> Result<TaskLinks, String> {
    let (project, parent, step) = conn
        .query_row(
            "SELECT project_id, parent_id, step_no FROM task_items WHERE id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|error| error.to_string())?;
    let mut statement = conn
        .prepare("SELECT id FROM task_items WHERE parent_id = ?1 AND deleted_at IS NULL")
        .map_err(|error| error.to_string())?;
    let steps = statement
        .query_map([id], |row| row.get(0))
        .and_then(Iterator::collect)
        .map_err(|error| error.to_string())?;
    Ok(TaskLinks {
        project,
        parent,
        step,
        steps,
    })
}

/// Updates that give the new task the old one's project, parent and step
/// number (unless the fix set them) and move the old task's steps under it.
fn carry_task_links(links: &TaskLinks, ops: &[Op]) -> Vec<Op> {
    let inserted: Vec<(&String, &Map<String, Value>)> = ops
        .iter()
        .filter_map(|op| match op {
            Op::Insert { table, id, values } if table == "task_items" => Some((id, values)),
            _ => None,
        })
        .collect();
    let [(new_id, new_values)] = inserted.as_slice() else {
        return Vec::new();
    };
    let unset = |name: &str| new_values.get(name).is_none_or(Value::is_null);
    let mut carried = Map::new();
    if let Some(project) = links.project.clone().filter(|_| unset("project_id")) {
        carried.insert("project_id".into(), Value::from(project));
    }
    if let Some(parent) = links.parent.clone().filter(|_| unset("parent_id")) {
        carried.insert("parent_id".into(), Value::from(parent));
    }
    if let Some(step) = links.step.filter(|_| unset("step_no")) {
        carried.insert("step_no".into(), Value::from(step));
    }
    let mut out = Vec::new();
    if !carried.is_empty() {
        out.push(Op::Update {
            table: "task_items".into(),
            id: (*new_id).clone(),
            values: carried,
        });
    }
    for step_id in &links.steps {
        let mut values = Map::new();
        values.insert("parent_id".into(), Value::from((*new_id).clone()));
        out.push(Op::Update {
            table: "task_items".into(),
            id: step_id.clone(),
            values,
        });
    }
    out
}

/// Shared with the capture bar (src/capture/fix.ts).
const UNDO_BLOCKED_SQL: &str = include_str!("../../src/capture/queries/undo_blocked.sql");

/// Why undoing or fixing a capture would throw something away, or None
/// (F2, F65): a record you have changed since (ticked, edited, deleted), or an
/// account it moved that you have checked since. The same words as
/// `undoBlocked` in src/capture/fix.ts, which the capture bar checks first.
pub(crate) fn undo_blocked(
    conn: &rusqlite::Connection,
    raw_id: i64,
    verb: &str,
) -> Result<Option<String>, String> {
    let mut statement = conn
        .prepare(UNDO_BLOCKED_SQL)
        .map_err(|error| error.to_string())?;
    let rows: Vec<(String, bool, bool, bool, Option<String>)> = statement
        .query_map([format!("capture:{raw_id}")], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })
        .and_then(Iterator::collect)
        .map_err(|error| error.to_string())?;
    let inserted: Vec<_> = rows.iter().filter(|row| row.1).collect();
    if !inserted.is_empty() && inserted.iter().all(|row| row.2) {
        return Ok(Some(format!("Nothing to {verb}: you've deleted it since.")));
    }
    if let Some((table, ..)) = rows.iter().find(|row| row.3) {
        let text = match table.as_str() {
            "project_items" => "You've changed this project since. Edit it on Projects.",
            "task_items" => "You've changed this task since. Edit it on Plan > Tasks.",
            "money_txns" => "You've changed this entry since. Edit it on Money.",
            "money_loans" => "This loan has changed since. Edit it on Money > Lent and owed.",
            "note_items" => "You've changed this note since. Edit it on Notes.",
            "note_items:cheat" => "You've changed this line since. Edit it on Plan > Cheat sheets.",
            "day_blocks" => "You've changed this block since. Edit it on Today.",
            "savings_entries" => "You've changed this saving since. Edit it on Money.",
            "core_settings" => "Away has changed since. Set it on Today.",
            _ => "You've changed this since.",
        };
        return Ok(Some(text.to_string()));
    }
    if let Some(account) = rows.iter().find_map(|row| row.4.as_ref()) {
        let action = if verb == "undo" { "Undo" } else { "Fix" };
        return Ok(Some(format!(
            "You checked {account} since. {action} it on Money > Ledger, then check {account} again."
        )));
    }
    Ok(None)
}

/// Undoes a capture inside an open transaction and marks it ignored, unless
/// that would throw away a later change (the capture bar and the tray).
pub(crate) fn undo_capture_in(
    txn: &rusqlite::Transaction<'_>,
    raw_id: i64,
    now: i64,
) -> Result<usize, String> {
    if let Some(blocked) = undo_blocked(txn, raw_id, "undo")? {
        return Err(blocked);
    }
    let undone = tx::undo_context(txn, "user", &format!("capture:{raw_id}"), now)
        .map_err(|error| error.to_string())?;
    db::mark_ignored(txn, raw_id).map_err(|error| error.to_string())?;
    Ok(undone)
}

/// Undoes everything a capture created or changed, and marks it ignored.
#[tauri::command]
pub fn capture_undo(raw_id: i64, app: AppHandle, db: State<'_, Db>) -> Result<usize, String> {
    let now = clock::now_ms();
    let undone = {
        let mut conn = db.write.lock();
        let txn = conn.transaction().map_err(|error| error.to_string())?;
        let undone = undo_capture_in(&txn, raw_id, now)?;
        txn.commit().map_err(|error| error.to_string())?;
        undone
    };
    emit_changed(&app, CAPTURE_TABLES.map(String::from).to_vec());
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
    use super::{capture_ops_allowed, is_read_query};
    use crate::tx::{self, Op};
    use serde_json::{Map, Value};

    #[test]
    fn captures_may_only_insert_tasks_notes_money_and_ideas() {
        let insert = |table: &str| Op::Insert {
            table: table.into(),
            id: "x".into(),
            values: Map::new(),
        };
        assert!(capture_ops_allowed(&[
            insert("task_items"),
            insert("money_txns"),
            insert("note_items"),
            insert("project_items"),
            insert("savings_entries")
        ]));
        assert!(!capture_ops_allowed(&[insert("area_items")]));
        assert!(!capture_ops_allowed(&[insert("core_settings")]));
        assert!(!capture_ops_allowed(&[Op::Delete {
            table: "task_items".into(),
            id: "x".into()
        }]));
        assert!(!capture_ops_allowed(&[Op::Update {
            table: "task_items".into(),
            id: "x".into(),
            values: Map::new()
        }]));
        // `gym done`: a block's status, and nothing else about it.
        let block = |key: &str, value: &str| {
            let mut values = Map::new();
            values.insert(key.into(), value.into());
            Op::Update {
                table: "day_blocks".into(),
                id: "b".into(),
                values,
            }
        };
        assert!(capture_ops_allowed(&[block("status", "done")]));
        assert!(capture_ops_allowed(&[block("status", "skipped")]));
        assert!(!capture_ops_allowed(&[block("status", "planned")]));
        assert!(!capture_ops_allowed(&[block("title", "x")]));
    }

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

    #[test]
    fn fixing_a_task_capture_keeps_its_project_parent_and_steps() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::configure(&conn).unwrap();
        crate::migrate::run(&mut conn, crate::migrate::MIGRATIONS, 0).unwrap();
        let task = |id: &str, title: &str| {
            let mut values = Map::new();
            values.insert("title".into(), title.into());
            vec![Op::Insert {
                table: "task_items".into(),
                id: id.into(),
                values,
            }]
        };
        let txn = conn.transaction().unwrap();
        let raw = super::store_capture(
            &txn,
            "read chapter 5",
            &task("t5", "read chapter 5"),
            None,
            1,
        )
        .unwrap();
        // Later, on the Projects page: the task joins a project as step 2 of
        // another task, and gets a step of its own.
        txn.execute_batch(
            "UPDATE task_items SET project_id = 'p1', parent_id = 'big', step_no = 2 WHERE id = 't5';
             INSERT INTO task_items (id, title, parent_id, step_no, created_at, updated_at)
               VALUES ('s1', 'take notes', 't5', 1, 0, 0);",
        )
        .unwrap();
        let fixed = super::replace_in(
            &txn,
            raw,
            "read chapter 6",
            &task("t6", "read chapter 6"),
            None,
            2,
        )
        .unwrap();
        let row: (String, Option<String>, Option<String>, Option<i64>) = txn
            .query_row(
                "SELECT title, project_id, parent_id, step_no FROM task_items WHERE id = 't6'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            row,
            (
                "read chapter 6".into(),
                Some("p1".into()),
                Some("big".into()),
                Some(2)
            )
        );
        let step_parent: String = txn
            .query_row(
                "SELECT parent_id FROM task_items WHERE id = 's1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(step_parent, "t6");
        // Undoing the fix puts the step back under the old task.
        crate::tx::undo_context(&txn, "user", &format!("capture:{fixed}"), 3).unwrap();
        let step_parent: String = txn
            .query_row(
                "SELECT parent_id FROM task_items WHERE id = 's1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(step_parent, "t5");
    }

    fn capture_db() -> rusqlite::Connection {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::configure(&conn).unwrap();
        crate::migrate::run(&mut conn, crate::migrate::MIGRATIONS, 0).unwrap();
        conn
    }

    fn task_op(id: &str, title: &str) -> Vec<Op> {
        let mut values = Map::new();
        values.insert("title".into(), title.into());
        vec![Op::Insert {
            table: "task_items".into(),
            id: id.into(),
            values,
        }]
    }

    #[test]
    fn undo_and_fix_refuse_a_task_changed_since() {
        let mut conn = capture_db();
        let txn = conn.transaction().unwrap();
        let raw = super::store_capture(&txn, "buy stamps", &task_op("t1", "buy stamps"), None, 1)
            .unwrap();
        assert_eq!(super::undo_blocked(&txn, raw, "undo").unwrap(), None);
        let mut values = Map::new();
        values.insert("status".into(), "done".into());
        let tick = Op::Update {
            table: "task_items".into(),
            id: "t1".into(),
            values,
        };
        tx::apply_ops(&txn, "user", Some("tray"), &[tick], 2).unwrap();
        let error = super::undo_capture_in(&txn, raw, 3).unwrap_err();
        assert_eq!(
            error,
            "You've changed this task since. Edit it on Plan > Tasks."
        );
        assert!(
            super::replace_in(&txn, raw, "buy stamps 5pm", &task_op("t2", "x"), None, 3).is_err()
        );
        let live: Vec<(String, String)> = txn
            .prepare("SELECT id, status FROM task_items WHERE deleted_at IS NULL")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(live, vec![("t1".to_string(), "done".to_string())]);
    }

    #[test]
    fn undo_refuses_an_entry_deleted_or_checked_since() {
        let mut conn = capture_db();
        let txn = conn.transaction().unwrap();
        let spend = |id: &str, account: &str, amount: i64, origin: Option<&str>| {
            let mut values = Map::new();
            values.insert("account".into(), account.into());
            values.insert("occurred_at".into(), 1.into());
            values.insert("local_date".into(), "2026-11-24".into());
            values.insert("amount_minor".into(), amount.into());
            values.insert("description".into(), id.into());
            values.insert("origin".into(), origin.map_or(Value::Null, Value::from));
            Op::Insert {
                table: "money_txns".into(),
                id: id.into(),
                values,
            }
        };
        let taxi = super::store_capture(
            &txn,
            "taxi 60",
            &[spend("m1", "cash", -6000, None)],
            None,
            1,
        )
        .unwrap();
        let delete = Op::Delete {
            table: "money_txns".into(),
            id: "m1".into(),
        };
        tx::apply_ops(&txn, "user", None, &[delete], 2).unwrap();
        assert_eq!(
            super::undo_blocked(&txn, taxi, "undo").unwrap().as_deref(),
            Some("Nothing to undo: you've deleted it since.")
        );
        let moved = super::store_capture(
            &txn,
            "moved 120 cash to telebirr",
            &[
                spend("o", "cash", -12000, None),
                spend("i", "telebirr", 12000, None),
            ],
            None,
            3,
        )
        .unwrap();
        tx::apply_ops(
            &txn,
            "user",
            None,
            &[spend("r", "cash", 635_000, Some("reconcile"))],
            4,
        )
        .unwrap();
        assert_eq!(
            super::undo_capture_in(&txn, moved, 5).unwrap_err(),
            "You checked Cash since. Undo it on Money > Ledger, then check Cash again."
        );
    }

    #[test]
    fn fixing_a_fixed_capture_still_keeps_its_project_parent_and_steps() {
        let mut conn = capture_db();
        let txn = conn.transaction().unwrap();
        let raw =
            super::store_capture(&txn, "read ch 5", &task_op("t5", "read ch 5"), None, 1).unwrap();
        // Put into a project and under a parent the way Plan > Tasks does it:
        // a logged update. Links alone don't count as changing the task.
        let mut links = Map::new();
        links.insert("project_id".into(), "p1".into());
        links.insert("parent_id".into(), "big".into());
        links.insert("step_no".into(), 2.into());
        crate::tx::apply_ops(
            &txn,
            "user",
            None,
            &[Op::Update {
                table: "task_items".into(),
                id: "t5".into(),
                values: links,
            }],
            1,
        )
        .unwrap();
        txn.execute_batch(
            "INSERT INTO task_items (id, title, parent_id, step_no, created_at, updated_at)
               VALUES ('s1', 'take notes', 't5', 1, 0, 0);",
        )
        .unwrap();
        let once = super::replace_in(&txn, raw, "read ch 6", &task_op("t6", "read ch 6"), None, 2)
            .unwrap();
        super::replace_in(
            &txn,
            once,
            "read ch 7",
            &task_op("t7", "read ch 7"),
            None,
            3,
        )
        .unwrap();
        let row: (Option<String>, Option<String>, Option<i64>) = txn
            .query_row(
                "SELECT project_id, parent_id, step_no FROM task_items WHERE id = 't7'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(row, (Some("p1".into()), Some("big".into()), Some(2)));
        let step_parent: String = txn
            .query_row(
                "SELECT parent_id FROM task_items WHERE id = 's1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(step_parent, "t7");
    }

    #[test]
    fn undoing_a_fix_keeps_later_edits_to_its_steps() {
        let mut conn = capture_db();
        let txn = conn.transaction().unwrap();
        let raw =
            super::store_capture(&txn, "read ch 5", &task_op("t5", "read ch 5"), None, 1).unwrap();
        txn.execute_batch(
            "INSERT INTO task_items (id, title, parent_id, step_no, created_at, updated_at)
               VALUES ('s1', 'take notes', 't5', 1, 0, 0);",
        )
        .unwrap();
        let fixed = super::replace_in(&txn, raw, "read ch 6", &task_op("t6", "read ch 6"), None, 2)
            .unwrap();
        let mut values = Map::new();
        values.insert("title".into(), "take good notes".into());
        values.insert("status".into(), "done".into());
        crate::tx::apply_ops(
            &txn,
            "user",
            None,
            &[Op::Update {
                table: "task_items".into(),
                id: "s1".into(),
                values,
            }],
            3,
        )
        .unwrap();
        crate::tx::undo_context(&txn, "user", &format!("capture:{fixed}"), 4).unwrap();
        let row: (String, String, String) = txn
            .query_row(
                "SELECT title, status, parent_id FROM task_items WHERE id = 's1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(row, ("take good notes".into(), "done".into(), "t5".into()));
    }

    #[test]
    fn the_sheet_shows_the_areas_cheat_lines_in_card_order() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::configure(&conn).unwrap();
        crate::migrate::run(&mut conn, crate::migrate::MIGRATIONS, 0).unwrap();
        conn.execute_batch(
            "INSERT INTO note_items (id, kind, status, body, area_id, sort_order, created_at, updated_at, deleted_at) VALUES
               ('a', 'cheat', 'kept', 'pinned later', 'coding', NULL, 30, 0, NULL),
               ('b', 'cheat', 'kept', 'first by hand', 'coding', 0, 20, 0, NULL),
               ('c', 'cheat', 'kept', 'pinned first', 'coding', NULL, 10, 0, NULL),
               ('d', 'cheat', 'kept', 'deleted', 'coding', NULL, 5, 0, 1),
               ('e', 'cheat', 'kept', 'other area', 'quran', NULL, 1, 0, NULL),
               ('f', 'note', 'kept', 'not a cheat', 'coding', NULL, 1, 0, NULL);",
        )
        .unwrap();
        assert_eq!(
            super::cheat_lines(&conn, Some("coding")),
            vec!["first by hand", "pinned first", "pinned later"]
        );
        assert!(super::cheat_lines(&conn, None).is_empty());
    }

    #[test]
    fn the_sheet_target_picks_the_block_area_or_nothing() {
        use super::SetupTarget;
        let opened = || Some("b1".to_string());
        // No choice made: the block the sheet was opened for.
        assert_eq!(
            SetupTarget::resolve(None, opened()),
            (Some("b1".into()), None)
        );
        // "Just focus": nothing, even when opened for a block.
        assert_eq!(
            SetupTarget::resolve(Some(&SetupTarget::default()), opened()),
            (None, None)
        );
        let area = SetupTarget {
            area_id: Some("coding".into()),
            ..SetupTarget::default()
        };
        assert_eq!(
            SetupTarget::resolve(Some(&area), opened()),
            (None, Some("coding".into()))
        );
        let other = SetupTarget {
            other: Some("  ".into()),
            ..SetupTarget::default()
        };
        assert_eq!(other.other_name(), None);
        let parsed: SetupTarget =
            serde_json::from_str(r#"{"blockId":"b2","other":" Read "}"#).unwrap();
        assert_eq!(parsed.block_id.as_deref(), Some("b2"));
        assert_eq!(parsed.other_name().as_deref(), Some("Read"));
    }
}

/// Opens the capture box; the + on the main window's rail.
#[tauri::command]
pub fn open_capture(app: AppHandle) {
    crate::windows::spawn_open_capture(app);
}

/// Opens (or brings up) the main window; the widget's Open button.
#[tauri::command]
pub fn open_main(app: AppHandle) {
    crate::windows::spawn_open_main(app);
}

/// Paints the calling window's title bar in the theme's colours (theme switch).
#[tauri::command]
pub fn title_bar(window: tauri::WebviewWindow, theme: String) {
    crate::windows::paint_title_bar(&window, &theme);
}

/// Opens or closes the desktop widget to match its setting (Settings switch).
#[tauri::command]
pub fn widget_apply(app: AppHandle) {
    crate::widget::apply(&app);
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

/// What the morning brief warns about: muted toasts, no autostart (R-NOT-03).
#[tauri::command]
pub fn brief_checks(app: AppHandle) -> crate::session::Checks {
    crate::session::checks(&app)
}

/// The brief calls this once its numbers are on screen; logs the time from
/// the unlock that opened it (T-025: under 1 s).
#[tauri::command]
pub fn brief_ready(requested_at: State<'_, crate::session::BriefRequestedAt>) {
    if let Some(requested) = requested_at.0.lock().take() {
        log::info!("brief ready in {} ms", requested.elapsed().as_millis());
    }
}

/// The screen the main window should open on (the night review), once.
#[tauri::command]
pub fn take_screen(pending: State<'_, crate::review::PendingScreen>) -> Option<String> {
    pending.0.lock().take()
}

/// Opens the focus set-up sheet for a block (Today's Start focus).
#[tauri::command]
pub fn focus_setup_open(block_id: Option<String>, app: AppHandle) {
    crate::windows::spawn_open_setup(app, block_id);
}

/// What the set-up sheet shows: the block, the session length and the kit.
#[derive(serde::Serialize)]
pub struct SetupInfo {
    pub title: String,
    pub minutes: i64,
    pub kit: crate::kit::Kit,
    /// Do not disturb is switched on automatically (T-029).
    pub dnd: bool,
    /// The area's cheat sheet, shown next to the timer (plan §3.15).
    pub notes: Vec<String>,
    /// The block the sheet was opened for, if any (the default "for what").
    pub block_id: Option<String>,
    /// What else the session can be for (spec §1 rule 7).
    pub blocks: Vec<crate::focus::DayBlock>,
    pub areas: Vec<crate::focus::AreaChoice>,
}

/// What the sheet's session is for: a block, an area with no block, or
/// "Other…" (a typed name that becomes a block now). All empty: a plain
/// session. No target at all: the block the sheet was opened for.
#[derive(serde::Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SetupTarget {
    pub block_id: Option<String>,
    pub area_id: Option<String>,
    pub other: Option<String>,
}

impl SetupTarget {
    /// The block and area a session is for (before "Other…" adds its block).
    fn resolve(
        target: Option<&SetupTarget>,
        opened_for: Option<String>,
    ) -> (Option<String>, Option<String>) {
        match target {
            None => (opened_for, None),
            Some(target) => (target.block_id.clone(), target.area_id.clone()),
        }
    }

    /// The typed "Other…" name, trimmed; None when it is not an Other target.
    fn other_name(&self) -> Option<String> {
        self.other
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_string)
    }
}

/// Most cheat lines a sheet shows; the card itself stays short on purpose.
const SHEET_NOTES: usize = 12;

/// An area's cheat lines in card order (same order as the Notes page).
pub fn cheat_lines(conn: &rusqlite::Connection, area_id: Option<&str>) -> Vec<String> {
    let Some(area_id) = area_id else {
        return Vec::new();
    };
    let lines = conn
        .prepare(
            "SELECT body FROM note_items
             WHERE kind = 'cheat' AND status = 'kept' AND deleted_at IS NULL AND area_id = ?1
             ORDER BY sort_order IS NULL, sort_order, created_at, id
             LIMIT ?2",
        )
        .and_then(|mut statement| {
            statement
                .query_map(rusqlite::params![area_id, SHEET_NOTES as i64], |row| {
                    row.get(0)
                })?
                .collect::<rusqlite::Result<Vec<String>>>()
        });
    lines.unwrap_or_else(|error| {
        log::warn!("could not read the cheat sheet: {error}");
        Vec::new()
    })
}

/// Async: it probes the Do not disturb COM server, which must never block
/// the main thread.
#[tauri::command(async)]
pub fn setup_info(
    target: Option<SetupTarget>,
    db: State<'_, Db>,
    pending: State<'_, crate::kit::PendingSetup>,
) -> Result<SetupInfo, String> {
    let opened_for = pending.0.lock().clone().flatten();
    let (block, area) = SetupTarget::resolve(target.as_ref(), opened_for.clone());
    let (context, kit, notes, blocks, areas) = {
        let conn = db.write.lock();
        let mut context =
            crate::focus::context_for_target(&conn, block.as_deref(), area.as_deref())
                .map_err(|error| error.to_string())?;
        if let Some(name) = target.as_ref().and_then(SetupTarget::other_name) {
            context.title = name;
        }
        let kit = crate::kit::load(&conn, context.area_id.as_deref());
        let notes = cheat_lines(&conn, context.area_id.as_deref());
        let blocks = crate::focus::today_blocks(&conn, clock::now_ms())
            .map_err(|error| error.to_string())?;
        let areas = crate::focus::area_choices(&conn).map_err(|error| error.to_string())?;
        (context, kit, notes, blocks, areas)
    };
    Ok(SetupInfo {
        kit,
        title: context.title,
        minutes: context.focus_min,
        dnd: crate::dnd::available(),
        notes,
        block_id: opened_for,
        blocks,
        areas,
    })
}

/// Enter on the sheet: starts the session, then (off the UI thread) records
/// the intent and applies the kit. Same answers as focus_start.
#[tauri::command]
pub fn setup_start(
    intent: Option<String>,
    force: Option<bool>,
    target: Option<SetupTarget>,
    app: AppHandle,
    window: WebviewWindow,
) -> Result<String, String> {
    let other = target.as_ref().and_then(|target| target.other.as_ref());
    let name = target.as_ref().and_then(SetupTarget::other_name);
    if other.is_some() && name.is_none() {
        return Err("Type what this session is for.".into());
    }
    // "Other…": the block goes in first, so the session can point at it.
    let added = match name {
        Some(name) => {
            let db = app.state::<Db>();
            let conn = db.write.lock();
            let minutes = crate::focus::context_for(&conn, None)
                .map(|context| context.focus_min)
                .unwrap_or(25);
            let id = crate::focus::add_other_block(&conn, &name, minutes, clock::now_ms())
                .map_err(|error| error.to_string())?;
            Some(id)
        }
        None => None,
    };
    let (block, area) = if let Some(id) = &added {
        (Some(id.clone()), None)
    } else {
        let opened_for = app
            .state::<crate::kit::PendingSetup>()
            .0
            .lock()
            .clone()
            .flatten();
        SetupTarget::resolve(target.as_ref(), opened_for)
    };
    let effects = crate::focus::start_for(
        &app,
        block.as_deref(),
        area.as_deref(),
        force.unwrap_or(false),
    );
    let result = start_result(&effects);
    if result != "started" {
        if let Some(id) = &added {
            let db = app.state::<Db>();
            crate::focus::remove_other_block(&db.write.lock(), id, clock::now_ms());
        }
        return Ok(result);
    }
    if added.is_some() {
        emit_changed(&app, vec!["day_blocks".into()]);
    }
    app.state::<crate::kit::PendingSetup>().0.lock().take();
    let _ = window.close();
    let intent = intent
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty());
    std::thread::spawn(move || {
        if let Some(intent) = intent {
            crate::focus::set_intent(&app, &intent);
        }
        let kit = {
            let db = app.state::<Db>();
            let conn = db.write.lock();
            crate::focus::context_for_target(&conn, block.as_deref(), area.as_deref())
                .map(|context| crate::kit::load(&conn, context.area_id.as_deref()))
                .unwrap_or_default()
        };
        let minimized = crate::kit::apply(&kit);
        log::info!(
            "focus kit: opened {}, minimized {minimized} window(s)",
            kit.open.len()
        );
    });
    Ok(result)
}

/// Undoes one Notes save (plan §3.15: an overwrite can be undone). Only
/// `notes:` contexts, so the webview can't undo other people's work.
#[tauri::command]
pub fn notes_undo(context: String, app: AppHandle, db: State<'_, Db>) -> Result<usize, String> {
    if !context.starts_with("notes:") || context.len() > 64 {
        return Err("only a Notes edit can be undone here".into());
    }
    let undone = {
        let mut conn = db.write.lock();
        let txn = conn.transaction().map_err(|error| error.to_string())?;
        let undone = tx::undo_context(&txn, "user", &context, clock::now_ms())
            .map_err(|error| error.to_string())?;
        txn.commit().map_err(|error| error.to_string())?;
        undone
    };
    emit_changed(&app, vec!["note_items".into()]);
    Ok(undone)
}

/// `? query` + Enter in the capture box: the main window opens on Notes.
#[tauri::command]
pub fn open_notes(query: String, app: AppHandle) {
    let query: String = query.chars().take(200).collect();
    crate::review::open_screen(&app, &format!("notes:{query}"));
}

/// `away till mon` (plan §3.11): pauses the brief, the review and block
/// toasts until that logical date. Returns the date stored.
#[tauri::command]
pub fn set_away(
    until: Option<String>,
    raw_id: Option<i64>,
    app: AppHandle,
    db: State<'_, Db>,
) -> Result<String, String> {
    let now = clock::now_ms();
    let (today, day_start) = crate::tasks::logical_day(now);
    let tomorrow = crate::tasks::logical_day(day_start + 25 * 60 * 60 * 1000).0;
    let date = crate::away::return_date(until.as_deref(), &today, &tomorrow);
    // Logged under the capture that asked for it: undoing or fixing that
    // capture (capture_undo, capture_replace, tray Undo) undoes away too.
    let context = raw_id.map_or_else(|| "away".to_string(), |id| format!("capture:{id}"));
    write_away(&app, &db, &date, &context, now, raw_id)?;
    Ok(date)
}

/// "I'm back" on Today, or `back` in the capture bar (`raw_id`): logged
/// under that capture, so undoing or fixing it puts away back (F41).
#[tauri::command]
pub fn clear_away(raw_id: Option<i64>, app: AppHandle, db: State<'_, Db>) -> Result<(), String> {
    let context = raw_id.map_or_else(|| "away".to_string(), |id| format!("capture:{id}"));
    // An empty date is never later than today, so it means "not away".
    write_away(&app, &db, "", &context, clock::now_ms(), raw_id)
}

/// Stores the return day. The capture line that asked for it, if any, is
/// marked parsed: it made a record, so Ctrl+Z, Up and the tray find it (F38).
fn write_away(
    app: &AppHandle,
    db: &Db,
    date: &str,
    context: &str,
    now: i64,
    raw_id: Option<i64>,
) -> Result<(), String> {
    {
        let mut conn = db.write.lock();
        let txn = conn.transaction().map_err(|error| error.to_string())?;
        let mut values = Map::new();
        values.insert(
            "value_json".into(),
            Value::from(Value::from(date).to_string()),
        );
        let op = Op::Upsert {
            table: "core_settings".into(),
            id: crate::away::AWAY_KEY.into(),
            values,
        };
        tx::apply_ops(&txn, "user", Some(context), &[op], now)
            .map_err(|error| error.to_string())?;
        if let Some(raw_id) = raw_id {
            db::mark_parsed(&txn, raw_id, Some("away"), now).map_err(|error| error.to_string())?;
        }
        txn.commit().map_err(|error| error.to_string())?;
    }
    emit_changed(app, vec!["core_settings".into(), "core_raw_items".into()]);
    crate::tray::rebuild(app);
    Ok(())
}

/// The task names the AI gate accepts (plan §7.3); each is logged by name.
const AI_TASKS: [&str; 8] = [
    "timing", "estimate", "brief", "week", "review", "capture", "split", "money",
];

/// Sends one model request through the gate (ai.rs). The webview builds the
/// body; the key stays in Rust. Errors are stable codes ("no-key",
/// "budget:15", "rate-limited:34", …) so every caller can fall back to its
/// template text.
#[tauri::command(async)]
pub fn ai_send(
    task: String,
    prompt_version: Option<String>,
    body: Value,
    db: State<'_, Db>,
) -> Result<crate::ai::Reply, String> {
    if !AI_TASKS.contains(&task.as_str()) {
        return Err(format!("unknown-task:{task}"));
    }
    let model = db::setting_string(&db.write.lock(), crate::ai::MODEL_KEY).unwrap_or_default();
    let request = crate::ai::Request {
        task: &task,
        model: &model,
        prompt_version: prompt_version.as_deref(),
        body: &body,
    };
    crate::ai::send_now(&db, &request).map_err(|refusal| refusal.code())
}

/// Fetches the calendar feed (plan Appendix A). The secret address stays in
/// Rust; the page gets the feed text, or a code to show in words.
#[tauri::command(async)]
pub fn calendar_fetch() -> Result<String, String> {
    match crate::calendar::fetch() {
        crate::calendar::Fetched::Feed(text) => Ok(text),
        crate::calendar::Fetched::Code(code) => {
            log::info!("calendar fetch: {code}");
            Err(code.to_string())
        }
    }
}

/// The models the saved key can use, for picking one in Settings.
#[tauri::command(async)]
pub fn ai_models(db: State<'_, Db>) -> Result<Vec<crate::ai::Model>, String> {
    crate::ai::list_models(&db).map_err(|refusal| refusal.code())
}

#[derive(serde::Serialize)]
pub struct AiUsage {
    pub has_key: bool,
    pub model: Option<String>,
    pub used: i64,
    pub cap: i64,
    pub quota_day: String,
}

/// Requests used today (by the Pacific date the free tier counts by).
#[tauri::command]
pub fn ai_usage(db: State<'_, Db>) -> AiUsage {
    let conn = db.write.lock();
    let quota_day = crate::ai::pacific_date(clock::now_ms());
    AiUsage {
        has_key: secrets::exists(crate::ai::KEY_NAME).unwrap_or(false),
        model: db::setting_string(&conn, crate::ai::MODEL_KEY).filter(|m| !m.is_empty()),
        used: crate::ai::used_on(&conn, &quota_day),
        cap: crate::ai::daily_cap(&conn),
        quota_day,
    }
}

/// The capture key in use, for Settings.
#[tauri::command]
pub fn hotkey_current(app: AppHandle) -> Option<String> {
    crate::hotkey::current(&app)
}

/// Switches to a new capture key (empty: back to the defaults) and saves it
/// once it is in use. A key another app owns is refused and the old one stays.
#[tauri::command]
pub fn hotkey_set(key: String, app: AppHandle, db: State<'_, Db>) -> Result<String, String> {
    let key = key.trim().to_string();
    let choice = if key.is_empty() {
        None
    } else {
        let shortcut = crate::hotkey::parse_key(&key).ok_or_else(|| {
            format!("\"{key}\" isn't a key combination with Ctrl, Alt or Win. Try Ctrl+Alt+K.")
        })?;
        Some((shortcut, key.clone()))
    };
    let in_use = crate::hotkey::switch(&app, choice)?;
    {
        let mut conn = db.write.lock();
        let txn = conn.transaction().map_err(|error| error.to_string())?;
        let mut values = Map::new();
        values.insert(
            "value_json".into(),
            Value::from(Value::from(key.as_str()).to_string()),
        );
        let op = Op::Upsert {
            table: "core_settings".into(),
            id: "capture.hotkey".into(),
            values,
        };
        tx::apply_ops(&txn, "user", Some("settings"), &[op], clock::now_ms())
            .map_err(|error| error.to_string())?;
        txn.commit().map_err(|error| error.to_string())?;
    }
    emit_changed(&app, vec!["core_settings".into()]);
    crate::tray::refresh_tooltip(&app);
    Ok(in_use)
}

/// Closes the calling window (the capture box).
#[tauri::command]
pub fn close_window(window: WebviewWindow) -> Result<(), String> {
    window.close().map_err(|error| error.to_string())
}

/// Starts Sirna with Windows (tray only), or stops it (plan §3.1 step 5).
#[tauri::command]
pub fn autostart_set(enabled: bool, app: AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    let launcher = app.autolaunch();
    let result = if enabled {
        launcher.enable()
    } else {
        launcher.disable()
    };
    result.map_err(|error| error.to_string())?;
    launcher.is_enabled().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn autostart_status(app: AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch()
        .is_enabled()
        .map_err(|error| error.to_string())
}

/// Starts a focus session for a block (or a plain one). Returns "started",
/// "confirm" (it would cut a long break short; call again with force) or
/// "already" (a session is running) or "confirm-stop" (past the hard stop).
#[tauri::command]
pub fn focus_start(block_id: Option<String>, force: Option<bool>, app: AppHandle) -> String {
    let effects = crate::focus::start_with_block(&app, block_id, force.unwrap_or(false));
    start_result(&effects)
}

fn start_result(effects: &[crate::focus::Effect]) -> String {
    if effects.contains(&crate::focus::Effect::PastHardStop) {
        "confirm-stop".into()
    } else if effects.contains(&crate::focus::Effect::NeedConfirm) {
        "confirm".into()
    } else if effects.contains(&crate::focus::Effect::AlreadyFocusing) {
        "already".into()
    } else {
        "started".into()
    }
}

/// pause, resume, stop or distracted.
#[tauri::command]
pub fn focus_control(action: String, app: AppHandle) -> Result<(), String> {
    use crate::focus::Event;
    let event = match action.as_str() {
        "pause" => Event::Pause,
        "resume" => Event::Resume,
        "stop" => Event::Stop,
        "distracted" => Event::Distracted,
        other => return Err(format!("Unknown focus action: {other}")),
    };
    crate::focus::dispatch(&app, event);
    Ok(())
}

#[tauri::command]
pub fn focus_status(focus: State<'_, crate::focus::FocusState>) -> crate::focus::Status {
    let machine = focus.machine.lock();
    crate::focus::status(&machine, clock::now_ms())
}
