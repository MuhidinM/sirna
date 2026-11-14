import { useState } from "react";

import { systemClock } from "../kernel/clock";
import { commitCapture, transact } from "../kernel/db";
import { ulid } from "../kernel/ulid";
import { echo, toOps } from "../capture/ops";
import { parseCapture, PARSER_ID } from "../capture/parse";
import { type ClockStyle } from "../capture/when";
import { SPLIT_MAX_MIN } from "../features/ai/touchpoints";
import {
  checkTask,
  COUNTS_SQL,
  filterTasks,
  statusOps,
  stepLabel,
  type TaskDraft,
  taskDraftOf,
  taskEditOps,
  type TaskListRow,
  TASKS_SQL,
  type TaskView,
  viewParams,
  VIEWS,
} from "../features/tasks/list";
import { SPLIT_FROM_MIN, SplitTask } from "./Today";
import { type AreaColor, Button, Chip } from "./ui";
import { useLiveQuery } from "./useLiveQuery";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const hours = (minutes: number) => `~${Math.round((minutes / 60) * 10) / 10} h`;

const AREAS_SQL =
  "SELECT id, name, active FROM area_items WHERE deleted_at IS NULL ORDER BY active DESC, priority_rank, name";
const PROJECTS_SQL =
  "SELECT id, title FROM project_items WHERE deleted_at IS NULL AND status NOT IN ('done', 'dropped') ORDER BY title";
const CLOCK_SQL = "SELECT value_json FROM core_settings WHERE key = 'capture.clock_style'";

type Named = { id: string; name: string; active?: number };

/** Adds a task the way the capture box does: the line is kept as typed, then parsed. */
function QuickAdd() {
  const clock = useLiveQuery<{ value_json: string }>(CLOCK_SQL);
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const style: ClockStyle = clock.rows[0]?.value_json === '"ethiopian"' ? "ethiopian" : "western";
  return (
    <form
      className="row quick-add"
      onSubmit={(event) => {
        event.preventDefault();
        const line = text.trim();
        if (!line) return;
        const nowMs = systemClock.now();
        // Here every line is a task (or a wait:); ideas and notes go through the capture box.
        const parsed = parseCapture(/^(t|wait)\s*:/i.test(line) ? line : `t: ${line}`, {
          nowMs,
          clockStyle: style,
        });
        commitCapture(line, toOps(parsed, { nowMs, newId: () => ulid() }), PARSER_ID)
          .then(() => {
            setText("");
            setNote(`Added · ${echo(parsed, nowMs)}`);
          })
          .catch((failure: unknown) => setNote(`Couldn't add it: ${message(failure)}`));
      }}
    >
      <input
        value={text}
        aria-label="Add a task"
        placeholder="Add a task: write the report ~3h fri #jobhunt"
        onChange={(event) => {
          setNote("");
          setText(event.target.value);
        }}
      />
      <Button type="submit" primary disabled={!text.trim()}>
        Add
      </Button>
      <span className="meta" role="status">
        {note}
      </span>
    </form>
  );
}

function TaskForm({
  row,
  areas,
  projects,
  onDone,
}: {
  row: TaskListRow;
  areas: Named[];
  projects: { id: string; title: string }[];
  onDone: () => void;
}) {
  const [draft, setDraft] = useState<TaskDraft>(() => taskDraftOf(row));
  const [error, setError] = useState<string | null>(null);
  const set = (change: Partial<TaskDraft>) => {
    setError(null);
    setDraft({ ...draft, ...change });
  };
  return (
    <form
      className="card block-form task-form"
      onSubmit={(event) => {
        event.preventDefault();
        const problem = checkTask(draft);
        if (problem) {
          setError(problem);
          return;
        }
        transact("user", taskEditOps(row, draft, systemClock.now()), `task:${row.id}`)
          .then(onDone)
          .catch((failure: unknown) => setError(`Couldn't save: ${message(failure)}`));
      }}
    >
      <label className="field">
        <span>Task</span>
        {/* eslint-disable-next-line jsx-a11y/no-autofocus -- opened on request */}
        <input autoFocus value={draft.title} onChange={(e) => set({ title: e.target.value })} />
      </label>
      <div className="row">
        <label className="field">
          <span>Status</span>
          <select
            value={draft.status}
            onChange={(e) => set({ status: e.target.value as TaskDraft["status"] })}
          >
            <option value="todo">To do (gets planned)</option>
            <option value="waiting">Waiting on someone</option>
            <option value="someday">Someday (not planned)</option>
            <option value="done">Done</option>
          </select>
        </label>
        <label className="field">
          <span>Area</span>
          <select value={draft.areaId} onChange={(e) => set({ areaId: e.target.value })}>
            <option value="">None</option>
            {areas
              .filter((area) => area.active !== 0 || area.id === draft.areaId)
              .map((area) => (
                <option key={area.id} value={area.id}>
                  {area.name}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          <span>Project</span>
          <select value={draft.projectId} onChange={(e) => set({ projectId: e.target.value })}>
            <option value="">None</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.title}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Due</span>
          <input type="date" value={draft.due} onChange={(e) => set({ due: e.target.value })} />
        </label>
        <label className="field">
          <span>Hours it takes</span>
          <input
            inputMode="decimal"
            value={draft.estimateHours}
            placeholder="e.g. 3"
            onChange={(e) => set({ estimateHours: e.target.value })}
          />
        </label>
      </div>
      {draft.status === "waiting" && (
        <div className="row">
          <label className="field">
            <span>Waiting on</span>
            <input value={draft.waitingOn} onChange={(e) => set({ waitingOn: e.target.value })} />
          </label>
          <label className="field">
            <span>Follow up on</span>
            <input
              type="date"
              value={draft.followUp}
              onChange={(e) => set({ followUp: e.target.value })}
            />
          </label>
        </div>
      )}
      <label className="field">
        <span>Notes</span>
        <textarea rows={2} value={draft.notes} onChange={(e) => set({ notes: e.target.value })} />
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
        <Button onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}

function TaskItem({
  row,
  view,
  areas,
  projects,
}: {
  row: TaskListRow;
  view: TaskView;
  areas: Named[];
  projects: { id: string; title: string }[];
}) {
  const [editing, setEditing] = useState(false);
  const [splitting, setSplitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const move = (to: "done" | "todo" | "someday" | "dropped") =>
    void transact("user", statusOps(row, to, systemClock.now()), `task:${row.id}`).catch(
      (failure: unknown) => setError(`Couldn't change it: ${message(failure)}`),
    );
  const big =
    row.status === "todo" &&
    (row.estimate_min ?? 0) >= SPLIT_FROM_MIN &&
    (row.estimate_min ?? 0) <= SPLIT_MAX_MIN;
  if (editing)
    return (
      <li>
        <TaskForm row={row} areas={areas} projects={projects} onDone={() => setEditing(false)} />
      </li>
    );
  return (
    <li className="task">
      <label>
        <input
          type="checkbox"
          checked={row.status === "done"}
          disabled={view === "dropped"}
          onChange={() => move(row.status === "done" ? "todo" : "done")}
        />
        <span className={row.status === "done" ? "done" : undefined}>
          {stepLabel(row.step_no, row.step_total) && (
            <span className="meta">{stepLabel(row.step_no, row.step_total)} </span>
          )}
          {row.title}
        </span>
      </label>
      <span className="row task-meta">
        {row.area_name && (
          <Chip area={(row.area_color ?? "admin") as AreaColor}>{row.area_name}</Chip>
        )}
        {row.project_title && <span className="meta">{row.project_title}</span>}
        {row.estimate_min && <span className="meta">{hours(row.estimate_min)}</span>}
        {row.planned_date && row.planned_date !== row.due_date && (
          <span className="meta">on {row.planned_date}</span>
        )}
        {row.due_date && <span className="meta">due {row.due_date}</span>}
        {row.deadline_stale === 1 && row.due_date && (
          <span
            className="meta warn-text"
            title="An old move may have changed this date. Open the task and save the real deadline."
          >
            check deadline
          </span>
        )}
        {row.waiting_on && (
          <span className="meta">
            on {row.waiting_on}
            {row.follow_up_date ? ` · ask ${row.follow_up_date}` : ""}
          </span>
        )}
        {view === "dropped" ? (
          <Button onClick={() => move("todo")}>Restore</Button>
        ) : (
          <>
            <Button onClick={() => setEditing(true)}>Edit</Button>
            {big && !splitting && <Button onClick={() => setSplitting(true)}>Split</Button>}
            {view === "open" && <Button onClick={() => move("someday")}>Someday</Button>}
            {view === "someday" && <Button onClick={() => move("todo")}>Plan it</Button>}
            {view !== "done" && <Button onClick={() => move("dropped")}>Drop</Button>}
          </>
        )}
      </span>
      {splitting && <SplitTask task={row} onClose={() => setSplitting(false)} />}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </li>
  );
}

/** Every task: find, edit, finish, park for someday, drop or bring back. */
export function Tasks() {
  const [view, setView] = useState<TaskView>("open");
  const [search, setSearch] = useState("");
  const [area, setArea] = useState("");
  const [nowMs] = useState(() => systemClock.now());
  const tasks = useLiveQuery<TaskListRow & Record<string, string | number | null>>(
    TASKS_SQL,
    viewParams(view, nowMs),
  );
  const counts = useLiveQuery<{ status: string; n: number }>(COUNTS_SQL, [
    viewParams("done", nowMs)[1],
  ]);
  const areas = useLiveQuery<Named & Record<string, string | number>>(AREAS_SQL);
  const projects = useLiveQuery<{ id: string; title: string }>(PROJECTS_SQL);
  const count = (statuses: string[]) =>
    counts.rows.filter((row) => statuses.includes(row.status)).reduce((sum, row) => sum + row.n, 0);
  const shown = filterTasks(tasks.rows, search, area);
  return (
    <main className="review tasks">
      <header className="review-head">
        <h1>Tasks</h1>
        <p className="meta">
          To do tasks get planned into your free slots (with an estimate, across days); Someday ones
          wait here until you plan them.
        </p>
      </header>
      <QuickAdd />
      <div className="row" role="tablist" aria-label="Which tasks">
        {VIEWS.map(({ view: name, label, statuses }) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={view === name}
            className={view === name ? "step current" : "step"}
            onClick={() => setView(name)}
          >
            {label} <span className="meta">{count(statuses)}</span>
          </button>
        ))}
      </div>
      <div className="row task-filters">
        <input
          type="search"
          value={search}
          aria-label="Search tasks"
          placeholder="Search"
          onChange={(event) => setSearch(event.target.value)}
        />
        <select aria-label="Area" value={area} onChange={(event) => setArea(event.target.value)}>
          <option value="">All areas</option>
          <option value="none">No area</option>
          {areas.rows.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
            </option>
          ))}
        </select>
      </div>
      {tasks.error && (
        <p role="alert" className="error">
          Couldn&apos;t load tasks: {tasks.error}
        </p>
      )}
      {!tasks.loading && shown.length === 0 && (
        <p className="meta">{tasks.rows.length === 0 ? "Nothing here." : "Nothing matches."}</p>
      )}
      <ul className="task-list">
        {shown.map((row) => (
          <TaskItem
            key={row.id}
            row={row}
            view={view}
            areas={areas.rows}
            projects={projects.rows}
          />
        ))}
      </ul>
    </main>
  );
}
