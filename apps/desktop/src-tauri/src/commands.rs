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

/// A capture may only add tasks, notes and money. Anything else (updates,
/// deletes, settings) goes through db_tx, which the capture window can't call.
pub fn capture_ops_allowed(ops: &[Op]) -> bool {
    ops.iter().all(|op| {
        matches!(op, Op::Insert { table, .. }
            if matches!(table.as_str(), "task_items" | "note_items" | "money_txns" | "project_items"))
    })
}

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
        return Err("A capture can only add tasks, notes, money or ideas".into());
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
        tx::undo_context(&txn, "user", &format!("capture:{raw_id}"), now)
            .map_err(|error| error.to_string())?;
        db::mark_ignored(&txn, raw_id).map_err(|error| error.to_string())?;
        let new_id = store_capture(&txn, &raw_text, &ops, parser.as_deref(), now)?;
        txn.commit().map_err(|error| error.to_string())?;
        new_id
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
    Ok(new_id)
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
    use super::{capture_ops_allowed, is_read_query};
    use crate::tx::Op;
    use serde_json::Map;

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
            insert("project_items")
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
    db: State<'_, Db>,
    pending: State<'_, crate::kit::PendingSetup>,
) -> Result<SetupInfo, String> {
    let block = pending.0.lock().clone().flatten();
    let (context, kit, notes) = {
        let conn = db.write.lock();
        let context = crate::focus::context_for(&conn, block.as_deref())
            .map_err(|error| error.to_string())?;
        let kit = crate::kit::load(&conn, context.area_id.as_deref());
        let notes = cheat_lines(&conn, context.area_id.as_deref());
        (context, kit, notes)
    };
    Ok(SetupInfo {
        kit,
        title: context.title,
        minutes: context.focus_min,
        dnd: crate::dnd::available(),
        notes,
    })
}

/// Enter on the sheet: starts the session, then (off the UI thread) records
/// the intent and applies the kit. Same answers as focus_start.
#[tauri::command]
pub fn setup_start(
    intent: Option<String>,
    force: Option<bool>,
    app: AppHandle,
    window: WebviewWindow,
) -> String {
    let block = app
        .state::<crate::kit::PendingSetup>()
        .0
        .lock()
        .clone()
        .flatten();
    let effects = crate::focus::start_with_block(&app, block.clone(), force.unwrap_or(false));
    let result = start_result(&effects);
    if result != "started" {
        return result;
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
            crate::focus::context_for(&conn, block.as_deref())
                .map(|context| crate::kit::load(&conn, context.area_id.as_deref()))
                .unwrap_or_default()
        };
        let minimized = crate::kit::apply(&kit);
        log::info!(
            "focus kit: opened {}, minimized {minimized} window(s)",
            kit.open.len()
        );
    });
    result
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
    write_away(&app, &db, &date, &context, now)?;
    Ok(date)
}

/// "I'm back" on Today.
#[tauri::command]
pub fn clear_away(app: AppHandle, db: State<'_, Db>) -> Result<(), String> {
    // An empty date is never later than today, so it means "not away".
    write_away(&app, &db, "", "away", clock::now_ms())
}

fn write_away(app: &AppHandle, db: &Db, date: &str, context: &str, now: i64) -> Result<(), String> {
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
        txn.commit().map_err(|error| error.to_string())?;
    }
    emit_changed(app, vec!["core_settings".into()]);
    crate::tray::rebuild(app);
    Ok(())
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
