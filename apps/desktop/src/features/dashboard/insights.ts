/**
 * Focus insights (plan §3.14, from Prodly; R-PRG-04): patterns in the last
 * 4 weeks of focus sessions, said only when the numbers clearly show them.
 * Pure and tested; the AI may reword them later, the numbers are these.
 */
import { hoursLabel } from "../projects/capacity";

export interface SessionRow {
  started_at: number;
  minutes: number; // focus minutes, pauses left out
  planned_min: number;
  outcome: string | null; // completed | stopped | interrupted | null (running)
  distractions: number;
}

/** Finished focus sessions since ?1 (ms). */
export const SESSIONS_SQL = `
  SELECT started_at,
         MAX(0, (ended_at - started_at - paused_ms) / 60000) AS minutes,
         planned_min, outcome, distractions
  FROM focus_sessions
  WHERE kind = 'focus' AND ended_at IS NOT NULL AND started_at >= ?1
  ORDER BY started_at`;

export const INSIGHT_DAYS = 28;

export interface Insight {
  key: "window" | "weekday" | "length" | "early";
  text: string;
}

const WINDOWS = [
  { name: "mornings", from: 5, to: 12 },
  { name: "afternoons", from: 12, to: 17 },
  { name: "evenings", from: 17, to: 23 },
  { name: "late nights", from: 23, to: 29 }, // 23:00–05:00
] as const;

/** Local hour in Addis (UTC+3, no summer time). */
export function localHour(ms: number): number {
  return (new Date(ms).getUTCHours() + 3) % 24;
}

function windowOf(ms: number): string {
  const hour = localHour(ms);
  const h = hour < 5 ? hour + 24 : hour;
  return WINDOWS.find((w) => h >= w.from && h < w.to)?.name ?? "late nights";
}

const finished = (s: SessionRow) => s.outcome === "completed";
const rate = (list: SessionRow[]) => (list.length ? list.filter(finished).length / list.length : 0);
const mean = (values: number[]) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
const round1 = (n: number) => Math.round(n * 10) / 10;

const DAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

/** The window's first and last logical dates (inclusive): today and the 27 days before. */
export function insightRange(today: string): { since: number; from: string; to: string } {
  const since = Date.parse(`${today}T00:00:00Z`) - (INSIGHT_DAYS - 1) * 86_400_000;
  return { since, from: new Date(since).toISOString().slice(0, 10), to: today };
}

/** How many times each weekday (0 = Sunday) falls between two dates, inclusive. */
export function weekdayCounts(from: string, to: string): number[] {
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000)
    counts[new Date(t).getUTCDay()] = (counts[new Date(t).getUTCDay()] ?? 0) + 1;
  return counts;
}

export function insights(sessions: SessionRow[], range?: { from: string; to: string }): Insight[] {
  const out: Insight[] = [];

  // 1. The time of day you finish most sessions in (4+ sessions there, a clear gap).
  const byWindow = WINDOWS.map((w) => ({
    name: w.name,
    list: sessions.filter((s) => windowOf(s.started_at) === w.name),
  })).filter((w) => w.list.length >= 4);
  if (byWindow.length >= 2) {
    const ranked = [...byWindow].sort((a, b) => rate(b.list) - rate(a.list));
    const best = ranked[0];
    const worst = ranked[ranked.length - 1];
    if (best && worst && rate(best.list) - rate(worst.list) >= 0.15) {
      const done = best.list.filter(finished).length;
      out.push({
        key: "window",
        text: `Your best focus window: ${best.name} (${done} of ${best.list.length} sessions finished).`,
      });
    }
  }

  // 2. The strongest weekday by average focus, once there are two weeks of it.
  const byDay = new Map<number, Map<string, number>>();
  for (const s of sessions) {
    // The logical day starts 03:00 Addis = 00:00 UTC: its weekday is the UTC weekday.
    const date = new Date(s.started_at);
    const day = date.getUTCDay();
    const key = date.toISOString().slice(0, 10);
    const days = byDay.get(day) ?? new Map<string, number>();
    days.set(key, (days.get(key) ?? 0) + s.minutes);
    byDay.set(day, days);
  }
  // Averages over every such day in the window, days without focus included.
  const counts = range ? weekdayCounts(range.from, range.to) : null;
  const weekdays = [...byDay.entries()]
    .filter(([, days]) => days.size >= 2)
    .map(([day, days]) => {
      const total = [...days.values()].reduce((a, b) => a + b, 0);
      return { day, avg: total / Math.max(days.size, counts?.[day] ?? 0) };
    })
    .sort((a, b) => b.avg - a.avg);
  const top = weekdays[0];
  const second = weekdays[1];
  if (top && second && top.avg >= 60 && top.avg >= second.avg * 1.25) {
    out.push({
      key: "weekday",
      text: `${DAYS[top.day]} are your strongest day (${hoursLabel(Math.round(top.avg))} of focus on average).`,
    });
  }

  // 3. Fewer distractions in shorter sessions.
  const short = sessions.filter((s) => s.planned_min <= 30);
  const long = sessions.filter((s) => s.planned_min > 30);
  if (short.length >= 4 && long.length >= 4) {
    const a = round1(mean(short.map((s) => s.distractions)));
    const b = round1(mean(long.map((s) => s.distractions)));
    if (b - a >= 0.5)
      out.push({
        key: "length",
        text: `You note fewer distractions in short sessions (${a} vs ${b} a session). Try 25 minutes when it's hard to settle.`,
      });
  }

  // 4. Many sessions ending early.
  if (sessions.length >= 6) {
    const early = sessions.filter(
      (s) => s.outcome === "stopped" || s.outcome === "interrupted",
    ).length;
    if (early / sessions.length >= 0.3)
      out.push({
        key: "early",
        text: `${early} of ${sessions.length} sessions ended early. A smaller first step may help them stick.`,
      });
  }

  return out;
}

// --- The week in plain words, when the AI isn't there ---------------------------

export interface WeekNumbers {
  areas: { name: string; done_min: number; target_min: number }[];
  sessions: number;
  overrunDays: number;
  nextWeekPercent: number | null;
}

/** A short template paragraph from the week's numbers (the AI's fallback). */
export function weekSummary(week: WeekNumbers): string {
  const met = week.areas.filter((a) => a.target_min > 0 && a.done_min >= a.target_min);
  const behind = week.areas
    .filter((a) => a.target_min > 0 && a.done_min < a.target_min)
    .sort((a, b) => a.done_min / a.target_min - b.done_min / b.target_min);
  const parts: string[] = [];
  parts.push(`${week.sessions} focus session${week.sessions === 1 ? "" : "s"} this week.`);
  if (met.length) parts.push(`On target: ${met.map((a) => a.name).join(", ")}.`);
  const most = behind[0];
  if (most)
    parts.push(
      `Furthest behind: ${most.name} (${hoursLabel(most.done_min)} of ${hoursLabel(most.target_min)}).`,
    );
  if (week.overrunDays > 0)
    parts.push(`${week.overrunDays} day${week.overrunDays === 1 ? "" : "s"} past the focus cap.`);
  if (week.nextWeekPercent !== null)
    parts.push(`Next week is at ${week.nextWeekPercent}% of your free time.`);
  return parts.join(" ");
}
