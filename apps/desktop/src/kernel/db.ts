/**
 * The webview's access to the database (plan §4.5): read with `query`, write
 * only with `transact` ops. Rust checks every table and column against its
 * allowlist and logs each change with its actor (src-tauri/src/tx.rs).
 */
import { invoke } from "@tauri-apps/api/core";

export type SqlValue = string | number | boolean | null;
export type Row = Record<string, SqlValue>;

/** The tables `transact` may write, mirroring `TABLES` in tx.rs. */
export type WritableTable =
  | "task_items"
  | "project_items"
  | "savings_goals"
  | "savings_entries"
  | "note_items"
  | "money_txns"
  | "money_templates"
  | "area_items"
  | "routine_blocks"
  | "day_blocks"
  | "task_daily_top"
  | "day_reviews"
  | "focus_kits"
  | "core_settings";

export type Op =
  | { op: "insert"; table: WritableTable; id: string; values: Record<string, SqlValue> }
  | { op: "update"; table: WritableTable; id: string; values: Record<string, SqlValue> }
  | { op: "delete"; table: WritableTable; id: string }
  | { op: "upsert"; table: WritableTable; id: string; values: Record<string, SqlValue> };

/** Who made a change: the user, a parser (`parser:capture@1`), a rule, the AI… */
export type Actor = "user" | "system" | `parser:${string}` | `rule:${string}` | `ai:${string}`;

export function query<T extends Row = Row>(sql: string, params: SqlValue[] = []): Promise<T[]> {
  return invoke<T[]>("db_query", { sql, params });
}

export function transact(actor: Actor, ops: Op[], context?: string): Promise<string[]> {
  return invoke<string[]>("db_tx", { actor, context: context ?? null, ops });
}

/** Saves a capture as typed plus the records parsed from it; returns the raw item id. */
export function commitCapture(rawText: string, ops: Op[] = [], parser?: string): Promise<number> {
  return invoke<number>("capture_commit", { rawText, ops, parser: parser ?? null });
}

/** Fixes a capture: undoes the old one and saves the new text, in one transaction. */
export function replaceCapture(
  rawId: number,
  rawText: string,
  ops: Op[],
  parser?: string,
): Promise<number> {
  return invoke<number>("capture_replace", { rawId, rawText, ops, parser: parser ?? null });
}

/** Undoes a capture's records; returns how many changes were reversed. */
export function undoCapture(rawId: number): Promise<number> {
  return invoke<number>("capture_undo", { rawId });
}
