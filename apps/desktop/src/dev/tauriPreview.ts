/**
 * Dev-only: lets the app run in a plain browser (`pnpm dev`, then
 * http://localhost:1420) for design work. It stands in for Tauri's IPC:
 * `db_query` and `db_tx` run against dev-data/sirna.db (built by
 * scripts/preview-db.mjs, never committed) in sql.js; other commands return
 * quiet defaults. Never part of a build: main.tsx imports it only in dev
 * when Tauri is absent.
 */
import initSqlJs, { type Database, type SqlValue } from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";

type Args = Record<string, unknown>;
type Callback = (payload: unknown) => void;

const callbacks = new Map<number, Callback>();
const listeners = new Map<string, number[]>();
let nextId = 1;

function emit(event: string, payload: unknown) {
  for (const handler of listeners.get(event) ?? [])
    callbacks.get(handler)?.({ event, id: handler, payload });
}

const toSql = (value: unknown): SqlValue =>
  typeof value === "boolean" ? (value ? 1 : 0) : ((value as SqlValue) ?? null);

function select(db: Database, sql: string, params: unknown[]) {
  const stmt = db.prepare(sql);
  stmt.bind(params.map(toSql));
  const rows: Record<string, SqlValue>[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function columns(db: Database, table: string): Set<string> {
  return new Set(select(db, `PRAGMA table_info(${table})`, []).map((c) => String(c.name)));
}

type Op = { op: string; table: string; id: string; values?: Record<string, unknown> };

function applyOps(db: Database, ops: Op[]) {
  const now = Date.now();
  const tables = new Set<string>();
  for (const op of ops) {
    tables.add(op.table);
    const cols = columns(db, op.table);
    const pk = op.table === "core_settings" ? "key" : "id";
    const values: Record<string, unknown> = { ...(op.values ?? {}) };
    if (cols.has("updated_at")) values.updated_at = now;
    if (op.op === "delete") {
      if (cols.has("deleted_at"))
        db.run(`UPDATE ${op.table} SET deleted_at = ?, updated_at = ? WHERE ${pk} = ?`, [
          now,
          now,
          op.id,
        ]);
      else db.run(`DELETE FROM ${op.table} WHERE ${pk} = ?`, [op.id]);
      continue;
    }
    if (op.op === "update") {
      const keys = Object.keys(values);
      db.run(`UPDATE ${op.table} SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE ${pk} = ?`, [
        ...keys.map((k) => toSql(values[k])),
        op.id,
      ]);
      continue;
    }
    if (cols.has("created_at")) values.created_at ??= now;
    if (op.op === "upsert" && cols.has("deleted_at")) values.deleted_at = null;
    const keys = [pk, ...Object.keys(values)];
    const all = { [pk]: op.id, ...values };
    const update = Object.keys(values)
      .filter((k) => k !== "created_at")
      .map((k) => `${k} = excluded.${k}`)
      .join(", ");
    db.run(
      `INSERT INTO ${op.table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})` +
        (op.op === "upsert" ? ` ON CONFLICT(${pk}) DO UPDATE SET ${update}` : ""),
      keys.map((k) => toSql(all[k])),
    );
  }
  return [...tables];
}

export async function install(): Promise<void> {
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  const bytes = await fetch("/dev-data/sirna.db").then((r) => {
    if (!r.ok) throw new Error("Run `node scripts/preview-db.mjs` first");
    return r.arrayBuffer();
  });
  const db = new SQL.Database(new Uint8Array(bytes));
  const params = new URLSearchParams(location.search);
  const screen = params.get("screen");
  // ?now=2026-11-16T09:30 shows the app at that Addis time.
  const at = params.get("now");
  if (at) {
    const offset = Date.parse(`${at}:00+03:00`) - Date.now();
    const realNow = Date.now.bind(Date);
    Date.now = () => realNow() + offset;
  }

  const commands: Record<string, (args: Args) => unknown> = {
    db_query: (a) => select(db, String(a.sql), (a.params as unknown[]) ?? []),
    db_tx: (a) => {
      const changed = applyOps(db, a.ops as Op[]);
      setTimeout(() => emit("data-changed", changed));
      return [];
    },
    "plugin:event|listen": (a) => {
      const handler = Number(a.handler);
      listeners.set(String(a.event), [...(listeners.get(String(a.event)) ?? []), handler]);
      return handler;
    },
    "plugin:event|unlisten": () => null,
    take_screen: () => screen,
    focus_status: () => ({
      kind: null,
      title: "",
      remaining_ms: 0,
      planned_min: 0,
      paused: false,
      in_row: 0,
      block_id: null,
    }),
    brief_checks: () => ({ notificationsMuted: false, autostartOff: false }),
    ai_usage: () => ({
      has_key: true,
      model: "gemini-flash-lite-latest",
      used: 3,
      cap: 15,
      quota_day: "",
    }),
    secret_status: () => true,
    hotkey_current: () => "Ctrl+Alt+J",
    autostart_status: () => true,
    calendar_fetch: () => Promise.reject(new Error("offline")),
    ai_models: () => [],
    ai_send: () => Promise.reject(new Error("no-key")),
  };

  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main", windowLabel: "main" },
    },
    transformCallback: (callback: Callback) => {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
    unregisterCallback: (id: number) => callbacks.delete(id),
    convertFileSrc: (path: string) => path,
    invoke: async (cmd: string, args: Args = {}) => {
      const run = commands[cmd];
      if (!run) {
        console.debug("[preview] ignored", cmd, args);
        return null;
      }
      return run(args);
    },
  };
  (window as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: () => undefined,
  };
}
