/**
 * Effort against return (T-080; R-PRG-06, R-MON-15): what each job pays per
 * worked hour, how that moves, the job days skipped, areas left under their
 * target week after week, and unused gaps between job blocks. Every number is
 * worked out here and tested; each insight shows only once its data is there.
 * "Worked job hours" are the job's blocks that were not skipped or moved, the
 * same base as rate.ts. Pure.
 */
import { hoursLabel } from "../projects/capacity";
import { type Rates, rowCurrencySql } from "../money/currency";
import { type JobRate, jobRates } from "../money/rate";
import { formatAmount, type Santim } from "../../kernel/money";
import { HOME_UTC_OFFSET_MIN } from "../../kernel/dates";

export type EffortKey = "jobRate" | "jobDrift" | "jobSkips" | "areaGap" | "useGap";

export interface EffortInsight {
  key: EffortKey;
  /** Unique within a list (one per job or area where there can be several). */
  id: string;
  text: string;
}

// --- SQL ------------------------------------------------------------------------

/** Minutes of each job's blocks per month between ?1 and ?2; skipped or moved ones left out. */
export const JOB_MONTH_MINUTES_SQL = `
  SELECT b.area_id, a.name, substr(b.logical_date, 1, 7) AS month,
         sum((b.end_at - b.start_at) / 60000) AS minutes
  FROM day_blocks b
  JOIN area_items a ON a.id = b.area_id AND a.kind = 'work'
  WHERE b.deleted_at IS NULL AND b.status NOT IN ('skipped', 'moved')
    AND b.logical_date >= ?1 AND b.logical_date <= ?2
  GROUP BY b.area_id, month`;

/** Pay received per job, month and currency between ?1 and ?2. */
export const JOB_MONTH_PAY_SQL = `
  SELECT m.area_id, substr(m.local_date, 1, 7) AS month, sum(m.amount_minor) AS minor,
         ${rowCurrencySql("m")} AS currency
  FROM money_txns m LEFT JOIN money_accounts acc ON acc.id = m.account
  WHERE m.deleted_at IS NULL AND m.transfer_id IS NULL AND m.amount_minor > 0
    AND m.area_id IS NOT NULL AND m.local_date >= ?1 AND m.local_date <= ?2
  GROUP BY m.area_id, month, ${rowCurrencySql("m")}`;

/** Every job block between ?1 and ?2 but moved ones (a moved block has its twin). */
export const JOB_DAYS_SQL = `
  SELECT b.area_id, a.name, b.logical_date AS date, b.status,
         (b.end_at - b.start_at) / 60000 AS minutes
  FROM day_blocks b
  JOIN area_items a ON a.id = b.area_id AND a.kind = 'work'
  WHERE b.deleted_at IS NULL AND b.status != 'moved'
    AND b.logical_date >= ?1 AND b.logical_date <= ?2
  ORDER BY b.area_id, b.logical_date`;

/** Blocks of the days ?1..?2 that were kept (not skipped or moved), with whether they are a job's. */
export const GAP_BLOCKS_SQL = `
  SELECT b.logical_date AS date, b.start_at, b.end_at, b.area_id,
         CASE WHEN a.kind = 'work' THEN a.name END AS job
  FROM day_blocks b
  LEFT JOIN area_items a ON a.id = b.area_id
  WHERE b.deleted_at IS NULL AND b.status NOT IN ('skipped', 'moved')
    AND b.logical_date >= ?1 AND b.logical_date <= ?2
  ORDER BY b.logical_date, b.start_at`;

/** Focus sessions from ?1 to ?2 (ms); a running one runs to its start. */
export const GAP_SESSIONS_SQL = `
  SELECT started_at, COALESCE(ended_at, started_at) AS ended_at
  FROM focus_sessions
  WHERE kind = 'focus' AND started_at >= ?1 AND started_at < ?2`;

// --- Months ---------------------------------------------------------------------

/** "YYYY-MM" moved by whole months. */
export function shiftMonth(month: string, by: number): string {
  const [y = 0, m = 1] = month.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1 + by, 1));
  return date.toISOString().slice(0, 7);
}

/** The last full month before the one `today` is in, as "YYYY-MM". */
export function lastFullMonth(today: string): string {
  return shiftMonth(today.slice(0, 7), -1);
}

/** First and last date of a "YYYY-MM" month. */
export function monthDates(month: string): { from: string; to: string } {
  const [y = 0, m = 1] = month.split("-").map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(days).padStart(2, "0")}` };
}

export interface MonthMinutes {
  area_id: string;
  name: string;
  month: string;
  minutes: number;
}

export interface MonthPay {
  area_id: string;
  month: string;
  minor: number;
  currency?: string | null;
}

/** Each month's job rates (rate.ts), foreign pay converted at its rate. */
export function ratesByMonth(
  minutes: MonthMinutes[],
  pay: MonthPay[],
  rates: Rates = {},
): Map<string, JobRate[]> {
  const months = new Set(minutes.map((m) => m.month));
  const out = new Map<string, JobRate[]>();
  for (const month of months)
    out.set(
      month,
      jobRates(
        minutes.filter((m) => m.month === month),
        pay.filter((p) => p.month === month),
        rates,
      ),
    );
  return out;
}

/** Santim per hour, unrounded; null without pay or hours (never a divide by zero). */
export function exactRate(rate: { pay: Santim; minutes: number }): number | null {
  return rate.pay > 0 && rate.minutes > 0 ? (rate.pay * 60) / rate.minutes : null;
}

const toBirr = (santimPerHour: number): Santim => Math.floor(santimPerHour / 100) * 100;

// --- 1. Pay per worked hour, compared --------------------------------------------

/** A job needs this many worked minutes in the month to be compared. */
export const COMPARE_MIN_MINUTES = 20 * 60;
/** The best job must pay at least this many times the lowest per hour. */
export const COMPARE_MIN_RATIO = 1.2;

export interface RateCompare {
  best: JobRate;
  other: JobRate;
  /** Rounded down to one decimal: 1.66 → 1.6. */
  ratio: number;
}

/** The best and lowest paying job per hour, once both have pay and 20+ hours and differ by 1.2×. */
export function compareRates(month: JobRate[]): RateCompare | null {
  const ranked = month
    .filter((r) => r.minutes >= COMPARE_MIN_MINUTES && exactRate(r) !== null)
    .sort((a, b) => (exactRate(b) ?? 0) - (exactRate(a) ?? 0));
  const best = ranked[0];
  const other = ranked[ranked.length - 1];
  if (!best || !other || best === other) return null;
  const ratio = (exactRate(best) ?? 0) / (exactRate(other) ?? 1);
  // Compared in integers so 1.2 exactly is not lost to floating point.
  if (best.pay * other.minutes * 10 < other.pay * best.minutes * COMPARE_MIN_RATIO * 10)
    return null;
  return { best, other, ratio: Math.floor(ratio * 10 + 1e-9) / 10 };
}

/** The Dashboard line: ratio only, no amounts. */
export function compareText(compare: RateCompare): string {
  return `${compare.best.name} pays ${compare.ratio}× ${compare.other.name} per hour worked.`;
}

/** The Money line: the ratio with each job's birr per hour (rounded down to whole birr). */
export function compareMoneyText(compare: RateCompare): string {
  const birr = (rate: JobRate) => formatAmount(toBirr(exactRate(rate) ?? 0));
  return `${compare.best.name} pays ${compare.ratio}× ${compare.other.name} per hour worked (about ${birr(compare.best)} against ${birr(compare.other)}).`;
}

// --- 2. Rate trend against your 3-month usual ------------------------------------

/** Full months before the last one that make "your usual". */
export const USUAL_MONTHS = 3;
/** A change this size (10%) or more is worth saying. */
export const DRIFT_MIN_PERCENT = 10;

export interface RateDrift {
  areaId: string;
  name: string;
  /** Santim per hour last full month and on average in the 3 months before, rounded down to birr. */
  last: Santim;
  usual: Santim;
  /** Whole percent, rounded down; the sign says up or down. */
  percent: number;
}

/**
 * Each job whose rate last full month moved 10%+ from its average over the 3
 * months before. Every one of those 4 months needs pay and hours.
 */
export function rateDrifts(byMonth: Map<string, JobRate[]>, lastMonth: string): RateDrift[] {
  const out: RateDrift[] = [];
  for (const job of byMonth.get(lastMonth) ?? []) {
    const last = exactRate(job);
    if (last === null) continue;
    const before: number[] = [];
    for (let i = 1; i <= USUAL_MONTHS; i++) {
      const row = byMonth.get(shiftMonth(lastMonth, -i))?.find((r) => r.areaId === job.areaId);
      const rate = row ? exactRate(row) : null;
      if (rate !== null) before.push(rate);
    }
    if (before.length < USUAL_MONTHS) continue;
    const usual = before.reduce((a, b) => a + b, 0) / before.length;
    const change = ((last - usual) * 100) / usual;
    if (Math.abs(change) + 1e-9 < DRIFT_MIN_PERCENT) continue;
    out.push({
      areaId: job.areaId,
      name: job.name,
      last: toBirr(last),
      usual: toBirr(usual),
      percent: Math.sign(change) * Math.floor(Math.abs(change) + 1e-9),
    });
  }
  return out;
}

export function driftText(drift: RateDrift): string {
  const way = drift.percent < 0 ? "fell" : "rose";
  return `${drift.name}'s pay per hour ${way} ${Math.abs(drift.percent)}% against your 3-month usual.`;
}

/** The Money line, with birr per hour. */
export function driftMoneyText(drift: RateDrift): string {
  return `${driftText(drift).slice(0, -1)} (about ${formatAmount(drift.last)} an hour, usually ${formatAmount(drift.usual)}).`;
}

// --- 3. Planned against worked job days ------------------------------------------

/** A job needs this many planned days in the month before its skips are said. */
export const SKIPS_MIN_DAYS = 10;

export interface JobBlockRow {
  area_id: string;
  name: string;
  date: string;
  status: string;
  minutes: number;
}

export interface JobSkips {
  areaId: string;
  name: string;
  days: number;
  /** Days every part of the job was skipped. */
  skippedDays: number;
  plannedMin: number;
  workedMin: number;
}

/** Per job: planned days, days skipped whole, and planned against worked minutes (all parts add up). */
export function jobSkips(rows: JobBlockRow[]): JobSkips[] {
  const jobs = new Map<
    string,
    { name: string; days: Map<string, boolean>; planned: number; worked: number }
  >();
  for (const row of rows) {
    const job = jobs.get(row.area_id) ?? { name: row.name, days: new Map(), planned: 0, worked: 0 };
    const skipped = row.status === "skipped";
    job.days.set(row.date, (job.days.get(row.date) ?? true) && skipped);
    job.planned += row.minutes;
    if (!skipped) job.worked += row.minutes;
    jobs.set(row.area_id, job);
  }
  return [...jobs.entries()]
    .map(([areaId, job]) => ({
      areaId,
      name: job.name,
      days: job.days.size,
      skippedDays: [...job.days.values()].filter(Boolean).length,
      plannedMin: job.planned,
      workedMin: job.worked,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Jobs with 10+ planned days and at least one skipped. */
export function skipInsights(skips: JobSkips[], monthName: string): EffortInsight[] {
  return skips
    .filter((s) => s.days >= SKIPS_MIN_DAYS && s.skippedDays > 0)
    .map((s) => ({
      key: "jobSkips" as const,
      id: `jobSkips-${s.areaId}`,
      text: `${s.name}: ${s.skippedDays} of ${s.days} days skipped in ${monthName} (${hoursLabel(s.workedMin)} of ${hoursLabel(s.plannedMin)} worked).`,
    }));
}

// --- 4. Focus against target, weeks running --------------------------------------

/** Weeks in a row under target before it is said. */
export const GAP_MIN_WEEKS = 3;
/** Under target means under 80% of it (a few minutes short is not a pattern). */
export const UNDER_SHARE = 0.8;

export interface AreaWeekRow {
  id: string;
  name: string;
  target_min: number;
  done_min: number;
  capped?: number | boolean;
}

const under = (row: AreaWeekRow) => row.done_min < row.target_min * UNDER_SHARE;

/**
 * Areas under 80% of their weekly target for 3+ full weeks running, counted
 * back from the latest. `weeks` runs oldest to newest. Capped areas are left
 * out: their target is a ceiling, so under it is fine.
 */
export function areaGaps(weeks: AreaWeekRow[][]): EffortInsight[] {
  const latest = weeks[weeks.length - 1] ?? [];
  const found: { row: AreaWeekRow; run: number }[] = [];
  for (const row of latest) {
    if (row.target_min <= 0 || row.capped) continue;
    let run = 0;
    for (let i = weeks.length - 1; i >= 0; i--) {
      const week = weeks[i]?.find((r) => r.id === row.id);
      if (!week || week.target_min <= 0 || !under(week)) break;
      run++;
    }
    if (run >= GAP_MIN_WEEKS) found.push({ row, run });
  }
  return found
    .sort(
      (a, b) =>
        b.run - a.run || a.row.done_min / a.row.target_min - b.row.done_min / b.row.target_min,
    )
    .slice(0, 2)
    .map(({ row, run }) => ({
      key: "areaGap" as const,
      id: `areaGap-${row.id}`,
      text: `${row.name} got ${hoursLabel(row.done_min)} of its ${hoursLabel(row.target_min)} target last week, ${run} weeks running.`,
    }));
}

// --- Idea 1. Use the gap --------------------------------------------------------

/** A gap between job blocks this long or more counts. */
export const GAP_MIN_MINUTES = 60;
/** Time to get out of the job before a session. */
export const GAP_BUFFER = 15;
/** A short session, so the words say how many fit. */
export const SHORT_SESSION = 20;
/** Weeks the same gap must have gone unused. */
export const GAP_WEEKS = 2;

export interface GapBlock {
  date: string;
  start_at: number;
  end_at: number;
  area_id: string | null;
  /** The job's name, null for any other block. */
  job: string | null;
}

export interface GapSession {
  started_at: number;
  ended_at: number;
}

/** Local minute of the day in Addis. */
const localMinute = (ms: number) =>
  (((Math.floor(ms / 60000) + HOME_UTC_OFFSET_MIN) % 1440) + 1440) % 1440;

const clock = (minute: number) =>
  `${String(Math.floor(minute / 60) % 24).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface DayGap {
  date: string;
  weekday: number;
  start: number; // local minute
  end: number;
  between: string;
  used: boolean;
}

/** The free stretch in each 60+ minute gap between job blocks on a day, after a 15-minute buffer. */
function dayGaps(date: string, blocks: GapBlock[], sessions: GapSession[]): DayGap[] {
  const jobs = blocks.filter((b) => b.job !== null).sort((a, b) => a.start_at - b.start_at);
  const others = blocks.filter((b) => b.job === null);
  const out: DayGap[] = [];
  for (let i = 0; i + 1 < jobs.length; i++) {
    const before = jobs[i];
    const after = jobs[i + 1];
    if (!before || !after) continue;
    if (after.start_at - before.end_at < GAP_MIN_MINUTES * 60000) continue;
    // The free stretches of the gap, other blocks (lunch, a focus block) taken out.
    let stretches: [number, number][] = [[before.end_at + GAP_BUFFER * 60000, after.start_at]];
    for (const other of others)
      stretches = stretches.flatMap(([from, to]): [number, number][] => {
        if (other.end_at <= from || other.start_at >= to) return [[from, to]];
        const parts: [number, number][] = [];
        if (other.start_at > from) parts.push([from, other.start_at]);
        if (other.end_at < to) parts.push([other.end_at, to]);
        return parts;
      });
    const longest = stretches.sort((a, b) => b[1] - b[0] - (a[1] - a[0]))[0];
    if (!longest || longest[1] - longest[0] < SHORT_SESSION * 60000) continue;
    const [from, to] = longest;
    const between =
      before.area_id === after.area_id
        ? `between the parts of ${before.job ?? ""}`
        : `between ${before.job ?? ""} and ${after.job ?? ""}`;
    out.push({
      date,
      weekday: new Date(`${date}T00:00:00Z`).getUTCDay(),
      start: localMinute(from),
      end: localMinute(to),
      between,
      used: sessions.some((s) => s.started_at < to && s.ended_at > from),
    });
  }
  return out;
}

/**
 * Gaps of 60+ minutes between job blocks (two parts of one job, or two jobs)
 * that had no focus session in them on that weekday for 2+ weeks running.
 * `blocks` are the kept blocks of the days before today; one line per gap,
 * the weekdays it falls on grouped.
 */
export function gapInsights(blocks: GapBlock[], sessions: GapSession[]): EffortInsight[] {
  const byDate = new Map<string, GapBlock[]>();
  for (const block of blocks) byDate.set(block.date, [...(byDate.get(block.date) ?? []), block]);
  const gaps = [...byDate.entries()].flatMap(([date, list]) => dayGaps(date, list, sessions));
  // The same gap (time and jobs) on the same weekday, newest dates first.
  const groups = new Map<string, DayGap[]>();
  for (const gap of gaps.sort((a, b) => b.date.localeCompare(a.date))) {
    const key = `${gap.weekday}|${gap.start}|${gap.end}|${gap.between}`;
    groups.set(key, [...(groups.get(key) ?? []), gap]);
  }
  // Unused on the latest 2 weeks of that weekday, a week apart.
  const unused = [...groups.values()].filter((list) => {
    const recent = list.slice(0, GAP_WEEKS);
    if (recent.length < GAP_WEEKS || recent.some((g) => g.used)) return false;
    const first = recent[0];
    const last = recent[recent.length - 1];
    if (!first || !last) return false;
    const days = (Date.parse(first.date) - Date.parse(last.date)) / 86_400_000;
    return days === (GAP_WEEKS - 1) * 7;
  });
  const lines = new Map<string, { gap: DayGap; days: number[] }>();
  for (const list of unused) {
    const gap = list[0];
    if (!gap) continue;
    const key = `${gap.start}|${gap.end}|${gap.between}`;
    const line = lines.get(key) ?? { gap, days: [] };
    line.days.push(gap.weekday);
    lines.set(key, line);
  }
  return [...lines.values()]
    .sort((a, b) => b.days.length - a.days.length || a.gap.start - b.gap.start)
    .slice(0, 1)
    .map(({ gap, days }) => {
      const fit = Math.floor((gap.end - gap.start) / SHORT_SESSION);
      const count = fit >= 2 ? "Two short sessions fit" : "One short session fits";
      const sorted = [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
      const dayText =
        sorted.length === 5 && sorted.every((d) => d >= 1 && d <= 5)
          ? "workdays"
          : sorted.map((d) => WEEKDAYS[d]).join(", ");
      return {
        key: "useGap" as const,
        id: "useGap",
        text: `${count} ${clock(gap.start)}–${clock(gap.end)} on ${dayText}, ${gap.between}. It went unused the last 2 weeks.`,
      };
    });
}
