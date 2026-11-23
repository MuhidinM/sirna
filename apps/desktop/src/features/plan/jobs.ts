/**
 * Tasks inside area blocks (T-067; proposal 4.1; time first §1 rule 6). The
 * planner fills only free time, so a task tagged with a job (`#joba`) never got
 * a block. Today lists each area's open tasks under that area's block (Job A,
 * Quran, Gym and focus blocks alike): deadline first, then the day you planned
 * it, then the oldest. Pure.
 */

/**
 * Open tasks of every area, on a day up to a week ahead or with no day at all
 * (?1 = the logical date a week from today). A later step of a split task
 * waits for the steps before it.
 */
export const AREA_TASKS_SQL = `
  SELECT t.id, t.title, t.area_id, t.status,
         CASE WHEN t.deadline_stale = 1 THEN NULL ELSE t.due_date END AS due_date,
         t.planned_date, t.created_at
  FROM task_items t
  JOIN area_items a ON a.id = t.area_id AND a.deleted_at IS NULL
  WHERE t.deleted_at IS NULL AND t.status = 'todo'
    AND (COALESCE(t.planned_date, t.due_date) IS NULL OR COALESCE(t.planned_date, t.due_date) <= ?1)
    AND NOT EXISTS (
      SELECT 1 FROM task_items AS before_step
      WHERE before_step.parent_id = t.parent_id AND before_step.step_no < t.step_no
        AND before_step.status IN ('todo', 'waiting') AND before_step.deleted_at IS NULL)`;

/** The old name: every area's tasks now, not only jobs'. */
export const JOB_TASKS_SQL = AREA_TASKS_SQL;

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

/**
 * Deadline first (none last), then planned day, then oldest; at most 5 per
 * area. `skip`: tasks already shown elsewhere (a task's own block today).
 */
export function tasksByJob(rows: JobTask[], skip: Set<string> = new Set()): Map<string, JobTask[]> {
  const sorted = rows
    .filter((row) => !skip.has(row.id))
    .sort(
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

export const tasksByArea = tasksByJob;

/**
 * Which block shows an area's list: the first of that area's blocks that
 * hasn't ended (so the list sits where you'll work), or none once they all
 * have. A task's own block (task_id set, not a focus block's pick) holds
 * the list only when the area has no other block left. `areas` limits it to
 * some areas; leave it out for every area (rule 6).
 */
export function listBlockIds(
  blocks: {
    id: string;
    area_id: string | null;
    kind: string;
    end_at: number;
    task_id?: string | null;
    title?: string;
    task_title?: string | null;
  }[],
  areas: Set<string> | undefined,
  nowMs: number,
): Set<string> {
  const taskOwn = (block: (typeof blocks)[number]) =>
    !!block.task_id && block.title !== undefined && block.title === block.task_title;
  const chosen = new Map<string, { id: string; own: boolean }>();
  for (const block of [...blocks].sort((a, b) => a.end_at - b.end_at)) {
    if (!block.area_id || block.kind === "rest" || block.end_at <= nowMs) continue;
    if (areas && !areas.has(block.area_id)) continue;
    const had = chosen.get(block.area_id);
    const own = taskOwn(block);
    if (!had || (had.own && !own)) chosen.set(block.area_id, { id: block.id, own });
  }
  return new Set([...chosen.values()].map((pick) => pick.id));
}
