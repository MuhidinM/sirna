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
    AND NOT EXISTS (SELECT 1 FROM task_items n WHERE n.repeat_of = t.id)`;

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
export function nextCopyOps(task: RepeatRow, today: string, id: string): Op[] {
  const rule = readRule(task.repeat_json);
  if (!rule) return [];
  const base = task.due_date ?? (task.completed_at ? logicalDate(task.completed_at) : today);
  let next = nextAfter(rule, base);
  if (next !== null && next < today) next = onOrAfter(rule, today);
  if (next === null) return [];
  return [
    {
      op: "insert",
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

/** Makes the next copy of every repeating task that was finished. */
export async function ensureRepeats(
  query: Query,
  transact: (ops: Op[]) => Promise<unknown>,
  today: string,
  newId: () => string,
): Promise<number> {
  const done = await query<RepeatRow & Record<string, string | number | null>>(REPEAT_DUE_SQL);
  const ops = done.flatMap((task) => nextCopyOps(task, today, newId()));
  if (ops.length > 0) await transact(ops);
  return ops.length;
}
