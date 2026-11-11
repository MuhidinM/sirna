/**
 * At-risk deadlines (plan §3.14, InBoard; R-PRJ-05): an open project whose
 * planned time before its deadline is less than what is left of its
 * estimate. Planned time is its weekly hours over the days left; what is
 * left is the estimate minus the focus time logged on its cards.
 */
import { daysBetween, hoursLabel } from "./capacity";
import { shortDay } from "./idea";

export interface RiskRow {
  id: string;
  title: string;
  deadline: string;
  estimate_min: number;
  weekly_min: number | null;
  start_date: string | null;
  done_min: number;
}

export const AT_RISK_SQL = `
SELECT p.id, p.title, p.deadline, p.estimate_min, p.weekly_min, p.start_date,
       COALESCE((SELECT sum(MAX(0, (f.ended_at - f.started_at - f.paused_ms) / 60000))
                 FROM focus_sessions f JOIN task_items t ON t.id = f.task_id
                 WHERE t.project_id = p.id AND f.kind = 'focus' AND f.ended_at IS NOT NULL), 0)
         AS done_min
FROM project_items p
WHERE p.deleted_at IS NULL AND p.status IN ('active', 'next_up')
  AND p.deadline IS NOT NULL AND p.estimate_min IS NOT NULL
ORDER BY p.deadline`;

export interface Risk {
  id: string;
  title: string;
  deadline: string;
  /** Minutes the plan falls short by before the deadline. */
  shortMin: number;
  overdue: boolean;
}

export function riskOf(row: RiskRow, today: string): Risk | null {
  const left = Math.max(0, row.estimate_min - Math.max(0, row.done_min));
  if (left === 0) return null;
  const from = row.start_date && row.start_date > today ? row.start_date : today;
  const days = daysBetween(from, row.deadline) + 1;
  const overdue = daysBetween(today, row.deadline) < 0;
  const planned = days > 0 ? ((row.weekly_min ?? 0) * days) / 7 : 0;
  const shortMin = Math.ceil(left - planned);
  if (shortMin <= 0) return null;
  return { id: row.id, title: row.title, deadline: row.deadline, shortMin, overdue };
}

export function risks(rows: RiskRow[], today: string): Risk[] {
  return rows.map((row) => riskOf(row, today)).filter((risk): risk is Risk => risk !== null);
}

/** One brief line: the nearest deadline first, then how many more. */
export function riskLine(list: Risk[]): string | null {
  const [first, ...rest] = list;
  if (!first) return null;
  const what = first.overdue
    ? `${first.title} · past ${shortDay(first.deadline)}, ${hoursLabel(first.shortMin)} left`
    : `${first.title} · ${hoursLabel(first.shortMin)} short before ${shortDay(first.deadline)}`;
  return rest.length ? `${what} · +${rest.length} more` : what;
}
