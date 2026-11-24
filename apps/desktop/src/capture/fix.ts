/**
 * Fixing the last capture with Up arrow (time-first §2, r2-7). The box opens
 * on the reading that matches what the capture made (an idea stays an idea),
 * and a record you have changed since (a project you edited) isn't replaced:
 * undoing the capture would throw those changes away.
 */
import { type Parsed } from "./parse";

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
                   AND b.action != 'undo') AS touched
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

/**
 * Why the capture can't be fixed here, or null. A project you changed since
 * (cards, dates, its title) is edited on Projects, not by retyping the idea.
 */
export function fixBlocked(rows: MadeRow[]): string | null {
  const project = rows.find((row) => row.entity_type === "project_items" && row.touched === 1);
  return project ? "You've changed this project since. Edit it on Projects." : null;
}
