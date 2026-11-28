/**
 * Focus time shared fairly between a run's lanes (T-084, R-RUN-01). The split
 * itself is the view v_focus_share (migration 0030): each moment of a run goes
 * to the lanes running then, idle moments to all the run's tasks, and a
 * session from before runs counts in full for its own task and area.
 */
import { query } from "../../kernel/db";

/** Shared focus minutes per task, every ended session so far. */
export const TASK_SHARE_SQL = `
  SELECT task_id, SUM(minutes) AS minutes FROM v_focus_share
  WHERE task_id IS NOT NULL GROUP BY task_id`;

/**
 * Pay per focused hour, for the switch to open days (#200): each job's shared
 * focus minutes between the logical dates ?1 and ?2, sessions started before
 * ?3 (now). Same columns as JOB_MINUTES_SQL in money/rate.ts, so jobRates
 * takes either. A session's logical date is its UTC date (the day starts at
 * 03:00 Addis, which is midnight UTC).
 */
export const JOB_SHARE_MINUTES_SQL = `
  SELECT s.area_id, a.name, CAST(ROUND(SUM(s.minutes)) AS INTEGER) AS minutes
  FROM v_focus_share AS s
  JOIN area_items AS a ON a.id = s.area_id AND a.kind = 'work'
  WHERE date(s.started_at / 1000, 'unixepoch') >= ?1
    AND date(s.started_at / 1000, 'unixepoch') <= ?2
    AND s.started_at < ?3
  GROUP BY s.area_id
  HAVING SUM(s.minutes) > 0`;

export type JobMinutes = {
  area_id: string;
  name: string;
  minutes: number;
};

/** Each job's shared focus minutes from `from` to `to` (logical dates, inclusive). */
export function loadJobShareMinutes(from: string, to: string, now: number): Promise<JobMinutes[]> {
  return query<JobMinutes>(JOB_SHARE_MINUTES_SQL, [from, to, now]);
}
