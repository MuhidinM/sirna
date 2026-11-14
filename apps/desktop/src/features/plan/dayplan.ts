/**
 * Loads what the generator needs, runs it, and saves the day (plan §3.3).
 * The SQL is exported so tests run it against the real schema.
 */
import { type Op, type Row, type SqlValue } from "../../kernel/db";
import { logicalDate } from "../../kernel/dates";
import { localToEpoch } from "../../capture/when";
import { type AreaInput, type DayPlan, generateDay, type PlanInput } from "./generate";

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
  SELECT t.id, t.title, t.area_id, t.due_date, t.created_at,
         CASE WHEN t.estimate_min IS NULL THEN NULL ELSE MAX(0, t.estimate_min - COALESCE((
           SELECT sum(MAX(0, (f.ended_at - f.started_at - f.paused_ms) / 60000))
           FROM focus_sessions f
           WHERE f.task_id = t.id AND f.kind = 'focus' AND f.ended_at IS NOT NULL), 0)) END
           AS remaining_min
  FROM task_items t
  WHERE t.deleted_at IS NULL AND t.status = 'todo'
    -- A task moved to a later day waits for that day (T-050).
    AND (t.planned_date IS NULL OR t.planned_date <= ?)
  ORDER BY t.created_at`;

export const CHOSEN_TOP_SQL =
  "SELECT task_id FROM task_daily_top WHERE logical_date = ? AND chosen_by = 'user' ORDER BY position";

export const KEPT_BLOCKS_SQL = `
  SELECT id, start_at, end_at FROM day_blocks
  WHERE logical_date = ? AND deleted_at IS NULL AND (source = 'user' OR user_edited_at IS NOT NULL)`;

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
    query<{
      id: string;
      title: string;
      area_id: string | null;
      due_date: string | null;
      created_at: number;
      remaining_min: number | null;
    }>(OPEN_TASKS_SQL, [date]),
    query<{ task_id: string }>(CHOSEN_TOP_SQL, [date]),
    query<{ id: string; start_at: number; end_at: number }>(KEPT_BLOCKS_SQL, [date]),
    query<{ value_json: string }>(REST_DAY_SQL),
    query<{ summary: string; start_at: number; end_at: number }>(DAY_EVENTS_SQL, [
      localToEpoch(shiftDate(date, 1), DAY_START_MIN),
      localToEpoch(date, DAY_START_MIN),
    ]),
  ]);
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
    })),
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
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      areaId: task.area_id,
      dueDate: task.due_date,
      createdAt: task.created_at,
      remainingMin: task.remaining_min,
    })),
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

/** Makes sure today has a plan; generates it once if not. Returns true when it wrote one. */
export function ensureDayPlan(
  query: Query,
  transact: (ops: Op[]) => Promise<unknown>,
  nowMs: number,
  newId: () => string,
): Promise<boolean> {
  const date = logicalDate(nowMs);
  const inFlight = running.get(date);
  if (inFlight) return inFlight.then(() => false);
  const run = planOnce(query, transact, nowMs, newId).finally(() => running.delete(date));
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
): Promise<void> {
  const [exists] = await query<{ n: number }>(PLAN_EXISTS_SQL, [date]);
  if ((exists?.n ?? 0) === 0) return;
  const stale = await query<{ id: string }>(STALE_BLOCKS_SQL, [date]);
  const input = await loadPlanInput(query, date);
  const plan = generateDay(input);
  await transact([
    ...stale.map(({ id }): Op => ({ op: "delete", table: "day_blocks", id })),
    ...planOps(plan, date, newId, true),
  ]);
}

async function planOnce(
  query: Query,
  transact: (ops: Op[]) => Promise<unknown>,
  nowMs: number,
  newId: () => string,
): Promise<boolean> {
  const date = logicalDate(nowMs);
  const [exists] = await query<{ n: number }>(PLAN_EXISTS_SQL, [date]);
  if ((exists?.n ?? 0) > 0) return false;
  const input = await loadPlanInput(query, date);
  if (input.template.length === 0) return false; // no routine yet (setup not done)
  const plan = generateDay(input);
  await transact(planOps(plan, date, newId, input.chosenTop.length > 0));
  return true;
}
