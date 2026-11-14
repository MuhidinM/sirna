/**
 * The Tasks page: every task in one place, to find, edit, finish, park or
 * bring back (plan §3.5 captures land here too). Pure and tested.
 */
import { type Op } from "../../kernel/db";
import { realDate } from "../projects/projects";

export type TaskView = "open" | "waiting" | "someday" | "done" | "dropped";

export const VIEWS: { view: TaskView; label: string; statuses: string[] }[] = [
  { view: "open", label: "To do", statuses: ["todo"] },
  { view: "waiting", label: "Waiting", statuses: ["waiting"] },
  { view: "someday", label: "Someday", statuses: ["someday"] },
  { view: "done", label: "Done", statuses: ["done"] },
  { view: "dropped", label: "Dropped", statuses: ["dropped", "archived"] },
];

export interface TaskListRow {
  id: string;
  title: string;
  status: string;
  notes: string | null;
  due_date: string | null;
  planned_date: string | null;
  deadline_stale: number;
  estimate_min: number | null;
  area_id: string | null;
  area_name: string | null;
  area_color: string | null;
  project_id: string | null;
  project_title: string | null;
  waiting_on: string | null;
  follow_up_date: string | null;
  completed_at: number | null;
  updated_at: number;
}

/** ?1 status list as JSON; done and dropped show the last 60 days. */
export const TASKS_SQL = `
SELECT t.id, t.title, t.status, t.notes, t.due_date, t.planned_date, t.deadline_stale,
       t.estimate_min, t.area_id,
       a.name AS area_name, a.color AS area_color, t.project_id, p.title AS project_title,
       t.waiting_on, t.follow_up_date, t.completed_at, t.updated_at
FROM task_items t
LEFT JOIN area_items a ON a.id = t.area_id
LEFT JOIN project_items p ON p.id = t.project_id AND p.deleted_at IS NULL
WHERE t.deleted_at IS NULL
  AND t.status IN (SELECT value FROM json_each(?1))
  AND (t.status NOT IN ('done', 'dropped', 'archived') OR t.updated_at >= ?2)
ORDER BY t.due_date IS NULL, t.due_date, t.follow_up_date, t.created_at DESC
LIMIT 500`;

export const COUNTS_SQL = `
SELECT status, count(*) AS n FROM task_items
WHERE deleted_at IS NULL AND (status NOT IN ('done', 'dropped', 'archived') OR updated_at >= ?1)
GROUP BY status`;

export const KEEP_DAYS = 60;

export function viewParams(view: TaskView, nowMs: number): [string, number] {
  const statuses = VIEWS.find((v) => v.view === view)?.statuses ?? ["todo"];
  return [JSON.stringify(statuses), nowMs - KEEP_DAYS * 86_400_000];
}

/** Search in the title, notes, area, project and waiting-on; an area filter on top. */
export function filterTasks(rows: TaskListRow[], text: string, areaId: string): TaskListRow[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((row) => {
    if (areaId === "none" ? row.area_id !== null : areaId && row.area_id !== areaId) return false;
    const hay = [row.title, row.notes, row.area_name, row.project_title, row.waiting_on]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return words.every((word) => hay.includes(word));
  });
}

export interface TaskDraft {
  title: string;
  status: "todo" | "waiting" | "someday" | "done";
  areaId: string;
  projectId: string;
  due: string;
  estimateHours: string;
  waitingOn: string;
  followUp: string;
  notes: string;
}

export function taskDraftOf(row: TaskListRow): TaskDraft {
  return {
    title: row.title,
    status:
      row.status === "waiting" || row.status === "someday" || row.status === "done"
        ? row.status
        : "todo",
    areaId: row.area_id ?? "",
    projectId: row.project_id ?? "",
    due: row.due_date ?? "",
    estimateHours:
      row.estimate_min == null ? "" : String(Math.round((row.estimate_min / 60) * 100) / 100),
    waitingOn: row.waiting_on ?? "",
    followUp: row.follow_up_date ?? "",
    notes: row.notes ?? "",
  };
}

export function checkTask(draft: TaskDraft): string | null {
  if (!draft.title.trim()) return "Give the task a name.";
  if (draft.due && !realDate(draft.due)) return "Due: a date like 2026-11-20.";
  if (draft.followUp && !realDate(draft.followUp)) return "Follow up: a date like 2026-11-20.";
  const hours = draft.estimateHours.trim();
  if (hours) {
    const value = Number(hours);
    if (!Number.isFinite(value) || value <= 0 || value > 200)
      return "Estimate: hours from 0 to 200.";
  }
  if (draft.status === "waiting" && !draft.waitingOn.trim()) return "Waiting on whom?";
  return null;
}

const orNull = (text: string) => (text.trim() ? text.trim() : null);

/**
 * The update for an edited task. A changed due date clears an old reminder
 * time (it belonged to the old date) and the planned day, so the task sits on
 * the date you just typed; saving the form confirms the deadline (T-050).
 * Waiting fields only stay while waiting.
 */
export function taskEditOps(row: TaskListRow, draft: TaskDraft, nowMs: number): Op[] {
  const hours = draft.estimateHours.trim();
  const waiting = draft.status === "waiting";
  const values: Record<string, string | number | null> = {
    title: draft.title.trim(),
    status: draft.status,
    area_id: orNull(draft.areaId),
    project_id: orNull(draft.projectId),
    due_date: orNull(draft.due),
    estimate_min: hours ? Math.round(Number(hours) * 60) : null,
    waiting_on: waiting ? orNull(draft.waitingOn) : null,
    follow_up_date: waiting ? orNull(draft.followUp) : null,
    notes: orNull(draft.notes),
    deadline_stale: 0,
  };
  if ((orNull(draft.due) ?? null) !== row.due_date) {
    values.due_at = null;
    values.remind_at = null;
    values.planned_date = null;
  }
  if (draft.status !== "todo") values.started_at = null;
  // Finished stays finished on a title fix; a status change sets or clears the time.
  if (draft.status === "done" && row.status !== "done") values.completed_at = nowMs;
  if (draft.status !== "done" && row.status === "done") values.completed_at = null;
  return [{ op: "update", table: "task_items", id: row.id, values }];
}

/** Done, back to do, someday, drop or restore, in one write. */
export function statusOps(
  row: Pick<TaskListRow, "id">,
  to: "done" | "todo" | "someday" | "dropped",
  nowMs: number,
): Op[] {
  return [
    {
      op: "update",
      table: "task_items",
      id: row.id,
      values: {
        status: to,
        completed_at: to === "done" ? nowMs : null,
        ...(to === "todo" ? {} : { started_at: null }),
      },
    },
  ];
}
