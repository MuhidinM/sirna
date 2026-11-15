/**
 * Work tasks inside job blocks (T-067; proposal 4.1). The planner fills only
 * free time, so a task tagged with a job (`#joba`) never got a block. Today
 * now lists each job's open tasks under that job's block: deadline first, then
 * the day you planned it, then the oldest. Any work area is a job. Pure.
 */

/**
 * Open tasks of every work area, on a day up to a week ahead or with no day
 * at all (?1 = the logical date a week from today). A later step of a split
 * task waits for the steps before it.
 */
export const JOB_TASKS_SQL = `
  SELECT t.id, t.title, t.area_id, t.status,
         CASE WHEN t.deadline_stale = 1 THEN NULL ELSE t.due_date END AS due_date,
         t.planned_date, t.created_at
  FROM task_items t
  JOIN area_items a ON a.id = t.area_id AND a.kind = 'work' AND a.deleted_at IS NULL
  WHERE t.deleted_at IS NULL AND t.status = 'todo'
    AND (COALESCE(t.planned_date, t.due_date) IS NULL OR COALESCE(t.planned_date, t.due_date) <= ?1)
    AND NOT EXISTS (
      SELECT 1 FROM task_items AS before_step
      WHERE before_step.parent_id = t.parent_id AND before_step.step_no < t.step_no
        AND before_step.status IN ('todo', 'waiting') AND before_step.deleted_at IS NULL)`;

export interface JobTask {
  id: string;
  title: string;
  area_id: string;
  status: string;
  due_date: string | null;
  planned_date: string | null;
  created_at: number;
}

export const JOB_TASKS_SHOWN = 5;

/** Deadline first (none last), then planned day, then oldest; at most 5 per job. */
export function tasksByJob(rows: JobTask[]): Map<string, JobTask[]> {
  const sorted = [...rows].sort(
    (a, b) =>
      (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999") ||
      (a.planned_date ?? "9999").localeCompare(b.planned_date ?? "9999") ||
      a.created_at - b.created_at,
  );
  const byJob = new Map<string, JobTask[]>();
  for (const task of sorted) {
    const list = byJob.get(task.area_id) ?? [];
    if (list.length < JOB_TASKS_SHOWN) list.push(task);
    byJob.set(task.area_id, list);
  }
  return byJob;
}

/**
 * Which block shows a job's list: the first of that job's blocks that hasn't
 * ended (so the list sits where you'll work), or none once they all have.
 */
export function listBlockIds(
  blocks: { id: string; area_id: string | null; kind: string; end_at: number }[],
  jobs: Set<string>,
  nowMs: number,
): Set<string> {
  const chosen = new Set<string>();
  const seen = new Set<string>();
  for (const block of [...blocks].sort((a, b) => a.end_at - b.end_at)) {
    if (!block.area_id || !jobs.has(block.area_id) || block.kind === "rest") continue;
    if (seen.has(block.area_id) || block.end_at <= nowMs) continue;
    seen.add(block.area_id);
    chosen.add(block.id);
  }
  return chosen;
}
