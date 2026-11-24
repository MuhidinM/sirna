/**
 * Fixing the last capture with Up arrow (time-first §2, r2-7). The box opens
 * on the reading that matches what the capture made (an idea stays an idea),
 * and a record you have changed since (a project you edited, a task you
 * ticked, an entry you edited on Money) isn't replaced or undone: undoing the
 * capture would throw those changes away.
 */
import { type Parsed } from "./parse";
import undoBlockedSql from "./queries/undo_blocked.sql?raw";

/**
 * The records a capture inserted (?1 = `capture:<raw id>`), each with its
 * note kind, and whether anything else has changed it since (`touched`).
 */
export const CAPTURE_MADE_SQL = `
  SELECT a.entity_type, a.entity_id,
         json_extract(a.after_json, '$.kind') AS note_kind,
         EXISTS (SELECT 1 FROM core_activity b
                 WHERE b.entity_type = a.entity_type AND b.entity_id = a.entity_id
                   AND b.id > a.id AND (b.context IS NULL OR b.context != a.context)
                   AND b.action != 'undo'
                   -- A later change you have undone since doesn't count (reg2-6).
                   AND NOT EXISTS (SELECT 1 FROM core_activity u
                                   WHERE u.context = 'undo:' || b.context AND u.action = 'undo')) AS touched
  FROM core_activity a
  WHERE a.context = ?1 AND a.action = 'insert'
  ORDER BY a.id`;

export type MadeRow = {
  entity_type: string;
  entity_id: string;
  note_kind: string | null;
  touched: number;
};

const NOTE_KINDS = new Set(["note", "feedback", "inbox", "cheat"]);

/** What the capture made, as a reading's kind; undefined for money and the rest. */
export function madeKind(rows: MadeRow[]): Parsed["kind"] | undefined {
  const first = rows[0];
  if (!first) return undefined;
  if (first.entity_type === "task_items") return "task";
  if (first.entity_type === "project_items") return "idea";
  if (first.entity_type === "note_items" && first.note_kind && NOTE_KINDS.has(first.note_kind))
    return first.note_kind as Parsed["kind"];
  return undefined;
}

/** Which reading the box starts on: the one of the kind the capture made, else the first. */
export function fixReading(options: Parsed[], kind: Parsed["kind"] | undefined): number {
  if (!kind) return 0;
  const index = options.findIndex((option) => option.kind === kind);
  return index < 0 ? 0 : index;
}

/** What undoing the capture would throw away (queries/undo_blocked.sql). */
export const UNDO_BLOCKED_SQL = undoBlockedSql;

export type BlockRow = {
  entity_type: string;
  inserted: number;
  gone: number;
  changed: number;
  checked: string | null;
};

/** Where a record you changed since is edited instead. */
const CHANGED: Record<string, string> = {
  project_items: "You've changed this project since. Edit it on Projects.",
  task_items: "You've changed this task since. Edit it on Plan > Tasks.",
  money_txns: "You've changed this entry since. Edit it on Money.",
  money_loans: "This loan has changed since. Edit it on Money > Lent and owed.",
  note_items: "You've changed this note since. Edit it on Notes.",
  "note_items:cheat": "You've changed this line since. Edit it on Plan > Cheat sheets.",
  day_blocks: "You've changed this block since. Edit it on Today.",
  savings_entries: "You've changed this saving since. Edit it on Money.",
  core_settings: "Away has changed since. Set it on Today.",
};

/**
 * Why the capture can't be undone or fixed, or null (F2, F65). Undoing a
 * record you have changed since (ticked, edited, deleted) would throw your
 * change away, and undoing an entry after a balance check would move the
 * balance off the number you typed. capture_undo and capture_replace in Rust
 * refuse with the same words, so the tray's Undo is covered too.
 */
export function undoBlocked(rows: BlockRow[], verb: "undo" | "fix"): string | null {
  const inserted = rows.filter((row) => row.inserted === 1);
  if (inserted.length > 0 && inserted.every((row) => row.gone === 1))
    return `Nothing to ${verb}: you've deleted it since.`;
  const changed = rows.find((row) => row.changed === 1);
  if (changed) return CHANGED[changed.entity_type] ?? "You've changed this since.";
  const checked = rows.find((row) => row.checked !== null)?.checked;
  if (checked)
    return `You checked ${checked} since. ${verb === "undo" ? "Undo" : "Fix"} it on Money > Ledger, then check ${checked} again.`;
  return null;
}

/**
 * The newest capture that hasn't been undone (?1 none). A line that made
 * nothing (`afford …`, `? search`) is still the newest: Ctrl+Z and Up say
 * there is nothing to undo rather than reaching past it to an older one (F38).
 * Rust's tray reads the same rule (tasks.rs).
 */
export const LAST_CAPTURE_SQL =
  "SELECT id, body, parse_status, parser_id, received_at FROM core_raw_items WHERE source = 'capture' AND parse_status != 'ignored' ORDER BY id DESC LIMIT 1";

export type LastCapture = {
  id: number;
  body: string;
  parse_status: string;
  /** `today` for a line from Add for today (capture/today.ts): a fix keeps it a task for that day. */
  parser_id?: string | null;
  received_at?: number;
};

/** The capture Ctrl+Z or Up acts on: none when the newest one made nothing. */
export function actionable(last: LastCapture | undefined): LastCapture | undefined {
  return last && last.parse_status !== "new" ? last : undefined;
}
