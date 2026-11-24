import { invoke } from "@tauri-apps/api/core";
import { type CSSProperties, type RefObject, useEffect, useRef, useState } from "react";

import "../theme/pages/plan-tasks.css";

import { systemClock } from "../kernel/clock";
import { logicalDate, showDate } from "../kernel/dates";
import { commitCapture, query, transact } from "../kernel/db";
import { ulid } from "../kernel/ulid";
import { echo, toOps } from "../capture/ops";
import { parseCapture, PARSER_ID } from "../capture/parse";
import { type ClockStyle } from "../capture/when";
import { ask } from "../features/ai/ask";
import { aiUnavailable } from "../features/ai/codes";
import { STRICT_SQL, strictOrNull } from "../features/ai/strict";
import { label, SPLIT } from "../features/ai/touchpoints";
import { formatMinutes } from "../features/plan/now";
import { AI_CHANGED_EVENT, type AiUsage } from "../features/settings/status";
import {
  canSplit,
  canSuggest,
  checkSteps,
  manualSplitOps,
  parseSteps,
  stepsMinutes,
  stepsText,
} from "../features/tasks/split";
import {
  checkTask,
  COUNTS_SQL,
  filterTasks,
  LATER_STEPS_SQL,
  repeatText,
  SPLIT_STEPS_SQL,
  statusOps,
  undoSplitOps,
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
import { IconPlus, IconSearch } from "./icons";
import { returnsFocus, useEscapeToCancel } from "./keys";
import { PanelHead } from "./kit";
import { type AreaColor, Button, Chip } from "./ui";
import { useLiveQuery } from "./useLiveQuery";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** "~2 h 20 min": an estimate, to 5 minutes, in the app's one hour format. */
const hours = (minutes: number) => `~${formatMinutes(Math.max(5, Math.round(minutes / 5) * 5))}`;

const AREAS_SQL =
  "SELECT id, name, active, color FROM area_items WHERE deleted_at IS NULL ORDER BY active DESC, priority_rank, name";
const PROJECTS_SQL =
  "SELECT id, title FROM project_items WHERE deleted_at IS NULL AND status NOT IN ('done', 'dropped') ORDER BY title";
const CLOCK_SQL = "SELECT value_json FROM core_settings WHERE key = 'capture.clock_style'";

type Named = { id: string; name: string; active?: number; color?: string | null };

/** The repeat mark in a task's facts, drawn like the shared icons (24 px, 1.8 stroke). */
function IconRepeat({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 11V9a3 3 0 0 1 3-3h12M16 3l3 3-3 3M20 13v2a3 3 0 0 1-3 3H5M8 21l-3-3 3-3" />
    </svg>
  );
}

/** What each view shows when it is empty, and how a task gets there. */
const EMPTY: Record<TaskView, string> = {
  open: "No tasks to do. Add one above.",
  waiting: "No tasks waiting. Mark a task Waiting to see it here.",
  someday: "No someday tasks. Move a task to Someday to park it here.",
  done: "No tasks done lately. Tick a task to see it here.",
  dropped: "No dropped tasks. Drop a task to see it here.",
};

const areaStyle = (color: string | null | undefined) =>
  ({ "--dot": `var(--area-${color ?? "admin"})` }) as CSSProperties;

/** Adds a task the way the capture box does: the line is kept as typed, then parsed. */
function QuickAdd({
  inputRef,
  areas,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  areas: Named[];
}) {
  const clock = useLiveQuery<{ value_json: string }>(CLOCK_SQL);
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const style: ClockStyle = clock.rows[0]?.value_json === '"ethiopian"' ? "ethiopian" : "western";
  return (
    <form
      className="tasks-add"
      onSubmit={(event) => {
        event.preventDefault();
        const line = text.trim();
        if (!line) return;
        const nowMs = systemClock.now();
        // "update cv for Job A" reads and echoes the area by name (F78).
        const names = areas.map(({ id, name }) => ({ id, name }));
        // Here every line is a task (or a wait:); ideas and notes go through the capture box.
        const parsed = parseCapture(/^(t|wait)\s*:/i.test(line) ? line : `t: ${line}`, {
          nowMs,
          clockStyle: style,
          areas: names,
        });
        commitCapture(line, toOps(parsed, { nowMs, newId: () => ulid() }), PARSER_ID)
          .then(() => {
            setText("");
            setNote(`Added · ${echo(parsed, nowMs, undefined, undefined, { areas: names })}`);
          })
          .catch((failure: unknown) => setNote(`Couldn't add it: ${message(failure)}`));
      }}
    >
      <div className="tasks-add-box">
        <span className="tasks-add-icon" aria-hidden="true">
          <IconPlus size={16} />
        </span>
        <input
          ref={inputRef}
          value={text}
          aria-label="Add a task"
          placeholder="Add a task: write the report ~3h fri #jobhunt"
          onChange={(event) => {
            setNote("");
            setText(event.target.value);
          }}
        />
        <Button type="submit" className="tasks-add-go" disabled={!text.trim()}>
          Add
        </Button>
      </div>
      <span className="hint tasks-add-note" role="status">
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
  const onEscape = useEscapeToCancel(onDone);
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Escape cancels; keydown bubbles from its fields
    <form
      className="task-form task-edit"
      aria-label={`Edit ${row.title}`}
      onKeyDown={onEscape}
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
      <p className="task-edit-label">Edit task</p>
      <label className="field task-edit-title">
        <span>Task</span>
        {/* eslint-disable-next-line jsx-a11y/no-autofocus -- opened on request */}
        <input autoFocus value={draft.title} onChange={(e) => set({ title: e.target.value })} />
      </label>
      <div className="task-edit-grid">
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
          <span>Time</span>
          <input type="time" value={draft.time} onChange={(e) => set({ time: e.target.value })} />
        </label>
        <label className="field">
          <span>Repeat</span>
          <input
            value={draft.repeat}
            placeholder="every fri, monthly 1"
            onChange={(e) => set({ repeat: e.target.value })}
          />
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
        {draft.status === "waiting" && (
          <>
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
          </>
        )}
      </div>
      <label className="field">
        <span>Notes</span>
        <textarea rows={2} value={draft.notes} onChange={(e) => set({ notes: e.target.value })} />
      </label>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="task-edit-actions">
        <Button type="submit" className="btn-orange task-edit-save">
          Save
        </Button>
        <Button className="btn-ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Whether a Gemini key is saved; read again when Settings changes it. */
function useHasAiKey(): boolean {
  const [hasKey, setHasKey] = useState(false);
  useEffect(() => {
    let live = true;
    const read = () =>
      void invoke<AiUsage>("ai_usage")
        .then((usage) => live && setHasKey(usage.has_key))
        .catch(() => live && setHasKey(false));
    read();
    window.addEventListener(AI_CHANGED_EVENT, read);
    return () => {
      live = false;
      window.removeEventListener(AI_CHANGED_EVENT, read);
    };
  }, []);
  return hasKey;
}

/**
 * Split any open task (time-first §5): type your own steps, one per line, or
 * let the AI suggest some into the same box to edit. Nothing changes until
 * "Use these steps"; the split is one undo.
 */
function SplitForm({ task, onClose }: { task: TaskListRow; onClose: () => void }) {
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<"asking" | "saving" | null>(null);
  const hasKey = useHasAiKey();
  const strict = strictOrNull(useLiveQuery<{ value_json: string | null }>(STRICT_SQL));
  const steps = parseSteps(text, task.estimate_min);
  const problem = checkSteps(steps);
  const total = stepsMinutes(steps);
  const suggest = () => {
    if (strict === null || !task.estimate_min) return;
    setBusy("asking");
    setNote(null);
    void ask(SPLIT, {
      task: label(task.title, task.area_name, strict, "task"),
      area: task.area_name,
      estimateMin: task.estimate_min,
      due: task.due_date,
    }).then((result) => {
      setBusy(null);
      if (result.ok) setText(stepsText(result.value.steps));
      else setNote(aiUnavailable(result.code));
    });
  };
  return (
    <form
      className="split task-split"
      aria-label={`Split ${task.title}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (problem) {
          setNote(problem);
          return;
        }
        setBusy("saving");
        // A step's new steps take its place: the later steps move down.
        const later =
          task.parent_id && task.step_no
            ? query<{ id: string; step_no: number | null }>(LATER_STEPS_SQL, [
                task.parent_id,
                task.step_no,
              ])
            : Promise.resolve([]);
        later
          .then((siblings) =>
            transact("user", manualSplitOps(task, steps, ulid, siblings), `split:${task.id}`),
          )
          .then(onClose)
          .catch((failure: unknown) => {
            setBusy(null);
            setNote(`Couldn't split it: ${message(failure)}`);
          });
      }}
    >
      <label className="field">
        <span>Steps, one per line (add a time like “30 min” if you know it)</span>
        <textarea
          // eslint-disable-next-line jsx-a11y/no-autofocus -- opened on request
          autoFocus
          rows={4}
          value={text}
          placeholder={"Outline — 30 min\nBuild the page — 1h\nPublish"}
          onChange={(event) => {
            setNote(null);
            setText(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && busy === null) {
              event.preventDefault();
              onClose();
            }
          }}
        />
      </label>
      {steps.length > 0 && (
        <p className="meta">
          {steps.length} {steps.length === 1 ? "step" : "steps"}
          {total > 0 && ` · ${total} min`}
          {task.estimate_min ? ` of about ${task.estimate_min} min` : ""}
        </p>
      )}
      {/* Why "Use these steps" is still off, so a disabled button is never a mystery. */}
      {!note && problem && text.trim() && (
        <p className="meta" id={`split-why-${task.id}`}>
          {problem}
        </p>
      )}
      {note && (
        <p role="alert" className="error">
          {note}
        </p>
      )}
      <div className="row">
        <Button
          primary
          type="submit"
          disabled={busy !== null || problem !== null}
          aria-describedby={problem && text.trim() ? `split-why-${task.id}` : undefined}
        >
          Use these steps
        </Button>
        {hasKey && canSuggest(task.estimate_min) && (
          <Button disabled={busy !== null || strict === null} onClick={suggest}>
            {busy === "asking" ? "Asking…" : "Suggest with AI"}
          </Button>
        )}
        <Button className="btn-ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
      {hasKey && !canSuggest(task.estimate_min) && (task.estimate_min ?? 0) < 20 && (
        <p className="meta">
          Give it an estimate of 20 min or more (Edit) and the AI can suggest steps.
        </p>
      )}
    </form>
  );
}

function TaskItem({
  row,
  view,
  today,
  areas,
  projects,
}: {
  row: TaskListRow;
  view: TaskView;
  today: string;
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
  const undoSplit = () =>
    void query<{ id: string }>(SPLIT_STEPS_SQL, [row.id])
      .then((steps) =>
        transact(
          "user",
          undoSplitOps(
            row,
            steps.map((step) => step.id),
            systemClock.now(),
          ),
          `task:${row.id}`,
        ),
      )
      .catch((failure: unknown) => setError(`Couldn't undo the split: ${message(failure)}`));
  const splittable = canSplit(row);
  // A split task sits in Dropped; its steps carry the work (F61).
  const split = view === "dropped" && row.split_steps > 0;
  if (editing)
    return (
      <li className="task-edit-row">
        <TaskForm row={row} areas={areas} projects={projects} onDone={() => setEditing(false)} />
      </li>
    );
  const done = row.status === "done";
  const step = stepLabel(row.step_no, row.step_total);
  const late = !done && row.due_date !== null && row.due_date <= today;
  const facts = [
    split && (
      <span key="split">
        split into {row.split_steps} step{row.split_steps === 1 ? "" : "s"}
      </span>
    ),
    row.project_title && <span key="project">{row.project_title}</span>,
    row.estimate_min && <span key="estimate">{hours(row.estimate_min)}</span>,
    row.planned_date && row.planned_date !== row.due_date && (
      <span key="planned">on {showDate(row.planned_date, today)}</span>
    ),
    row.repeat_json && (
      <span key="repeat" className="task-repeat">
        <IconRepeat /> {repeatText(row.repeat_json)}
      </span>
    ),
    row.waiting_on && (
      <span key="waiting">
        on {row.waiting_on}
        {row.follow_up_date ? ` · ask ${showDate(row.follow_up_date, today)}` : ""}
      </span>
    ),
  ].filter(Boolean);
  return (
    <li className={done ? "task task-row is-done" : "task task-row"}>
      <div className="task-main">
        <label>
          <input
            type="checkbox"
            checked={done}
            disabled={view === "dropped"}
            onChange={() => move(done ? "todo" : "done")}
          />
          <span className={done ? "task-title done" : "task-title"}>
            {step && <span className="task-step">{step}</span>}
            {row.title}
          </span>
        </label>
        {facts.length > 0 && <span className="task-facts">{facts}</span>}
      </div>
      <div className="task-side">
        {row.area_name && (
          <Chip area={(row.area_color ?? "admin") as AreaColor}>{row.area_name}</Chip>
        )}
        {row.due_date && (
          <span className={late ? "task-due late" : "task-due"}>
            due {showDate(row.due_date, today)}
          </span>
        )}
        {row.deadline_stale === 1 && row.due_date && (
          <span
            className="task-check warn-text"
            title="An old move may have changed this date. Open the task and save the real deadline."
          >
            check deadline
          </span>
        )}
        <span className="task-actions">
          {split ? (
            row.split_settled === 0 && (
              <Button className="btn-ghost" onClick={undoSplit}>
                Undo split
              </Button>
            )
          ) : view === "dropped" ? (
            <Button className="btn-ghost" onClick={() => move("todo")}>
              Restore
            </Button>
          ) : (
            <>
              <Button
                className="btn-ghost"
                {...returnsFocus(`task-edit:${row.id}`)}
                onClick={() => setEditing(true)}
              >
                Edit
              </Button>
              {splittable && !splitting && (
                <Button className="btn-ghost" onClick={() => setSplitting(true)}>
                  Split
                </Button>
              )}
              {view === "open" && (
                <Button className="btn-ghost" onClick={() => move("someday")}>
                  Someday
                </Button>
              )}
              {view === "someday" && (
                <Button className="btn-ghost" onClick={() => move("todo")}>
                  Plan it
                </Button>
              )}
              {view !== "done" && (
                <Button className="btn-ghost btn-danger task-drop" onClick={() => move("dropped")}>
                  Drop
                </Button>
              )}
            </>
          )}
        </span>
      </div>
      {splitting && <SplitForm task={row} onClose={() => setSplitting(false)} />}
      {error && (
        <p role="alert" className="error task-error">
          {error}
        </p>
      )}
    </li>
  );
}

/** The area filter as a list on a dark panel (wide windows). */
function AreaPanel({
  rows,
  areas,
  area,
  onArea,
}: {
  rows: TaskListRow[];
  areas: Named[];
  area: string;
  onArea: (area: string) => void;
}) {
  const minutes = rows.reduce((sum, row) => sum + (row.estimate_min ?? 0), 0);
  const options = [
    { id: "", name: "All areas", color: null as string | null, n: rows.length },
    ...areas
      .map((row) => ({
        id: row.id,
        name: row.name,
        color: row.color ?? null,
        n: rows.filter((task) => task.area_id === row.id).length,
      }))
      .filter((row) => row.n > 0 || row.id === area),
    {
      id: "none",
      name: "No area",
      color: null,
      n: rows.filter((task) => task.area_id === null).length,
    },
  ];
  return (
    <section className="panel task-areas" aria-labelledby="task-areas">
      <PanelHead
        id="task-areas"
        title="Areas"
        sub={`${rows.length} ${rows.length === 1 ? "task" : "tasks"}${minutes ? ` · ${hours(minutes)}` : ""}`}
      />
      <ul className="list-rows">
        {options.map((option) => (
          <li key={option.id || "all"} className={area === option.id ? "on" : undefined}>
            <button
              type="button"
              aria-pressed={area === option.id}
              onClick={() => onArea(option.id)}
            >
              <span
                className={option.id === "" ? "area-dot all" : "area-dot"}
                style={option.id && option.id !== "none" ? areaStyle(option.color) : undefined}
                aria-hidden="true"
              />
              <span className="grow">{option.name}</span>
              <span className="area-n">{option.n}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Every task: find, edit, finish, park for someday, drop or bring back. */
export function Tasks() {
  const [view, setView] = useState<TaskView>("open");
  const [search, setSearch] = useState("");
  const [area, setArea] = useState("");
  const [nowMs] = useState(() => systemClock.now());
  const addRef = useRef<HTMLInputElement>(null);
  const today = logicalDate(nowMs);
  const tasks = useLiveQuery<TaskListRow & Record<string, string | number | null>>(
    TASKS_SQL,
    viewParams(view, nowMs),
  );
  const counts = useLiveQuery<{ status: string; n: number }>(COUNTS_SQL, [
    viewParams("done", nowMs)[1],
  ]);
  const areas = useLiveQuery<Named & Record<string, string | number | null>>(AREAS_SQL);
  const projects = useLiveQuery<{ id: string; title: string }>(PROJECTS_SQL);
  const count = (statuses: string[]) =>
    counts.rows.filter((row) => statuses.includes(row.status)).reduce((sum, row) => sum + row.n, 0);
  const shown = filterTasks(tasks.rows, search, area);
  return (
    <main className="page tasks-page">
      <div className="layout-split">
        <aside className="side" aria-label="Tasks by area">
          <AreaPanel rows={tasks.rows} areas={areas.rows} area={area} onArea={setArea} />
        </aside>
        <div className="main">
          <section className="canvas tasks-canvas" aria-labelledby="tasks-title">
            <header className="canvas-head">
              <h1 id="tasks-title" className="page-title">
                Tasks <span className="soft">{count(["todo"])} to do</span>
              </h1>
              <span className="spacer" />
              <div className="search tasks-search">
                <IconSearch size={16} />
                <input
                  type="search"
                  value={search}
                  aria-label="Search tasks"
                  placeholder="Search"
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
              <Button primary onClick={() => addRef.current?.focus()}>
                <IconPlus size={16} /> New task
              </Button>
            </header>
            <p className="tasks-hint">
              To do tasks get planned into your free slots (with an estimate, across days); Someday
              ones wait here until you plan them.
            </p>
            <div className="tasks-bar">
              <div className="seg" role="tablist" aria-label="Which tasks">
                {VIEWS.map(({ view: name, label, statuses }) => (
                  <button
                    key={name}
                    type="button"
                    role="tab"
                    aria-selected={view === name}
                    className="seg-item"
                    onClick={() => setView(name)}
                  >
                    {label} <span className="seg-count">{count(statuses)}</span>
                  </button>
                ))}
              </div>
              <select
                className="tasks-area-select"
                aria-label="Area"
                value={area}
                onChange={(event) => setArea(event.target.value)}
              >
                <option value="">All areas</option>
                <option value="none">No area</option>
                {areas.rows.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                  </option>
                ))}
              </select>
            </div>
            <QuickAdd inputRef={addRef} areas={areas.rows} />
            {tasks.error && (
              <p role="alert" className="error">
                Couldn&apos;t load tasks: {tasks.error}
              </p>
            )}
            {!tasks.loading && shown.length === 0 && (
              <p className="empty tasks-empty">
                {tasks.rows.length === 0
                  ? EMPTY[view]
                  : "No tasks match. Try another word or area."}
              </p>
            )}
            <ul className="task-rows tasks-list">
              {shown.map((row) => (
                <TaskItem
                  key={row.id}
                  row={row}
                  view={view}
                  today={today}
                  areas={areas.rows}
                  projects={projects.rows}
                />
              ))}
            </ul>
          </section>
        </div>
      </div>
    </main>
  );
}
