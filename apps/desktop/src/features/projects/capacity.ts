/**
 * Capacity, load and the slot finder (plan §3.7–3.8; R-PRJ-01, R-PRJ-02,
 * R-BRN-05). Pure and deterministic: the numbers and the verdict come from
 * here; the AI (T-037) only phrases reasons from them.
 *
 *   capacity  = free time in the template week (waking window minus fixed
 *               and routine blocks, rest day excluded) minus a 20% buffer
 *   committed = what areas still need beyond their routine blocks
 *               + the weekly hours of projects running that week
 *   load      = committed / capacity; new work keeps it at or under 85%
 */
import { shiftDate, weekStart } from "../plan/dayplan";

export const BUFFER = 0.2;
export const LOAD_LIMIT = 0.85;
export const MAX_ACTIVE = 2;
/** Less than this in a week is not worth a slot. */
export const MIN_SLOT_MIN = 30;
/** How far the slot finder looks. */
export const HORIZON_WEEKS = 52;

export interface TemplateBlock {
  weekday: number; // 1 = Monday … 7 = Sunday
  start_min: number;
  duration_min: number;
  kind: string; // fixed | routine | area | rest
  area_id: string | null;
}

export interface Window {
  /** Where area time can start each day (the generator uses wake + 30). */
  fromMin: number;
  /** Where it ends: the earlier of the night review and the hard stop. */
  toMin: number;
}

/** Minutes of [from, to) covered by the given intervals (overlaps counted once). */
function covered(intervals: [number, number][], from: number, to: number): number {
  const clipped = intervals
    .map(([start, end]) => [Math.max(start, from), Math.min(end, to)] as [number, number])
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cursor = from;
  for (const [start, end] of clipped) {
    if (end <= cursor) continue;
    total += end - Math.max(start, cursor);
    cursor = end;
  }
  return total;
}

/** Free minutes in the template week before the buffer. */
export function freeMinutes(blocks: TemplateBlock[], window: Window): number {
  let free = 0;
  for (let day = 1; day <= 7; day++) {
    const today = blocks.filter((block) => block.weekday === day);
    if (today.some((block) => block.kind === "rest")) continue;
    const busy = today
      .filter((block) => block.kind === "fixed" || block.kind === "routine")
      .map((block) => [block.start_min, block.start_min + block.duration_min] as [number, number]);
    const length = Math.max(0, window.toMin - window.fromMin);
    free += length - covered(busy, window.fromMin, window.toMin);
  }
  return free;
}

export function weeklyCapacity(blocks: TemplateBlock[], window: Window): number {
  return Math.round(freeMinutes(blocks, window) * (1 - BUFFER));
}

export interface AreaTarget {
  id: string;
  weekly_target_min: number;
  active: number;
}

/**
 * What active areas still need each week beyond their own fixed and routine
 * blocks (Gym and Quran are mostly routine already; jobs are fixed).
 */
export function areaCommitted(areas: AreaTarget[], blocks: TemplateBlock[]): number {
  let total = 0;
  for (const area of areas) {
    if (area.active !== 1) continue;
    const scheduled = blocks
      .filter(
        (block) =>
          block.area_id === area.id && (block.kind === "fixed" || block.kind === "routine"),
      )
      .reduce((sum, block) => sum + block.duration_min, 0);
    total += Math.max(0, area.weekly_target_min - scheduled);
  }
  return total;
}

export interface WeekModel {
  capacity: number;
  areaCommitted: number;
}

export interface PlannedProject {
  id: string;
  status: string; // idea | next_up | active | paused | done | dropped
  weekly_min: number | null;
  start_date: string | null;
  forecast_finish: string | null;
}

/** Whether a project takes time in the week starting `monday`. */
export function runsIn(project: PlannedProject, monday: string): boolean {
  if (project.status !== "active" && project.status !== "next_up") return false;
  if (project.status === "next_up" && !project.start_date) return false;
  const sunday = shiftDate(monday, 6);
  if (project.start_date && project.start_date > sunday) return false;
  if (project.forecast_finish && project.forecast_finish < monday) return false;
  return true;
}

export interface WeekLoad {
  monday: string;
  committed: number;
  capacity: number;
  /** committed / capacity; Infinity when there is no capacity. */
  ratio: number;
  activeProjects: number;
}

export function weekLoad(week: WeekModel, projects: PlannedProject[], monday: string): WeekLoad {
  const running = projects.filter((project) => runsIn(project, monday));
  const committed =
    week.areaCommitted + running.reduce((sum, project) => sum + (project.weekly_min ?? 0), 0);
  return {
    monday,
    committed,
    capacity: week.capacity,
    ratio: ratio(committed, week.capacity),
    activeProjects: running.length,
  };
}

function ratio(committed: number, capacity: number): number {
  if (capacity <= 0) return committed > 0 ? Infinity : 0;
  return committed / capacity;
}

/** The first week the finder can use: this Monday when today is Monday, else next Monday. */
export function firstMonday(today: string): string {
  const monday = weekStart(today);
  return monday === today ? today : shiftDate(monday, 7);
}

export interface Slot {
  start: string; // Monday of the first week with time
  finish: string; // Sunday of the last week with time
  /** Minutes given to the new project, one entry per week from `start`. */
  weeks: number[];
  weeklyMin: number; // the most it gets in any week
}

/**
 * Walks forward week by week, giving the new work min(remaining, room under
 * 85%, the weekly hours asked for). It pauses in any week where 2 other
 * projects run, so at most 2 run at once (R-BRN-05). Null when it doesn't fit
 * in a year.
 */
export function findSlot(
  estimateMin: number,
  today: string,
  week: WeekModel,
  projects: PlannedProject[],
  weeklyMin: number | null = null,
): Slot | null {
  if (estimateMin <= 0) return null;
  let remaining = estimateMin;
  let monday = firstMonday(today);
  let start: string | null = null;
  const weeks: number[] = [];
  for (let i = 0; i < HORIZON_WEEKS && remaining > 0; i++, monday = shiftDate(monday, 7)) {
    const load = weekLoad(week, projects, monday);
    const room = Math.floor(week.capacity * LOAD_LIMIT) - load.committed;
    const blocked = load.activeProjects >= MAX_ACTIVE;
    let give = blocked ? 0 : Math.min(remaining, room, weeklyMin ?? room);
    // A last small piece still finishes the work; a small first piece waits.
    if (give < MIN_SLOT_MIN && give < remaining) give = 0;
    if (give <= 0) {
      if (start !== null) weeks.push(0);
      continue;
    }
    start ??= monday;
    weeks.push(give);
    remaining -= give;
  }
  if (remaining > 0 || start === null) return null;
  while (weeks.at(-1) === 0) weeks.pop();
  return {
    start,
    finish: shiftDate(start, weeks.length * 7 - 1),
    weeks,
    weeklyMin: Math.max(...weeks),
  };
}

export type Verdict = "good" | "tight" | "too_much";

export interface DateCheck {
  verdict: Verdict;
  weeksLeft: number;
  weeklyNeeded: number;
  before: number; // load ratio now
  after: number; // load ratio with the new work
  limitBroken: boolean; // already 2 active projects
  reasons: string[];
  /** Where the slot finder would put it instead (null if it doesn't fit). */
  suggestion: Slot | null;
}

export function verdictOf(after: number, limitBroken: boolean): Verdict {
  if (after > 1) return "too_much";
  if (after > LOAD_LIMIT || limitBroken) return "tight";
  return "good";
}

const percent = (value: number) => (Number.isFinite(value) ? `${Math.round(value * 100)}%` : "∞");

export function hoursLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  if (!hours) return `${rest} min`;
  return rest ? `${hours} h ${String(rest).padStart(2, "0")}` : `${hours} h`;
}

/**
 * An idea with a date (`by 20 dec`): what it needs each week until then and
 * what that does to this week's load. The weeks run from today to the
 * deadline, inclusive.
 */
export function checkWithDate(
  estimateMin: number,
  deadline: string,
  today: string,
  week: WeekModel,
  projects: PlannedProject[],
): DateCheck {
  const days = daysBetween(today, deadline) + 1;
  const now = weekLoad(week, projects, weekStart(today));
  const limitBroken = now.activeProjects >= MAX_ACTIVE;
  const suggestion = findSlot(estimateMin, today, week, projects);
  if (days <= 0) {
    return {
      verdict: "too_much",
      weeksLeft: 0,
      weeklyNeeded: estimateMin,
      before: now.ratio,
      after: Infinity,
      limitBroken,
      reasons: ["The date has passed."],
      suggestion,
    };
  }
  const weeksLeft = days / 7;
  const weeklyNeeded = Math.ceil(estimateMin / Math.max(weeksLeft, 1));
  // The busiest week until the deadline decides: a project that starts later
  // can fill a week that is quiet now.
  let worst = now;
  let mostActive = now.activeProjects;
  for (let monday = now.monday; monday <= deadline; monday = shiftDate(monday, 7)) {
    const load = weekLoad(week, projects, monday);
    if (load.committed > worst.committed) worst = load;
    mostActive = Math.max(mostActive, load.activeProjects);
  }
  const after = ratio(worst.committed + weeklyNeeded, week.capacity);
  const crowded = mostActive >= MAX_ACTIVE;
  const reasons = [
    `Needs ${hoursLabel(weeklyNeeded)} a week for ${formatWeeks(weeksLeft)}.`,
    worst.monday === now.monday
      ? `Your load would go ${percent(now.ratio)} → ${percent(after)}.`
      : `Your load would go ${percent(now.ratio)} → ${percent(after)} in the week of ${worst.monday}.`,
  ];
  if (crowded)
    reasons.push(`${MAX_ACTIVE} active projects already; this would be number ${mostActive + 1}.`);
  return {
    verdict: verdictOf(after, crowded),
    weeksLeft,
    weeklyNeeded,
    before: now.ratio,
    after,
    limitBroken: crowded,
    reasons,
    suggestion,
  };
}

function formatWeeks(weeks: number): string {
  if (weeks < 1) {
    const days = Math.round(weeks * 7);
    return days === 1 ? "1 day" : `${days} days`;
  }
  const rounded = Math.round(weeks * 2) / 2;
  return rounded === 1 ? "1 week" : `${rounded} weeks`;
}

export function daysBetween(from: string, to: string): number {
  const ms = (date: string) => {
    const [y, m, d] = date.split("-").map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ms(to) - ms(from)) / 86_400_000);
}

/** Status for a new project: a third active one waits in Next up (R-BRN-05). */
export function admitStatus(
  wanted: string,
  projects: PlannedProject[],
  selfId: string | null,
): { status: string; held: boolean } {
  if (wanted !== "active") return { status: wanted, held: false };
  const active = projects.filter((p) => p.status === "active" && p.id !== selfId).length;
  return active >= MAX_ACTIVE ? { status: "next_up", held: true } : { status: wanted, held: false };
}

// Reading the week from the database ----------------------------------------

type Row = Record<string, string | number | boolean | null>;
export type Query = <T extends Row>(
  sql: string,
  params?: (string | number | null)[],
) => Promise<T[]>;

export const WEEK_BLOCKS_SQL = `SELECT weekday, start_min, duration_min, kind, area_id
  FROM routine_blocks WHERE active = 1 AND deleted_at IS NULL`;
export const WINDOW_SQL = `SELECT key, value_json FROM core_settings
  WHERE key IN ('day.wake', 'day.review', 'day.hard_stop')`;
export const AREA_TARGETS_SQL = `SELECT id, weekly_target_min, active FROM area_items
  WHERE deleted_at IS NULL`;
export const PLANNED_PROJECTS_SQL = `SELECT id, status, weekly_min, start_date, forecast_finish
  FROM project_items WHERE deleted_at IS NULL`;

/** Defaults match the setup's (routine.ts DEFAULT_ANSWERS). */
export function windowOf(rows: { key: string; value_json: string | null }[]): Window {
  const time = (key: string, fallback: number) => {
    const row = rows.find((entry) => entry.key === key);
    try {
      const text = JSON.parse(row?.value_json ?? "null") as unknown;
      const match = typeof text === "string" ? /^(\d{1,2}):(\d{2})$/.exec(text) : null;
      return match ? Number(match[1]) * 60 + Number(match[2]) : fallback;
    } catch {
      return fallback;
    }
  };
  return {
    fromMin: time("day.wake", 6 * 60) + 30,
    toMin: Math.min(time("day.review", 21 * 60), time("day.hard_stop", 22 * 60 + 30)),
  };
}

export async function loadWeek(
  query: Query,
): Promise<{ week: WeekModel; projects: PlannedProject[] }> {
  const [blocks, settings, areas, projects] = await Promise.all([
    query<TemplateBlock & Row>(WEEK_BLOCKS_SQL),
    query<{ key: string; value_json: string | null }>(WINDOW_SQL),
    query<AreaTarget & Row>(AREA_TARGETS_SQL),
    query<PlannedProject & Row>(PLANNED_PROJECTS_SQL),
  ]);
  return {
    week: {
      capacity: weeklyCapacity(blocks, windowOf(settings)),
      areaCommitted: areaCommitted(areas, blocks),
    },
    projects,
  };
}
