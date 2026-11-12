/**
 * The morning brief (plan §3.4): at most 12 lines, empty sections hidden, no
 * questions. Pure: the screen and the tests feed it rows and get lines back.
 */
import { logicalDate } from "../../kernel/dates";
import { logicalDayStart } from "../tasks/today";
import { type BlockRow, formatMinutes, nowAndNext } from "../plan/now";
import { type ChangedCounts, changedText } from "./changed";

export const MAX_LINES = 12;

export interface BriefTask {
  title: string;
  due_date: string | null;
}

export interface BriefArea {
  id: string;
  name: string;
  target_min: number;
  done_min: number;
}

export interface BriefChecks {
  notificationsMuted: boolean;
  autostartOff: boolean;
}

export interface BriefInput {
  nowMs: number;
  today: string;
  blocks: BlockRow[];
  top: BriefTask[];
  week: BriefArea[];
  checks: BriefChecks;
  /** Minutes after midnight, from setup. */
  wakeMin: number;
  hardStopMin: number;
  /** What changed since yesterday (T-030); the line is hidden when nothing did. */
  changed?: ChangedCounts | undefined;
  /** Projects whose plan falls short of their deadline (T-035). */
  atRisk?: string | null;
  /** The first focus insight, if any (T-042). */
  insight?: string | null;
}

export interface BriefLine {
  /** "NOW", "TOP 3", …; empty for a continuation line. */
  label: string;
  text: string;
  meta?: string | undefined;
  tone?: "warn";
}

const clock = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Africa/Addis_Ababa",
});
const day = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "short",
  timeZone: "Africa/Addis_Ababa",
});

const minutesOf = (block: BlockRow) => Math.round((block.end_at - block.start_at) / 60000);

/** "08–12" for whole hours, else "17:30". */
function shortTime(ms: number): string {
  const text = clock.format(ms);
  return text.endsWith(":00") ? text.slice(0, 2) : text;
}

/** How full the day is, from planned minutes against free minutes. */
export function loadLabel(plannedMin: number, freeMin: number): string {
  if (freeMin <= 0) return plannedMin > 0 ? "over" : "free";
  const ratio = plannedMin / freeMin;
  if (ratio < 0.6) return "light";
  if (ratio < 0.85) return "steady";
  if (ratio <= 1) return "full";
  return "over";
}

/** "1 h 30 / 4 h" with a bare "0" for nothing yet. */
function progress(doneMin: number, targetMin: number): string {
  return `${doneMin === 0 ? "0" : formatMinutes(doneMin)} / ${formatMinutes(targetMin)}`;
}

export function buildBrief(input: BriefInput): BriefLine[] {
  const lines: BriefLine[] = [];
  lines.push({ label: "", text: day.format(input.nowMs), meta: clock.format(input.nowMs) });

  if (input.checks.notificationsMuted)
    lines.push({
      label: "CHECK",
      text: "Windows notifications are off for Sirna; reminders won't show.",
      tone: "warn",
    });
  if (input.checks.autostartOff)
    lines.push({
      label: "CHECK",
      text: "Sirna won't start with Windows; the brief can't find you.",
      tone: "warn",
    });

  const live = input.blocks.filter((block) => block.status !== "skipped");
  const { now, next } = nowAndNext(live, input.nowMs);
  const shown = now ?? next;
  if (shown)
    lines.push({
      label: now ? "NOW" : "NEXT",
      text: `${shown.title} · ${clock.format(shown.start_at)}–${clock.format(shown.end_at)}`,
    });

  input.top.slice(0, 3).forEach((task, index) => {
    const due =
      task.due_date === null
        ? undefined
        : task.due_date < input.today
          ? `since ${task.due_date}`
          : task.due_date === input.today
            ? "due today"
            : undefined;
    lines.push({ label: index === 0 ? "TOP 3" : "", text: task.title, meta: due });
  });

  const ahead = live.filter((block) => block.kind !== "rest" && block.end_at > input.nowMs);
  if (ahead.length > 0) {
    const parts = ahead.slice(0, 5).map((block) => {
      const range =
        block.kind === "fixed"
          ? `${shortTime(block.start_at)}–${shortTime(block.end_at)}`
          : clock.format(block.start_at);
      return `${range} ${block.title}`;
    });
    if (ahead.length > 5) parts.push(`+${ahead.length - 5}`);
    lines.push({ label: "TODAY", text: parts.join(" · ") });
  }

  // Free = waking day minus fixed work; planned = everything else on the plan.
  const fixedMin = live.filter((b) => b.kind === "fixed").reduce((s, b) => s + minutesOf(b), 0);
  const plannedMin = live
    .filter((b) => b.kind === "area" || b.kind === "routine")
    .reduce((s, b) => s + minutesOf(b), 0);
  const freeMin = Math.max(0, input.hardStopMin - input.wakeMin - fixedMin);
  if (plannedMin > 0)
    lines.push({
      label: "LOAD",
      text: `${formatMinutes(plannedMin)} planned of ${formatMinutes(freeMin)} free · ${loadLabel(plannedMin, freeMin)}`,
    });

  // The three areas furthest behind their weekly target.
  const behind = input.week
    .filter((area) => area.target_min > 0)
    .sort((a, b) => a.done_min / a.target_min - b.done_min / b.target_min)
    .slice(0, 3);
  if (behind.length > 0)
    lines.push({
      label: "THIS WEEK",
      text: behind
        .map((area) => `${area.name} ${progress(area.done_min, area.target_min)}`)
        .join(" · "),
    });

  if (input.atRisk) lines.push({ label: "AT RISK", text: input.atRisk });

  const changed = changedText(input.changed);
  if (changed) lines.push({ label: "CHANGED", text: changed });
  // Last, so it is the line dropped when the brief is full.
  if (input.insight) lines.push({ label: "INSIGHT", text: input.insight });

  return lines.slice(0, MAX_LINES);
}

/** UTC ms when the logical week (Monday 03:00) containing `nowMs` began. */
export function weekStart(nowMs: number): number {
  const today = logicalDate(nowMs);
  const [y = 0, m = 1, d = 1] = today.split("-").map(Number);
  const weekday = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // Monday = 0
  const monday = new Date(Date.UTC(y, m - 1, d - weekday)).toISOString().slice(0, 10);
  return logicalDayStart(monday);
}

/**
 * Minutes done per growth, health and faith area this week: focused minutes
 * from sessions, plus routine blocks marked done (Quran, gym).
 * ?1 week start, ?2 now (for a session still running).
 */
export const WEEK_SQL = `
  SELECT a.id, a.name, a.weekly_target_min AS target_min,
         COALESCE((
           SELECT SUM(MAX(0, (COALESCE(f.ended_at, ?2) - f.started_at - f.paused_ms) / 60000))
           FROM focus_sessions AS f
           LEFT JOIN day_blocks AS fb ON fb.id = f.block_id
           WHERE f.kind = 'focus' AND f.started_at >= ?1
             AND COALESCE(f.area_id, fb.area_id) = a.id
         ), 0)
       + COALESCE((
           SELECT SUM((b.end_at - b.start_at) / 60000)
           FROM day_blocks AS b
           WHERE b.deleted_at IS NULL AND b.kind = 'routine' AND b.status = 'done'
             AND b.area_id = a.id AND b.start_at >= ?1
         ), 0) AS done_min
  FROM area_items AS a
  WHERE a.deleted_at IS NULL AND a.active = 1 AND a.kind != 'work' AND a.weekly_target_min > 0
  ORDER BY a.priority_rank`;

/** The setting that records the day the brief was put away. */
export const BRIEF_DISMISSED_KEY = "brief.dismissed";
