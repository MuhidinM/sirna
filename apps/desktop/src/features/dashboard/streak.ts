/**
 * The forgiving focus streak and the year chart (plan §3.13; R-PRG-01,
 * R-PRG-02). Computed from what is already stored, never kept separately,
 * so it can't drift. Pure and tested.
 */
import { shiftDate, weekStart } from "../plan/dayplan";

/** One logical day's facts. The logical date is the UTC date (the day starts 03:00 Addis = 00:00 UTC). */
export interface DayFacts {
  date: string;
  sessions: number; // finished focus sessions
  focusMin: number;
  protectedPlanned: number; // protected habit blocks in the plan (Quran, gym)
  protectedDone: number;
  light: boolean;
  rest: boolean;
  planned: boolean; // Sirna made a plan that day (false: away or not used)
  away: boolean; // away mode was on (`away till mon`)
}

/** ?1 = first date (YYYY-MM-DD), ?2 = area id or '' for all. */
export const FOCUS_DAYS_SQL = `
  SELECT date(f.started_at / 1000, 'unixepoch') AS date,
         sum(CASE WHEN f.outcome = 'completed' THEN 1 ELSE 0 END) AS sessions,
         sum(MAX(0, (COALESCE(f.ended_at, f.started_at) - f.started_at - f.paused_ms) / 60000)) AS focus_min
  FROM focus_sessions f
  LEFT JOIN day_blocks b ON b.id = f.block_id
  WHERE f.kind = 'focus' AND date(f.started_at / 1000, 'unixepoch') >= ?1
    AND (?2 = '' OR COALESCE(f.area_id, b.area_id) = ?2)
  GROUP BY 1`;

/** Per planned day: protected habits planned and done, light and rest days. ?1 = first date. */
export const PLAN_DAYS_SQL = `
  SELECT b.logical_date AS date,
         sum(CASE WHEN b.kind = 'routine' AND a.protected = 1 THEN 1 ELSE 0 END) AS protected_planned,
         sum(CASE WHEN b.kind = 'routine' AND a.protected = 1 AND b.status = 'done' THEN 1 ELSE 0 END)
           AS protected_done,
         max(b.light_day) AS light,
         max(CASE WHEN b.kind = 'rest' AND b.end_at - b.start_at >= 6 * 3600000 THEN 1 ELSE 0 END) AS rest
  FROM day_blocks b
  LEFT JOIN area_items a ON a.id = b.area_id
  WHERE b.deleted_at IS NULL AND b.logical_date >= ?1
  GROUP BY b.logical_date`;

/** Minutes of done habit blocks per day (Quran, gym), so habit areas show in the chart. ?1 first date, ?2 area or ''. */
export const HABIT_DAYS_SQL = `
  SELECT logical_date AS date, sum((end_at - start_at) / 60000) AS minutes
  FROM day_blocks
  WHERE deleted_at IS NULL AND kind = 'routine' AND status = 'done' AND logical_date >= ?1
    AND (?2 = '' OR area_id = ?2)
  GROUP BY logical_date`;

/** Every change to away mode, oldest first (the audit log keeps the value after each). */
export const AWAY_HISTORY_SQL = `
  SELECT at, after_json FROM core_activity
  WHERE entity_type = 'core_settings' AND entity_id = 'away.until'
  ORDER BY at, id`;

/** The first day Sirna has anything for, so the streak isn't cut off at a year. */
export const FIRST_DAY_SQL = `
  SELECT min(d) AS first FROM (
    SELECT min(date(started_at / 1000, 'unixepoch')) AS d FROM focus_sessions
    UNION ALL SELECT min(logical_date) FROM day_blocks WHERE deleted_at IS NULL)`;

export interface AwayChange {
  at: number;
  after_json: string | null;
}

/**
 * The days away mode was on, from its history: a day is away when the
 * latest change on or before it set a return date later than that day.
 */
export function awayDays(changes: AwayChange[], from: string, to: string): Set<string> {
  const steps = changes.map((change) => {
    let until: string | null = null;
    try {
      const row = JSON.parse(change.after_json ?? "null") as { value_json?: string } | null;
      const value = row?.value_json ? (JSON.parse(row.value_json) as unknown) : null;
      until = typeof value === "string" && value ? value : null;
    } catch {
      until = null;
    }
    // The logical date of the change: 03:00 Addis is 00:00 UTC, so the UTC date.
    return { date: new Date(change.at).toISOString().slice(0, 10), until };
  });
  const days = new Set<string>();
  let index = 0;
  let until: string | null = null;
  for (let date = from; date <= to; date = shiftDate(date, 1)) {
    while (index < steps.length && (steps[index]?.date ?? "") <= date) {
      until = steps[index]?.until ?? null;
      index += 1;
    }
    if (until && until > date) days.add(date);
  }
  return days;
}

export interface HabitDayRow {
  date: string;
  minutes: number;
}

export interface FocusDayRow {
  date: string;
  sessions: number;
  focus_min: number;
}

export interface PlanDayRow {
  date: string;
  protected_planned: number;
  protected_done: number;
  light: number;
  rest: number;
}

/** Every day from `from` to `to`, inclusive, with its facts (empty days included). */
export function dayFacts(
  from: string,
  to: string,
  focus: FocusDayRow[],
  plans: PlanDayRow[],
  habits: HabitDayRow[] = [],
  away: Set<string> = new Set(),
): DayFacts[] {
  const byFocus = new Map(focus.map((row) => [row.date, row]));
  const byPlan = new Map(plans.map((row) => [row.date, row]));
  const byHabit = new Map(habits.map((row) => [row.date, row.minutes]));
  const days: DayFacts[] = [];
  for (let date = from; date <= to; date = shiftDate(date, 1)) {
    const f = byFocus.get(date);
    const p = byPlan.get(date);
    days.push({
      date,
      sessions: f?.sessions ?? 0,
      focusMin: (f?.focus_min ?? 0) + (byHabit.get(date) ?? 0),
      protectedPlanned: p?.protected_planned ?? 0,
      protectedDone: p?.protected_done ?? 0,
      light: (p?.light ?? 0) === 1,
      rest: (p?.rest ?? 0) === 1,
      planned: p !== undefined,
      away: away.has(date),
    });
  }
  return days;
}

export type DayMark = "counted" | "rest" | "away" | "light" | "free_miss" | "today" | "missed";

/**
 * A day counts with 2 finished sessions, or with every protected habit done;
 * on a light day one session is enough. Rest days, days without a plan
 * (away, or Sirna not used), light days and today never break it, and the
 * first miss in each Monday-to-Sunday week is free.
 */
export function markDays(days: DayFacts[], today: string): DayMark[] {
  const freeUsed = new Set<string>();
  return days.map((day) => {
    const habits = day.protectedPlanned > 0 && day.protectedDone >= day.protectedPlanned;
    if (day.sessions >= 2 || habits || (day.light && day.sessions >= 1)) return "counted";
    if (day.date === today) return "today";
    if (day.rest) return "rest";
    if (day.away) return "away";
    if (!day.planned && day.sessions === 0) return "away";
    if (day.light) return "light";
    const week = weekStart(day.date);
    if (!freeUsed.has(week)) {
      freeUsed.add(week);
      return "free_miss";
    }
    return "missed";
  });
}

export interface Streak {
  current: number;
  best: number;
  /** Free misses left in the current week (0 or 1). */
  freeLeft: number;
  /** The current run is alive today or ended yesterday-ish (no miss since). */
  alive: boolean;
}

/** Counted days in runs that only a real miss ends. */
export function streakOf(days: DayFacts[], today: string): Streak {
  const marks = markDays(days, today);
  let run = 0;
  let best = 0;
  marks.forEach((mark) => {
    if (mark === "missed") run = 0;
    else if (mark === "counted") {
      run += 1;
      best = Math.max(best, run);
    }
  });
  const thisWeek = weekStart(today);
  const usedThisWeek = marks.some(
    (mark, index) => mark === "free_miss" && weekStart(days[index]?.date ?? "") === thisWeek,
  );
  return { current: run, best, freeLeft: usedThisWeek ? 0 : 1, alive: run > 0 };
}

// --- Year chart ----------------------------------------------------------------------

export type Shade = 0 | 1 | 2 | 3 | 4;

/** 0 none, 1 under 1 h, 2 1–2 h, 3 2–3 h, 4 3 h or more. */
export function shadeOf(minutes: number): Shade {
  if (minutes <= 0) return 0;
  if (minutes < 60) return 1;
  if (minutes < 120) return 2;
  if (minutes < 180) return 3;
  return 4;
}

export interface Cell {
  date: string;
  minutes: number;
  shade: Shade;
  /** Rest and away days show as an outline, not an empty cell. */
  outline: boolean;
  future: boolean;
}

/**
 * 53 columns of Monday-to-Sunday weeks ending with this week, oldest first;
 * each column is 7 cells. Days after today are marked future.
 */
export function yearGrid(days: DayFacts[], today: string): Cell[][] {
  const byDate = new Map(days.map((day) => [day.date, day]));
  const marks = new Map(markDays(days, today).map((mark, index) => [days[index]?.date, mark]));
  const lastMonday = weekStart(today);
  const columns: Cell[][] = [];
  for (let week = 52; week >= 0; week--) {
    const monday = shiftDate(lastMonday, -7 * week);
    const column: Cell[] = [];
    for (let d = 0; d < 7; d++) {
      const date = shiftDate(monday, d);
      const day = byDate.get(date);
      const mark = marks.get(date);
      column.push({
        date,
        minutes: day?.focusMin ?? 0,
        shade: shadeOf(day?.focusMin ?? 0),
        outline: mark === "rest" || mark === "away",
        future: date > today,
      });
    }
    columns.push(column);
  }
  return columns;
}

/** The first date the year chart needs (the Monday 52 weeks back). */
export function yearStart(today: string): string {
  return shiftDate(weekStart(today), -7 * 52);
}

// --- Tiles ------------------------------------------------------------------------------

/** Minutes of a session up to now, without paused time (finished or current pauses). */
const MINUTES = `MAX(0, (COALESCE(f.ended_at, ?2) - f.started_at - f.paused_ms
  - CASE WHEN f.ended_at IS NULL AND f.paused_at IS NOT NULL THEN ?2 - f.paused_at ELSE 0 END) / 60000)`;

/** This week's focus, breaks and distractions. ?1 = week start ms, ?2 = now ms. */
export const TILES_SQL = `
  SELECT
    COALESCE(sum(CASE WHEN f.kind = 'focus' THEN ${MINUTES} END), 0) AS focus_min,
    COALESCE(sum(CASE WHEN f.kind = 'focus' AND a.kind IN ('growth', 'admin') THEN ${MINUTES} END), 0)
      AS goal_focus_min,
    COALESCE(sum(CASE WHEN f.kind != 'focus' THEN ${MINUTES} END), 0) AS break_min,
    COALESCE(sum(CASE WHEN f.kind = 'focus' THEN f.distractions END), 0) AS distractions,
    COALESCE(sum(CASE WHEN f.kind = 'focus' AND f.outcome = 'completed' THEN 1 END), 0) AS sessions
  FROM focus_sessions f
  LEFT JOIN day_blocks b ON b.id = f.block_id
  LEFT JOIN area_items a ON a.id = COALESCE(f.area_id, b.area_id)
  WHERE f.started_at >= ?1 AND f.started_at < ?2`;

/** The week's focus goal: the hours Grow and Admin areas aim for (habits are kept by their blocks). */
export const GOAL_SQL = `SELECT COALESCE(sum(weekly_target_min), 0) AS goal_min FROM area_items
  WHERE deleted_at IS NULL AND active = 1 AND kind IN ('growth', 'admin')`;

export interface Tiles {
  focus_min: number;
  /** Focus in Grow and Admin areas: what the goal counts. */
  goal_focus_min: number;
  break_min: number;
  distractions: number;
  sessions: number;
}
