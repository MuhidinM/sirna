/**
 * Dev-only port of the write commands in src-tauri/src/commands.rs (and the
 * helpers they call in db.rs, away.rs, tasks.rs, session.rs, review.rs).
 * Each command runs on a Conn and returns its result plus the tables it
 * reports in "data-changed", as Rust emits them.
 */
import { type Conn, inTransaction, type SqlScalar } from "./conn";
import { type BlockRow, UNDO_BLOCKED_SQL, undoBlocked } from "../capture/fix";
import { applyOps, type Op, parseOps, rowText, tablesOf, type Undone, undoContext } from "./tx";

export interface Done<T> {
  result: T;
  /** Payload of the "data-changed" event; undefined emits nothing. */
  changed?: string[] | undefined;
}

// --- Time (tasks.rs, session.rs, review.rs) --------------------------------------

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const UTC_OFFSET_MS = 3 * HOUR_MS;
const DAY_START_MS = 3 * HOUR_MS;

/** tasks::logical_day: the logical date and the UTC ms that day began. */
export function logicalDay(nowMs: number): [string, number] {
  const shifted = nowMs + UTC_OFFSET_MS - DAY_START_MS;
  const dayIndex = Math.floor(shifted / DAY_MS);
  const start = dayIndex * DAY_MS - UTC_OFFSET_MS + DAY_START_MS;
  return [new Date(dayIndex * DAY_MS).toISOString().slice(0, 10), start];
}

/** session::local_minutes: minutes after midnight in Addis Ababa. */
export function localMinutes(nowMs: number): number {
  const minutes = Math.floor(nowMs / 60_000) + 180;
  return ((minutes % 1440) + 1440) % 1440;
}

/** session::parse_hhmm: "06:30" → 390. */
export function parseHhmm(text: string): number | undefined {
  const at = text.indexOf(":");
  if (at < 0) return undefined;
  const [h, m] = [text.slice(0, at).trim(), text.slice(at + 1).trim()];
  if (!/^\+?\d+$/.test(h) || !/^\+?\d+$/.test(m)) return undefined;
  const [hours, minutes] = [Number(h), Number(m)];
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : undefined;
}

/** review::logical_minutes: minutes since 03:00. */
export const logicalMinutes = (localMin: number) => (localMin + 24 * 60 - 3 * 60) % (24 * 60);

/** db::setting_string: a setting stored as a JSON string. */
export function settingString(conn: Conn, key: string): string | undefined {
  const row = conn.all("SELECT value_json FROM core_settings WHERE key = ?", [key])[0];
  if (!row || typeof row.value_json !== "string") return undefined;
  try {
    const value: unknown = JSON.parse(row.value_json);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

// --- Reads (commands.rs) ----------------------------------------------------------

/** is_read_query: the first word after any comments is SELECT or WITH. */
export function isReadQuery(sql: string): boolean {
  let rest = sql;
  for (;;) {
    rest = rest.trimStart();
    if (rest.startsWith("--")) {
      const end = rest.indexOf("\n");
      rest = end < 0 ? "" : rest.slice(end + 1);
    } else if (rest.startsWith("/*")) {
      const end = rest.indexOf("*/");
      rest = end < 0 ? "" : rest.slice(end + 2);
    } else break;
  }
  const word = (rest.split(/[\s(]/)[0] ?? "").toLowerCase();
  return word === "select" || word === "with";
}

/** db::query_json's parameter binding: bools as 0/1, objects as JSON text. */
export function bindParam(value: unknown): SqlScalar {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" || typeof value === "string") return value;
  return JSON.stringify(value);
}

/** db_query, minus the read-only connection (SELECT-only is checked the same way). */
export function dbQuery(conn: Conn, sql: string, params: unknown[] = []) {
  if (!isReadQuery(sql)) throw "db_query only runs SELECT queries";
  return conn
    .all(sql, params.map(bindParam))
    .map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          value instanceof Uint8Array ? null : value,
        ]),
      ),
    );
}

// --- db_tx ------------------------------------------------------------------------

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Runs `work` in a transaction; errors become the plain strings Rust returns. */
function command<T>(conn: Conn, work: () => T): T {
  try {
    return inTransaction(conn, work);
  } catch (error) {
    throw typeof error === "string" ? error : message(error);
  }
}

export function dbTx(
  conn: Conn,
  args: { actor?: unknown; context?: unknown; ops?: unknown },
  nowMs: number,
): Done<string[]> {
  const ops = parseOps("db_tx", args.ops);
  const actor = String(args.actor ?? "");
  const context = typeof args.context === "string" ? args.context : null;
  const ids = command(conn, () => applyOps(conn, actor, context, ops, nowMs));
  return { result: ids, changed: tablesOf(ops) };
}

// --- Captures (commands.rs, db.rs) ------------------------------------------------

/**
 * capture_ops_allowed: a capture may only insert tasks, notes, money and
 * ideas, and set a block's status to done or skipped (`gym done`).
 */
export function captureOpsAllowed(ops: readonly Op[]): boolean {
  return ops.every((op) => {
    if (op.op === "insert")
      return [
        "task_items",
        "note_items",
        "money_txns",
        "money_loans",
        "project_items",
        "savings_entries",
      ].includes(op.table);
    if (op.op === "update" && op.table === "day_blocks") {
      const entries = Object.entries(op.values);
      return (
        entries.length > 0 &&
        entries.every(
          ([key, value]) => key === "status" && (value === "done" || value === "skipped"),
        )
      );
    }
    return false;
  });
}

function checkCapture(rawText: string, ops: readonly Op[]) {
  if (rawText.trim() === "") throw "Nothing to save";
  if (!captureOpsAllowed(ops)) throw "A capture can only add tasks, notes, money, ideas or savings";
}

/** db::insert_capture */
function insertCapture(conn: Conn, body: string, receivedAt: number): number {
  return conn.run(
    "INSERT INTO core_raw_items (source, received_at, body) VALUES ('capture', ?, ?)",
    [receivedAt, body],
  ).lastInsertRowid;
}

/** db::mark_parsed */
function markParsed(conn: Conn, rawId: number, parser: string | null, at: number) {
  const split = parser?.indexOf("@") ?? -1;
  let parserId: string | null = parser;
  let version: number | null = null;
  if (parser !== null && split >= 0) {
    parserId = parser.slice(0, split);
    const text = parser.slice(split + 1);
    version = /^[+-]?\d+$/.test(text) ? Number(text) : null;
  }
  conn.run(
    "UPDATE core_raw_items SET parse_status = 'parsed', parser_id = ?, parser_version = ?, parsed_at = ? WHERE id = ?",
    [parserId, version, at, rawId],
  );
}

/** db::mark_ignored */
function markIgnored(conn: Conn, rawId: number) {
  conn.run("UPDATE core_raw_items SET parse_status = 'ignored' WHERE id = ?", [rawId]);
}

/** db::mark_refused */
function markRefused(conn: Conn, rawId: number, why: string) {
  conn.run("UPDATE core_raw_items SET parse_status = 'failed', error = ? WHERE id = ?", [
    why,
    rawId,
  ]);
}

/** store_capture: the raw line and its records, logged under capture:<id>. */
export function storeCapture(
  conn: Conn,
  rawText: string,
  ops: readonly Op[],
  parser: string | null,
  now: number,
): number {
  const rawId = insertCapture(conn, rawText, now);
  if (ops.length > 0) {
    applyOps(conn, "user", `capture:${rawId}`, ops, now);
    markParsed(conn, rawId, parser, now);
  }
  return rawId;
}

interface CaptureArgs {
  rawText?: unknown;
  ops?: unknown;
  parser?: unknown;
  /** capture_commit only: why nothing was made from the line. */
  refused?: unknown;
}

const opsArg = (name: string, ops: unknown) =>
  ops === null || ops === undefined ? [] : parseOps(name, ops);
const parserArg = (parser: unknown) => (typeof parser === "string" ? parser : null);

export function captureCommit(conn: Conn, args: CaptureArgs, now: number): Done<number> {
  const ops = opsArg("capture_commit", args.ops);
  const rawText = String(args.rawText ?? "");
  checkCapture(rawText, ops);
  const refused = typeof args.refused === "string" ? args.refused : null;
  const rawId = command(conn, () => {
    const id = storeCapture(conn, rawText, ops, parserArg(args.parser), now);
    if (ops.length === 0 && refused !== null) markRefused(conn, id, refused);
    return id;
  });
  return { result: rawId, changed: [...tablesOf(ops), "core_raw_items"] };
}

const CAPTURE_TABLES = ["core_raw_items", "task_items", "note_items", "money_txns", "day_blocks"];

export function captureReplace(
  conn: Conn,
  args: CaptureArgs & { rawId?: unknown },
  now: number,
): Done<number> {
  const ops = opsArg("capture_replace", args.ops);
  const rawText = String(args.rawText ?? "");
  checkCapture(rawText, ops);
  const newId = command(conn, () =>
    replaceIn(conn, Number(args.rawId), rawText, ops, parserArg(args.parser), now),
  );
  return { result: newId, changed: CAPTURE_TABLES };
}

/**
 * replace_in: undo the old capture, save the new one, and carry the old
 * task's project, parent and steps over to the new task.
 */
export function replaceIn(
  conn: Conn,
  rawId: number,
  rawText: string,
  ops: readonly Op[],
  parser: string | null,
  now: number,
): number {
  const oldContext = `capture:${rawId}`;
  refuseChanged(conn, rawId, "fix");
  const old = capturedTask(conn, oldContext);
  const links = old === undefined ? undefined : taskLinks(conn, old);
  undoContext(conn, "user", oldContext, now);
  markIgnored(conn, rawId);
  const newId = storeCapture(conn, rawText, ops, parser, now);
  const carried = links ? carryTaskLinks(links, ops) : [];
  if (carried.length > 0) {
    const context = `capture:${newId}`;
    const loggedBefore = Number(
      conn.all("SELECT COALESCE(MAX(id), 0) AS id FROM core_activity")[0]?.id ?? 0,
    );
    applyOps(conn, "user", context, carried, now);
    keepOnlyCarriedColumns(conn, context, loggedBefore, carried);
  }
  return newId;
}

/** keep_only_carried_columns: trims each carried update's "before" to the columns it set. */
export function keepOnlyCarriedColumns(
  conn: Conn,
  context: string,
  afterId: number,
  carried: readonly Op[],
) {
  const rows = conn.all(
    `SELECT id, entity_id, before_json FROM core_activity
     WHERE context = ? AND id > ? AND action = 'update' AND entity_type = 'task_items'`,
    [context, afterId],
  );
  for (const row of rows) {
    const op = carried.find((item) => item.op === "update" && item.id === row.entity_id);
    if (!op || op.op !== "update") continue;
    let before: unknown;
    try {
      before = typeof row.before_json === "string" ? JSON.parse(row.before_json) : undefined;
    } catch {
      before = undefined;
    }
    if (typeof before !== "object" || before === null || Array.isArray(before)) continue;
    const snapshot = before as Record<string, unknown>;
    const trimmed: Record<string, unknown> = {};
    for (const name of Object.keys(op.values)) trimmed[name] = snapshot[name] ?? null;
    conn.run("UPDATE core_activity SET before_json = ? WHERE id = ?", [
      rowText(trimmed),
      Number(row.id),
    ]);
  }
}

/** refuse_changed: a capture whose records you changed since is left alone (F2, F65). */
function refuseChanged(conn: Conn, rawId: number, verb: "undo" | "fix") {
  const rows = conn.all(UNDO_BLOCKED_SQL, [`capture:${rawId}`]) as unknown as BlockRow[];
  const blocked = undoBlocked(rows, verb);
  if (blocked !== null) throw blocked;
}

/** captured_task: the one task a capture made, when it made exactly one. */
function capturedTask(conn: Conn, context: string): string | undefined {
  const ids = conn.all(
    "SELECT entity_id FROM core_activity WHERE context = ? AND entity_type = 'task_items' AND action = 'insert'",
    [context],
  );
  return ids.length === 1 ? String(ids[0]?.entity_id) : undefined;
}

interface TaskLinks {
  project: string | null;
  parent: string | null;
  step: number | null;
  steps: string[];
}

function taskLinks(conn: Conn, id: string): TaskLinks {
  const row = conn.all("SELECT project_id, parent_id, step_no FROM task_items WHERE id = ?", [
    id,
  ])[0];
  if (!row) throw "Query returned no rows";
  const steps = conn
    .all("SELECT id FROM task_items WHERE parent_id = ? AND deleted_at IS NULL", [id])
    .map((step) => String(step.id));
  return {
    project: (row.project_id as string | null) ?? null,
    parent: (row.parent_id as string | null) ?? null,
    step: (row.step_no as number | null) ?? null,
    steps,
  };
}

/** carry_task_links */
function carryTaskLinks(links: TaskLinks, ops: readonly Op[]): Op[] {
  const inserted = ops.filter((op) => op.op === "insert" && op.table === "task_items");
  const only = inserted.length === 1 ? inserted[0] : undefined;
  if (!only || only.op === "delete") return [];
  const unset = (name: string) => only.values[name] === undefined || only.values[name] === null;
  const carried: Record<string, unknown> = {};
  if (links.project !== null && unset("project_id")) carried.project_id = links.project;
  if (links.parent !== null && unset("parent_id")) carried.parent_id = links.parent;
  if (links.step !== null && unset("step_no")) carried.step_no = links.step;
  const out: Op[] = [];
  if (Object.keys(carried).length > 0)
    out.push({ op: "update", table: "task_items", id: only.id, values: carried });
  for (const stepId of links.steps)
    out.push({ op: "update", table: "task_items", id: stepId, values: { parent_id: only.id } });
  return out;
}

export function captureUndo(conn: Conn, args: { rawId?: unknown }, now: number): Done<number> {
  const rawId = Number(args.rawId);
  const undone = command(conn, () => {
    refuseChanged(conn, rawId, "undo");
    const count = undoContext(conn, "user", `capture:${rawId}`, now).changes;
    markIgnored(conn, rawId);
    return count;
  });
  return { result: undone, changed: CAPTURE_TABLES };
}

export function notesUndo(conn: Conn, args: { context?: unknown }, now: number): Done<Undone> {
  const context = String(args.context ?? "");
  if (!context.startsWith("notes:") || new TextEncoder().encode(context).length > 64)
    throw "only a Notes edit can be undone here";
  const undone = command(conn, () => undoContext(conn, "user", context, now));
  return { result: undone, changed: ["note_items"] };
}

// --- Away (away.rs, commands.rs) --------------------------------------------------

export const AWAY_KEY = "away.until";

/** away::valid_date: YYYY-MM-DD by shape and range. */
export function validDate(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return false;
  const [month, day] = [Number(match[2]), Number(match[3])];
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

/** away::return_date */
export function returnDate(until: string | null, today: string, tomorrow: string): string {
  return until !== null && validDate(until) && until > today ? until : tomorrow;
}

function writeAway(
  conn: Conn,
  date: string,
  context: string,
  now: number,
  rawId: number | null = null,
) {
  command(conn, () => {
    applyOps(
      conn,
      "user",
      context,
      [
        {
          op: "upsert",
          table: "core_settings",
          id: AWAY_KEY,
          values: { value_json: JSON.stringify(date) },
        },
      ],
      now,
    );
    if (rawId !== null) markParsed(conn, rawId, "away", now);
  });
}

export function setAway(
  conn: Conn,
  args: { until?: unknown; rawId?: unknown },
  now: number,
): Done<string> {
  const [today, dayStart] = logicalDay(now);
  const [tomorrow] = logicalDay(dayStart + 25 * HOUR_MS);
  const date = returnDate(typeof args.until === "string" ? args.until : null, today, tomorrow);
  const rawId = args.rawId === null || args.rawId === undefined ? null : Number(args.rawId);
  const context = rawId === null ? "away" : `capture:${rawId}`;
  // The line made a record (the setting), so Ctrl+Z and Up find it (F38).
  writeAway(conn, date, context, now, rawId);
  return { result: date, changed: ["core_settings", "core_raw_items"] };
}

/** commands::clear_away: `back` in the capture bar logs it under that capture (F41). */
export function clearAway(conn: Conn, args: { rawId?: unknown }, now: number): Done<null> {
  const rawId = args.rawId === null || args.rawId === undefined ? null : Number(args.rawId);
  writeAway(conn, "", rawId === null ? "away" : `capture:${rawId}`, now, rawId);
  return { result: null, changed: ["core_settings", "core_raw_items"] };
}
