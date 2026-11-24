/** Queries behind the Today screen (plan §3.4). Pure SQL text + small helpers. */
import {
  HOME_UTC_OFFSET_MIN,
  localDate,
  LOGICAL_DAY_START_HOUR,
  logicalDate,
  showDate,
} from "../../kernel/dates";
import { rowCurrencySql } from "../money/currency";
import { formatEstimate } from "../plan/now";
import todayTopSql from "./queries/today_top.sql?raw";

export { todayTopSql };

/** UTC epoch ms when a logical day starts (03:00 local). */
export function logicalDayStart(date: string): number {
  const [y = 0, m = 1, d = 1] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d) + (LOGICAL_DAY_START_HOUR * 60 - HOME_UTC_OFFSET_MIN) * 60 * 1000;
}

export function todayParams(nowMs: number): [string, number] {
  const date = logicalDate(nowMs);
  return [date, logicalDayStart(date)];
}

/** Open tasks due today or earlier that aren't in the top 3. */
export const DUE_SQL = `
  SELECT t.id, t.title, 'todo' AS status, CASE WHEN t.deadline_stale = 1 THEN NULL ELSE t.due_date END AS due_date, t.due_at, t.estimate_min,
         t.area_id, t.planned_date, t.deadline_stale, t.step_no,
         (SELECT count(*) FROM task_items AS step
          WHERE step.parent_id = t.parent_id AND step.deleted_at IS NULL) AS step_total
  FROM task_items t
  WHERE t.deleted_at IS NULL AND t.status = 'todo' AND COALESCE(t.planned_date, t.due_date) <= ?1
    -- A later step waits for the steps before it (T-051).
    AND NOT EXISTS (
      SELECT 1 FROM task_items AS before_step
      WHERE before_step.parent_id = t.parent_id AND before_step.step_no < t.step_no
        AND before_step.status IN ('todo', 'waiting') AND before_step.deleted_at IS NULL)
  ORDER BY CASE WHEN t.deadline_stale = 1 THEN NULL ELSE t.due_date END, CASE WHEN t.due_at IS NULL THEN 1 ELSE 0 END, t.due_at
  LIMIT 20`;

/** Things waiting on someone else. */
export const WAITING_SQL = `
  SELECT id, title, waiting_on, follow_up_date FROM task_items
  WHERE deleted_at IS NULL AND status = 'waiting'
  ORDER BY follow_up_date IS NULL, follow_up_date
  LIMIT 10`;

/** Loose lines from captures, sorted in the night review. */
export const INBOX_SQL = `
  SELECT id, body FROM note_items
  WHERE deleted_at IS NULL AND kind = 'inbox' AND status = 'inbox'
  ORDER BY created_at DESC
  LIMIT 10`;

/**
 * Today's spending per currency, minor units (positive numbers): dollars are
 * not birr, so the screen converts them at the saved rate (F4).
 */
export const SPENT_TODAY_SQL = `
  SELECT ${rowCurrencySql("m")} AS currency, -SUM(m.amount_minor) AS spent
  FROM money_txns m
  LEFT JOIN money_accounts acc ON acc.id = m.account
  WHERE m.deleted_at IS NULL AND m.transfer_id IS NULL AND m.amount_minor < 0 AND m.local_date = ?1
  GROUP BY 1`;

const clock = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Africa/Addis_Ababa",
});

/**
 * The small line under a task on Today: its estimate and when it is due,
 * joined only when both are there. A late task's time takes its date from
 * the moment itself, so 01:00 after midnight reads as that calendar day.
 */
export function taskMeta(
  task: { estimate_min: number | null; due_date: string | null; due_at: number | null },
  today: string,
): string {
  const estimate = task.estimate_min ? formatEstimate(task.estimate_min) : "";
  const overdue = task.due_date !== null && task.due_date < today;
  const when = overdue
    ? task.due_at !== null
      ? `since ${showDate(localDate(task.due_at), today)} ${clock.format(task.due_at)}`
      : `since ${showDate(task.due_date ?? "", today)}`
    : task.due_at !== null
      ? clock.format(task.due_at)
      : task.due_date === today
        ? "due today"
        : "";
  return [estimate, when].filter(Boolean).join(" · ");
}

/** The last capture that can still be undone. */
export const LAST_CAPTURE_SQL = `
  SELECT id, body FROM core_raw_items
  WHERE source = 'capture' AND parse_status NOT IN ('ignored', 'new', 'failed')
  ORDER BY id DESC LIMIT 1`;
