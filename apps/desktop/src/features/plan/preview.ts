/**
 * The week ahead (T-069; proposal 4.2): the planner run over the next 7 days
 * in memory, carrying what each task still needs from one day to the next,
 * so you see what each day holds and which tasks won't be done by their
 * deadline. Read-only: nothing is written until you act. Pure, plus a loader.
 */
import { type Op } from "../../kernel/db";
import { FILLABLE_KINDS, hasEstimate, type PlanInput } from "./generate";
import { type PreviewDay, runChain, type SavedDay, shiftDate } from "./carry";
import { loadChain, type Query } from "./dayplan";

export { fromNow, type PreviewBlock, type PreviewDay } from "./carry";

export const PREVIEW_DAYS = 7;

export interface LateTask {
  id: string;
  title: string;
  dueDate: string;
  /** Minutes still missing at the end of the due day (estimate left, or one block). */
  shortMin: number | null;
  /** The day the plan would finish it, if within the week. */
  finishes: string | null;
}

export interface WeekPreview {
  days: PreviewDay[];
  late: LateTask[];
}

/**
 * Runs the days in order (`runChain`): a task's minutes planned on one day
 * come off what it still needs the next; a day already saved counts as saved.
 * Then lists the tasks that won't be done by their deadline.
 */
export function previewWeek(
  inputs: PlanInput[],
  awayDates: ReadonlySet<string> = new Set(),
  saved: ReadonlyMap<string, SavedDay> = new Map(),
): WeekPreview {
  const { days, carry, allTasks, leftAtEnd } = runChain(inputs, awayDates, saved);
  const finished = carry.finished;
  const last = inputs[inputs.length - 1]?.date ?? "";
  const late: LateTask[] = [];
  const kinds = new Map(inputs.flatMap((input) => input.areas.map((area) => [area.id, area.kind])));
  for (const task of allTasks.values()) {
    if (!task.dueDate || task.dueDate > last) continue; // past the week: can't tell yet
    // Only tasks the planner places can be judged here; a job's or the gym's
    // tasks are done inside their own blocks.
    const kind = task.areaId ? kinds.get(task.areaId) : undefined;
    if (task.areaId !== null && (kind === undefined || !FILLABLE_KINDS.has(kind))) continue;
    // A task with no area gets time only by its own time, part of the day or
    // estimate (time first, rule 5); without any of them it is a list item.
    const placeable =
      hasEstimate(task) || (task.atMin !== null && task.atMin !== undefined) || !!task.window;
    if (task.areaId === null && !placeable && !finished.has(task.id)) continue;
    const finishedOn = finished.get(task.id) ?? null;
    if (finishedOn !== null && finishedOn <= task.dueDate) continue;
    // What was still missing at the end of the due day (or now, if already overdue).
    const onDueDay = leftAtEnd.get(task.dueDate);
    const stillNeeds =
      onDueDay && onDueDay.has(task.id)
        ? (onDueDay.get(task.id) ?? 0)
        : (task.remainingMin ?? null);
    late.push({
      id: task.id,
      title: task.title,
      dueDate: task.dueDate,
      shortMin: stillNeeds,
      finishes: finishedOn,
    });
  }
  late.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.title.localeCompare(b.title));
  return { days, late };
}

/**
 * Loads the next 7 days and runs them, today from `nowMs` on. Days already
 * saved show what they hold, so a day you open keeps what this showed.
 */
export async function loadPreview(
  query: Query,
  today: string,
  nowMs: number,
): Promise<WeekPreview> {
  const { inputs, away, saved } = await loadChain(
    query,
    today,
    shiftDate(today, PREVIEW_DAYS - 1),
    nowMs,
  );
  return previewWeek(inputs, away, saved);
}

/** Move earlier: plan the task for today, so it gets the first free time. */
export function planTodayOps(taskId: string, today: string): Op[] {
  return [{ op: "update", table: "task_items", id: taskId, values: { planned_date: today } }];
}

/** Push the deadline a week (you said it can wait). */
export function pushDeadlineOps(task: Pick<LateTask, "id" | "dueDate">, days = 7): Op[] {
  return [
    {
      op: "update",
      table: "task_items",
      id: task.id,
      values: { due_date: shiftDate(task.dueDate, days), deadline_stale: 0 },
    },
  ];
}
