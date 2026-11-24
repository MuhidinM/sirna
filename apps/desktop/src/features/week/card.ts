/**
 * The Sunday week card (plan §3.10; R-CHK-04): where the week's time went,
 * next week's load, projects, spending against your usual, and one change.
 * Pure and tested against hand counts; the page only reads these queries
 * and writes these ops.
 */
import { type Op } from "../../kernel/db";
import {
  hoursLabel,
  LOAD_LIMIT,
  type PlannedProject,
  type WeekModel,
  weekLoad,
} from "../projects/capacity";
import {
  type Conversion,
  convert,
  newConversion,
  type Rates,
  rowCurrencySql,
} from "../money/currency";
import { shiftDate } from "../plan/dayplan";

// --- 1. Where time went --------------------------------------------------------

export interface AreaWeek {
  id: string;
  name: string;
  color: string;
  target_min: number;
  done_min: number;
  /** 1 when the target is also a ceiling (Experiments). */
  capped?: number;
}

/** A session's minutes up to now (?2), paused time left out. */
const SESSION_MIN = (
  f: string,
) => `MAX(0, (COALESCE(${f}.ended_at, ?2) - ${f}.started_at - ${f}.paused_ms
  - CASE WHEN ${f}.ended_at IS NULL AND ${f}.paused_at IS NOT NULL
         THEN ?2 - ${f}.paused_at ELSE 0 END) / 60000)`;

/**
 * Minutes per area this week: focus sessions (paused time left out) plus
 * habit blocks marked done. A done habit block focused on counts once: the
 * focus, topped up to the block's length. ?1 = week start (ms), ?2 = now (ms).
 */
export const AREA_WEEK_SQL = `
  SELECT a.id, a.name, a.color, a.weekly_target_min AS target_min, a.capped,
         COALESCE((
           SELECT SUM(${SESSION_MIN("f")})
           FROM focus_sessions AS f
           LEFT JOIN day_blocks AS fb ON fb.id = f.block_id
           WHERE f.kind = 'focus' AND f.started_at >= ?1 AND f.started_at < ?2
             AND COALESCE(f.area_id, fb.area_id) = a.id
         ), 0)
       + COALESCE((
           SELECT SUM(MAX(0, (b.end_at - b.start_at) / 60000 - COALESCE((
             SELECT SUM(${SESSION_MIN("f2")})
             FROM focus_sessions AS f2
             WHERE f2.block_id = b.id AND f2.kind = 'focus'
               AND f2.started_at >= ?1 AND f2.started_at < ?2
               AND COALESCE(f2.area_id, b.area_id) = a.id
           ), 0)))
           FROM day_blocks AS b
           WHERE b.deleted_at IS NULL AND b.kind = 'routine' AND b.status = 'done'
             AND b.area_id = a.id AND b.start_at >= ?1 AND b.start_at < ?2
         ), 0) AS done_min
  FROM area_items AS a
  WHERE a.deleted_at IS NULL AND a.active = 1 AND a.kind != 'work' AND a.weekly_target_min > 0
  ORDER BY a.priority_rank, a.name`;

/**
 * Sessions finished, distractions and days with an overrun. Distractions and
 * overruns count on every session, stopped ones too (the time was spent), as
 * the Dashboard counts them. ?1 week start, ?2 now.
 */
export const FOCUS_WEEK_SQL = `
  SELECT count(CASE WHEN outcome = 'completed' THEN 1 END) AS sessions,
         COALESCE(sum(distractions), 0) AS distractions,
         -- The logical day starts at 03:00 Addis, which is 00:00 UTC: its date is the UTC date.
         count(DISTINCT CASE WHEN overrun = 1 THEN date(started_at / 1000, 'unixepoch') END)
           AS overrun_days
  FROM focus_sessions
  WHERE kind = 'focus' AND started_at >= ?1 AND started_at < ?2`;

export interface FocusWeek {
  sessions: number;
  distractions: number;
  overrun_days: number;
}

export function share(area: Pick<AreaWeek, "done_min" | "target_min">): number {
  return area.target_min > 0 ? area.done_min / area.target_min : 0;
}

// --- 2. Next week ---------------------------------------------------------------

export interface NextWeek {
  monday: string;
  committed: number;
  capacity: number;
  ratio: number;
  activeProjects: number;
  over: boolean;
}

export function nextWeek(
  week: WeekModel,
  projects: PlannedProject[],
  thisMonday: string,
): NextWeek {
  const load = weekLoad(week, projects, shiftDate(thisMonday, 7));
  return { ...load, over: load.ratio > LOAD_LIMIT };
}

// --- 3. Projects -----------------------------------------------------------------

export interface ProjectWeek {
  id: string;
  title: string;
  status: string;
  estimate_min: number | null;
  weekly_min: number | null;
  deadline: string | null;
  forecast_finish: string | null;
  done_min: number;
  week_min: number;
}

/** Open projects with focus time done in all and this week. ?1 = week start, ?2 = now. */
export const PROJECTS_WEEK_SQL = `
  SELECT p.id, p.title, p.status, p.estimate_min, p.weekly_min, p.deadline, p.forecast_finish,
         COALESCE((SELECT sum(MAX(0, (f.ended_at - f.started_at - f.paused_ms) / 60000))
                   FROM focus_sessions f JOIN task_items t ON t.id = f.task_id
                   WHERE t.project_id = p.id AND f.kind = 'focus' AND f.ended_at IS NOT NULL), 0)
           AS done_min,
         COALESCE((SELECT sum(MAX(0, (f.ended_at - f.started_at - f.paused_ms) / 60000))
                   FROM focus_sessions f JOIN task_items t ON t.id = f.task_id
                   WHERE t.project_id = p.id AND f.kind = 'focus' AND f.ended_at IS NOT NULL
                     AND f.started_at >= ?1 AND f.started_at < ?2), 0)
           AS week_min
  FROM project_items p
  WHERE p.deleted_at IS NULL AND p.status IN ('active', 'next_up')
  ORDER BY p.status = 'next_up', p.deadline IS NULL, p.deadline, p.title`;

export function progressLabel(project: ProjectWeek): string {
  const done = hoursLabel(project.done_min);
  return project.estimate_min
    ? `${done} of ${hoursLabel(project.estimate_min)} (${Math.min(100, Math.round((project.done_min / project.estimate_min) * 100))}%)`
    : `${done} so far`;
}

export function projectStatusOps(id: string, status: "active" | "paused" | "done"): Op[] {
  return [{ op: "update", table: "project_items", id, values: { status } }];
}

// --- 4. Money -----------------------------------------------------------------

export interface SpendRow {
  category: string;
  week_minor: number;
  past_minor: number;
  /** The rows' currency; missing means birr. */
  currency?: string | null;
}

/**
 * Spending by category: this week and the 4 weeks before it (for the
 * average). ?1 = this Monday, ?2 = the Monday 4 weeks earlier, ?3 = next Monday.
 * Amounts are minor units, expenses positive, one row per category and
 * currency: dollars are not added to birr here (F4), spendLines converts.
 */
export const SPEND_SQL = `
  SELECT COALESCE(c.name, 'Other') AS category, ${rowCurrencySql("m")} AS currency,
         COALESCE(sum(CASE WHEN m.local_date >= ?1 AND m.local_date < ?3 THEN -m.amount_minor END), 0)
           AS week_minor,
         COALESCE(sum(CASE WHEN m.local_date >= ?2 AND m.local_date < ?1 THEN -m.amount_minor END), 0)
           AS past_minor
  FROM money_txns m
  LEFT JOIN money_categories c ON c.id = m.category_id
  LEFT JOIN money_accounts acc ON acc.id = m.account
  WHERE m.deleted_at IS NULL AND m.transfer_id IS NULL AND m.amount_minor < 0 AND m.local_date >= ?2 AND m.local_date < ?3
  GROUP BY COALESCE(c.name, 'Other'), 2
  HAVING week_minor > 0 OR past_minor > 0
  ORDER BY week_minor DESC, past_minor DESC`;

/** The first expense in the 4 weeks before (?1 = this Monday, ?2 = 4 weeks earlier). */
export const SPEND_SINCE_SQL = `SELECT min(local_date) AS since FROM money_txns
  WHERE deleted_at IS NULL AND transfer_id IS NULL AND amount_minor < 0 AND local_date >= ?2 AND local_date < ?1`;

/** Weeks of history behind the average: 0 to 4, from the first expense in the window. */
export function historyWeeks(since: string | null, thisMonday: string): number {
  if (!since) return 0;
  const days =
    (Date.parse(`${thisMonday}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / 86_400_000;
  return Math.max(1, Math.min(4, Math.ceil(days / 7)));
}

export function spendParams(thisMonday: string): [string, string, string] {
  return [thisMonday, shiftDate(thisMonday, -28), shiftDate(thisMonday, 7)];
}

export interface SpendLine {
  category: string;
  week: number;
  /** Null when there is no history to compare with. */
  average: number | null;
}

/**
 * This week against the weekly average of the weeks before (up to 4) that
 * have data, in ETB: foreign money converts at the saved rates, and money
 * with no rate is left out and named in `conversion` (F4).
 */
export function spendLines(
  rows: SpendRow[],
  weeks: number,
  rates: Rates = {},
): { lines: SpendLine[]; week: number; average: number | null; conversion: Conversion } {
  const conversion = newConversion();
  const byCategory = new Map<string, { week: number; past: number }>();
  for (const row of rows) {
    const week = convert(conversion, rates, Number(row.week_minor) || 0, row.currency) ?? 0;
    const past = convert(conversion, rates, Number(row.past_minor) || 0, row.currency) ?? 0;
    const sum = byCategory.get(row.category) ?? { week: 0, past: 0 };
    byCategory.set(row.category, { week: sum.week + week, past: sum.past + past });
  }
  const lines = [...byCategory]
    .filter(([, sum]) => sum.week > 0 || sum.past > 0)
    .map(([category, sum]) => ({
      category,
      week: sum.week,
      average: weeks > 0 ? Math.round(sum.past / weeks) : null,
    }))
    .sort((x, y) => y.week - x.week || (y.average ?? 0) - (x.average ?? 0));
  return {
    lines,
    week: lines.reduce((sum, line) => sum + line.week, 0),
    average: weeks > 0 ? lines.reduce((sum, line) => sum + (line.average ?? 0), 0) : null,
    conversion,
  };
}

// --- 5. One change ---------------------------------------------------------------

export interface Change {
  key: string; // what it is about, so "No" holds for the week
  text: string;
  apply: Op[];
}

/**
 * One routine change from the week's numbers, the first that applies:
 * 1. next week over 85% → pause the project with the latest (or no) deadline;
 * 2. 3+ days past the focus cap → an hour less a week for the biggest project;
 * 3. an area under half its target → a target it can meet (what it did, +25%).
 */
export function oneChange(input: {
  next: NextWeek;
  focus: FocusWeek;
  areas: AreaWeek[];
  projects: ProjectWeek[];
  /** False before Friday: an area can't be judged on half a week. */
  weekMostlyDone: boolean;
  /** Days of this week spent away (away mode): they never count against you. */
  awayDays?: number;
}): Change | null {
  const active = input.projects.filter((p) => p.status === "active");
  if (input.next.over && active.length > 0) {
    const pick = [...active].sort((a, b) =>
      (b.deadline ?? "9999").localeCompare(a.deadline ?? "9999"),
    )[0];
    if (pick)
      return {
        key: `pause:${pick.id}`,
        text: Number.isFinite(input.next.ratio)
          ? `Next week is at ${Math.round(input.next.ratio * 100)}% of your free time. Pause ${pick.title} for now?`
          : `Your routine leaves no free time next week. Pause ${pick.title} for now?`,
        apply: projectStatusOps(pick.id, "paused"),
      };
  }
  if (input.focus.overrun_days >= 3) {
    const pick = [...active].sort((a, b) => (b.weekly_min ?? 0) - (a.weekly_min ?? 0))[0];
    if (pick?.weekly_min && pick.weekly_min > 60)
      return {
        key: `less:${pick.id}`,
        text: `You went past the focus cap on ${input.focus.overrun_days} days. Give ${pick.title} an hour less a week (${hoursLabel(pick.weekly_min - 60)})?`,
        apply: [
          {
            op: "update",
            table: "project_items",
            id: pick.id,
            values: { weekly_min: pick.weekly_min - 60 },
          },
        ],
      };
  }
  // Away days are left out: each target shrinks to the days you were here,
  // and a week mostly away (4+ days) is not judged at all.
  const here = 7 - Math.min(7, Math.max(0, input.awayDays ?? 0));
  if (input.weekMostlyDone && here >= 4) {
    const fair = (area: AreaWeek) => share({ ...area, target_min: (area.target_min * here) / 7 });
    const behind = input.areas
      .filter((area) => area.target_min >= 60 && fair(area) < 0.5)
      .sort((a, b) => fair(a) - fair(b))[0];
    if (behind) {
      const target = Math.max(60, Math.ceil((behind.done_min * 1.25) / 30) * 30);
      if (target < behind.target_min)
        return {
          key: `target:${behind.id}`,
          text: `${behind.name} got ${hoursLabel(behind.done_min)} of ${hoursLabel(behind.target_min)} this week. Set its target to ${hoursLabel(target)} so it's one you can meet?`,
          apply: [
            {
              op: "update",
              table: "area_items",
              id: behind.id,
              values: { weekly_target_min: target },
            },
          ],
        };
    }
  }
  return null;
}

/** One change a week: once applied or declined, the card is done until Monday. */
export const DISMISSED_KEY = "week.change_dismissed";

export function dismissOps(monday: string, key: string): Op[] {
  return [
    {
      op: "upsert",
      table: "core_settings",
      id: DISMISSED_KEY,
      values: { value_json: JSON.stringify({ monday, key }) },
    },
  ];
}

/** True once this week's change was applied or declined. */
export function isHandled(valueJson: string | null | undefined, monday: string): boolean {
  try {
    const saved = JSON.parse(valueJson ?? "null") as { monday?: string } | null;
    return saved?.monday === monday;
  } catch {
    return false;
  }
}

/** Applying writes the change and marks the week's change handled, in one write. */
export function applyOps(change: Change, monday: string): Op[] {
  return [...change.apply, ...dismissOps(monday, change.key)];
}
