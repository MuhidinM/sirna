/**
 * Dev-only port of src-tauri/src/tx.rs: the one write path. Ops are checked
 * against the same allowlist, stamped with created_at / updated_at /
 * user_edited_at, deletes are soft, and every change writes a core_activity
 * row with the row as JSON before and after. `undoContext` replays it back.
 *
 * Keep it in step with tx.rs; the tests in tx.test.ts are its unit tests.
 */
import { type Conn, type DbRow, type SqlScalar } from "./conn";

export interface TableSpec {
  name: string;
  idColumn: string;
  columns: readonly string[];
  hasCreatedAt: boolean;
  softDelete: boolean;
  hasUserEditedAt: boolean;
}

const spec_ = (
  name: string,
  columns: string[],
  { id = "id", created = true, soft = true, edited = false } = {},
): TableSpec => ({
  name,
  idColumn: id,
  columns,
  hasCreatedAt: created,
  softDelete: soft,
  hasUserEditedAt: edited,
});

/** TABLES in tx.rs, in the same order. */
export const TABLES: readonly TableSpec[] = [
  spec_(
    "task_items",
    [
      "title",
      "notes",
      "first_step",
      "status",
      "due_date",
      "planned_date",
      "deadline_stale",
      "parent_id",
      "step_no",
      "repeat_json",
      "repeat_of",
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
      "planned_window",
    ],
    { edited: true },
  ),
  spec_("cal_occurrences", [
    "ical_uid",
    "summary",
    "location",
    "start_at",
    "end_at",
    "local_date",
    "all_day",
  ]),
  spec_("savings_goals", ["title", "target_minor", "start_date", "status", "target_date"]),
  spec_("savings_entries", [
    "goal_id",
    "occurred_at",
    "local_date",
    "amount_minor",
    "note",
    "origin",
    "account",
    "transfer_id",
  ]),
  spec_(
    "project_items",
    [
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
    { edited: true },
  ),
  spec_(
    "note_items",
    ["kind", "status", "title", "body", "area_id", "project_id", "sort_order", "origin"],
    { edited: true },
  ),
  spec_(
    "money_txns",
    [
      "account",
      "occurred_at",
      "local_date",
      "amount_minor",
      "currency",
      "description",
      "category_id",
      "origin",
      "area_id",
      "transfer_id",
      "regular_id",
      "due_date",
    ],
    { edited: true },
  ),
  spec_("money_accounts", [
    "name",
    "kind",
    "opening_minor",
    "opening_date",
    "pays_in",
    "sort_order",
    "currency",
    "is_savings",
  ]),
  spec_("money_regulars", [
    "kind",
    "name",
    "amount_minor",
    "rule_json",
    "category_id",
    "account",
    "area_id",
    "active",
    "currency",
  ]),
  spec_("money_loans", [
    "person",
    "kind",
    "amount_minor",
    "local_date",
    "account",
    "note",
    "follow_up_date",
    "currency",
  ]),
  spec_("money_learned", ["category_id"]),
  spec_("money_categories", ["name", "kind", "cap_minor", "cap_since"]),
  spec_("money_templates", ["label", "amount_minor", "category_id", "uses"]),
  spec_("area_items", [
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
  ]),
  spec_("routine_blocks", [
    "weekday",
    "start_min",
    "duration_min",
    "kind",
    "area_id",
    "title",
    "active",
  ]),
  spec_(
    "day_blocks",
    [
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
    { edited: true },
  ),
  spec_("task_daily_top", ["logical_date", "position", "task_id", "chosen_by"], { soft: false }),
  spec_("focus_kits", ["open_json", "minimize_json", "checklist_json"], {
    id: "area_id",
    soft: false,
  }),
  spec_("day_reviews", ["status", "energy", "spent_none", "mind"], {
    id: "logical_date",
    soft: false,
  }),
  spec_("core_settings", ["value_json"], { id: "key", created: false, soft: false }),
];

export type Values = Record<string, unknown>;

export type Op =
  | { op: "insert" | "update" | "upsert"; table: string; id: string; values: Values }
  | { op: "delete"; table: string; id: string };

/** TxError and its Display text, as the webview sees it in a rejected invoke. */
export class TxError extends Error {}

const unknownTable = (table: string) => new TxError(`table not writable: ${table}`);

export function spec(table: string): TableSpec {
  const found = TABLES.find((entry) => entry.name === table);
  if (!found) throw unknownTable(table);
  return found;
}

function column(table: TableSpec, name: string): string {
  if (!table.columns.includes(name))
    throw new TxError(`column not writable: ${table.name}.${name}`);
  return name;
}

/** to_sql: scalars only; booleans become 0/1. */
export function toSql(name: string, value: unknown): SqlScalar {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw badValue(name);
    return value;
  }
  if (typeof value === "string") return value;
  throw badValue(name);
}

const badValue = (name: string) =>
  new TxError(`value for ${name} must be text, a number, a boolean or null`);

/** One SQLite value as JSON (blobs become null, as in to_json). */
const toJson = (value: SqlScalar): SqlScalar => (value instanceof Uint8Array ? null : value);

/**
 * A row as serde_json writes it: serde_json without `preserve_order` keeps
 * object keys sorted, so before/after JSON has sorted keys here too.
 */
export function rowText(row: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(row).sort()) sorted[key] = row[key];
  return JSON.stringify(sorted);
}

/** The whole row as an object, or undefined if it doesn't exist. */
export function rowJson(conn: Conn, table: TableSpec, id: string): DbRow | undefined {
  const row = conn.all(`SELECT * FROM ${table.name} WHERE ${table.idColumn} = ?`, [id])[0];
  if (!row) return undefined;
  const out: DbRow = {};
  for (const [key, value] of Object.entries(row)) out[key] = toJson(value);
  return out;
}

function logActivity(
  conn: Conn,
  at: number,
  actor: string,
  context: string | null,
  table: string,
  id: string,
  action: string,
  before: DbRow | undefined,
  after: DbRow | undefined,
) {
  conn.run(
    `INSERT INTO core_activity (at, actor, context, entity_type, entity_id, action, before_json, after_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      at,
      actor,
      context,
      table,
      id,
      action,
      before ? rowText(before) : null,
      after ? rowText(after) : null,
    ],
  );
}

/** Values in serde_json's (sorted) map order. */
const entries = (values: Values) =>
  Object.keys(values)
    .sort()
    .map((key) => [key, values[key]] as const);

/**
 * Checks the shape serde would accept for an Op (tagged by `op`, lowercase).
 * Tauri reports a bad shape as `invalid args`.
 */
export function parseOps(command: string, raw: unknown): Op[] {
  const fail = (why: string): never => {
    throw `invalid args \`ops\` for command \`${command}\`: ${why}`;
  };
  if (!Array.isArray(raw)) return fail("expected a sequence");
  return raw.map((item: unknown) => {
    if (typeof item !== "object" || item === null) return fail("expected an op object");
    const op = item as Record<string, unknown>;
    const kind = op.op;
    if (typeof op.table !== "string") return fail("missing field `table`");
    if (typeof op.id !== "string") return fail("missing field `id`");
    if (kind === "delete") return { op: "delete", table: op.table, id: op.id };
    if (kind !== "insert" && kind !== "update" && kind !== "upsert")
      return fail(`unknown variant \`${String(kind)}\``);
    if (typeof op.values !== "object" || op.values === null || Array.isArray(op.values))
      return fail("missing field `values`");
    return { op: kind, table: op.table, id: op.id, values: op.values as Values };
  });
}

/** apply_ops: applies ops inside the caller's transaction. Returns the ids touched. */
export function applyOps(
  conn: Conn,
  actor: string,
  context: string | null,
  ops: readonly Op[],
  nowMs: number,
): string[] {
  const ids: string[] = [];
  for (const original of ops) {
    // An upsert means "this row, with these values": it also brings back a
    // soft-deleted row (undo puts the deletion back).
    const upsert = original.op === "upsert";
    let op: Op = original;
    if (original.op === "upsert") {
      const exists = rowJson(conn, spec(original.table), original.id) !== undefined;
      op = { ...original, op: exists ? "update" : "insert" };
    }
    if (op.op === "insert") {
      const table = spec(op.table);
      if (op.id.trim() === "") throw new TxError("rows need an id");
      const names = [table.idColumn];
      const values: SqlScalar[] = [op.id];
      for (const [name, value] of entries(op.values)) {
        names.push(column(table, name));
        values.push(toSql(name, value));
      }
      if (table.hasCreatedAt) {
        names.push("created_at");
        values.push(nowMs);
      }
      names.push("updated_at");
      values.push(nowMs);
      conn.run(
        `INSERT INTO ${table.name} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
        values,
      );
      const after = rowJson(conn, table, op.id);
      logActivity(conn, nowMs, actor, context, table.name, op.id, "insert", undefined, after);
      ids.push(op.id);
    } else if (op.op === "update") {
      const table = spec(op.table);
      const before = rowJson(conn, table, op.id);
      if (!before) throw new TxError(`no ${op.table} row with id ${op.id}`);
      const sets: string[] = [];
      const values: SqlScalar[] = [];
      for (const [name, value] of entries(op.values)) {
        sets.push(column(table, name));
        values.push(toSql(name, value));
      }
      if (upsert && table.softDelete && before.deleted_at !== null) {
        sets.push("deleted_at");
        values.push(null);
      }
      sets.push("updated_at");
      values.push(nowMs);
      if (table.hasUserEditedAt && actor === "user") {
        sets.push("user_edited_at");
        values.push(nowMs);
      }
      conn.run(
        `UPDATE ${table.name} SET ${sets.map((name) => `${name} = ?`).join(", ")} WHERE ${table.idColumn} = ?`,
        [...values, op.id],
      );
      const after = rowJson(conn, table, op.id);
      logActivity(conn, nowMs, actor, context, table.name, op.id, "update", before, after);
      ids.push(op.id);
    } else if (op.op === "delete") {
      const table = spec(op.table);
      const before = rowJson(conn, table, op.id);
      if (!before) throw new TxError(`no ${op.table} row with id ${op.id}`);
      if (table.softDelete)
        conn.run(
          `UPDATE ${table.name} SET deleted_at = ?, updated_at = ? WHERE ${table.idColumn} = ?`,
          [nowMs, nowMs, op.id],
        );
      else conn.run(`DELETE FROM ${table.name} WHERE ${table.idColumn} = ?`, [op.id]);
      const after = rowJson(conn, table, op.id);
      logActivity(conn, nowMs, actor, context, table.name, op.id, "delete", before, after);
      ids.push(op.id);
    }
  }
  return ids;
}

/** restore: puts the writable columns of a row back to an earlier snapshot. */
function restore(conn: Conn, table: TableSpec, id: string, snapshot: Record<string, unknown>) {
  const names = [
    ...table.columns,
    ...(table.softDelete ? ["deleted_at"] : []),
    ...(table.hasUserEditedAt ? ["user_edited_at"] : []),
  ];
  const sets: string[] = [];
  const values: SqlScalar[] = [];
  for (const name of names) {
    if (Object.hasOwn(snapshot, name)) {
      sets.push(`${name} = ?`);
      values.push(toSql(name, snapshot[name]));
    }
  }
  if (sets.length === 0) return;
  conn.run(`UPDATE ${table.name} SET ${sets.join(", ")} WHERE ${table.idColumn} = ?`, [
    ...values,
    id,
  ]);
}

/**
 * undo_context: reverses every change logged under `context`, newest first.
 * Inserts become soft deletes; updates and deletes are restored to their
 * "before" snapshot. Returns how many changes were undone.
 */
export function undoContext(conn: Conn, actor: string, context: string, nowMs: number): number {
  const rows = conn.all(
    `SELECT entity_type, entity_id, action, before_json FROM core_activity
     WHERE context = ? AND action != 'undo' ORDER BY id DESC`,
    [context],
  );
  const undo = `undo:${context}`;
  for (const row of rows) {
    const table = spec(String(row.entity_type));
    const id = String(row.entity_id);
    const current = rowJson(conn, table, id);
    if (row.action === "insert") {
      if (table.softDelete)
        conn.run(
          `UPDATE ${table.name} SET deleted_at = ?, updated_at = ? WHERE ${table.idColumn} = ?`,
          [nowMs, nowMs, id],
        );
      else conn.run(`DELETE FROM ${table.name} WHERE ${table.idColumn} = ?`, [id]);
    } else if (typeof row.before_json === "string") {
      let snapshot: unknown;
      try {
        snapshot = JSON.parse(row.before_json);
      } catch {
        snapshot = undefined;
      }
      if (typeof snapshot === "object" && snapshot !== null && !Array.isArray(snapshot))
        restore(conn, table, id, snapshot as Record<string, unknown>);
    }
    const after = rowJson(conn, table, id);
    logActivity(conn, nowMs, actor, undo, table.name, id, "undo", current, after);
  }
  return rows.length;
}

/** tables_of in commands.rs: the tables ops touch, sorted, once each. */
export function tablesOf(ops: readonly Op[]): string[] {
  return [...new Set(ops.map((op) => op.table))].sort();
}
