/**
 * The night review (plan §3.9): today, spending, energy, tomorrow. Pure
 * helpers; the screen is shell/Review.tsx.
 */
import { type Op } from "../../kernel/db";
import { logicalDate } from "../../kernel/dates";
import { type Parsed, parseCapture } from "../../capture/parse";
import { logicalDayStart } from "../tasks/today";

export const REVIEW_PARSER = "review@1";
const DAY_MS = 24 * 60 * 60 * 1000;

/** The logical date after `date`. */
export function nextDate(date: string): string {
  return logicalDate(logicalDayStart(date) + DAY_MS + 60 * 60 * 1000);
}

/** The review row for a day, if any. */
export const REVIEW_SQL =
  "SELECT status, energy, spent_none, mind FROM day_reviews WHERE logical_date = ?";

/** Open tasks on today's list or earlier: what "All the rest to tomorrow" moves. */
export const OPEN_DUE_SQL = `
  SELECT id, title, carries, due_date FROM task_items
  WHERE deleted_at IS NULL AND status = 'todo' AND COALESCE(planned_date, due_date) <= ?1
  ORDER BY COALESCE(planned_date, due_date), created_at`;

/** Expenses typed today, newest first. */
export const SPENT_LIST_SQL = `
  SELECT id, description, amount_minor FROM money_txns
  WHERE deleted_at IS NULL AND local_date = ?1 AND amount_minor < 0
  ORDER BY occurred_at DESC`;

/**
 * One-tap chips: an expense typed the same way at least 3 times in the last
 * 60 days (plan §3.14). ?1 = the first date counted.
 */
export const CHIPS_SQL = `
  SELECT description, amount_minor, category_id, count(*) AS uses FROM money_txns
  WHERE deleted_at IS NULL AND amount_minor < 0 AND local_date >= ?1
  GROUP BY lower(description), amount_minor
  HAVING count(*) >= 3
  ORDER BY uses DESC, description
  LIMIT 6`;

export function chipsSince(today: string): string {
  return logicalDate(logicalDayStart(today) - 60 * DAY_MS + 60 * 60 * 1000);
}

/** The third carry asks "Make it smaller?" (plan §3.9 step 1). */
export function asksToShrink(carries: number): boolean {
  return carries >= 2;
}

/**
 * Moves open tasks to tomorrow's list, counting the carry. Only the planned
 * day changes: the deadline stays what it was (T-050). Today's reminder time
 * has passed, so it is dropped.
 */
export function carryOps(tasks: { id: string; carries: number }[], tomorrow: string): Op[] {
  return tasks.map((task) => ({
    op: "update",
    table: "task_items",
    id: task.id,
    values: { planned_date: tomorrow, remind_at: null, carries: task.carries + 1 },
  }));
}

export interface SpendingLine {
  text: string;
  parsed: Extract<Parsed, { kind: "expense" | "income" }> | undefined;
}

/**
 * "lunch 120, taxi 40" → one line per comma or newline. Each line is read by
 * the capture parser as spending; a line it can't read stays unparsed so the
 * screen can say so instead of guessing.
 */
export function readSpending(text: string, nowMs: number): SpendingLine[] {
  return text
    .split(/[,\n]/)
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0)
    .map((piece) => {
      const parsed = parseCapture(piece, { nowMs });
      return { text: piece, parsed: parsed.kind === "expense" ? parsed : undefined };
    });
}

/** A chip tapped: the same expense again, today. */
export function chipOps(
  chip: { description: string; amount_minor: number; category_id: string | null },
  today: string,
  nowMs: number,
  id: string,
): Op[] {
  return [
    {
      op: "insert",
      table: "money_txns",
      id,
      values: {
        occurred_at: nowMs,
        local_date: today,
        amount_minor: chip.amount_minor,
        description: chip.description,
        category_id: chip.category_id,
        origin: "review:chip",
      },
    },
  ];
}

/** Up to two loose captures to sort in step 1. */
export const INBOX_TWO_SQL = `
  SELECT id, body FROM note_items
  WHERE deleted_at IS NULL AND kind = 'inbox' AND status = 'inbox'
  ORDER BY created_at
  LIMIT 2`;

/** [Task] [Note] [Drop] on a loose capture. */
export function sortInboxOps(
  note: { id: string; body: string },
  choice: "task" | "note" | "drop",
  newId: () => string,
): Op[] {
  if (choice === "drop")
    return [{ op: "update", table: "note_items", id: note.id, values: { status: "dropped" } }];
  if (choice === "note")
    return [
      { op: "update", table: "note_items", id: note.id, values: { kind: "note", status: "kept" } },
    ];
  return [
    {
      op: "insert",
      table: "task_items",
      id: newId(),
      values: { title: note.body, status: "todo", origin: `note:${note.id}` },
    },
    { op: "update", table: "note_items", id: note.id, values: { status: "converted" } },
  ];
}

/** Writes the review row; later steps update it. */
export function reviewOps(date: string, values: Record<string, string | number | null>): Op[] {
  return [{ op: "upsert", table: "day_reviews", id: date, values }];
}
