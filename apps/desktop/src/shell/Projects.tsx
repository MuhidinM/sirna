import { useState } from "react";

import { systemClock } from "../kernel/clock";
import { transact } from "../kernel/db";
import { ulid } from "../kernel/ulid";
import {
  addTaskOp,
  checkDraft,
  type Column,
  COLUMNS,
  columnOf,
  draftOf,
  EMPTY_DRAFT,
  groupBoard,
  moveOps,
  openStep,
  type ProjectDraft,
  type ProjectRow,
  projectOps,
  PROJECT_STATUSES,
  PROJECT_TASKS_SQL,
  PROJECTS_SQL,
  type ProjectTask,
  weeklyLabel,
} from "../features/projects/projects";
import { type AreaColor, Button, Chip } from "./ui";
import { useLiveQuery } from "./useLiveQuery";

/** Every area, so a project keeps showing one that was later turned off. */
const AREAS_SQL =
  "SELECT id, name, active FROM area_items WHERE deleted_at IS NULL ORDER BY priority_rank, name";

type Area = { id: string; name: string; active: number };

const statusLabel = (status: string) =>
  PROJECT_STATUSES.find((entry) => entry.status === status)?.label ?? status;
const columnLabel = (column: Column | null) =>
  COLUMNS.find((entry) => entry.column === column)?.label ?? "";
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function ProjectForm({
  project,
  areas,
  openTasks = [],
  onSaved,
  onCancel,
}: {
  project: ProjectRow | null;
  openTasks?: ProjectTask[];
  areas: Area[];
  onSaved: (id: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<ProjectDraft>(project ? draftOf(project) : EMPTY_DRAFT);
  const [error, setError] = useState<string | null>(null);
  const set = (change: Partial<ProjectDraft>) => {
    setError(null);
    setDraft({ ...draft, ...change });
  };
  return (
    <form
      className="card project-form"
      onSubmit={(event) => {
        event.preventDefault();
        const problem = checkDraft(draft);
        if (problem) {
          setError(problem);
          return;
        }
        const { ops, projectId } = projectOps(draft, project, () => ulid(), openTasks);
        transact("user", ops, `project:${projectId}`)
          .then(() => onSaved(projectId))
          .catch((failure: unknown) => setError(`Couldn't save: ${message(failure)}`));
      }}
    >
      <h2>{project ? "Edit project" : "New project"}</h2>
      <label className="field">
        <span>Name</span>
        <input value={draft.title} onChange={(e) => set({ title: e.target.value })} />
      </label>
      <label className="field">
        <span>Next step</span>
        <input
          value={draft.nextStep}
          placeholder="The very next thing to do; it goes on the board"
          onChange={(e) => set({ nextStep: e.target.value })}
        />
      </label>
      <div className="row">
        <label className="field">
          <span>Area</span>
          <select value={draft.areaId} onChange={(e) => set({ areaId: e.target.value })}>
            <option value="">None</option>
            {areas
              .filter((area) => area.active === 1 || area.id === draft.areaId)
              .map((area) => (
                <option key={area.id} value={area.id}>
                  {area.name}
                  {area.active === 1 ? "" : " (off)"}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          <span>Hours a week</span>
          <input
            inputMode="decimal"
            value={draft.weeklyHours}
            placeholder="e.g. 2.5"
            onChange={(e) => set({ weeklyHours: e.target.value })}
          />
        </label>
        <label className="field">
          <span>Deadline (optional)</span>
          <input
            type="date"
            value={draft.deadline}
            onChange={(e) => set({ deadline: e.target.value })}
          />
        </label>
        <label className="field">
          <span>Status</span>
          <select
            value={draft.status}
            onChange={(e) => set({ status: e.target.value as ProjectDraft["status"] })}
          >
            {PROJECT_STATUSES.map(({ status, label }) => (
              <option key={status} value={status}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        <span>Goal (optional)</span>
        <textarea rows={2} value={draft.goal} onChange={(e) => set({ goal: e.target.value })} />
      </label>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="row">
        <Button type="submit" primary>
          Save
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

function Card({ task, onMove }: { task: ProjectTask; onMove: (to: Column) => void }) {
  const column = columnOf(task);
  return (
    <li
      className="board-card"
      draggable
      onDragStart={(event) => event.dataTransfer.setData("text/plain", task.id)}
    >
      <span>{task.title}</span>
      {task.waiting_on && <span className="meta">Waiting on {task.waiting_on}</span>}
      {task.due_date && <span className="meta">Due {task.due_date}</span>}
      <select
        aria-label={`Move "${task.title}"`}
        value={column ?? ""}
        onChange={(event) => onMove(event.target.value as Column)}
      >
        {COLUMNS.map((entry) => (
          <option key={entry.column} value={entry.column}>
            {entry.label}
          </option>
        ))}
      </select>
    </li>
  );
}

function Board({ project, tasks }: { project: ProjectRow; tasks: ProjectTask[] }) {
  const board = groupBoard(tasks);
  const [newCard, setNewCard] = useState("");
  const [error, setError] = useState<string | null>(null);
  const move = (task: ProjectTask, to: Column) =>
    transact("user", moveOps(task, to, systemClock.now()), `project:${project.id}`).catch(
      (failure: unknown) => setError(`Couldn't move it: ${message(failure)}`),
    );
  return (
    <>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="board">
        {COLUMNS.map(({ column, label }) => (
          <section
            key={column}
            className="board-column"
            aria-label={label}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const task = tasks.find((t) => t.id === event.dataTransfer.getData("text/plain"));
              if (task) void move(task, column);
            }}
          >
            <h3>
              {label} <span className="meta">{board[column].length}</span>
            </h3>
            <ul>
              {board[column].map((task) => (
                <Card key={task.id} task={task} onMove={(to) => void move(task, to)} />
              ))}
            </ul>
            {column === "todo" && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!newCard.trim()) return;
                  transact("user", [addTaskOp(project, newCard, ulid())], `project:${project.id}`)
                    .then(() => setNewCard(""))
                    .catch((failure: unknown) => setError(`Couldn't add it: ${message(failure)}`));
                }}
              >
                <input
                  value={newCard}
                  placeholder="Add a card"
                  aria-label="Add a card to To do"
                  onChange={(event) => setNewCard(event.target.value)}
                />
              </form>
            )}
          </section>
        ))}
      </div>
    </>
  );
}

function List({ tasks }: { tasks: ProjectTask[] }) {
  if (tasks.length === 0) return <p className="meta">No cards yet.</p>;
  return (
    <table className="project-list">
      <thead>
        <tr>
          <th>Card</th>
          <th>Column</th>
          <th>Due</th>
        </tr>
      </thead>
      <tbody>
        {tasks.map((task) => (
          <tr key={task.id}>
            <td>{task.title}</td>
            <td>{columnLabel(columnOf(task))}</td>
            <td>{task.due_date ?? ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ProjectView({ project, areas }: { project: ProjectRow; areas: Area[] }) {
  const tasks = useLiveQuery<ProjectTask & Record<string, string | number | null>>(
    PROJECT_TASKS_SQL,
    [project.id],
  );
  const [tab, setTab] = useState<"board" | "list">("board");
  const [editing, setEditing] = useState(false);
  if (editing)
    return (
      <ProjectForm
        project={project}
        areas={areas}
        openTasks={tasks.rows.filter((task) => task.status !== "done")}
        onSaved={() => setEditing(false)}
        onCancel={() => setEditing(false)}
      />
    );
  const nextDone = project.next_step_task_id && project.next_step_status === "done";
  return (
    <section className="project-view">
      <header className="row">
        <h2>{project.title}</h2>
        <Chip area={(project.area_color ?? "admin") as AreaColor}>
          {statusLabel(project.status)}
        </Chip>
        <span className="meta">{weeklyLabel(project.weekly_min)}</span>
        {project.deadline && <span className="meta">by {project.deadline}</span>}
        <Button onClick={() => setEditing(true)}>Edit</Button>
      </header>
      {project.goal && <p className="meta">{project.goal}</p>}
      <p>
        {openStep(project) ? (
          <>
            <strong>Next step:</strong> {project.next_step_title}
            {project.next_step_status === "waiting" && <span className="meta"> · waiting</span>}
          </>
        ) : (
          <span className="meta">
            {nextDone
              ? "Next step done. What's the next one? (Edit)"
              : "No next step. Add one with Edit."}
          </span>
        )}
      </p>
      <div className="row" role="tablist" aria-label="View">
        {(["board", "list"] as const).map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            className={tab === name ? "step current" : "step"}
            onClick={() => setTab(name)}
          >
            {name === "board" ? "Board" : "List"}
          </button>
        ))}
      </div>
      {tasks.error && (
        <p role="alert" className="error">
          Couldn&apos;t load the cards: {tasks.error}
        </p>
      )}
      {!tasks.loading &&
        (tab === "board" ? (
          <Board project={project} tasks={tasks.rows} />
        ) : (
          <List tasks={tasks.rows} />
        ))}
    </section>
  );
}

/** Projects with a board and a list (plan §3.8, §3.14; R-PRJ-03). */
export function Projects() {
  const projects = useLiveQuery<ProjectRow & Record<string, string | number | null>>(PROJECTS_SQL);
  const areas = useLiveQuery<Area>(AREAS_SQL);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const current = projects.rows.find((p) => p.id === selected) ?? projects.rows[0] ?? null;

  return (
    <main className="projects">
      <header className="review-head">
        <h1>Projects</h1>
        <Button primary onClick={() => setCreating(true)}>
          New project
        </Button>
      </header>
      {projects.error && (
        <p role="alert" className="error">
          Couldn&apos;t load projects: {projects.error}
        </p>
      )}
      {creating && (
        <ProjectForm
          project={null}
          areas={areas.rows}
          onSaved={(id) => {
            setCreating(false);
            setSelected(id);
          }}
          onCancel={() => setCreating(false)}
        />
      )}
      {!projects.loading && projects.rows.length === 0 && !creating && (
        <p className="meta">No projects yet. Start one with New project.</p>
      )}
      {projects.rows.length > 0 && (
        <div className="projects-layout">
          <ul className="project-picker" aria-label="Projects">
            {projects.rows.map((project) => (
              <li key={project.id}>
                <button
                  type="button"
                  className="sidebar-item"
                  aria-current={project.id === current?.id ? "page" : undefined}
                  onClick={() => setSelected(project.id)}
                >
                  <span>{project.title}</span>
                  <span className="meta">
                    {statusLabel(project.status)} · {project.open_count} open
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {current && <ProjectView key={current.id} project={current} areas={areas.rows} />}
        </div>
      )}
    </main>
  );
}
