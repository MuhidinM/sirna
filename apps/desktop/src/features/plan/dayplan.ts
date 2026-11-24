/**
 * Loads what the generator needs, runs it, and saves the day (plan §3.3).
 * The SQL is exported so tests run it against the real schema.
 */
import { type Op, type Row, type SqlValue } from "../../kernel/db";
import { logicalDate } from "../../kernel/dates";
import { localToEpoch } from "../../capture/when";
import { type PlannedProject, runsIn } from "../projects/capacity";
import { AWAY_SQL, awayUntil } from "./away";
import {
  carriedInput,
  fromNow,
  isoWeekday,
  type PreviewBlock,
  runChain,
  type SavedDay,
  shiftDate,
  weekStart,
} from "./carry";
import {
  type AreaInput,
  cut,
  type DayPlan,
  type DayWindow,
  generateDay,
  hasEstimate,
  type KeptBlock,
  MIN_BLOCK_MIN,
  type PlannedBlock,
  type PlanInput,
  type TaskInput,
  type TemplateBlock,
  WINDOWS,
} from "./generate";

export type Query = <T extends Row>(sql: string, params?: SqlValue[]) => Promise<T[]>;

/** The logical day starts at 03:00 (rule 4). */
const DAY_START_MIN = 180;

export { isoWeekday, shiftDate, weekStart };

export const PLAN_EXISTS_SQL =
  "SELECT count(*) AS n FROM day_blocks WHERE logical_date = ? AND deleted_at IS NULL";

export const TEMPLATE_SQL = `
  SELECT start_min, duration_min, kind, area_id, title FROM routine_blocks
  WHERE weekday = ? AND active = 1 AND deleted_at IS NULL ORDER BY start_min`;

/** Projects with weekly hours and an area: their hours add to the area's target (plan §3.8). */
export const PROJECT_TIME_SQL = `
  SELECT id, status, weekly_min, start_date, forecast_finish, area_id FROM project_items
  WHERE deleted_at IS NULL AND area_id IS NOT NULL AND weekly_min > 0`;

export const AREAS_SQL = `
  SELECT id, name, kind, weekly_target_min, capped, protected, priority_rank, active
  FROM area_items WHERE deleted_at IS NULL`;

/**
 * Minutes done per area from Monday up to (not including) today: a block
 * marked done counts in full, any other block counts the focus time on it
 * (up to its length). Focus started "For" an area, with no block, counts
 * too, as on the Week card (the logical day starts 03:00 Addis = 00:00 UTC,
 * so a session's logical date is its UTC date). ?1/?3 = Monday, ?2/?4 = today.
 */
export const DONE_THIS_WEEK_SQL = `
  SELECT area_id, SUM(minutes) AS minutes FROM (
    SELECT area_id, CASE WHEN status = 'done' THEN length ELSE MIN(length, focused) END AS minutes
    FROM (
      SELECT b.area_id, b.status, (b.end_at - b.start_at) / 60000 AS length,
             COALESCE((SELECT SUM(MAX(0, (f.ended_at - f.started_at - f.paused_ms) / 60000))
                       FROM focus_sessions f
                       WHERE f.block_id = b.id AND f.kind = 'focus' AND f.ended_at IS NOT NULL), 0)
               AS focused
      FROM day_blocks b
      WHERE b.deleted_at IS NULL AND b.area_id IS NOT NULL
        AND b.logical_date >= ? AND b.logical_date < ?)
    UNION ALL
    SELECT f.area_id, MAX(0, (f.ended_at - f.started_at - f.paused_ms) / 60000)
    FROM focus_sessions f
    WHERE f.kind = 'focus' AND f.ended_at IS NOT NULL
      AND f.block_id IS NULL AND f.area_id IS NOT NULL
      AND date(f.started_at / 1000, 'unixepoch') >= ?
      AND date(f.started_at / 1000, 'unixepoch') < ?)
  GROUP BY area_id
  HAVING minutes > 0`;

/** Open tasks, with what is left of their estimate after focus time on them. */
export const OPEN_TASKS_SQL = `
  SELECT t.id, t.title, t.area_id, t.created_at, t.due_at, t.planned_window, t.planned_date,
         t.estimate_min, t.parent_id, t.step_no,
         -- A later step of a split task: planned after the steps before it.
         EXISTS (SELECT 1 FROM task_items AS before_step
                 WHERE before_step.parent_id = t.parent_id AND before_step.step_no < t.step_no
                   AND before_step.status = 'todo' AND before_step.deleted_at IS NULL) AS waits,
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
    -- A later step waits while a step before it is blocked (T-051); steps
    -- still to do are planned in order on the calendar.
    AND NOT EXISTS (
      SELECT 1 FROM task_items AS before_step
      WHERE before_step.parent_id = t.parent_id AND before_step.step_no < t.step_no
        AND before_step.status = 'waiting' AND before_step.deleted_at IS NULL)
  ORDER BY t.created_at`;

export const CHOSEN_TOP_SQL =
  "SELECT task_id FROM task_daily_top WHERE logical_date = ? AND chosen_by = 'user' ORDER BY position";

/**
 * Blocks a replan keeps and plans around: yours, ones you edited, and ones a
 * focus session ran in (a capture heals today's plan mid-session).
 */
export const KEPT_BLOCKS_SQL = `
  SELECT id, start_at, end_at, task_id, title, kind, area_id FROM day_blocks
  WHERE logical_date = ? AND deleted_at IS NULL
    AND (source = 'user' OR user_edited_at IS NOT NULL
      OR EXISTS (SELECT 1 FROM focus_sessions f WHERE f.block_id = day_blocks.id))`;

/**
 * Tasks whose own block you deleted on this day after touching it (user_edited_at
 * set; the planner's own clean-up skips such blocks): not made again.
 */
export const REMOVED_TASK_BLOCKS_SQL = `
  SELECT DISTINCT b.task_id FROM day_blocks b
  JOIN task_items t ON t.id = b.task_id AND t.title = b.title
  WHERE b.logical_date = ? AND b.deleted_at IS NOT NULL AND b.user_edited_at IS NOT NULL`;

/**
 * Other planner blocks you deleted on this day (the board stamps
 * user_edited_at before it deletes): the planner leaves their time empty and
 * doesn't copy a routine block of the same name again. A task's own block is
 * handled by REMOVED_TASK_BLOCKS_SQL.
 */
export const REMOVED_BLOCKS_SQL = `
  SELECT b.start_at, b.end_at, b.kind, b.title FROM day_blocks b
  WHERE b.logical_date = ? AND b.deleted_at IS NOT NULL AND b.user_edited_at IS NOT NULL
    AND b.source IN ('template', 'generator')
    AND NOT EXISTS (SELECT 1 FROM task_items t WHERE t.id = b.task_id AND t.title = b.title)`;

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
  parent_id?: string | null;
  step_no?: number | null;
  /** 1 when a step before it is still to do. */
  waits?: number | null;
};

const WINDOW_NAMES = new Set<string>(["morning", "afternoon", "evening"]);

/**
 * An open task as the planner sees it on `date` (time first, rules 1 and 2):
 * timed on that day → its minute; a part of that day → its window; set for a
 * later day → not today (undefined). A time or window on a day already gone
 * is forgotten, so the task is planned like any other; a time still to come
 * (`nowMs`) on an earlier day keeps it there, off later days (reg1-3).
 */
export function taskOnDay(task: OpenTaskRow, date: string, nowMs?: number): TaskInput | undefined {
  const base: TaskInput = {
    id: task.id,
    title: task.title,
    areaId: task.area_id,
    dueDate: task.due_date,
    createdAt: task.created_at,
    remainingMin: task.remaining_min,
    ...(task.parent_id && task.step_no !== null && task.step_no !== undefined
      ? { step: { parentId: task.parent_id, no: task.step_no, waits: task.waits === 1 } }
      : {}),
    estimateMin: task.estimate_min,
  };
  if (task.due_at !== null) {
    const timedDay = logicalDate(task.due_at);
    // A move to another day (planned_date) outranks the old time.
    const day = task.planned_date ?? timedDay;
    if (day === date && timedDay === date)
      return { ...base, atMin: Math.round((task.due_at - localToEpoch(date, 0)) / 60000) };
    if (day > date) return undefined;
    if (nowMs !== undefined && task.due_at > nowMs && day === timedDay) return undefined;
    return base;
  }
  if (task.planned_window && WINDOW_NAMES.has(task.planned_window)) {
    const day = task.planned_date ?? task.due_date;
    if (day === date) return { ...base, window: task.planned_window as DayWindow };
    if (day !== null && day > date) return undefined;
  }
  return base;
}

type KeptRow = {
  id: string;
  start_at: number;
  end_at: number;
  task_id: string | null;
  title: string;
  kind: string;
  area_id?: string | null;
  light_day?: number;
};

function keptOf(block: KeptRow, minuteOf: (epochMs: number) => number): KeptBlock {
  return {
    startMin: minuteOf(block.start_at),
    durationMin: minuteOf(block.end_at) - minuteOf(block.start_at),
    taskId: block.task_id,
    title: block.title,
    kind: block.kind as TemplateBlock["kind"],
    areaId: block.area_id ?? null,
  };
}

/**
 * What the generator needs for `date`, on its own. `nowMs` keeps a task whose
 * time is still to come on its own day. A day after today is planned after
 * the days before it: `chainedInput`.
 */
export async function loadPlanInput(
  query: Query,
  date: string,
  nowMs?: number,
): Promise<PlanInput> {
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
    query<{ area_id: string; minutes: number }>(DONE_THIS_WEEK_SQL, [
      weekStart(date),
      date,
      weekStart(date),
      date,
    ]),
    query<OpenTaskRow>(OPEN_TASKS_SQL, [date]),
    query<{ task_id: string }>(CHOSEN_TOP_SQL, [date]),
    query<KeptRow>(KEPT_BLOCKS_SQL, [date]),
    query<{ value_json: string }>(REST_DAY_SQL),
    query<{ summary: string; start_at: number; end_at: number }>(DAY_EVENTS_SQL, [
      localToEpoch(shiftDate(date, 1), DAY_START_MIN),
      localToEpoch(date, DAY_START_MIN),
    ]),
  ]);
  const projects = await query<PlannedProject & { area_id: string } & Row>(PROJECT_TIME_SQL);
  /** Weekly minutes of the projects running this week, per area. */
  const projectMin = new Map<string, number>();
  for (const project of projects)
    if (runsIn(project, weekStart(date)))
      projectMin.set(
        project.area_id,
        (projectMin.get(project.area_id) ?? 0) + (project.weekly_min ?? 0),
      );
  const removed = await query<{ task_id: string }>(REMOVED_TASK_BLOCKS_SQL, [date]);
  const removedBlocks = await query<{
    start_at: number;
    end_at: number;
    kind: string;
    title: string;
  }>(REMOVED_BLOCKS_SQL, [date]);
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
    kept: kept.map((block) => keptOf(block, minuteOf)),
    removedTaskIds: removed.map((row) => row.task_id),
    removedBlocks: removedBlocks.map((block) => ({
      startMin: minuteOf(block.start_at),
      durationMin: minuteOf(block.end_at) - minuteOf(block.start_at),
      kind: block.kind as PlanInput["template"][number]["kind"],
      title: block.title,
    })),
    // A running project's weekly hours are its area's time too, so the
    // planner gives them slots (an area switched off still gets them).
    areas: areas.map((area): AreaInput => {
      const extra = projectMin.get(area.id) ?? 0;
      return {
        id: area.id,
        name: area.name,
        kind: area.kind as AreaInput["kind"],
        weeklyTargetMin: area.weekly_target_min + extra,
        capped: area.capped === 1,
        protected: area.protected === 1,
        priorityRank: area.priority_rank,
        active: area.active === 1 || extra > 0,
      };
    }),
    doneThisWeekMin: Object.fromEntries(done.map((row) => [row.area_id, row.minutes])),
    tasks: tasks.flatMap((task) => {
      const planned = taskOnDay(task, date, nowMs);
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
      // A task's own block is stored as a generator block with task_id set
      // (the schema has no 'task' source), so a replan remakes it from the
      // task's current time.
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
 * Makes sure a day has a plan; generates it once if not. A day already planned
 * heals itself: a task with a time or a part of that day that has no block
 * there (captured after the day was planned, or its time changed) gets the
 * day planned again around your edits (`healDay`). Returns true when it wrote.
 * The day is today (the logical date of `nowMs`) unless `date` names another
 * logical date (YYYY-MM-DD), e.g. a day opened in Plan → Day.
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

/** True when `date` falls before the away return day (`away till mon`). */
export async function isAwayOn(query: Query, date: string): Promise<boolean> {
  const [row] = await query<{ value_json: string }>(AWAY_SQL).catch(() => []);
  return awayUntil(row?.value_json, date) !== undefined;
}

/** A Rest block this long makes a rest day; a shorter one is just time off. */
export const REST_DAY_MIN = 6 * 60;

/** Today's plan blocks Sirna made and you didn't touch. */
export const STALE_BLOCKS_SQL = `SELECT id, start_at, end_at, task_id, title, kind, area_id, light_day
  FROM day_blocks WHERE logical_date = ? AND deleted_at IS NULL
  AND source IN ('template', 'generator') AND user_edited_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM focus_sessions f WHERE f.block_id = day_blocks.id)`;

/**
 * What a replan of `date` starts from: the planner's input (today from now on)
 * and the untouched blocks it replaces. On today, a block already over stays
 * as it was (the planner can't place it again in time gone) and counts as kept.
 */
async function replanInput(
  query: Query,
  date: string,
  nowMs?: number,
): Promise<{ input: PlanInput; stale: KeptRow[] }> {
  const loaded = startingNow(await chainedInput(query, date, nowMs), nowMs);
  const untouched = await query<KeptRow>(STALE_BLOCKS_SQL, [date]);
  if (loaded.notBeforeMin === undefined || nowMs === undefined)
    return { input: loaded, stale: untouched };
  const dayStartMs = localToEpoch(date, 0);
  const minuteOf = (epochMs: number) => Math.round((epochMs - dayStartMs) / 60000);
  const past = untouched
    .filter((block) => block.end_at <= nowMs)
    .map((block) => {
      const kept = keptOf(block, minuteOf);
      const task = loaded.tasks.find((t) => t.id === block.task_id);
      // A task's own block holds it for the day, unless its time moved since;
      // a focus block's task may still get time in a later slot.
      const holds =
        task !== undefined &&
        block.title === task.title &&
        (task.atMin === null || task.atMin === undefined || task.atMin === kept.startMin);
      return holds ? kept : { ...kept, taskId: null };
    });
  return {
    input: { ...loaded, kept: [...loaded.kept, ...past] },
    stale: untouched.filter((block) => block.end_at > nowMs),
  };
}

/**
 * After the routine changes: a day that already has a plan gets a new one
 * from the new routine. Blocks you added, edited, started or finished stay,
 * and the new plan goes around them; your top-3 choice stays. On today, blocks
 * already over stay too. A day not yet planned is left alone (Today plans it
 * when opened).
 */
export async function replanDay(
  query: Query,
  transact: (ops: Op[]) => Promise<unknown>,
  date: string,
  newId: () => string,
  nowMs?: number,
  /** Write the default top 3 again (unless you chose one): a light day changed. */
  freshTop = false,
): Promise<void> {
  const [exists] = await query<{ n: number }>(PLAN_EXISTS_SQL, [date]);
  if ((exists?.n ?? 0) === 0) return;
  const { input, stale } = await replanInput(query, date, nowMs);
  const plan = generateDay(input);
  await transact([
    ...stale.map(({ id }): Op => ({ op: "delete", table: "day_blocks", id })),
    ...planOps(plan, date, newId, !freshTop || input.chosenTop.length > 0),
    ...(freshTop && input.chosenTop.length === 0 ? await extraTopOps(query, date, plan) : []),
  ]);
}

/** The day's default top-3 rows past the plan's top (a light day keeps one). */
async function extraTopOps(query: Query, date: string, plan: DayPlan): Promise<Op[]> {
  const rows = await query<{ id: string; position: number }>(
    "SELECT id, position FROM task_daily_top WHERE logical_date = ?",
    [date],
  );
  return rows
    .filter((row) => row.position > plan.top.length)
    .map((row): Op => ({ op: "delete", table: "task_daily_top", id: row.id }));
}

/**
 * After you move a block by a command ("move gym to 6pm"): the planner's
 * focus blocks it now sits on, untouched and still to come, move out of its
 * way into the day's free time (`bumpOps`); every other block stays as it
 * was (F15, reg1-4). Returns the ops that undo the moves, or null when
 * nothing was in the way. A drag on the board doesn't call this: there you
 * place it yourself.
 */
export async function replanAround(
  query: Query,
  transact: (ops: Op[]) => Promise<unknown>,
  date: string,
  blockId: string,
  _newId: () => string,
  nowMs: number,
): Promise<Op[] | null> {
  const live = await query<LiveRow>(LIVE_BLOCKS_SQL, [date]);
  const moved = live.find((row) => row.id === blockId);
  if (!moved) return null;
  const untouched = new Set(
    (await query<KeptRow>(STALE_BLOCKS_SQL, [date]))
      .filter((block) => block.end_at > nowMs)
      .map((block) => block.id),
  );
  const slots = (
    await query<{ start_min: number; duration_min: number; kind: string }>(TEMPLATE_SQL, [
      isoWeekday(date),
    ])
  )
    .filter((block) => block.kind === "area")
    .map((block) => ({
      start_at: localToEpoch(date, block.start_min),
      end_at: localToEpoch(date, block.start_min + block.duration_min),
    }));
  const bump = bumpOps(date, moved, live, untouched, slots, nowMs);
  if (!bump) return null;
  await transact(bump.ops);
  return bump.undo;
}

const QUARTER_MS = 15 * 60_000;

/**
 * Moves the untouched focus blocks that overlap `moved` into the first free
 * time in the day's free slots (the routine's focus time) nearest their old
 * start, later first: whole if they fit, else the longest piece of at least
 * 25 minutes; a block with no room left goes. Pure; null when nothing
 * overlaps. `undo` puts each block back where it was.
 */
export function bumpOps(
  date: string,
  moved: { id: string; start_at: number; end_at: number },
  live: LiveRow[],
  untouched: ReadonlySet<string>,
  slots: { start_at: number; end_at: number }[],
  nowMs: number,
): { ops: Op[]; undo: Op[] } | null {
  const overlaps = (a: { start_at: number; end_at: number }, b: typeof a) =>
    a.start_at < b.end_at && b.start_at < a.end_at;
  const inTheWay = live
    .filter(
      (row) =>
        row.id !== moved.id && row.kind === "area" && untouched.has(row.id) && overlaps(row, moved),
    )
    .sort((a, b) => a.start_at - b.start_at);
  if (inTheWay.length === 0) return null;
  const busy = live.filter((row) => !inTheWay.includes(row));
  const ops: Op[] = [];
  const undo: Op[] = [];
  for (const block of inTheWay) {
    const length = block.end_at - block.start_at;
    const gaps = slots.flatMap((slot) => {
      let pieces = [{ start: Math.max(slot.start_at, nowMs), end: slot.end_at }];
      for (const taken of busy)
        pieces = pieces.flatMap((piece) =>
          taken.end_at <= piece.start || taken.start_at >= piece.end
            ? [piece]
            : [
                { start: piece.start, end: Math.max(piece.start, taken.start_at) },
                { start: Math.min(piece.end, taken.end_at), end: piece.end },
              ],
        );
      return pieces
        .map((piece) => ({
          start: Math.ceil(piece.start / QUARTER_MS) * QUARTER_MS,
          end: piece.end,
        }))
        .filter((piece) => piece.end - piece.start >= MIN_BLOCK_MIN * 60_000);
    });
    const distance = (start: number) =>
      Math.abs(start - block.start_at) + (start < block.start_at ? 1 : 0);
    const whole = gaps
      .filter((gap) => gap.end - gap.start >= length)
      .sort((a, b) => distance(a.start) - distance(b.start))[0];
    const piece =
      whole ??
      [...gaps].sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start)[0];
    const back: Op = {
      op: "upsert",
      table: "day_blocks",
      id: block.id,
      values: {
        logical_date: date,
        start_at: block.start_at,
        end_at: block.end_at,
        task_id: block.task_id,
        title: block.title,
        kind: block.kind,
        area_id: block.area_id ?? null,
        light_day: block.light_day ?? 0,
      },
    };
    if (!piece) {
      ops.push({ op: "delete", table: "day_blocks", id: block.id });
      undo.push(back);
      continue;
    }
    const start = piece.start;
    const end = Math.min(piece.end, start + length);
    ops.push({
      op: "update",
      table: "day_blocks",
      id: block.id,
      values: { start_at: start, end_at: end },
    });
    undo.push(back);
    busy.push({ ...block, start_at: start, end_at: end });
  }
  return { ops, undo };
}

/**
 * The undo `replanAround` gave, as it stands now: a block it moved that you
 * have since moved or focused in is yours and stays. Run the result as the
 * system, not as you, so the blocks it puts back stay untouched planner
 * blocks that heals and replans may still change.
 */
export async function replanUndoOps(query: Query, undo: Op[]): Promise<Op[]> {
  const ids = undo.map((op) => op.id);
  if (ids.length === 0) return undo;
  const kept = new Set(
    (
      await query<{ id: string }>(
        `SELECT id FROM day_blocks WHERE id IN (${ids.map(() => "?").join(", ")})
          AND (user_edited_at IS NOT NULL
            OR EXISTS (SELECT 1 FROM focus_sessions f WHERE f.block_id = day_blocks.id))`,
        ids,
      )
    ).map((row) => row.id),
  );
  return undo.filter((op) => !kept.has(op.id));
}

/** Days from today on that have a plan. */
export const PLANNED_FROM_SQL = `
  SELECT DISTINCT logical_date FROM day_blocks
  WHERE deleted_at IS NULL AND logical_date >= ? ORDER BY logical_date`;

/**
 * After the routine changes: every day from today on that already has a plan
 * gets a new one (`replanDay`; today keeps the blocks already over).
 */
export async function replanFromToday(
  query: Query,
  transact: (ops: Op[]) => Promise<unknown>,
  nowMs: number,
  newId: () => string,
): Promise<void> {
  const today = logicalDate(nowMs);
  const days = await query<{ logical_date: string }>(PLANNED_FROM_SQL, [today]);
  for (const { logical_date: date } of days) await replanDay(query, transact, date, newId, nowMs);
}

/** On today, a part of the day is filled from now on (the morning may be gone). */
export function startingNow(input: PlanInput, nowMs?: number): PlanInput {
  if (nowMs === undefined || input.date !== logicalDate(nowMs)) return input;
  return {
    ...input,
    notBeforeMin: Math.round((nowMs - localToEpoch(input.date, 0)) / 60000),
  };
}

/** A day's live blocks that hold a task. */
export const DAY_TASK_BLOCKS_SQL = `
  SELECT task_id, start_at, title FROM day_blocks
  WHERE logical_date = ? AND deleted_at IS NULL AND task_id IS NOT NULL`;

/**
 * The tasks with a time or a part of the day whose own block the planner
 * would make but the saved day doesn't have: none at all, one at another time
 * (a timed task), or one outside its window. Pure; empty means the day is fine,
 * so healing a day twice writes nothing the second time.
 */
export function missingTaskBlocks(
  plan: DayPlan,
  input: PlanInput,
  existing: { task_id: string; start_at: number; title: string }[],
): string[] {
  const asked = new Map(
    input.tasks
      .filter((task) => (task.atMin !== null && task.atMin !== undefined) || task.window)
      .map((task) => [task.id, task]),
  );
  const at = (minutes: number) => localToEpoch(input.date, minutes);
  return plan.blocks.flatMap((block) => {
    const task = block.fromTask && block.taskId ? asked.get(block.taskId) : undefined;
    if (!task) return [];
    const has = existing.some((row) => {
      if (row.task_id !== task.id || row.title !== block.title) return false;
      if (task.atMin !== null && task.atMin !== undefined)
        return row.start_at === at(block.startMin);
      const window = task.window ? WINDOWS[task.window] : undefined;
      return !window || (row.start_at >= at(window.startMin) && row.start_at < at(window.endMin));
    });
    return has ? [] : [task.id];
  });
}

/**
 * A planned day whose timed or windowed tasks lack their blocks heals. When
 * the missing blocks fit beside the saved day (no focus block in their way),
 * only they are added (and a task's old untouched block at the wrong time
 * goes); otherwise the day is planned again (`replanDay`: your edits and, on
 * today, blocks already over stay). Returns true when it wrote.
 */
export async function healDay(
  query: Query,
  transact: (ops: Op[]) => Promise<unknown>,
  date: string,
  newId: () => string,
  nowMs?: number,
): Promise<boolean> {
  const { input, stale } = await replanInput(query, date, nowMs);
  if (input.template.length === 0) return false;
  const orphans = orphanOps(input, stale);
  const plan = generateDay(input);
  // Energy saved after the day was planned (the night review) made it light,
  // or no longer light: the untouched blocks are planned again (F53), with
  // the top three set afresh.
  const flipped = stale.some((block) => (block.light_day ?? 0) !== (plan.light ? 1 : 0));
  if (orphans.refill || flipped) {
    await replanDay(query, transact, date, newId, nowMs, flipped);
    return true;
  }
  const existing = await query<{ task_id: string; start_at: number; title: string }>(
    DAY_TASK_BLOCKS_SQL,
    [date],
  );
  const missing = missingTaskBlocks(plan, input, existing);
  if (missing.length === 0) {
    if (orphans.ops.length === 0) return false;
    await transact(orphans.ops);
    return true;
  }
  const live = (await query<LiveRow>(LIVE_BLOCKS_SQL, [date])).filter(
    (row) => !orphans.dropped.has(row.id),
  );
  const quick = healOps(plan, input, missing, date, newId, live, stale);
  if (quick) await transact([...orphans.ops, ...quick]);
  else await replanDay(query, transact, date, newId, nowMs);
  return true;
}

/**
 * Untouched blocks whose task changed since the day was planned (finished,
 * dropped, deleted, moved to another day or area, renamed, lost its time):
 * a task's own block that the planner wouldn't make any more goes; a renamed
 * task's block takes the new name; a focus slot that lost its task makes the
 * day planned again (`refill`), so the slot gets the area's next task. Pure;
 * a day already in step gives nothing, so healing twice writes once.
 */
export function orphanOps(
  input: PlanInput,
  stale: {
    id: string;
    task_id: string | null;
    title: string;
    kind: string;
    area_id?: string | null;
  }[],
): { ops: Op[]; dropped: Set<string>; refill: boolean } {
  const tasks = new Map(input.tasks.map((task) => [task.id, task]));
  const areas = new Map(input.areas.map((area) => [area.id, area]));
  const ops: Op[] = [];
  const dropped = new Set<string>();
  let refill = false;
  const drop = (id: string) => {
    ops.push({ op: "delete", table: "day_blocks", id });
    dropped.add(id);
  };
  const retitle = (id: string, title: string) =>
    ops.push({ op: "update", table: "day_blocks", id, values: { title } });
  for (const block of stale) {
    if (block.task_id === null) continue;
    const task = tasks.get(block.task_id);
    const area = block.area_id ? areas.get(block.area_id) : undefined;
    const timed = task !== undefined && ((task.atMin ?? null) !== null || !!task.window);
    // A focus slot ("Coding skills: …") that holds a task, not the task's own
    // block. Told apart by more than the area's name, which may have changed
    // since: the planner gives a task with an area a block of its own only
    // for a time or a part of the day, so an untimed one is in a slot.
    const slot =
      block.kind === "area" &&
      !!block.area_id &&
      block.title !== task?.title &&
      ((area !== undefined && block.title.startsWith(`${area.name}: `)) ||
        (task !== undefined && !timed) ||
        (task === undefined && block.title.includes(": ")));
    if (slot) {
      if (!task || timed || task.areaId !== block.area_id) {
        drop(block.id);
        refill = true;
      } else if (area && block.title !== `${area.name}: ${task.title}`)
        retitle(block.id, `${area.name}: ${task.title}`);
      continue;
    }
    if (!task) drop(block.id);
    else if (timed)
      continue; // `missingTaskBlocks` moves it
    else if (task.areaId !== null || !hasEstimate(task)) drop(block.id);
    else if (block.title !== task.title) retitle(block.id, task.title);
  }
  return { ops, dropped, refill };
}

/** A day's live blocks, for `healOps`. */
export const LIVE_BLOCKS_SQL = `SELECT id, start_at, end_at, kind, task_id, title, area_id, light_day
  FROM day_blocks WHERE logical_date = ? AND deleted_at IS NULL`;

type LiveRow = {
  id: string;
  start_at: number;
  end_at: number;
  kind: string;
  task_id: string | null;
  title: string;
  area_id?: string | null;
  light_day?: number;
};

/**
 * The writes that add only the missing tasks' own blocks. A focus slot the
 * planner made and you didn't touch gives up the new block's time and keeps
 * the rest (time first, rule 1: a task takes its time out of focus slots), so
 * nothing else on the day moves. Null when a slot you edited or focused in is
 * in the way (a full replan then plans around it). A task's old own block
 * that the planner made and you didn't touch is removed.
 */
export function healOps(
  plan: DayPlan,
  input: PlanInput,
  missing: string[],
  date: string,
  newId: () => string,
  live: LiveRow[],
  stale: { id: string }[],
): Op[] | null {
  const untouched = new Set(stale.map((block) => block.id));
  const wanted = new Set(missing);
  const adds: PlannedBlock[] = plan.blocks.filter(
    (block) => block.fromTask && block.taskId !== null && wanted.has(block.taskId),
  );
  const replaced = live.filter(
    (row) => row.task_id !== null && wanted.has(row.task_id) && untouched.has(row.id),
  );
  const gone = new Set(replaced.map((row) => row.id));
  const dayStart = localToEpoch(input.date, 0);
  const at = (minutes: number) => localToEpoch(input.date, minutes);
  const minuteOf = (ms: number) => Math.round((ms - dayStart) / 60000);
  const titles = new Map(input.tasks.map((task) => [task.id, task.title]));
  // A task's own block may sit beside another one; only focus slots give way.
  const ownBlock = (row: LiveRow) => row.task_id !== null && titles.get(row.task_id) === row.title;
  /** What is left of each focus slot a new block cuts into. */
  const cuts = new Map<
    string,
    { row: LiveRow; pieces: { startMin: number; durationMin: number }[] }
  >();
  for (const block of adds) {
    const start = at(block.startMin);
    const end = at(block.startMin + block.durationMin);
    // The same title at the same minute is one block (the database allows one).
    const clash = live.some(
      (row) => !gone.has(row.id) && row.title === block.title && row.start_at === start,
    );
    if (clash) return null;
    for (const row of live) {
      if (gone.has(row.id) || row.kind !== "area" || ownBlock(row)) continue;
      if (!(row.start_at < end && start < row.end_at)) continue;
      if (!untouched.has(row.id)) return null;
      const entry = cuts.get(row.id) ?? {
        row,
        pieces: [
          {
            startMin: minuteOf(row.start_at),
            durationMin: minuteOf(row.end_at) - minuteOf(row.start_at),
          },
        ],
      };
      entry.pieces = entry.pieces.flatMap((piece) => cut(piece, [block]));
      cuts.set(row.id, entry);
    }
  }
  const trims: Op[] = [...cuts.values()].flatMap(({ row, pieces }): Op[] => {
    const [first, ...rest] = pieces.filter((piece) => piece.durationMin >= MIN_BLOCK_MIN);
    if (!first) return [{ op: "delete", table: "day_blocks", id: row.id }];
    return [
      {
        op: "update",
        table: "day_blocks",
        id: row.id,
        values: { start_at: at(first.startMin), end_at: at(first.startMin + first.durationMin) },
      },
      ...rest.map((piece): Op => ({
        op: "insert",
        table: "day_blocks",
        id: newId(),
        values: {
          logical_date: date,
          start_at: at(piece.startMin),
          end_at: at(piece.startMin + piece.durationMin),
          kind: row.kind,
          area_id: row.area_id ?? null,
          task_id: row.task_id,
          title: row.title,
          source: "generator",
          light_day: row.light_day ?? 0,
        },
      })),
    ];
  });
  return [
    ...replaced.map(({ id }): Op => ({ op: "delete", table: "day_blocks", id })),
    ...trims,
    ...planOps({ ...plan, blocks: adds }, date, newId, true),
  ];
}

/** Planned days from today on (a week ahead at most), for `healPlans`. */
export const PLANNED_DAYS_SQL = `
  SELECT DISTINCT logical_date FROM day_blocks
  WHERE deleted_at IS NULL AND logical_date BETWEEN ? AND ? ORDER BY logical_date`;

/**
 * Heals every planned day from today to a week ahead (after captures, and
 * when the window opens). Returns the dates it planned again.
 */
export async function healPlans(
  query: Query,
  transact: (ops: Op[]) => Promise<unknown>,
  nowMs: number,
  newId: () => string,
): Promise<string[]> {
  const today = logicalDate(nowMs);
  const days = await query<{ logical_date: string }>(PLANNED_DAYS_SQL, [
    today,
    shiftDate(today, 7),
  ]);
  const healed: string[] = [];
  for (const { logical_date: date } of days) {
    if (await ensureDayPlan(query, transact, nowMs, newId, date)) healed.push(date);
  }
  return healed;
}

async function planOnce(
  query: Query,
  transact: (ops: Op[]) => Promise<unknown>,
  date: string,
  newId: () => string,
  nowMs: number,
): Promise<boolean> {
  // Away days get no plan, and a plan made before stays as it was (plan
  // §3.11): you come back to a fresh plan, not one made while you were gone.
  if (await isAwayOn(query, date)) return false;
  const [exists] = await query<{ n: number }>(PLAN_EXISTS_SQL, [date]);
  // A day already gone stays as it was.
  if ((exists?.n ?? 0) > 0)
    return date < logicalDate(nowMs) ? false : healDay(query, transact, date, newId, nowMs);
  const input = startingNow(await chainedInput(query, date, nowMs), nowMs);
  if (input.template.length === 0) return false; // no routine yet (setup not done)
  const plan = generateDay(input);
  await transact(planOps(plan, date, newId, input.chosenTop.length > 0));
  return true;
}

/** Days a chain looks back over before the day it plans. */
export const CHAIN_DAYS = 7;

/** Saved blocks of a range of days, for `savedDays`. */
export const SAVED_BLOCKS_SQL = `
  SELECT b.logical_date, b.start_at, b.end_at, b.kind, b.area_id, b.task_id, b.title,
         b.light_day, b.status,
         EXISTS (SELECT 1 FROM focus_sessions f WHERE f.block_id = b.id) AS focused
  FROM day_blocks b
  WHERE b.deleted_at IS NULL AND b.logical_date BETWEEN ? AND ?
  ORDER BY b.logical_date, b.start_at`;

export type SavedRow = {
  logical_date: string;
  start_at: number;
  end_at: number;
  kind: string;
  area_id: string | null;
  task_id: string | null;
  title: string;
  light_day: number;
  status: string;
  focused: number;
};

/**
 * The days that have a plan, as the chain sees them: the blocks still to
 * come that are not finished, skipped or moved and have no focus in them
 * (focus time is in a task's remaining minutes already). A block missed
 * earlier today gave its task nothing, so it doesn't count (F18). Pure.
 */
export function savedDays(rows: SavedRow[], nowMs: number): Map<string, SavedDay> {
  const days = new Map<string, SavedDay>();
  for (const row of rows) {
    const day = days.get(row.logical_date) ?? { light: false, blocks: [], booked: [] };
    days.set(row.logical_date, day);
    if (row.light_day === 1) day.light = true;
    if (["done", "skipped", "moved"].includes(row.status) || row.end_at <= nowMs) continue;
    if (row.focused === 1) continue;
    const durationMin = Math.round((row.end_at - row.start_at) / 60000);
    const focus = row.kind === "area";
    day.booked.push({ areaId: focus ? row.area_id : null, taskId: row.task_id, durationMin });
    if (focus) {
      const block: PreviewBlock = {
        startMin: Math.round((row.start_at - localToEpoch(row.logical_date, 0)) / 60000),
        durationMin,
        areaId: row.area_id,
        title: row.title,
        taskId: row.task_id,
      };
      day.blocks.push(block);
    }
  }
  return days;
}

/**
 * The inputs of the days from `from` to `to` (today from now on), the away
 * days and the days already saved: what `runChain` needs.
 */
export async function loadChain(
  query: Query,
  from: string,
  to: string,
  nowMs: number,
): Promise<{ inputs: PlanInput[]; away: Set<string>; saved: Map<string, SavedDay> }> {
  const today = logicalDate(nowMs);
  const inputs: PlanInput[] = [];
  const away = new Set<string>();
  for (let date = from; date <= to; date = shiftDate(date, 1)) {
    const input = await loadPlanInput(query, date, nowMs);
    inputs.push(
      date === today
        ? fromNow(input, Math.round((nowMs - localToEpoch(today, 0)) / 60_000))
        : input,
    );
    if (await isAwayOn(query, date)) away.add(date);
  }
  const rows = await query<SavedRow>(SAVED_BLOCKS_SQL, [from, to]);
  return { inputs, away, saved: savedDays(rows, nowMs) };
}

/**
 * What the generator needs for `date`, planned after the days before it, as
 * Next 7 days forecasts it (F18, reg1-1, reg1-2): a task's time on earlier
 * days (saved, or as they would be planned) comes off what it still needs,
 * and their focus time counts toward the week's area targets. So a 1-hour
 * task is planned once, whichever day you open first.
 */
export async function chainedInput(query: Query, date: string, nowMs?: number): Promise<PlanInput> {
  const own = await loadPlanInput(query, date, nowMs);
  if (nowMs === undefined) return own;
  const today = logicalDate(nowMs);
  if (date <= today) return own;
  const back = shiftDate(date, -CHAIN_DAYS);
  const { inputs, away, saved } = await loadChain(
    query,
    back > today ? back : today,
    shiftDate(date, -1),
    nowMs,
  );
  return carriedInput(own, runChain(inputs, away, saved).carry);
}
