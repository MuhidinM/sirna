/**
 * Loads what the generator needs, runs it, and saves the day (plan §3.3).
 * The SQL is exported so tests run it against the real schema.
 */
import { type Op, type Row, type SqlValue } from "../../kernel/db";
import { logicalDate } from "../../kernel/dates";
import { localToEpoch } from "../../capture/when";
import {
  type AreaInput,
  type DayPlan,
  type DayWindow,
  generateDay,
  type PlanInput,
  type TaskInput,
} from "./generate";

export type Query = <T extends Row>(sql: string, params?: SqlValue[]) => Promise<T[]>;

const DAY_MS = 24 * 60 * 60 * 1000;
/** The logical day starts at 03:00 (rule 4). */
const DAY_START_MIN = 180;

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

export const PLAN_EXISTS_SQL =
  "SELECT count(*) AS n FROM day_blocks WHERE logical_date = ? AND deleted_at IS NULL";

export const TEMPLATE_SQL = `
  SELECT start_min, duration_min, kind, area_id, title FROM routine_blocks
  WHERE weekday = ? AND active = 1 AND deleted_at IS NULL ORDER BY start_min`;

export const AREAS_SQL = `
  SELECT id, name, kind, weekly_target_min, capped, protected, priority_rank, active
  FROM area_items WHERE deleted_at IS NULL`;

/** Minutes of done blocks per area from Monday up to (not including) today. */
export const DONE_THIS_WEEK_SQL = `
  SELECT area_id, SUM((end_at - start_at) / 60000) AS minutes FROM day_blocks
  WHERE deleted_at IS NULL AND status = 'done' AND area_id IS NOT NULL
    AND logical_date >= ? AND logical_date < ?
  GROUP BY area_id`;

/** Open tasks, with what is left of their estimate after focus time on them. */
export const OPEN_TASKS_SQL = `
  SELECT t.id, t.title, t.area_id, t.created_at, t.due_at, t.planned_window, t.planned_date,
         t.estimate_min,
         -- A deadline an old carry may have written isn't urgent until confirmed.
         CASE WHEN t.deadline_stale = 1 THEN NULL ELSE t.due_date END AS due_date,
         CASE WHEN t.estimate_min IS NULL THEN NULL ELSE MAX(0, t.estimate_min - COALESCE((
           SELECT sum(MAX(0, (f.ended_at - f.started_at - f.paused_ms) / 60000))
           FROM focus_sessions f
           WHERE f.task_id = t.id AND f.kind = 'focus' AND f.ended_at IS NOT NULL), 0)) END
           AS remaining_min
  FROM task_items t
  WHERE t.deleted_at IS NULL AND t.status = 'todo'
    -- A task moved to a later day waits for that day (T-050).
    AND (t.planned_date IS NULL OR t.planned_date <= ?)
    -- A later step of a split task waits for the steps before it (T-051).
    AND NOT EXISTS (
      SELECT 1 FROM task_items AS before_step
      WHERE before_step.parent_id = t.parent_id AND before_step.step_no < t.step_no
        AND before_step.status IN ('todo', 'waiting') AND before_step.deleted_at IS NULL)
  ORDER BY t.created_at`;

export const CHOSEN_TOP_SQL =
  "SELECT task_id FROM task_daily_top WHERE logical_date = ? AND chosen_by = 'user' ORDER BY position";

export const KEPT_BLOCKS_SQL = `
  SELECT id, start_at, end_at, task_id FROM day_blocks
  WHERE logical_date = ? AND deleted_at IS NULL AND (source = 'user' OR user_edited_at IS NOT NULL)`;

/**
 * Tasks whose own block you deleted on this day after touching it (user_edited_at
 * set; the planner's own clean-up skips such blocks): not made again.
 */
export const REMOVED_TASK_BLOCKS_SQL = `
  SELECT DISTINCT b.task_id FROM day_blocks b
  JOIN task_items t ON t.id = b.task_id AND t.title = b.title
  WHERE b.logical_date = ? AND b.deleted_at IS NOT NULL AND b.user_edited_at IS NOT NULL`;

/**
 * Timed calendar events that overlap a logical day, given its start and end
 * (an overnight flight counts on both days). All-day ones don't take time.
 */
export const DAY_EVENTS_SQL = `SELECT summary, start_at, end_at FROM cal_occurrences
  WHERE deleted_at IS NULL AND all_day = 0 AND start_at < ? AND end_at > ? ORDER BY start_at`;
export const REST_DAY_SQL = "SELECT value_json FROM core_settings WHERE key = 'setup.answers'";

/** Energy from the last two night reviews, newest first (plan §3.7: two 1s → light day). */
export const ENERGY_SQL = `
  SELECT energy FROM day_reviews
  WHERE logical_date IN (?, ?) AND energy IS NOT NULL
  ORDER BY logical_date DESC`;

/** A YYYY-MM-DD date moved by whole days. */
export function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export type OpenTaskRow = {
  id: string;
  title: string;
  area_id: string | null;
  due_date: string | null;
  due_at: number | null;
  planned_window: string | null;
  planned_date: string | null;
  estimate_min: number | null;
  created_at: number;
  remaining_min: number | null;
};

const WINDOW_NAMES = new Set<string>(["morning", "afternoon", "evening"]);

/**
 * An open task as the planner sees it on `date` (time first, rules 1 and 2):
 * timed on that day → its minute; a part of that day → its window; set for a
 * later day → not today (undefined). A time or window on a day already gone
 * is forgotten, so the task is planned like any other.
 */
export function taskOnDay(task: OpenTaskRow, date: string): TaskInput | undefined {
  const base: TaskInput = {
    id: task.id,
    title: task.title,
    areaId: task.area_id,
    dueDate: task.due_date,
    createdAt: task.created_at,
    remainingMin: task.remaining_min,
    estimateMin: task.estimate_min,
  };
  if (task.due_at !== null) {
    const timedDay = logicalDate(task.due_at);
    // A move to another day (planned_date) outranks the old time.
    const day = task.planned_date ?? timedDay;
    if (day === date && timedDay === date)
      return { ...base, atMin: Math.round((task.due_at - localToEpoch(date, 0)) / 60000) };
    if (day > date) return undefined;
    return base;
  }
  if (task.planned_window && WINDOW_NAMES.has(task.planned_window)) {
    const day = task.planned_date ?? task.due_date;
    if (day === date) return { ...base, window: task.planned_window as DayWindow };
    if (day !== null && day > date) return undefined;
  }
  return base;
}

export async function loadPlanInput(query: Query, date: string): Promise<PlanInput> {
  const dayStartMs = localToEpoch(date, 0);
  const minuteOf = (epochMs: number) => Math.round((epochMs - dayStartMs) / 60000);

  const [template, areas, done, tasks, chosen, kept, answers, events] = await Promise.all([
    query<{
      start_min: number;
      duration_min: number;
      kind: string;
      area_id: string | null;
      title: string;
    }>(TEMPLATE_SQL, [isoWeekday(date)]),
    query<{
      id: string;
      name: string;
      kind: string;
      weekly_target_min: number;
      capped: number;
      protected: number;
      priority_rank: number;
      active: number;
    }>(AREAS_SQL),
    query<{ area_id: string; minutes: number }>(DONE_THIS_WEEK_SQL, [weekStart(date), date]),
    query<OpenTaskRow>(OPEN_TASKS_SQL, [date]),
    query<{ task_id: string }>(CHOSEN_TOP_SQL, [date]),
    query<{ id: string; start_at: number; end_at: number; task_id: string | null }>(
      KEPT_BLOCKS_SQL,
      [date],
    ),
    query<{ value_json: string }>(REST_DAY_SQL),
    query<{ summary: string; start_at: number; end_at: number }>(DAY_EVENTS_SQL, [
      localToEpoch(shiftDate(date, 1), DAY_START_MIN),
      localToEpoch(date, DAY_START_MIN),
    ]),
  ]);
  const removed = await query<{ task_id: string }>(REMOVED_TASK_BLOCKS_SQL, [date]);
  const energy = await query<{ energy: number }>(ENERGY_SQL, [
    shiftDate(date, -1),
    shiftDate(date, -2),
  ]);

  let restDay: number | undefined;
  try {
    const parsed: unknown = answers[0] ? JSON.parse(answers[0].value_json) : undefined;
    if (
      parsed &&
      typeof parsed === "object" &&
      "restDay" in parsed &&
      typeof parsed.restDay === "number"
    ) {
      restDay = parsed.restDay;
    }
  } catch {
    restDay = undefined;
  }

  return {
    date,
    // The routine decides: a day with a Rest block is a rest day (My week can
    // move or remove it). Routines from before the editor fall back to the answer.
    isRestDay: template.length
      ? template.some((block) => block.kind === "rest" && block.duration_min >= REST_DAY_MIN)
      : restDay === isoWeekday(date),
    recentEnergy: energy.map((row) => row.energy),
    template: template.map((block) => ({
      startMin: block.start_min,
      durationMin: block.duration_min,
      kind: block.kind as PlanInput["template"][number]["kind"],
      areaId: block.area_id,
      title: block.title,
    })),
    kept: kept.map((block) => ({
      startMin: minuteOf(block.start_at),
      durationMin: minuteOf(block.end_at) - minuteOf(block.start_at),
      taskId: block.task_id,
    })),
    removedTaskIds: removed.map((row) => row.task_id),
    areas: areas.map((area): AreaInput => ({
      id: area.id,
      name: area.name,
      kind: area.kind as AreaInput["kind"],
      weeklyTargetMin: area.weekly_target_min,
      capped: area.capped === 1,
      protected: area.protected === 1,
      priorityRank: area.priority_rank,
      active: area.active === 1,
    })),
    doneThisWeekMin: Object.fromEntries(done.map((row) => [row.area_id, row.minutes])),
    tasks: tasks.flatMap((task) => {
      const planned = taskOnDay(task, date);
      return planned ? [planned] : [];
    }),
    chosenTop: chosen.map((row) => row.task_id),
    // Clipped to the logical day (03:00 to 03:00).
    events: events.map((event) => {
      const start = Math.max(minuteOf(event.start_at), DAY_START_MIN);
      const end = Math.min(minuteOf(event.end_at), DAY_START_MIN + 24 * 60);
      return { startMin: start, durationMin: Math.max(0, end - start), title: event.summary };
    }),
  };
}

/** The writes for a generated day: block inserts and the default top 3. */
export function planOps(
  plan: DayPlan,
  date: string,
  newId: () => string,
  keepUserTop: boolean,
): Op[] {
  const ops: Op[] = plan.blocks.map((block) => ({
    op: "insert",
    table: "day_blocks",
    id: newId(),
    values: {
      logical_date: date,
      start_at: localToEpoch(date, block.startMin),
      end_at: localToEpoch(date, block.startMin + block.durationMin),
      kind: block.kind,
      area_id: block.areaId,
      task_id: block.taskId,
      title: block.title,
      // A task's own block is a generator block too (the schema has no 'task'
      // source yet), so a replan remakes it from the task's current time.
      source: block.kind === "area" ? "generator" : "template",
      light_day: plan.light ? 1 : 0,
    },
  }));
  if (!keepUserTop) {
    plan.top.forEach((taskId, index) => {
      ops.push({
        op: "upsert",
        table: "task_daily_top",
        id: `${date}:${index + 1}`,
        values: { logical_date: date, position: index + 1, task_id: taskId, chosen_by: "default" },
      });
    });
  }
  return ops;
}

/** One plan run per date at a time in this window (React may run effects twice). */
const running = new Map<string, Promise<boolean>>();

/**
 * Makes sure a day has a plan; generates it once if not. Returns true when it
 * wrote one. The day is today (the logical date of `nowMs`) unless `date` names
 * another logical date (YYYY-MM-DD), e.g. a day opened in Plan → Day.
 */
export function ensureDayPlan(
  query: Query,
  transact: (ops: Op[]) => Promise<unknown>,
  nowMs: number,
  newId: () => string,
  date: string = logicalDate(nowMs),
): Promise<boolean> {
  const inFlight = running.get(date);
  if (inFlight) return inFlight.then(() => false);
  const run = planOnce(query, transact, date, newId, nowMs).finally(() => running.delete(date));
  running.set(date, run);
  return run;
}

/** A Rest block this long makes a rest day; a shorter one is just time off. */
export const REST_DAY_MIN = 6 * 60;

/** Today's plan blocks Sirna made and you didn't touch. */
export const STALE_BLOCKS_SQL = `SELECT id FROM day_blocks WHERE logical_date = ? AND deleted_at IS NULL
  AND source IN ('template', 'generator') AND user_edited_at IS NULL`;

/**
 * After the routine changes: a day that already has a plan gets a new one
 * from the new routine. Blocks you added, edited, started or finished stay,
 * and the new plan goes around them; your top-3 choice stays. A day not yet
 * planned is left alone (Today plans it when opened).
 */
export async function replanDay(
  query: Query,
  transact: (ops: Op[]) => Promise<unknown>,
  date: string,
  newId: () => string,
  nowMs?: number,
): Promise<void> {
  const [exists] = await query<{ n: number }>(PLAN_EXISTS_SQL, [date]);
  if ((exists?.n ?? 0) === 0) return;
  const stale = await query<{ id: string }>(STALE_BLOCKS_SQL, [date]);
  const input = startingNow(await loadPlanInput(query, date), nowMs);
  const plan = generateDay(input);
  await transact([
    ...stale.map(({ id }): Op => ({ op: "delete", table: "day_blocks", id })),
    ...planOps(plan, date, newId, true),
  ]);
}

/** On today, a part of the day is filled from now on (the morning may be gone). */
export function startingNow(input: PlanInput, nowMs?: number): PlanInput {
  if (nowMs === undefined || input.date !== logicalDate(nowMs)) return input;
  return {
    ...input,
    notBeforeMin: Math.round((nowMs - localToEpoch(input.date, 0)) / 60000),
  };
}

async function planOnce(
  query: Query,
  transact: (ops: Op[]) => Promise<unknown>,
  date: string,
  newId: () => string,
  nowMs: number,
): Promise<boolean> {
  const [exists] = await query<{ n: number }>(PLAN_EXISTS_SQL, [date]);
  if ((exists?.n ?? 0) > 0) return false;
  const input = startingNow(await loadPlanInput(query, date), nowMs);
  if (input.template.length === 0) return false; // no routine yet (setup not done)
  const plan = generateDay(input);
  await transact(planOps(plan, date, newId, input.chosenTop.length > 0));
  return true;
}
