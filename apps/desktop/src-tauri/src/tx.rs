//! The one write path (plan §4.5, ADR-0002).
//!
//! The webview never sends SQL to write. It sends ops — insert, update or
//! delete a row by id — and Rust checks every table and column against an
//! allowlist, stamps `created_at` / `updated_at` / `user_edited_at`, turns
//! deletes into soft deletes, and writes a `core_activity` row with the row as
//! JSON before and after. Undo replays that log backwards.

use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{Connection, OptionalExtension, params_from_iter};
use serde::Deserialize;
use serde_json::{Map, Value};

/// How one writable table behaves.
pub struct TableSpec {
    pub name: &'static str,
    pub id_column: &'static str,
    /// Columns the webview may set. Timestamps are never in this list.
    pub columns: &'static [&'static str],
    pub has_created_at: bool,
    pub soft_delete: bool,
    pub has_user_edited_at: bool,
}

pub const TABLES: &[TableSpec] = &[
    TableSpec {
        name: "task_items",
        id_column: "id",
        columns: &[
            "title",
            "notes",
            "first_step",
            "status",
            "due_date",
            "planned_date",
            "deadline_stale",
            "parent_id",
            "step_no",
            "due_at",
            "remind_at",
            "estimate_min",
            "area_id",
            "project_id",
            "waiting_on",
            "follow_up_date",
            "carries",
            "origin",
            "completed_at",
            "started_at",
        ],
        has_created_at: true,
        soft_delete: true,
        has_user_edited_at: true,
    },
    TableSpec {
        name: "cal_occurrences",
        id_column: "id",
        columns: &[
            "ical_uid",
            "summary",
            "location",
            "start_at",
            "end_at",
            "local_date",
            "all_day",
        ],
        has_created_at: true,
        soft_delete: true,
        has_user_edited_at: false,
    },
    TableSpec {
        name: "savings_goals",
        id_column: "id",
        columns: &["title", "target_minor", "start_date", "status"],
        has_created_at: true,
        soft_delete: true,
        has_user_edited_at: false,
    },
    TableSpec {
        name: "savings_entries",
        id_column: "id",
        columns: &[
            "goal_id",
            "occurred_at",
            "local_date",
            "amount_minor",
            "note",
            "origin",
        ],
        has_created_at: true,
        soft_delete: true,
        has_user_edited_at: false,
    },
    TableSpec {
        name: "project_items",
        id_column: "id",
        columns: &[
            "title",
            "area_id",
            "goal",
            "estimate_min",
            "estimate_by",
            "deadline",
            "weekly_min",
            "start_date",
            "forecast_finish",
            "status",
            "next_step_task_id",
            "last_check_json",
            "origin",
        ],
        has_created_at: true,
        soft_delete: true,
        has_user_edited_at: true,
    },
    TableSpec {
        name: "note_items",
        id_column: "id",
        columns: &[
            "kind",
            "status",
            "title",
            "body",
            "area_id",
            "project_id",
            "sort_order",
            "origin",
        ],
        has_created_at: true,
        soft_delete: true,
        has_user_edited_at: true,
    },
    TableSpec {
        name: "money_txns",
        id_column: "id",
        columns: &[
            "account",
            "occurred_at",
            "local_date",
            "amount_minor",
            "currency",
            "description",
            "category_id",
            "origin",
        ],
        has_created_at: true,
        soft_delete: true,
        has_user_edited_at: true,
    },
    TableSpec {
        name: "money_templates",
        id_column: "id",
        columns: &["label", "amount_minor", "category_id", "uses"],
        has_created_at: true,
        soft_delete: true,
        has_user_edited_at: false,
    },
    TableSpec {
        name: "area_items",
        id_column: "id",
        columns: &[
            "name",
            "kind",
            "color",
            "weekly_target_min",
            "capped",
            "protected",
            "priority_rank",
            "focus_min",
            "break_min",
            "active",
        ],
        has_created_at: true,
        soft_delete: true,
        has_user_edited_at: false,
    },
    TableSpec {
        name: "routine_blocks",
        id_column: "id",
        columns: &[
            "weekday",
            "start_min",
            "duration_min",
            "kind",
            "area_id",
            "title",
            "active",
        ],
        has_created_at: true,
        soft_delete: true,
        has_user_edited_at: false,
    },
    TableSpec {
        name: "day_blocks",
        id_column: "id",
        columns: &[
            "logical_date",
            "start_at",
            "end_at",
            "kind",
            "area_id",
            "task_id",
            "project_id",
            "title",
            "source",
            "status",
            "light_day",
        ],
        has_created_at: true,
        soft_delete: true,
        has_user_edited_at: true,
    },
    TableSpec {
        name: "task_daily_top",
        id_column: "id",
        columns: &["logical_date", "position", "task_id", "chosen_by"],
        has_created_at: true,
        soft_delete: false,
        has_user_edited_at: false,
    },
    TableSpec {
        name: "focus_kits",
        id_column: "area_id",
        columns: &["open_json", "minimize_json", "checklist_json"],
        has_created_at: true,
        soft_delete: false,
        has_user_edited_at: false,
    },
    TableSpec {
        name: "day_reviews",
        id_column: "logical_date",
        columns: &["status", "energy", "spent_none", "mind"],
        has_created_at: true,
        soft_delete: false,
        has_user_edited_at: false,
    },
    TableSpec {
        name: "core_settings",
        id_column: "key",
        columns: &["value_json"],
        has_created_at: false,
        soft_delete: false,
        has_user_edited_at: false,
    },
];

#[derive(Debug, Deserialize, PartialEq)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum Op {
    Insert {
        table: String,
        id: String,
        values: Map<String, Value>,
    },
    Update {
        table: String,
        id: String,
        values: Map<String, Value>,
    },
    Delete {
        table: String,
        id: String,
    },
    /// Insert, or update the existing row with the same id (settings by key).
    Upsert {
        table: String,
        id: String,
        values: Map<String, Value>,
    },
}

#[derive(Debug, PartialEq)]
pub enum TxError {
    UnknownTable(String),
    ColumnNotAllowed { table: String, column: String },
    BadValue { column: String },
    EmptyId,
    NotFound { table: String, id: String },
    Sql(String),
}

impl std::fmt::Display for TxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnknownTable(table) => write!(f, "table not writable: {table}"),
            Self::ColumnNotAllowed { table, column } => {
                write!(f, "column not writable: {table}.{column}")
            }
            Self::BadValue { column } => write!(
                f,
                "value for {column} must be text, a number, a boolean or null"
            ),
            Self::EmptyId => write!(f, "rows need an id"),
            Self::NotFound { table, id } => write!(f, "no {table} row with id {id}"),
            Self::Sql(message) => write!(f, "database error: {message}"),
        }
    }
}

impl std::error::Error for TxError {}

impl From<rusqlite::Error> for TxError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sql(error.to_string())
    }
}

fn spec(table: &str) -> Result<&'static TableSpec, TxError> {
    TABLES
        .iter()
        .find(|spec| spec.name == table)
        .ok_or_else(|| TxError::UnknownTable(table.to_string()))
}

/// The allowlisted column name (a `'static` constant), never the caller's string.
fn column(spec: &TableSpec, name: &str) -> Result<&'static str, TxError> {
    spec.columns
        .iter()
        .find(|column| **column == name)
        .copied()
        .ok_or_else(|| TxError::ColumnNotAllowed {
            table: spec.name.to_string(),
            column: name.to_string(),
        })
}

fn to_sql(column: &str, value: &Value) -> Result<SqlValue, TxError> {
    Ok(match value {
        Value::Null => SqlValue::Null,
        Value::Bool(flag) => SqlValue::Integer(i64::from(*flag)),
        Value::Number(number) => match number.as_i64() {
            Some(integer) => SqlValue::Integer(integer),
            None => SqlValue::Real(number.as_f64().ok_or(TxError::BadValue {
                column: column.to_string(),
            })?),
        },
        Value::String(text) => SqlValue::Text(text.clone()),
        Value::Array(_) | Value::Object(_) => {
            return Err(TxError::BadValue {
                column: column.to_string(),
            });
        }
    })
}

/// One SQLite value as JSON.
pub fn to_json(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(integer) => Value::from(integer),
        ValueRef::Real(real) => Value::from(real),
        ValueRef::Text(text) => Value::from(String::from_utf8_lossy(text).into_owned()),
        ValueRef::Blob(_) => Value::Null,
    }
}

/// The whole row as a JSON object, or None if it doesn't exist.
fn row_json(conn: &Connection, spec: &TableSpec, id: &str) -> Result<Option<Value>, TxError> {
    let sql = format!("SELECT * FROM {} WHERE {} = ?1", spec.name, spec.id_column);
    let mut statement = conn.prepare(&sql)?;
    let names: Vec<String> = statement
        .column_names()
        .map(|name| (*name).to_string())
        .collect();
    let row = statement
        .query_row([id], |row| {
            let mut object = Map::new();
            for (index, name) in names.iter().enumerate() {
                object.insert(name.clone(), to_json(row.get_ref(index)?));
            }
            Ok(Value::Object(object))
        })
        .optional()?;
    Ok(row)
}

// One argument per core_activity column; a struct would only rename them.
#[allow(clippy::too_many_arguments)]
fn log_activity(
    conn: &Connection,
    at: i64,
    actor: &str,
    context: Option<&str>,
    table: &str,
    id: &str,
    action: &str,
    before: Option<&Value>,
    after: Option<&Value>,
) -> Result<(), TxError> {
    conn.execute(
        "INSERT INTO core_activity (at, actor, context, entity_type, entity_id, action, before_json, after_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![
            at,
            actor,
            context,
            table,
            id,
            action,
            before.map(Value::to_string),
            after.map(Value::to_string),
        ],
    )?;
    Ok(())
}

/// Applies ops inside the caller's transaction. Returns the ids touched.
pub fn apply_ops(
    conn: &Connection,
    actor: &str,
    context: Option<&str>,
    ops: &[Op],
    now_ms: i64,
) -> Result<Vec<String>, TxError> {
    let mut ids = Vec::with_capacity(ops.len());
    for op in ops {
        let resolved;
        // An upsert means "this row, with these values": it also brings back
        // a soft-deleted row (undo puts the deletion back).
        let upsert = matches!(op, Op::Upsert { .. });
        let op = if let Op::Upsert { table, id, values } = op {
            let exists = row_json(conn, spec(table)?, id)?.is_some();
            resolved = if exists {
                Op::Update {
                    table: table.clone(),
                    id: id.clone(),
                    values: values.clone(),
                }
            } else {
                Op::Insert {
                    table: table.clone(),
                    id: id.clone(),
                    values: values.clone(),
                }
            };
            &resolved
        } else {
            op
        };
        match op {
            Op::Insert { table, id, values } => {
                let spec = spec(table)?;
                if id.trim().is_empty() {
                    return Err(TxError::EmptyId);
                }
                let mut names = vec![spec.id_column];
                let mut sql_values = vec![SqlValue::Text(id.clone())];
                for (name, value) in values {
                    names.push(column(spec, name)?);
                    sql_values.push(to_sql(name, value)?);
                }
                if spec.has_created_at {
                    names.push("created_at");
                    sql_values.push(SqlValue::Integer(now_ms));
                }
                names.push("updated_at");
                sql_values.push(SqlValue::Integer(now_ms));
                let placeholders = (1..=names.len())
                    .map(|n| format!("?{n}"))
                    .collect::<Vec<_>>()
                    .join(", ");
                let sql = format!(
                    "INSERT INTO {} ({}) VALUES ({placeholders})",
                    spec.name,
                    names.join(", ")
                );
                conn.execute(&sql, params_from_iter(sql_values))?;
                let after = row_json(conn, spec, id)?;
                log_activity(
                    conn,
                    now_ms,
                    actor,
                    context,
                    spec.name,
                    id,
                    "insert",
                    None,
                    after.as_ref(),
                )?;
                ids.push(id.clone());
            }
            Op::Update { table, id, values } => {
                let spec = spec(table)?;
                let before = row_json(conn, spec, id)?.ok_or_else(|| TxError::NotFound {
                    table: table.clone(),
                    id: id.clone(),
                })?;
                let mut sets = Vec::new();
                let mut sql_values = Vec::new();
                for (name, value) in values {
                    sets.push(column(spec, name)?);
                    sql_values.push(to_sql(name, value)?);
                }
                if upsert && spec.soft_delete && !before["deleted_at"].is_null() {
                    sets.push("deleted_at");
                    sql_values.push(SqlValue::Null);
                }
                sets.push("updated_at");
                sql_values.push(SqlValue::Integer(now_ms));
                if spec.has_user_edited_at && actor == "user" {
                    sets.push("user_edited_at");
                    sql_values.push(SqlValue::Integer(now_ms));
                }
                let assignments = sets
                    .iter()
                    .enumerate()
                    .map(|(index, name)| format!("{name} = ?{}", index + 1))
                    .collect::<Vec<_>>()
                    .join(", ");
                sql_values.push(SqlValue::Text(id.clone()));
                let sql = format!(
                    "UPDATE {} SET {assignments} WHERE {} = ?{}",
                    spec.name,
                    spec.id_column,
                    sql_values.len()
                );
                conn.execute(&sql, params_from_iter(sql_values))?;
                let after = row_json(conn, spec, id)?;
                log_activity(
                    conn,
                    now_ms,
                    actor,
                    context,
                    spec.name,
                    id,
                    "update",
                    Some(&before),
                    after.as_ref(),
                )?;
                ids.push(id.clone());
            }
            Op::Upsert { .. } => unreachable!("upserts are resolved above"),
            Op::Delete { table, id } => {
                let spec = spec(table)?;
                let before = row_json(conn, spec, id)?.ok_or_else(|| TxError::NotFound {
                    table: table.clone(),
                    id: id.clone(),
                })?;
                if spec.soft_delete {
                    let sql = format!(
                        "UPDATE {} SET deleted_at = ?1, updated_at = ?1 WHERE {} = ?2",
                        spec.name, spec.id_column
                    );
                    conn.execute(&sql, rusqlite::params![now_ms, id])?;
                } else {
                    let sql = format!("DELETE FROM {} WHERE {} = ?1", spec.name, spec.id_column);
                    conn.execute(&sql, [id])?;
                }
                let after = row_json(conn, spec, id)?;
                log_activity(
                    conn,
                    now_ms,
                    actor,
                    context,
                    spec.name,
                    id,
                    "delete",
                    Some(&before),
                    after.as_ref(),
                )?;
                ids.push(id.clone());
            }
        }
    }
    Ok(ids)
}

/// Restores the writable columns of a row to an earlier JSON snapshot.
fn restore(
    conn: &Connection,
    spec: &TableSpec,
    id: &str,
    snapshot: &Map<String, Value>,
) -> Result<(), TxError> {
    let mut sets = Vec::new();
    let mut sql_values = Vec::new();
    for name in spec.columns.iter().copied().chain(
        ["deleted_at", "user_edited_at"]
            .into_iter()
            .filter(|name| *name != "user_edited_at" || spec.has_user_edited_at)
            .filter(|name| *name != "deleted_at" || spec.soft_delete),
    ) {
        if let Some(value) = snapshot.get(name) {
            sets.push(format!("{name} = ?{}", sets.len() + 1));
            sql_values.push(to_sql(name, value)?);
        }
    }
    if sets.is_empty() {
        return Ok(());
    }
    sql_values.push(SqlValue::Text(id.to_string()));
    let sql = format!(
        "UPDATE {} SET {} WHERE {} = ?{}",
        spec.name,
        sets.join(", "),
        spec.id_column,
        sql_values.len()
    );
    conn.execute(&sql, params_from_iter(sql_values))?;
    Ok(())
}

/// Reverses every change logged under `context`, newest first, inside the
/// caller's transaction. Inserts become soft deletes; updates and deletes are
/// restored to their "before" snapshot. Returns how many changes were undone.
pub fn undo_context(
    conn: &Connection,
    actor: &str,
    context: &str,
    now_ms: i64,
) -> Result<usize, TxError> {
    let entries: Vec<(String, String, String, Option<String>)> = {
        let mut statement = conn.prepare(
            "SELECT entity_type, entity_id, action, before_json FROM core_activity
             WHERE context = ?1 AND action != 'undo' ORDER BY id DESC",
        )?;
        statement
            .query_map([context], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })?
            .collect::<Result<_, _>>()?
    };
    let undo_context = format!("undo:{context}");
    for (table, id, action, before) in &entries {
        let spec = spec(table)?;
        let current = row_json(conn, spec, id)?;
        match (action.as_str(), before) {
            ("insert", _) if spec.soft_delete => {
                let sql = format!(
                    "UPDATE {} SET deleted_at = ?1, updated_at = ?1 WHERE {} = ?2",
                    spec.name, spec.id_column
                );
                conn.execute(&sql, rusqlite::params![now_ms, id])?;
            }
            ("insert", _) => {
                let sql = format!("DELETE FROM {} WHERE {} = ?1", spec.name, spec.id_column);
                conn.execute(&sql, [id])?;
            }
            (_, Some(before)) => {
                if let Ok(Value::Object(snapshot)) = serde_json::from_str::<Value>(before) {
                    restore(conn, spec, id, &snapshot)?;
                }
            }
            (_, None) => {}
        }
        let after = row_json(conn, spec, id)?;
        log_activity(
            conn,
            now_ms,
            actor,
            Some(&undo_context),
            spec.name,
            id,
            "undo",
            current.as_ref(),
            after.as_ref(),
        )?;
    }
    Ok(entries.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{db, migrate};
    use serde_json::json;

    fn conn() -> Connection {
        let mut conn = Connection::open_in_memory().expect("open");
        db::configure(&conn).expect("pragmas");
        migrate::run(&mut conn, migrate::MIGRATIONS, 0).expect("migrate");
        conn
    }

    /// Tables the webview may never write through `db_tx`: Rust owns them
    /// (the capture store, the audit log, the timer, AI calls, toasts, usage)
    /// or they are seeded by a migration. A new table must go in `TABLES` or
    /// here, on purpose (T-052).
    const RUST_OWNED: &[&str] = &[
        "core_migrations",
        "core_raw_items",
        "core_activity",
        "core_ai_calls",
        "core_notifications",
        "core_usage",
        "focus_sessions",
        "money_categories",
    ];

    #[test]
    fn every_table_is_writable_or_listed_as_rust_owned() {
        let conn = conn();
        let mut statement = conn
            .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table'
                 AND name NOT LIKE 'sqlite_%' ORDER BY name",
            )
            .expect("prepare");
        let tables: Vec<String> = statement
            .query_map([], |row| row.get(0))
            .expect("query")
            .collect::<Result<_, _>>()
            .expect("rows");
        let unlisted: Vec<&String> = tables
            .iter()
            .filter(|name| {
                !TABLES.iter().any(|spec| spec.name == name.as_str())
                    && !RUST_OWNED.contains(&name.as_str())
            })
            .collect();
        assert!(
            unlisted.is_empty(),
            "add a TableSpec in tx.rs (or list it in RUST_OWNED): {unlisted:?}"
        );
        // And nothing listed that no migration creates.
        for spec in TABLES {
            assert!(
                tables.contains(&spec.name.to_string()),
                "no table {}",
                spec.name
            );
        }
    }

    #[test]
    fn every_allowlisted_column_exists() {
        let conn = conn();
        for spec in TABLES {
            let statement = conn
                .prepare(&format!("SELECT * FROM {} LIMIT 0", spec.name))
                .expect("prepare");
            let names: Vec<String> = statement
                .column_names()
                .map(|name| name.to_string())
                .collect();
            for column in spec.columns {
                assert!(
                    names.contains(&column.to_string()),
                    "{}.{column} is allowlisted but not in the schema",
                    spec.name
                );
            }
            drop(statement);
        }
    }

    fn values(value: Value) -> Map<String, Value> {
        match value {
            Value::Object(map) => map,
            _ => panic!("expected an object"),
        }
    }

    fn insert_task(conn: &Connection, id: &str, title: &str) {
        let op = Op::Insert {
            table: "task_items".into(),
            id: id.into(),
            values: values(json!({ "title": title })),
        };
        apply_ops(conn, "user", Some("capture:1"), &[op], 100).expect("insert");
    }

    fn task(conn: &Connection, id: &str) -> Value {
        row_json(conn, spec("task_items").expect("spec"), id)
            .expect("read")
            .expect("row")
    }

    #[test]
    fn parses_ops_as_the_webview_sends_them() {
        let op: Op = serde_json::from_value(json!({
            "op": "insert", "table": "task_items", "id": "01T", "values": { "title": "Call bank" }
        }))
        .expect("parse");
        assert_eq!(
            op,
            Op::Insert {
                table: "task_items".into(),
                id: "01T".into(),
                values: values(json!({ "title": "Call bank" }))
            }
        );
    }

    #[test]
    fn insert_stamps_times_and_logs_the_row() {
        let conn = conn();
        insert_task(&conn, "t1", "Call bank");
        let row = task(&conn, "t1");
        assert_eq!(row["title"], "Call bank");
        assert_eq!(row["created_at"], 100);
        assert_eq!(row["status"], "todo");
        let (action, after): (String, String) = conn
            .query_row(
                "SELECT action, after_json FROM core_activity WHERE entity_id = 't1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("activity");
        assert_eq!(action, "insert");
        assert!(after.contains("Call bank"));
    }

    #[test]
    fn rejects_unknown_tables_and_columns() {
        let conn = conn();
        let bad_table = Op::Insert {
            table: "core_activity".into(),
            id: "x".into(),
            values: Map::new(),
        };
        assert_eq!(
            apply_ops(&conn, "user", None, &[bad_table], 1),
            Err(TxError::UnknownTable("core_activity".into()))
        );
        let bad_column = Op::Insert {
            table: "task_items".into(),
            id: "x".into(),
            values: values(json!({ "title": "x", "created_at": 5 })),
        };
        assert_eq!(
            apply_ops(&conn, "user", None, &[bad_column], 1),
            Err(TxError::ColumnNotAllowed {
                table: "task_items".into(),
                column: "created_at".into()
            })
        );
    }

    #[test]
    fn rejects_nested_values() {
        let conn = conn();
        let op = Op::Insert {
            table: "task_items".into(),
            id: "x".into(),
            values: values(json!({ "title": ["a"] })),
        };
        assert_eq!(
            apply_ops(&conn, "user", None, &[op], 1),
            Err(TxError::BadValue {
                column: "title".into()
            })
        );
    }

    #[test]
    fn a_user_update_marks_the_row_as_user_edited() {
        let conn = conn();
        insert_task(&conn, "t1", "Call bank");
        let op = Op::Update {
            table: "task_items".into(),
            id: "t1".into(),
            values: values(json!({ "title": "Call CBE" })),
        };
        apply_ops(&conn, "user", None, &[op], 200).expect("update");
        let row = task(&conn, "t1");
        assert_eq!(row["title"], "Call CBE");
        assert_eq!(row["user_edited_at"], 200);
        assert_eq!(row["updated_at"], 200);
    }

    #[test]
    fn a_parser_update_does_not_mark_user_edited() {
        let conn = conn();
        insert_task(&conn, "t1", "Call bank");
        let op = Op::Update {
            table: "task_items".into(),
            id: "t1".into(),
            values: values(json!({ "notes": "x" })),
        };
        apply_ops(&conn, "parser:capture@1", None, &[op], 200).expect("update");
        assert_eq!(task(&conn, "t1")["user_edited_at"], Value::Null);
    }

    #[test]
    fn delete_is_soft() {
        let conn = conn();
        insert_task(&conn, "t1", "Call bank");
        let op = Op::Delete {
            table: "task_items".into(),
            id: "t1".into(),
        };
        apply_ops(&conn, "user", None, &[op], 300).expect("delete");
        assert_eq!(task(&conn, "t1")["deleted_at"], 300);
    }

    #[test]
    fn updating_a_missing_row_fails() {
        let conn = conn();
        let op = Op::Update {
            table: "task_items".into(),
            id: "nope".into(),
            values: Map::new(),
        };
        assert!(matches!(
            apply_ops(&conn, "user", None, &[op], 1),
            Err(TxError::NotFound { .. })
        ));
    }

    #[test]
    fn undo_reverses_a_capture() {
        let conn = conn();
        insert_task(&conn, "t1", "Call bank");
        let undone = undo_context(&conn, "user", "capture:1", 500).expect("undo");
        assert_eq!(undone, 1);
        assert_eq!(task(&conn, "t1")["deleted_at"], 500);
    }

    #[test]
    fn undo_restores_an_update() {
        let conn = conn();
        insert_task(&conn, "t1", "Call bank");
        let op = Op::Update {
            table: "task_items".into(),
            id: "t1".into(),
            values: values(json!({ "title": "Wrong" })),
        };
        apply_ops(&conn, "user", Some("capture:2"), &[op], 200).expect("update");
        undo_context(&conn, "user", "capture:2", 300).expect("undo");
        let row = task(&conn, "t1");
        assert_eq!(row["title"], "Call bank");
        assert_eq!(row["deleted_at"], Value::Null);
    }

    #[test]
    fn settings_upsert_by_key() {
        let conn = conn();
        let op = Op::Insert {
            table: "core_settings".into(),
            id: "capture.at3".into(),
            values: values(json!({ "value_json": "\"15:00\"" })),
        };
        apply_ops(&conn, "user", None, &[op], 1).expect("insert setting");
        let value: String = conn
            .query_row(
                "SELECT value_json FROM core_settings WHERE key = 'capture.at3'",
                [],
                |r| r.get(0),
            )
            .expect("read");
        assert_eq!(value, "\"15:00\"");
    }

    #[test]
    fn upsert_inserts_then_updates() {
        let conn = conn();
        let set = |value: &str| Op::Upsert {
            table: "core_settings".into(),
            id: "ui.theme".into(),
            values: values(json!({ "value_json": value })),
        };
        apply_ops(&conn, "user", None, &[set("\"dark\"")], 1).expect("insert");
        apply_ops(&conn, "user", None, &[set("\"light\"")], 2).expect("update");
        let (value, count): (String, i64) = conn
            .query_row(
                "SELECT value_json, (SELECT count(*) FROM core_settings) FROM core_settings WHERE key = 'ui.theme'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("read");
        assert_eq!(value, "\"light\"");
        assert_eq!(count, 1);
    }

    #[test]
    fn upsert_revives_a_soft_deleted_row() {
        let conn = conn();
        let put = |summary: &str| Op::Upsert {
            table: "cal_occurrences".into(),
            id: "e|1".into(),
            values: values(json!({
                "ical_uid": "e", "summary": summary, "start_at": 1, "end_at": 2,
                "local_date": "2026-11-12", "all_day": 0
            })),
        };
        let deleted = |conn: &Connection| -> Option<i64> {
            conn.query_row(
                "SELECT deleted_at FROM cal_occurrences WHERE id = 'e|1'",
                [],
                |r| r.get(0),
            )
            .expect("read")
        };
        apply_ops(&conn, "system", None, &[put("A")], 1).expect("insert");
        let delete = Op::Delete {
            table: "cal_occurrences".into(),
            id: "e|1".into(),
        };
        apply_ops(&conn, "system", None, &[delete], 2).expect("delete");
        assert_eq!(deleted(&conn), Some(2));
        apply_ops(&conn, "system", None, &[put("B")], 3).expect("revive");
        assert_eq!(deleted(&conn), None);
    }

    #[test]
    fn areas_and_routine_blocks_are_writable() {
        let conn = conn();
        let ops = [
            Op::Update {
                table: "area_items".into(),
                id: "coding".into(),
                values: values(json!({ "weekly_target_min": 300 })),
            },
            Op::Insert {
                table: "routine_blocks".into(),
                id: "b1".into(),
                values: values(
                    json!({ "weekday": 1, "start_min": 360, "duration_min": 20, "kind": "routine", "area_id": "quran", "title": "Quran" }),
                ),
            },
        ];
        apply_ops(&conn, "user", Some("setup"), &ops, 1).expect("write");
        let target: i64 = conn
            .query_row(
                "SELECT weekly_target_min FROM area_items WHERE id = 'coding'",
                [],
                |r| r.get(0),
            )
            .expect("read");
        assert_eq!(target, 300);
    }
}
