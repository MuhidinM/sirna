/**
 * The days ahead as one chain (F18): each day is planned after the days
 * before it, carrying what each task still needs and the area time the week
 * already has. Week → Next 7 days shows the chain; a day you open is saved
 * from the same chain, so it holds what the forecast said. A day already
 * saved enters the chain as it was saved. Pure.
 */
import { generateDay, type PlanInput, TASK_BLOCK_MIN, type TaskInput } from "./generate";

const DAY_MS = 24 * 60 * 60 * 1000;

/** ISO weekday of a YYYY-MM-DD date: Monday = 1 … Sunday = 7. */
export function isoWeekday(date: string): number {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

/** The Monday that starts the week of `date`. */
export function weekStart(date: string): string {
  const monday = Date.parse(`${date}T00:00:00Z`) - (isoWeekday(date) - 1) * DAY_MS;
  return new Date(monday).toISOString().slice(0, 10);
}

/** A YYYY-MM-DD date moved by whole days. */
export function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

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
  /** Before the away return day: no plan and no time for tasks (plan §3.11). */
  away?: boolean;
  /** Focus blocks only: what the planner fills free time with. */
  blocks: PreviewBlock[];
}

/** Time a day gives: to a task (its minutes come off), to an area (its week fills). */
export interface Booking {
  /** Set for a focus block: its minutes count toward the area's week. */
  areaId: string | null;
  taskId: string | null;
  durationMin: number;
}

/** A day that already has a plan: it enters the chain as saved. */
export interface SavedDay {
  light: boolean;
  /** Its focus blocks still to come, as Next 7 days shows them. */
  blocks: PreviewBlock[];
  /** Its blocks still to come, not finished or skipped, with no focus in them. */
  booked: Booking[];
}

export interface Carry {
  /** Task id → minutes still needed (null: one block is enough). */
  left: Map<string, number | null>;
  /** Task id → the day the chain finishes it. */
  finished: Map<string, string>;
  /** Monday → area → minutes planned that week by the days before. */
  plannedByWeek: Map<string, Record<string, number>>;
}

/** A day's planner input after the days before it in the chain. */
export function carriedInput(input: PlanInput, carry: Carry): PlanInput {
  const already = carry.plannedByWeek.get(weekStart(input.date)) ?? {};
  const tasks = input.tasks
    .filter((task) => !carry.finished.has(task.id))
    .map((task) =>
      carry.left.has(task.id) ? { ...task, remainingMin: carry.left.get(task.id) ?? null } : task,
    );
  const done = { ...input.doneThisWeekMin };
  for (const [area, minutes] of Object.entries(already)) done[area] = (done[area] ?? 0) + minutes;
  return { ...input, tasks, doneThisWeekMin: done };
}

/** Books a day's time into the chain. `input` is the day's carried input. */
function book(carry: Carry, input: PlanInput, booked: Booking[]): void {
  const monday = weekStart(input.date);
  const already = carry.plannedByWeek.get(monday) ?? {};
  for (const block of booked) {
    if (block.areaId) already[block.areaId] = (already[block.areaId] ?? 0) + block.durationMin;
    if (!block.taskId || carry.finished.has(block.taskId)) continue;
    const task = input.tasks.find((t) => t.id === block.taskId);
    const need = carry.left.has(block.taskId)
      ? carry.left.get(block.taskId)
      : (task?.remainingMin ?? null);
    const rest = need === null || need === undefined ? 0 : need - block.durationMin;
    if (rest > 0) carry.left.set(block.taskId, rest);
    else {
      carry.left.set(block.taskId, 0);
      carry.finished.set(block.taskId, input.date);
    }
  }
  carry.plannedByWeek.set(monday, already);
}

export interface Chain {
  days: PreviewDay[];
  carry: Carry;
  /** Every task the chain saw, as first seen. */
  allTasks: Map<string, TaskInput>;
  /** What each task still needed at the end of each day. */
  leftAtEnd: Map<string, Map<string, number | null>>;
  /** Each day's input after the days before it. */
  carried: Map<string, PlanInput>;
}

/**
 * Runs the days in order. A task's minutes planned on one day come off what
 * it still needs the next; a task without an estimate is done after its first
 * block. Area minutes planned earlier in the same week count toward its
 * target. A saved day books what it holds instead of being planned.
 */
export function runChain(
  inputs: PlanInput[],
  awayDates: ReadonlySet<string> = new Set(),
  saved: ReadonlyMap<string, SavedDay> = new Map(),
): Chain {
  const carry: Carry = { left: new Map(), finished: new Map(), plannedByWeek: new Map() };
  const days: PreviewDay[] = [];
  const allTasks = new Map<string, TaskInput>();
  const leftAtEnd = new Map<string, Map<string, number | null>>();
  const carried = new Map<string, PlanInput>();

  for (const input of inputs) {
    for (const task of input.tasks) if (!allTasks.has(task.id)) allTasks.set(task.id, task);
    // Away: nothing planned, so tasks carry over to the days you are back.
    if (awayDates.has(input.date)) {
      leftAtEnd.set(input.date, new Map(carry.left));
      days.push({ date: input.date, light: false, away: true, blocks: [] });
      continue;
    }
    const day = carriedInput(input, carry);
    carried.set(input.date, day);
    const kept = saved.get(input.date);
    if (kept) {
      book(carry, day, kept.booked);
      days.push({ date: input.date, light: kept.light, blocks: kept.blocks });
    } else {
      const plan = generateDay(day);
      const blocks = plan.blocks
        .filter((block) => block.kind === "area")
        .map((block) => ({
          startMin: block.startMin,
          durationMin: block.durationMin,
          areaId: block.areaId,
          title: block.title,
          taskId: block.taskId,
        }));
      // A task block you moved or added (kept) covers its task that day too.
      const keptTaskTime = day.kept.flatMap((block) =>
        block.taskId && day.tasks.some((t) => t.id === block.taskId)
          ? [{ areaId: null, taskId: block.taskId, durationMin: block.durationMin }]
          : [],
      );
      book(carry, day, [...blocks, ...keptTaskTime]);
      days.push({ date: input.date, light: plan.light, blocks });
    }
    leftAtEnd.set(input.date, new Map(carry.left));
  }
  return { days, carry, allTasks, leftAtEnd, carried };
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
