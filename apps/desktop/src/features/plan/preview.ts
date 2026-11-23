/**
 * The week ahead (T-069; proposal 4.2): the planner run over the next 7 days
 * in memory, carrying what each task still needs from one day to the next,
 * so you see what each day holds and which tasks won't be done by their
 * deadline. Read-only: nothing is written until you act. Pure, plus a loader.
 */
import { type Op } from "../../kernel/db";
import { localToEpoch } from "../../capture/when";
import {
  FILLABLE_KINDS,
  generateDay,
  hasEstimate,
  type PlanInput,
  TASK_BLOCK_MIN,
  type TaskInput,
} from "./generate";
import { loadPlanInput, type Query, shiftDate, weekStart } from "./dayplan";

export const PREVIEW_DAYS = 7;

export interface PreviewBlock {
  startMin: number;
  durationMin: number;
  areaId: string | null;
  title: string;
  taskId: string | null;
}

export interface PreviewDay {
  date: string;
  light: boolean;
  /** Focus blocks only: what the planner fills free time with. */
  blocks: PreviewBlock[];
}

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
 * Runs the days in order. A task's minutes planned on one day come off what
 * it still needs the next; a task without an estimate is done after its first
 * block. Area minutes planned earlier in the same week count toward its target.
 */
export function previewWeek(inputs: PlanInput[]): WeekPreview {
  const left = new Map<string, number | null>(); // task id → minutes still needed (null: one block)
  const finished = new Map<string, string>(); // task id → day the plan finishes it
  const plannedByWeek = new Map<string, Record<string, number>>(); // monday → area → minutes
  const days: PreviewDay[] = [];
  const allTasks = new Map<string, TaskInput>();
  /** What each task still needed at the end of each day. */
  const leftAtEnd = new Map<string, Map<string, number | null>>();

  for (const input of inputs) {
    for (const task of input.tasks) if (!allTasks.has(task.id)) allTasks.set(task.id, task);
    const monday = weekStart(input.date);
    const already = plannedByWeek.get(monday) ?? {};
    const tasks = input.tasks
      .filter((task) => !finished.has(task.id))
      .map((task) =>
        left.has(task.id) ? { ...task, remainingMin: left.get(task.id) ?? null } : task,
      );
    const done = { ...input.doneThisWeekMin };
    for (const [area, minutes] of Object.entries(already)) done[area] = (done[area] ?? 0) + minutes;
    const plan = generateDay({ ...input, tasks, doneThisWeekMin: done });
    const blocks = plan.blocks
      .filter((block) => block.kind === "area")
      .map((block) => ({
        startMin: block.startMin,
        durationMin: block.durationMin,
        areaId: block.areaId,
        title: block.title,
        taskId: block.taskId,
      }));
    for (const block of blocks) {
      if (block.areaId) already[block.areaId] = (already[block.areaId] ?? 0) + block.durationMin;
      if (!block.taskId || finished.has(block.taskId)) continue;
      const task = tasks.find((t) => t.id === block.taskId);
      const need = left.has(block.taskId) ? left.get(block.taskId) : (task?.remainingMin ?? null);
      const rest = need === null || need === undefined ? 0 : need - block.durationMin;
      if (rest > 0) left.set(block.taskId, rest);
      else {
        left.set(block.taskId, 0);
        finished.set(block.taskId, input.date);
      }
    }
    plannedByWeek.set(monday, already);
    leftAtEnd.set(input.date, new Map(left));
    days.push({ date: input.date, light: plan.light, blocks });
  }

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
 * Today's free slots from now on: time already gone can't be planned. A task
 * whose time has passed is planned like any other; a part of the day starts now.
 */
export function fromNow(input: PlanInput, nowMin: number): PlanInput {
  return {
    ...input,
    notBeforeMin: Math.max(input.notBeforeMin ?? 0, nowMin),
    tasks: input.tasks.map((task) =>
      task.atMin !== null &&
      task.atMin !== undefined &&
      task.atMin + (task.estimateMin && task.estimateMin > 0 ? task.estimateMin : TASK_BLOCK_MIN) <=
        nowMin
        ? { ...task, atMin: null }
        : task,
    ),
    template: input.template.flatMap((block) => {
      if (block.kind !== "area") return [block];
      const end = block.startMin + block.durationMin;
      if (end <= nowMin) return [];
      if (block.startMin >= nowMin) return [block];
      return [{ ...block, startMin: nowMin, durationMin: end - nowMin }];
    }),
  };
}

/** Loads the next 7 days' inputs and runs them, today from `nowMs` on. */
export async function loadPreview(
  query: Query,
  today: string,
  nowMs: number,
): Promise<WeekPreview> {
  const inputs: PlanInput[] = [];
  for (let i = 0; i < PREVIEW_DAYS; i++)
    inputs.push(await loadPlanInput(query, shiftDate(today, i)));
  const first = inputs[0];
  if (first) inputs[0] = fromNow(first, Math.round((nowMs - localToEpoch(today, 0)) / 60_000));
  return previewWeek(inputs);
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
