/**
 * Projects and their board (plan §3.8, §3.14). Pure and tested: the page only
 * reads with these queries and writes the ops these functions return.
 */
import { type Op } from "../../kernel/db";

export type ProjectStatus = "idea" | "next_up" | "active" | "paused" | "done" | "dropped";

export const PROJECT_STATUSES: { status: ProjectStatus; label: string }[] = [
  { status: "active", label: "Active" },
  { status: "next_up", label: "Next up" },
  { status: "idea", label: "Idea" },
  { status: "paused", label: "Paused" },
  { status: "done", label: "Done" },
  { status: "dropped", label: "Dropped" },
];

export type Column = "todo" | "doing" | "waiting" | "done";

export const COLUMNS: { column: Column; label: string }[] = [
  { column: "todo", label: "To do" },
  { column: "doing", label: "Doing" },
  { column: "waiting", label: "Waiting" },
  { column: "done", label: "Done" },
];

export interface ProjectRow {
  id: string;
  title: string;
  area_id: string | null;
  /** The area's theme colour (work, coding, …). */
  area_color: string | null;
  goal: string | null;
  deadline: string | null;
  weekly_min: number | null;
  estimate_min: number | null;
  start_date: string | null;
  forecast_finish: string | null;
  status: ProjectStatus;
  next_step_task_id: string | null;
  next_step_title: string | null;
  next_step_status: string | null;
  open_count: number;
  done_count: number;
}

/** Active first, then the order of PROJECT_STATUSES, then the deadline. */
export const PROJECTS_SQL = `
SELECT p.id, p.title, p.area_id, a.color AS area_color, p.goal, p.deadline, p.weekly_min,
       p.estimate_min, p.start_date, p.forecast_finish, p.status,
       p.next_step_task_id, n.title AS next_step_title, n.status AS next_step_status,
       (SELECT count(*) FROM task_items t WHERE t.project_id = p.id AND t.deleted_at IS NULL
          AND t.status IN ('todo', 'waiting')) AS open_count,
       (SELECT count(*) FROM task_items t WHERE t.project_id = p.id AND t.deleted_at IS NULL
          AND t.status = 'done') AS done_count
FROM project_items p
LEFT JOIN area_items a ON a.id = p.area_id
LEFT JOIN task_items n ON n.id = p.next_step_task_id AND n.deleted_at IS NULL
WHERE p.deleted_at IS NULL
ORDER BY CASE p.status WHEN 'active' THEN 0 WHEN 'next_up' THEN 1 WHEN 'idea' THEN 2
           WHEN 'paused' THEN 3 WHEN 'done' THEN 4 ELSE 5 END,
         p.deadline IS NULL, p.deadline, p.created_at`;

export interface ProjectTask {
  id: string;
  title: string;
  status: string;
  started_at: number | null;
  completed_at: number | null;
  due_date: string | null;
  waiting_on: string | null;
  area_id: string | null;
}

/** A project's tasks for the board and the list (dropped ones are left out). */
export const PROJECT_TASKS_SQL = `
SELECT id, title, status, started_at, completed_at, due_date, waiting_on, area_id
FROM task_items
WHERE project_id = ? AND deleted_at IS NULL AND status IN ('todo', 'waiting', 'done')
ORDER BY status = 'done', completed_at DESC, due_date IS NULL, due_date, created_at`;

/** The column a task sits in; null for tasks the board doesn't show. */
export function columnOf(task: Pick<ProjectTask, "status" | "started_at">): Column | null {
  if (task.status === "todo") return task.started_at == null ? "todo" : "doing";
  if (task.status === "waiting") return "waiting";
  if (task.status === "done") return "done";
  return null;
}

export function groupBoard(tasks: ProjectTask[]): Record<Column, ProjectTask[]> {
  const board: Record<Column, ProjectTask[]> = { todo: [], doing: [], waiting: [], done: [] };
  for (const task of tasks) {
    const column = columnOf(task);
    if (column) board[column].push(task);
  }
  return board;
}

/** The write that moves a card; nothing when it is already there. */
export function moveOps(task: ProjectTask, to: Column, nowMs: number): Op[] {
  if (columnOf(task) === to) return [];
  const values: Record<string, string | number | null> =
    to === "todo"
      ? { status: "todo", started_at: null, completed_at: null }
      : to === "doing"
        ? { status: "todo", started_at: task.started_at ?? nowMs, completed_at: null }
        : to === "waiting"
          ? { status: "waiting", completed_at: null }
          : { status: "done", completed_at: nowMs };
  return [{ op: "update", table: "task_items", id: task.id, values }];
}

export interface ProjectDraft {
  title: string;
  areaId: string;
  goal: string;
  weeklyHours: string;
  estimateHours: string;
  deadline: string;
  status: ProjectStatus;
  nextStep: string;
}

export const EMPTY_DRAFT: ProjectDraft = {
  title: "",
  areaId: "",
  goal: "",
  weeklyHours: "",
  estimateHours: "",
  deadline: "",
  status: "active",
  nextStep: "",
};

/** The next step still counts while its card is open (To do, Doing or Waiting). */
export function openStep(
  project: Pick<ProjectRow, "next_step_status" | "next_step_title">,
): string {
  return project.next_step_status === "todo" || project.next_step_status === "waiting"
    ? (project.next_step_title ?? "")
    : "";
}

export function draftOf(project: ProjectRow): ProjectDraft {
  return {
    title: project.title,
    areaId: project.area_id ?? "",
    goal: project.goal ?? "",
    weeklyHours:
      project.weekly_min == null ? "" : String(Math.round((project.weekly_min / 60) * 100) / 100),
    estimateHours:
      project.estimate_min == null
        ? ""
        : String(Math.round((project.estimate_min / 60) * 100) / 100),
    deadline: project.deadline ?? "",
    status: project.status,
    nextStep: openStep(project),
  };
}

export const MAX_WEEKLY_HOURS = 40;
export const MAX_ESTIMATE_HOURS = 2000;

/** Hours typed in a field as minutes, or null when empty or not a number. */
export function hoursToMin(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 60) : null;
}

/** YYYY-MM-DD naming a day that exists (no 2026-02-30). */
export function realDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [year, month, day] = text.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** An error to show, or null when the draft can be saved. */
export function checkDraft(draft: ProjectDraft): string | null {
  if (!draft.title.trim()) return "Give the project a name.";
  const hours = draft.weeklyHours.trim();
  if (hours) {
    const value = Number(hours);
    if (!Number.isFinite(value) || value < 0.5 || value > MAX_WEEKLY_HOURS)
      return `Weekly hours: from 0.5 to ${MAX_WEEKLY_HOURS}, or leave it empty.`;
  }
  const estimate = draft.estimateHours.trim();
  if (estimate) {
    const value = Number(estimate);
    if (!Number.isFinite(value) || value <= 0 || value > MAX_ESTIMATE_HOURS)
      return `Estimate: hours from 0 to ${MAX_ESTIMATE_HOURS}.`;
  }
  const deadline = draft.deadline.trim();
  if (deadline && !realDate(deadline)) return "Deadline: a date like 2026-12-20.";
  return null;
}

const orNull = (text: string) => (text.trim() ? text.trim() : null);

/**
 * Writes for a new or edited project. A new next step becomes a To do task on
 * the board and is linked; clearing it unlinks (the task stays).
 */
export function projectOps(
  draft: ProjectDraft,
  existing: ProjectRow | null,
  newId: () => string,
  /** The project's open cards; they follow an area change. */
  openTasks: { id: string; area_id: string | null }[] = [],
  /** Dates and status from the timing check (capacity.ts), when there is one. */
  plan: Partial<
    Record<"start_date" | "forecast_finish" | "weekly_min" | "status", string | number | null>
  > = {},
): { ops: Op[]; projectId: string } {
  const projectId = existing?.id ?? newId();
  const ops: Op[] = [];
  const areaId = orNull(draft.areaId);
  const hours = draft.weeklyHours.trim();
  const step = draft.nextStep.trim();

  // Open cards that were in the project's old area move with it.
  if (existing && existing.area_id !== areaId)
    for (const task of openTasks)
      if (task.area_id === existing.area_id)
        ops.push({ op: "update", table: "task_items", id: task.id, values: { area_id: areaId } });

  let nextStepId: string | null = existing?.next_step_task_id ?? null;
  const currentStep = existing ? openStep(existing) : "";
  if (!step) nextStepId = null;
  else if (step !== currentStep) {
    nextStepId = newId();
    ops.push({
      op: "insert",
      table: "task_items",
      id: nextStepId,
      values: {
        title: step,
        status: "todo",
        project_id: projectId,
        area_id: areaId,
        origin: "project",
      },
    });
  }

  const values = {
    title: draft.title.trim(),
    area_id: areaId,
    goal: orNull(draft.goal),
    weekly_min: hours ? Math.round(Number(hours) * 60) : null,
    estimate_min: hoursToMin(draft.estimateHours),
    estimate_by: hoursToMin(draft.estimateHours) == null ? null : "user",
    deadline: orNull(draft.deadline),
    status: draft.status,
    next_step_task_id: nextStepId,
    ...plan,
  };
  // The project row goes last: its next step must exist first.
  ops.push(
    existing
      ? { op: "update", table: "project_items", id: projectId, values }
      : {
          op: "insert",
          table: "project_items",
          id: projectId,
          values: { ...values, origin: "user" },
        },
  );
  return { ops, projectId };
}

/** A new To do card on a project's board. */
export function addTaskOp(
  project: Pick<ProjectRow, "id" | "area_id">,
  title: string,
  id: string,
): Op {
  return {
    op: "insert",
    table: "task_items",
    id,
    values: {
      title: title.trim(),
      status: "todo",
      project_id: project.id,
      area_id: project.area_id,
      origin: "project",
    },
  };
}

/** "2 h 30 / week", or "" when not set. */
export function weeklyLabel(minutes: number | null): string {
  if (!minutes) return "";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours ? `${hours} h` : ""}${hours && rest ? " " : ""}${rest ? `${rest} min` : ""} / week`;
}
