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
  SELECT id, title, carries, due_date, due_at FROM task_items
  WHERE deleted_at IS NULL AND status = 'todo' AND COALESCE(planned_date, due_date) <= ?1
  ORDER BY COALESCE(planned_date, due_date), created_at`;

/** Expenses typed today, newest first. */
export const SPENT_LIST_SQL = `
  SELECT id, description, amount_minor FROM money_txns
  WHERE deleted_at IS NULL AND transfer_id IS NULL AND local_date = ?1 AND amount_minor < 0
  ORDER BY occurred_at DESC`;

/**
 * One-tap chips: an expense typed at least 3 times in the last 60 days
 * (plan §3.14), one chip per description at its most used amount (the latest
 * breaks a tie), so a price that varies doesn't fill the row. ?1 = the first
 * date counted.
 */
export const CHIPS_SQL = `
  WITH priced AS (
    SELECT lower(description) AS item, description, amount_minor, category_id,
           count(*) AS times, max(occurred_at) AS last_at
    FROM money_txns
    WHERE deleted_at IS NULL AND transfer_id IS NULL AND amount_minor < 0 AND local_date >= ?1
    GROUP BY lower(description), amount_minor
  ), ranked AS (
    SELECT *, sum(times) OVER (PARTITION BY item) AS uses,
           row_number() OVER (PARTITION BY item ORDER BY times DESC, last_at DESC) AS pick
    FROM priced
  )
  SELECT description, amount_minor, category_id, uses FROM ranked
  WHERE pick = 1 AND uses >= 3
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
 *
 * A task with a time today ("call bank at 2pm") is an appointment, and its
 * time is when it starts (time-first §1 rule 1), not a deadline: it moves
 * whole, to the same time tomorrow, so it keeps its slot and isn't late.
 */
export function carryOps(
  tasks: { id: string; carries: number; due_at?: number | null }[],
  tomorrow: string,
): Op[] {
  const today = logicalDate(logicalDayStart(tomorrow) - 12 * 60 * 60 * 1000);
  return tasks.map((task) => {
    if (task.due_at != null && logicalDate(task.due_at) === today) {
      const at = task.due_at + DAY_MS;
      return {
        op: "update",
        table: "task_items",
        id: task.id,
        values: {
          planned_date: tomorrow,
          due_date: tomorrow,
          due_at: at,
          remind_at: at,
          carries: task.carries + 1,
        },
      };
    }
    return {
      op: "update",
      table: "task_items",
      id: task.id,
      values: { planned_date: tomorrow, remind_at: null, carries: task.carries + 1 },
    };
  });
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

/** How many loose captures wait in all: the badge, while two show at a time. */
export const INBOX_COUNT_SQL = `
  SELECT count(*) AS n FROM note_items
  WHERE deleted_at IS NULL AND kind = 'inbox' AND status = 'inbox'`;

/** "2 of 5" while more wait than show, else the count. */
export function inboxBadge(shown: number, total: number): string {
  return total > shown ? `${shown} of ${total}` : String(shown);
}

export type SortChoice = "task" | "note" | "drop";

/** What a sort did, for its undo line (Night review and the week ahead say it the same way). */
export const SORTED: Record<SortChoice, string> = {
  task: "Made a task",
  note: "Kept as a note",
  drop: "Dropped",
};

/**
 * [Task] [Note] [Drop] on a loose capture, with the writes that take it back
 * (Undo on the card): the note returns to the inbox, a new task is deleted.
 */
export function sortInbox(
  note: { id: string; body: string },
  choice: SortChoice,
  newId: () => string,
): { ops: Op[]; undo: Op[] } {
  const back: Op = {
    op: "update",
    table: "note_items",
    id: note.id,
    values: { kind: "inbox", status: "inbox" },
  };
  if (choice === "drop")
    return {
      ops: [{ op: "update", table: "note_items", id: note.id, values: { status: "dropped" } }],
      undo: [back],
    };
  if (choice === "note")
    return {
      ops: [
        {
          op: "update",
          table: "note_items",
          id: note.id,
          values: { kind: "note", status: "kept" },
        },
      ],
      undo: [back],
    };
  const taskId = newId();
  return {
    ops: [
      {
        op: "insert",
        table: "task_items",
        id: taskId,
        values: { title: note.body, status: "todo", origin: `note:${note.id}` },
      },
      { op: "update", table: "note_items", id: note.id, values: { status: "converted" } },
    ],
    undo: [{ op: "delete", table: "task_items", id: taskId }, back],
  };
}

/** The writes of sorting a loose capture (see sortInbox). */
export function sortInboxOps(
  note: { id: string; body: string },
  choice: SortChoice,
  newId: () => string,
): Op[] {
  return sortInbox(note, choice, newId).ops;
}

/** Writes the review row; later steps update it. */
export function reviewOps(date: string, values: Record<string, string | number | null>): Op[] {
  return [{ op: "upsert", table: "day_reviews", id: date, values }];
}

/** The routine's own "Night review" block. */
export function isReviewBlock(block: {
  kind: string;
  area_id: string | null;
  title: string;
}): boolean {
  return block.kind === "routine" && block.area_id === null && block.title === "Night review";
}

/**
 * Closing the review: its row, and, when it was done (not skipped), tonight's
 * Night review block marked done in the same write, so one undo takes both.
 */
export function finishOps(
  date: string,
  values: Record<string, string | number | null>,
  blocks: { id: string; kind: string; area_id: string | null; title: string; status: string }[],
): Op[] {
  const ops = reviewOps(date, values);
  if (values.status !== "done") return ops;
  for (const block of blocks)
    if (isReviewBlock(block) && block.status !== "done")
      ops.push({ op: "update", table: "day_blocks", id: block.id, values: { status: "done" } });
  return ops;
}
