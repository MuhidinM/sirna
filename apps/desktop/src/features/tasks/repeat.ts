/**
 * Repeating tasks (T-068; proposal 4.3): timesheets, weekly applications,
 * laundry. A task carries the same repeat rule as bills (`every fri`,
 * `monthly 1`, `every weekday`, `daily`). When one is done, the next copy is
 * made the next time Sirna looks (Today, Tasks), whichever way it was
 * finished, the tray included. Dropping one stops the repeat. Pure + one
 * small runner.
 */
import { logicalDate } from "../../kernel/dates";
import { type Op } from "../../kernel/db";
import { occurrences, readRule, type Rule } from "../money/regulars";
import { shiftDate, type Query } from "../plan/dayplan";

/** The first date the rule falls on after `date` (within a year). */
export function nextAfter(rule: Rule, date: string): string | null {
  return occurrences(rule, shiftDate(date, 1), shiftDate(date, 366))[0] ?? null;
}

/** The first date the rule falls on, `date` included. */
export function onOrAfter(rule: Rule, date: string): string | null {
  return occurrences(rule, date, shiftDate(date, 366))[0] ?? null;
}

/** Done repeating tasks that have no next copy yet. */
export const REPEAT_DUE_SQL = `
  SELECT t.id, t.title, t.area_id, t.project_id, t.estimate_min, t.repeat_json, t.due_date,
         t.completed_at
  FROM task_items t
  WHERE t.deleted_at IS NULL AND t.status = 'done' AND t.repeat_json IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM task_items n WHERE n.repeat_of = t.id AND n.deleted_at IS NULL)`;

/**
 * Next copies whose task is no longer done (you un-ticked it, or undid it):
 * if untouched, the copy goes, so there aren't two open ones.
 */
export const REPEAT_UNDONE_SQL = `
  SELECT n.id FROM task_items n
  JOIN task_items p ON p.id = n.repeat_of
  WHERE n.deleted_at IS NULL AND n.status = 'todo' AND n.user_edited_at IS NULL
    AND p.status != 'done' AND p.deleted_at IS NULL`;

/** The next copy's id: one per task, so running twice can't make two. */
export const copyId = (taskId: string) => `${taskId}~next`;

export interface RepeatRow {
  id: string;
  title: string;
  area_id: string | null;
  project_id: string | null;
  estimate_min: number | null;
  repeat_json: string;
  due_date: string | null;
  completed_at: number | null;
}

/**
 * The next copy: due on the rule's next date after the one just done (or
 * after the day it was finished). If that is already past (it sat done for
 * a while), the next date from today, so you never get a pile of late ones.
 */
export function nextCopyOps(task: RepeatRow, today: string, id = copyId(task.id)): Op[] {
  const rule = readRule(task.repeat_json);
  if (!rule) return [];
  const base = task.due_date ?? (task.completed_at ? logicalDate(task.completed_at) : today);
  let next = nextAfter(rule, base);
  if (next !== null && next < today) next = onOrAfter(rule, today);
  if (next === null) return [];
  return [
    {
      // An upsert: a copy removed earlier (task un-ticked, then ticked again) comes back.
      op: "upsert",
      table: "task_items",
      id,
      values: {
        title: task.title,
        status: "todo",
        area_id: task.area_id,
        project_id: task.project_id,
        estimate_min: task.estimate_min,
        due_date: next,
        repeat_json: task.repeat_json,
        repeat_of: task.id,
        origin: "repeat",
      },
    },
  ];
}

let running: Promise<number> | null = null;

/**
 * Makes the next copy of every repeating task that was finished, and removes
 * an untouched copy whose task is no longer done. One run at a time.
 */
export function ensureRepeats(
  query: Query,
  transact: (ops: Op[]) => Promise<unknown>,
  today: string,
): Promise<number> {
  running ??= (async () => {
    const done = await query<RepeatRow & Record<string, string | number | null>>(REPEAT_DUE_SQL);
    const undone = await query<{ id: string }>(REPEAT_UNDONE_SQL);
    const ops: Op[] = [
      ...done.flatMap((task) => nextCopyOps(task, today)),
      ...undone.map((row): Op => ({ op: "delete", table: "task_items", id: row.id })),
    ];
    if (ops.length > 0) await transact(ops);
    return ops.length;
  })().finally(() => {
    running = null;
  });
  return running;
}
