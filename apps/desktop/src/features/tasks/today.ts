/** Queries behind the Today screen (plan §3.4). Pure SQL text + small helpers. */
import { HOME_UTC_OFFSET_MIN, LOGICAL_DAY_START_HOUR, logicalDate } from "../../kernel/dates";
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
  SELECT id, title, 'todo' AS status, due_date, due_at, estimate_min, area_id FROM task_items
  WHERE deleted_at IS NULL AND status = 'todo' AND due_date <= ?1
  ORDER BY due_date, CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at
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

/** Today's spending, santim (positive number). */
export const SPENT_TODAY_SQL = `
  SELECT COALESCE(-SUM(amount_minor), 0) AS spent FROM money_txns
  WHERE deleted_at IS NULL AND amount_minor < 0 AND local_date = ?1`;

/** The last capture that can still be undone. */
export const LAST_CAPTURE_SQL = `
  SELECT id, body FROM core_raw_items
  WHERE source = 'capture' AND parse_status NOT IN ('ignored', 'new')
  ORDER BY id DESC LIMIT 1`;
