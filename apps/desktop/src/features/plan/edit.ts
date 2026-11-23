/**
 * Changing a day's blocks by hand (time-first §1 rules 6 and 8): move, resize
 * in 15-minute steps, change, add and delete. Pure: the board writes the ops
 * these return with `transact("user", …)`, which stamps `user_edited_at` on
 * every update (tx.rs), and a block you add is `source = 'user'`, so the
 * planner never overwrites either. Overlaps never fail: the board puts
 * overlapping blocks side by side in lanes.
 */
import { type Op, type SqlValue } from "../../kernel/db";
import { localToEpoch } from "../../capture/when";
import { type Parsed, parseCapture } from "../../capture/parse";

/** Every edit lands on a 15-minute line. */
export const SNAP_MIN = 15;
/** The logical day runs 03:00 to 03:00 (rule 4), in minutes after the date's midnight. */
export const DAY_START_MIN = 180;
export const DAY_END_MIN = DAY_START_MIN + 24 * 60;
/** A block added from an empty hour lasts this long. */
export const ADD_MIN = 60;

const MIN_MS = 60_000;

export const snap = (minutes: number) => Math.round(minutes / SNAP_MIN) * SNAP_MIN;

/** Minutes after `date`'s midnight (01:00 the night after is 1500). */
export function minuteOf(date: string, epochMs: number): number {
  return Math.round((epochMs - localToEpoch(date, 0)) / MIN_MS);
}

/** "07:30" for a minute of the logical day (1500 → "01:00"). */
export function clockOf(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/**
 * "07:30" → minutes on the logical day; a time before 03:00 is after
 * midnight. With `after`, a time not later than it (an end) is read as the
 * night after, so "00:00" and "03:00" can end a day.
 */
export function readClock(text: string, after?: number): number | null {
  const match = /^\s*(\d{1,2})[:.](\d{2})\s*$/.exec(text);
  if (!match) return null;
  const hours = Number(match[1]);
  const mins = Number(match[2]);
  if (hours > 24 || mins > 59 || (hours === 24 && mins > 0)) return null;
  let minutes = hours * 60 + mins;
  if (minutes < DAY_START_MIN) minutes += 1440;
  if (after !== undefined && minutes <= after && minutes + 1440 <= DAY_END_MIN) minutes += 1440;
  return minutes;
}

export interface Span {
  startMin: number;
  endMin: number;
}

/** The block the board edits: a `day_blocks` row as TODAY_BLOCKS_SQL reads it. */
export interface EditBlock {
  id: string;
  start_at: number;
  end_at: number;
  title: string;
  kind: string;
  area_id: string | null;
  task_id: string | null;
  status: string;
}

export function spanOf(date: string, block: Pick<EditBlock, "start_at" | "end_at">): Span {
  return { startMin: minuteOf(date, block.start_at), endMin: minuteOf(date, block.end_at) };
}

/** Moved by `deltaMin`, its start on a 15-minute line, kept inside the logical day. */
export function moveSpan(span: Span, deltaMin: number): Span {
  const length = span.endMin - span.startMin;
  const start = Math.max(
    DAY_START_MIN,
    Math.min(DAY_END_MIN - length, snap(span.startMin + deltaMin)),
  );
  return { startMin: start, endMin: start + length };
}

/** A new end on a 15-minute line: at least 15 minutes long, by the end of the day. */
export function resizeSpan(span: Span, endMin: number): Span {
  const end = Math.max(span.startMin + SNAP_MIN, Math.min(DAY_END_MIN, snap(endMin)));
  return { startMin: span.startMin, endMin: end };
}

function timeOps(date: string, block: EditBlock, span: Span): Op[] {
  const start = localToEpoch(date, span.startMin);
  const end = localToEpoch(date, span.endMin);
  if (start === block.start_at && end === block.end_at) return [];
  return [
    { op: "update", table: "day_blocks", id: block.id, values: { start_at: start, end_at: end } },
  ];
}

/** Drag or arrow keys: the whole block moves. */
export function moveOps(date: string, block: EditBlock, deltaMin: number): Op[] {
  return timeOps(date, block, moveSpan(spanOf(date, block), deltaMin));
}

/** Drag the bottom edge (or Shift+arrows): the end moves. */
export function resizeOps(date: string, block: EditBlock, endMin: number): Op[] {
  return timeOps(date, block, resizeSpan(spanOf(date, block), endMin));
}

/** What the edit popover holds. */
export interface BlockDraft {
  title: string;
  start: string;
  end: string;
  areaId: string | null;
  taskId: string | null;
}

export function draftOf(date: string, block: EditBlock): BlockDraft {
  const span = spanOf(date, block);
  return {
    title: block.title,
    start: clockOf(span.startMin),
    end: clockOf(span.endMin),
    areaId: block.area_id,
    taskId: block.task_id,
  };
}

/** A new block from an empty spot on the board: an hour from the 15-minute line above. */
export function newDraft(atMin: number): BlockDraft {
  const start = Math.max(
    DAY_START_MIN,
    Math.min(DAY_END_MIN - SNAP_MIN, Math.floor(atMin / SNAP_MIN) * SNAP_MIN),
  );
  return {
    title: "",
    start: clockOf(start),
    end: clockOf(Math.min(DAY_END_MIN, start + ADD_MIN)),
    areaId: null,
    taskId: null,
  };
}

/**
 * The edit popover's React key: another block, another start or another
 * click (`opened`) remounts it, so a click on another empty hour (or "Add a
 * block") while it is open shows that time, not the old one.
 */
export function editorKey(
  editing:
    { mode: "edit"; block: { id: string } } | { mode: "add"; draft: BlockDraft; opened?: number },
): string {
  return editing.mode === "edit"
    ? `edit:${editing.block.id}`
    : `add:${editing.draft.start}:${editing.opened ?? 0}`;
}

/** The span a draft names, or an error to show. */
export function readDraft(draft: BlockDraft): Span | string {
  if (!draft.title.trim() && !draft.areaId && !draft.taskId)
    return "Give it a name, an area or a task.";
  const start = readClock(draft.start);
  if (start === null) return "Times look like 07:30.";
  const end = readClock(draft.end, start);
  if (end === null) return "Times look like 07:30.";
  if (end <= start) return "It has to end after it starts.";
  if (end - start < 5) return "At least 5 minutes.";
  return { startMin: start, endMin: end };
}

/** The title to save: what you typed, else the task's or the area's name. */
function titleOf(
  draft: BlockDraft,
  names: { task?: string | undefined; area?: string | undefined },
): string {
  return draft.title.trim() || names.task || names.area || "Block";
}

/** Saves the popover over an existing block. Throws on a draft `readDraft` rejects. */
export function changeOps(
  date: string,
  block: EditBlock,
  draft: BlockDraft,
  names: { task?: string | undefined; area?: string | undefined } = {},
): Op[] {
  const span = readDraft(draft);
  if (typeof span === "string") throw new Error(span);
  const values: Record<string, SqlValue> = {};
  const title = titleOf(draft, names);
  if (title !== block.title) values.title = title;
  const start = localToEpoch(date, span.startMin);
  const end = localToEpoch(date, span.endMin);
  if (start !== block.start_at) values.start_at = start;
  if (end !== block.end_at) values.end_at = end;
  if (draft.areaId !== block.area_id) values.area_id = draft.areaId;
  if (draft.taskId !== block.task_id) values.task_id = draft.taskId;
  // A rest band given an area or a task becomes a block you work in.
  if (block.kind === "rest" && (draft.areaId || draft.taskId)) values.kind = "area";
  if (Object.keys(values).length === 0) return [];
  return [{ op: "update", table: "day_blocks", id: block.id, values }];
}

/** A block you add: yours (`source = 'user'`), so the planner keeps it. */
export function addOps(
  date: string,
  draft: BlockDraft,
  id: string,
  names: { task?: string | undefined; area?: string | undefined } = {},
): Op[] {
  const span = readDraft(draft);
  if (typeof span === "string") throw new Error(span);
  return [
    {
      op: "insert",
      table: "day_blocks",
      id,
      values: {
        logical_date: date,
        start_at: localToEpoch(date, span.startMin),
        end_at: localToEpoch(date, span.endMin),
        kind: "area",
        area_id: draft.areaId,
        task_id: draft.taskId,
        title: titleOf(draft, names),
        source: "user",
        status: "planned",
      },
    },
  ];
}

/**
 * Deletes a block so the planner doesn't make it again: an empty update first
 * (tx.rs stamps `user_edited_at` on a user's update), then the soft delete.
 * The planner reads a deleted block you touched as "removed" (dayplan.ts
 * REMOVED_TASK_BLOCKS_SQL and REMOVED_BLOCKS_SQL).
 */
export function deleteOps(block: Pick<EditBlock, "id">): Op[] {
  return [
    { op: "update", table: "day_blocks", id: block.id, values: {} },
    { op: "delete", table: "day_blocks", id: block.id },
  ];
}

/**
 * Where keyboard focus goes after a block is deleted: the next block in time,
 * else the one before, else none (the board itself).
 */
export function focusAfterDelete(
  blocks: { id: string; start_at: number }[],
  deletedId: string,
): string | null {
  const sorted = [...blocks].sort((a, b) => a.start_at - b.start_at);
  const index = sorted.findIndex((block) => block.id === deletedId);
  if (index < 0) return null;
  return sorted[index + 1]?.id ?? sorted[index - 1]?.id ?? null;
}

/**
 * The ops that put things back: an insert is deleted, an update gets its old
 * values, a delete is revived (an upsert on a soft-deleted row clears
 * `deleted_at`). `before` holds each touched row's values before the change.
 */
export function undoOps(ops: Op[], before: Record<string, Record<string, SqlValue>>): Op[] {
  return [...ops].reverse().flatMap((op): Op[] => {
    const old = before[op.id] ?? {};
    if (op.op === "insert") return [{ op: "delete", table: op.table, id: op.id }];
    if (op.op === "delete") return [{ op: "upsert", table: op.table, id: op.id, values: old }];
    // The stamp before a delete has nothing to put back.
    if (op.op === "update" && Object.keys(op.values).length === 0) return [];
    const values: Record<string, SqlValue> = {};
    for (const key of Object.keys(op.values)) values[key] = old[key] ?? null;
    return [{ op: "update", table: op.table, id: op.id, values }];
  });
}

/** A block's own values, for `undoOps`. */
export function blockBefore(block: EditBlock): Record<string, SqlValue> {
  return {
    title: block.title,
    start_at: block.start_at,
    end_at: block.end_at,
    kind: block.kind,
    area_id: block.area_id,
    task_id: block.task_id,
    status: block.status,
  };
}

// --- Tasks inside blocks (rule 6) -----------------------------------------------------------------

/**
 * Open tasks for the popover's task picker, with or without an area (the
 * lists inside blocks come from AREA_TASKS_SQL in jobs.ts). A later step of a
 * split task waits for the steps before it.
 */
export const BOARD_TASKS_SQL = `
  SELECT t.id, t.title, t.area_id, t.status, t.estimate_min,
         CASE WHEN t.deadline_stale = 1 THEN NULL ELSE t.due_date END AS due_date,
         t.planned_date, t.created_at
  FROM task_items t
  LEFT JOIN area_items a ON a.id = t.area_id
  WHERE t.deleted_at IS NULL AND t.status = 'todo'
    AND (t.area_id IS NULL OR a.deleted_at IS NULL)
    AND NOT EXISTS (
      SELECT 1 FROM task_items AS before_step
      WHERE before_step.parent_id = t.parent_id AND before_step.step_no < t.step_no
        AND before_step.status IN ('todo', 'waiting') AND before_step.deleted_at IS NULL)
  ORDER BY t.created_at`;

export interface BoardTask {
  id: string;
  title: string;
  area_id: string | null;
  status: string;
  estimate_min: number | null;
  due_date: string | null;
  planned_date: string | null;
  created_at: number;
}

// --- Add for today (§5) ---------------------------------------------------------------------------

/**
 * "Add for today": the line read as a capture, always a task, dated today
 * unless it names a day itself ("call bank 3pm" keeps its time).
 */
export function todayTask(text: string, today: string, nowMs: number): Parsed | null {
  const raw = text.trim();
  if (!raw) return null;
  const parsed = parseCapture(raw, { nowMs });
  if (parsed.kind !== "task") return { kind: "task", title: raw, dueDate: today };
  return { ...parsed, dueDate: parsed.dueDate ?? today };
}

// --- Next 7 days columns -----------------------------------------------------------------------------

export interface ColumnBlock {
  startMin: number;
  durationMin: number;
  areaId: string | null;
  title: string;
}

/**
 * Everything a day column shows. A day already planned shows its blocks; a
 * day not yet planned shows the routine's fixed blocks and habits with the
 * forecast's focus blocks. Rest is the background, not a card.
 */
export function weekColumn(
  date: string,
  planned: {
    start_at: number;
    end_at: number;
    kind: string;
    area_id: string | null;
    title: string;
  }[],
  routine: {
    start_min: number;
    duration_min: number;
    kind: string;
    area_id: string | null;
    title: string;
  }[],
  forecast: ColumnBlock[],
): ColumnBlock[] {
  if (planned.length > 0)
    return planned
      .filter((block) => block.kind !== "rest")
      .map((block) => ({
        startMin: minuteOf(date, block.start_at),
        durationMin: Math.round((block.end_at - block.start_at) / MIN_MS),
        areaId: block.area_id,
        title: block.title,
      }))
      .sort((a, b) => a.startMin - b.startMin);
  const out: ColumnBlock[] = routine
    .filter((block) => block.kind === "fixed" || block.kind === "routine")
    .map((block) => ({
      startMin: block.start_min,
      durationMin: block.duration_min,
      areaId: block.area_id,
      title: block.title,
    }));
  for (const block of forecast) {
    const twin = out.some((b) => b.startMin === block.startMin && b.title === block.title);
    if (!twin) out.push(block);
  }
  return out.sort((a, b) => a.startMin - b.startMin);
}

/** Planned blocks for a run of days (?1 first date, ?2 last). */
export const PLANNED_RANGE_SQL = `
  SELECT logical_date, start_at, end_at, kind, area_id, title FROM day_blocks
  WHERE logical_date BETWEEN ?1 AND ?2 AND deleted_at IS NULL
  ORDER BY logical_date, start_at`;
