/**
 * Dev-only port of the focus timer: src-tauri/src/focus.rs (the Machine, runs
 * and their lanes, its database effects, contexts), the done write in
 * tasks.rs, guard.rs (hard stop, daily cap), kit.rs (the
 * kit list) and the set-up sheet commands in commands.rs. Sessions land in
 * focus_sessions exactly as Rust writes them. There is no timer thread:
 * the harness ticks the machine when time moves (see store.ts).
 *
 * Not emulated: toasts (break started/over, cap, hard stop), Do not disturb,
 * opening and minimizing the kit's programs.
 */
import { type Conn, first } from "./conn";
import { localMinutes, logicalDay, logicalMinutes, parseHhmm, settingString } from "./commands";
import { applyOps, undoContext } from "./tx";

const MINUTE_MS = 60_000;
export const ROW_GAP_MS = 15 * MINUTE_MS;
export const LONG_BREAK_EVERY = 4;
export const LONG_BREAK_MIN = 20;
export const LONG_BREAK_LOCK_MS = 10 * MINUTE_MS;
export const SLEEP_GRACE_MS = 30 * MINUTE_MS;
export const EXTEND_MIN = 5;
export const RUN_MIN = 30;
export const CLEAN_SHARE = 0.7;

export type Kind = "focus" | "break" | "long_break";

/** focus::Lane: a task in a run, started, paused and finished on its own. */
export interface Lane {
  task_id: string;
  title: string;
  area_id: string | null;
  area: string | null;
  position: number;
  running_since: number | null;
  done: boolean;
  closed_ms: number;
}

export const wallMs = (lane: Lane, now: number) =>
  lane.closed_ms + (lane.running_since === null ? 0 : Math.max(now - lane.running_since, 0));

function stopRunning(lane: Lane, at: number): boolean {
  if (lane.running_since === null) return false;
  lane.closed_ms += Math.max(at - lane.running_since, 0);
  lane.running_since = null;
  return true;
}

/** run_title: the first task, "+N" for the rest. */
export function runTitle(lanes: readonly Lane[]): string {
  const [first] = lanes;
  if (!first) return "Focus";
  return lanes.length === 1 ? first.title : `${first.title} +${lanes.length - 1}`;
}

const copyLanes = (lanes: readonly Lane[]) => lanes.map((lane) => ({ ...lane }));

export interface Session {
  id: string;
  kind: Kind;
  started_at: number;
  planned_min: number;
  paused_at: number | null;
  paused_ms: number;
  block_id: string | null;
  area_id: string | null;
  task_id: string | null;
  title: string;
  extended: boolean;
  break_min: number;
  /** Distracted (+1) taps on this session; the card shows them. */
  distractions: number;
  lanes: Lane[];
  run_of: string | null;
}

export const endsAt = (session: Session) =>
  session.started_at + session.planned_min * MINUTE_MS + session.paused_ms;

export const remainingMs = (session: Session, now: number) =>
  endsAt(session) - (session.paused_at ?? now);

export interface Context {
  block_id: string | null;
  area_id: string | null;
  task_id: string | null;
  title: string;
  focus_min: number;
  break_min: number;
  lanes: Lane[];
}

export type Outcome = "completed" | "stopped" | "interrupted";

export type Event =
  | { type: "start"; context: Context; force: boolean; id: string }
  | { type: "tick" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "stop" }
  | { type: "distracted" }
  | { type: "extend"; id: string }
  | { type: "lane_start"; task_id: string }
  | { type: "lane_pause"; task_id: string }
  | { type: "lane_done"; task_id: string }
  | { type: "lane_add"; lane: Lane }
  | { type: "lane_remove"; task_id: string };

export type Effect =
  | { type: "save"; session: Session }
  | { type: "close"; id: string; at: number; outcome: Outcome }
  | { type: "add_distraction"; id: string }
  | { type: "break_started"; minutes: number; long: boolean; can_extend: boolean }
  | { type: "break_over" }
  | { type: "need_confirm" }
  | { type: "already_focusing" }
  | { type: "past_hard_stop" }
  | { type: "span_open"; session_id: string; task_id: string; at: number }
  | { type: "span_close"; session_id: string; task_id: string; at: number; end: "done" | "pause" }
  | { type: "lane_removed"; session_id: string; task_id: string }
  | { type: "task_done"; session_id: string; task_id: string; at: number };

/** A session as an effect carries it: its own copy of the lanes. */
const snapshot = (session: Session): Session => ({ ...session, lanes: copyLanes(session.lanes) });

export interface Machine {
  current: Session | null;
  in_row: number;
  last_focus_end: number | null;
}

export const emptyMachine = (): Machine => ({ current: null, in_row: 0, last_focus_end: null });

/** Machine::handle: pure, mutates `machine` like the Rust one. */
export function handle(machine: Machine, event: Event, now: number): Effect[] {
  switch (event.type) {
    case "start":
      return start(machine, event.context, event.force, event.id, now);
    case "tick":
      return tick(machine, now);
    case "pause": {
      const session = machine.current;
      if (session && session.kind === "focus" && session.paused_at === null) {
        session.paused_at = now;
        return [{ type: "save", session: snapshot(session) }];
      }
      return [];
    }
    case "resume": {
      const session = machine.current;
      if (session && session.paused_at !== null) {
        session.paused_ms += now - session.paused_at;
        session.paused_at = null;
        return [{ type: "save", session: snapshot(session) }];
      }
      return [];
    }
    case "stop": {
      const session = machine.current;
      machine.current = null;
      if (!session) return [];
      if (session.kind === "focus") machine.last_focus_end = now;
      const effects: Effect[] = [];
      // An open pause is pause time, not focus: fold it in before closing.
      if (session.paused_at !== null) {
        session.paused_ms += now - session.paused_at;
        session.paused_at = null;
        effects.push({ type: "save", session: snapshot(session) });
      }
      for (const l of session.lanes) stopRunning(l, now);
      effects.push({ type: "close", id: session.id, at: now, outcome: "stopped" });
      return effects;
    }
    case "distracted": {
      const session = machine.current;
      if (session?.kind !== "focus") return [];
      session.distractions += 1;
      return [{ type: "add_distraction", id: session.id }];
    }
    case "extend":
      return extend(machine, event.id, now);
    default:
      return lane(machine, event, now);
  }
}

/**
 * Session::follow_first_lane: a run of tasks keeps its first task on the row;
 * a block or area session keeps its own area. With no lanes left the row
 * names no task. The run's name follows its lanes.
 */
function followFirstLane(session: Session, titleBefore: string) {
  const follows = session.block_id === null && session.task_id !== null;
  const first = [...session.lanes].sort((a, b) => a.position - b.position)[0];
  if (first) {
    if (follows) {
      session.task_id = first.task_id;
      session.area_id = first.area_id;
    }
  } else {
    if (follows) session.area_id = null;
    session.task_id = null;
  }
  if (session.block_id === null && session.title === titleBefore)
    session.title = runTitle(session.lanes);
}

/** focus::refresh_done: lanes whose task was reopened since (an undone done) are open again. */
export function refreshDone(conn: Conn, machine: Machine) {
  for (const lane of machine.current?.lanes ?? []) {
    if (!lane.done) continue;
    const row = first(conn, "SELECT status FROM task_items WHERE id = ?", [lane.task_id]);
    if (row && row.status !== "done") lane.done = false;
  }
}

function lane(
  machine: Machine,
  event: Extract<
    Event,
    { type: "lane_start" | "lane_pause" | "lane_done" | "lane_add" | "lane_remove" }
  >,
  now: number,
): Effect[] {
  const session = machine.current;
  if (session?.kind !== "focus") return [];
  const session_id = session.id;
  const find = (taskId: string) => session.lanes.find((l) => l.task_id === taskId);
  switch (event.type) {
    case "lane_start": {
      const found = find(event.task_id);
      if (!found || found.done || found.running_since !== null) return [];
      found.running_since = now;
      return [{ type: "span_open", session_id, task_id: event.task_id, at: now }];
    }
    case "lane_pause": {
      const found = find(event.task_id);
      if (!found || !stopRunning(found, now)) return [];
      return [{ type: "span_close", session_id, task_id: event.task_id, at: now, end: "pause" }];
    }
    case "lane_done": {
      const found = find(event.task_id);
      if (!found || found.done) return [];
      const effects: Effect[] = [];
      if (stopRunning(found, now))
        effects.push({
          type: "span_close",
          session_id,
          task_id: event.task_id,
          at: now,
          end: "done",
        });
      found.done = true;
      effects.push({ type: "task_done", session_id, task_id: event.task_id, at: now });
      return effects;
    }
    case "lane_add": {
      if (find(event.lane.task_id)) return [];
      const titleBefore = runTitle(session.lanes);
      const position = Math.max(0, ...session.lanes.map((l) => l.position)) + 1;
      session.lanes.push({ ...event.lane, position, running_since: null, closed_ms: 0 });
      followFirstLane(session, titleBefore);
      return [{ type: "save", session: snapshot(session) }];
    }
    case "lane_remove": {
      const index = session.lanes.findIndex((l) => l.task_id === event.task_id);
      if (index < 0 || session.lanes[index]?.done) return [];
      const titleBefore = runTitle(session.lanes);
      session.lanes.splice(index, 1);
      followFirstLane(session, titleBefore);
      return [
        { type: "lane_removed", session_id, task_id: event.task_id },
        { type: "save", session: snapshot(session) },
      ];
    }
  }
}

function start(machine: Machine, context: Context, force: boolean, id: string, now: number) {
  const effects: Effect[] = [];
  const current = machine.current;
  if (current) {
    if (current.kind === "focus") return [{ type: "already_focusing" } as Effect];
    if (current.kind === "long_break" && !force && now - current.started_at < LONG_BREAK_LOCK_MS)
      return [{ type: "need_confirm" } as Effect];
    effects.push({ type: "close", id: current.id, at: now, outcome: "stopped" });
  }
  if (machine.last_focus_end === null || now - machine.last_focus_end > ROW_GAP_MS)
    machine.in_row = 0;
  const session: Session = {
    id,
    kind: "focus",
    started_at: now,
    planned_min: Math.max(context.focus_min, 1),
    paused_at: null,
    paused_ms: 0,
    block_id: context.block_id,
    area_id: context.area_id,
    task_id: context.task_id,
    title: context.title,
    extended: false,
    break_min: Math.max(context.break_min, 0),
    distractions: 0,
    lanes: copyLanes(context.lanes),
    run_of: null,
  };
  // The first open task's lane starts with the run.
  const opened = session.lanes.find((l) => !l.done);
  if (opened) opened.running_since = now;
  effects.push({ type: "save", session: snapshot(session) });
  if (opened)
    effects.push({ type: "span_open", session_id: session.id, task_id: opened.task_id, at: now });
  machine.current = session;
  return effects;
}

function tick(machine: Machine, now: number): Effect[] {
  const session = machine.current;
  if (!session || session.paused_at !== null || remainingMs(session, now) > 0) return [];
  const ended = endsAt(session);
  for (const l of session.lanes) stopRunning(l, ended);
  if (session.kind === "focus") {
    if (now - ended > SLEEP_GRACE_MS) {
      machine.current = null;
      machine.in_row = 0;
      return [{ type: "close", id: session.id, at: ended, outcome: "interrupted" }];
    }
    machine.in_row += 1;
    machine.last_focus_end = ended;
    const long = machine.in_row % LONG_BREAK_EVERY === 0;
    const minutes = long ? LONG_BREAK_MIN : session.break_min;
    const effects: Effect[] = [{ type: "close", id: session.id, at: ended, outcome: "completed" }];
    if (minutes === 0) {
      machine.current = null;
      effects.push({ type: "break_over" });
      return effects;
    }
    const rest: Session = {
      ...session,
      id: `${session.id}-break`,
      kind: long ? "long_break" : "break",
      started_at: ended,
      planned_min: minutes,
      paused_at: null,
      paused_ms: 0,
      distractions: 0,
      lanes: session.lanes.map((l) => ({ ...l, running_since: null })),
      run_of: session.run_of ?? session.id,
    };
    effects.push({ type: "save", session: snapshot(rest) });
    effects.push({ type: "break_started", minutes, long, can_extend: !long && !session.extended });
    machine.current = rest;
    return effects;
  }
  machine.current = null;
  return [
    { type: "close", id: session.id, at: ended, outcome: "completed" },
    { type: "break_over" },
  ];
}

function extend(machine: Machine, id: string, now: number): Effect[] {
  const current = machine.current;
  if (!current || current.kind !== "break" || current.extended) return [];
  const focus: Session = {
    ...current,
    id,
    kind: "focus",
    started_at: now,
    planned_min: EXTEND_MIN,
    paused_at: null,
    paused_ms: 0,
    extended: true,
    distractions: 0,
    lanes: current.lanes.map((l) => ({ ...l, running_since: null, closed_ms: 0 })),
    run_of: current.run_of,
  };
  machine.in_row = Math.max(0, machine.in_row - 1);
  machine.current = focus;
  return [
    { type: "close", id: current.id, at: now, outcome: "stopped" },
    { type: "save", session: snapshot(focus) },
  ];
}

/** What the UI and tray show (focus::Status). */
export function status(machine: Machine, now: number) {
  const session = machine.current;
  if (!session)
    return {
      kind: null,
      title: "",
      remaining_ms: 0,
      planned_min: 0,
      paused: false,
      in_row: machine.in_row,
      block_id: null,
      distractions: 0,
      lanes: [],
    };
  return {
    kind: session.kind,
    title: session.title,
    remaining_ms: Math.max(remainingMs(session, now), 0),
    planned_min: session.planned_min,
    paused: session.paused_at !== null,
    in_row: machine.in_row,
    block_id: session.block_id,
    distractions: session.distractions,
    lanes: session.lanes.map((l) => ({
      id: l.task_id,
      title: l.title,
      area_id: l.area_id,
      area: l.area,
      running: l.running_since !== null,
      done: l.done,
      wall_min: Math.floor(wallMs(l, now) / MINUTE_MS),
    })),
  };
}

/** focus::new_id: "fs-<13-digit ms>-<4-digit counter>". */
export const newId = (now: number, counter: number) =>
  `fs-${String(now).padStart(13, "0")}-${String(counter % 10_000).padStart(4, "0")}`;

/** apply_db: the effects that write focus_sessions. */
export function applyDb(conn: Conn, effects: readonly Effect[]) {
  for (const effect of effects) {
    if (effect.type === "save") {
      const s = effect.session;
      conn.run(
        `INSERT INTO focus_sessions
           (id, block_id, area_id, task_id, kind, started_at, planned_min, paused_at, paused_ms, extended, run_of)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT (id) DO UPDATE SET planned_min = ?7, paused_at = ?8, paused_ms = ?9, extended = ?10,
           area_id = ?3, task_id = ?4`,
        [
          s.id,
          s.block_id,
          s.area_id,
          s.task_id,
          s.kind,
          s.started_at,
          s.planned_min,
          s.paused_at,
          s.paused_ms,
          s.extended ? 1 : 0,
          s.run_of,
        ],
      );
      if (s.kind === "focus")
        for (const l of s.lanes)
          conn.run(
            `INSERT OR IGNORE INTO focus_run_tasks (session_id, task_id, area_id, position)
             VALUES (?, ?, ?, ?)`,
            [s.id, l.task_id, l.area_id, l.position],
          );
    } else if (effect.type === "close") {
      conn.run(
        "UPDATE focus_sessions SET ended_at = ?, outcome = ?, paused_at = NULL WHERE id = ?",
        [effect.at, effect.outcome, effect.id],
      );
      conn.run(
        `UPDATE focus_lane_spans SET end_at = MAX(start_at, ?), end_kind = 'run_end'
         WHERE session_id = ? AND end_at IS NULL`,
        [effect.at, effect.id],
      );
      finishRun(conn, effect.id);
    } else if (effect.type === "span_open") {
      conn.run("INSERT INTO focus_lane_spans (session_id, task_id, start_at) VALUES (?, ?, ?)", [
        effect.session_id,
        effect.task_id,
        effect.at,
      ]);
    } else if (effect.type === "span_close") {
      conn.run(
        `UPDATE focus_lane_spans SET end_at = MAX(start_at, ?), end_kind = ?
         WHERE session_id = ? AND task_id = ? AND end_at IS NULL`,
        [effect.at, effect.end, effect.session_id, effect.task_id],
      );
    } else if (effect.type === "lane_removed") {
      for (const table of ["focus_lane_spans", "focus_run_tasks"])
        conn.run(`DELETE FROM ${table} WHERE session_id = ? AND task_id = ?`, [
          effect.session_id,
          effect.task_id,
        ]);
    } else if (effect.type === "task_done") {
      // The run records done only once the task really is done.
      try {
        markDoneIn(conn, effect.task_id, laneContext(effect.session_id), effect.at);
        conn.run(
          "UPDATE focus_run_tasks SET result = 'done' WHERE session_id = ? AND task_id = ?",
          [effect.session_id, effect.task_id],
        );
      } catch (error) {
        console.error("could not mark the lane's task done:", error);
      }
    } else if (effect.type === "add_distraction") {
      conn.run("UPDATE focus_sessions SET distractions = distractions + 1 WHERE id = ?", [
        effect.id,
      ]);
    }
  }
}

export const laneContext = (sessionId: string) => `lane:${sessionId}`;

/** tasks::mark_done_in: done, logged under `context`; done or deleted tasks are left alone. */
export function markDoneIn(conn: Conn, taskId: string, context: string, now: number) {
  const row = first(conn, "SELECT status FROM task_items WHERE id = ? AND deleted_at IS NULL", [
    taskId,
  ]);
  if (!row || row.status === "done") return;
  applyOps(
    conn,
    "user",
    context,
    [
      {
        op: "update",
        table: "task_items",
        id: taskId,
        values: { status: "done", completed_at: now },
      },
    ],
    now,
  );
}

/** solo_ms: per task, the time it was the only lane running. */
export function soloMs(
  spans: readonly [string, number, number][],
  from: number,
  to: number,
): Map<string, number> {
  const clamped = spans
    .map(([task, start, end]) => [task, Math.max(start, from), Math.min(end, to)] as const)
    .filter(([, start, end]) => end > start);
  const points = [...new Set(clamped.flatMap(([, start, end]) => [start, end]))].sort(
    (a, b) => a - b,
  );
  const out = new Map<string, number>();
  points.forEach((a, i) => {
    const b = points[i + 1];
    if (b === undefined) return;
    const running = [
      ...new Set(clamped.filter(([, start, end]) => start <= a && end >= b).map(([task]) => task)),
    ];
    const [only] = running;
    if (running.length === 1 && only !== undefined) out.set(only, (out.get(only) ?? 0) + b - a);
  });
  return out;
}

/** finish_run: each task's effort, wall minutes and clean flag when a run closes. */
export function finishRun(conn: Conn, sessionId: string) {
  // A lane's done that was undone since is not a result.
  conn.run(
    `UPDATE focus_run_tasks SET result = NULL
     WHERE session_id = ? AND result = 'done'
       AND task_id NOT IN (SELECT id FROM task_items WHERE status = 'done')`,
    [sessionId],
  );
  const tasks = conn.all("SELECT task_id, result FROM focus_run_tasks WHERE session_id = ?", [
    sessionId,
  ]);
  if (tasks.length === 0) return;
  const row = first(
    conn,
    "SELECT started_at, ended_at, paused_ms FROM focus_sessions WHERE id = ?",
    [sessionId],
  );
  if (!row || row.ended_at === null) return;
  const started = Number(row.started_at);
  const ended = Number(row.ended_at);
  const wall = ended - started;
  const scale = wall > 0 ? Math.max(wall - Number(row.paused_ms), 0) / wall : 0;
  const spans = conn
    .all(
      "SELECT task_id, start_at, end_at FROM focus_lane_spans WHERE session_id = ? AND end_at IS NOT NULL",
      [sessionId],
    )
    .map(
      (r) => [String(r.task_id), Number(r.start_at), Number(r.end_at)] as [string, number, number],
    );
  const solo = soloMs(spans, started, ended);
  for (const task of tasks) {
    const taskId = String(task.task_id);
    const wallMsOf = spans
      .filter(([id]) => id === taskId)
      .reduce((sum, [, a, b]) => sum + Math.max(Math.min(b, ended) - Math.max(a, started), 0), 0);
    const effort = Number(
      first(
        conn,
        "SELECT COALESCE(SUM(minutes), 0) AS n FROM v_focus_share WHERE session_id = ? AND task_id = ?",
        [sessionId, taskId],
      )?.n ?? 0,
    );
    const soloMin = ((solo.get(taskId) ?? 0) * scale) / 60_000;
    const clean = task.result === "done" && effort > 0 && soloMin + 1e-9 >= CLEAN_SHARE * effort;
    conn.run(
      `UPDATE focus_run_tasks SET effort_min = ?, wall_min = ?, clean = ?
       WHERE session_id = ? AND task_id = ?`,
      [
        effort,
        Math.floor((wallMsOf + MINUTE_MS / 2) / MINUTE_MS),
        clean ? 1 : 0,
        sessionId,
        taskId,
      ],
    );
  }
}

const plain = (): Context => ({
  block_id: null,
  area_id: null,
  task_id: null,
  title: "Focus",
  focus_min: 25,
  break_min: 5,
  lanes: [],
});

/** context_for: the block's area, task and title, and the area's lengths. */
export function contextFor(conn: Conn, blockId: string | null): Context {
  if (blockId === null) return plain();
  const row = first(
    conn,
    `SELECT b.area_id, b.task_id, b.title, COALESCE(a.focus_min, 25) AS focus_min, COALESCE(a.break_min, 5) AS break_min
     FROM day_blocks AS b LEFT JOIN area_items AS a ON a.id = b.area_id
     WHERE b.id = ?`,
    [blockId],
  );
  if (!row) return plain();
  const taskId = row.task_id as string | null;
  const taskLane = taskId === null ? undefined : laneFor(conn, taskId, 1);
  // A task with no area counts for the block's area, as before runs.
  if (taskLane && taskLane.area_id === null && row.area_id !== null) {
    taskLane.area_id = row.area_id as string;
    taskLane.area = (first(conn, "SELECT name FROM area_items WHERE id = ?", [taskLane.area_id])
      ?.name ?? null) as string | null;
  }
  return {
    block_id: blockId,
    area_id: row.area_id as string | null,
    task_id: taskId,
    title: String(row.title),
    focus_min: Number(row.focus_min),
    break_min: Number(row.break_min),
    lanes: taskLane ? [taskLane] : [],
  };
}

/** lane_for: a task as a lane, nothing run yet; undefined when it is gone. */
export function laneFor(conn: Conn, taskId: string, position: number): Lane | undefined {
  const row = first(
    conn,
    `SELECT t.title, t.area_id, a.name, t.status = 'done' AS done
     FROM task_items AS t LEFT JOIN area_items AS a ON a.id = t.area_id
     WHERE t.id = ? AND t.deleted_at IS NULL`,
    [taskId],
  );
  if (!row) return undefined;
  return {
    task_id: taskId,
    title: String(row.title),
    area_id: row.area_id as string | null,
    area: row.name as string | null,
    position,
    running_since: null,
    done: Number(row.done) === 1,
    closed_ms: 0,
  };
}

/** context_for_run: the run's lanes in order, its first task's area and break. */
export function contextForRun(
  conn: Conn,
  taskIds: readonly string[],
  minutes: number | null,
): Context | undefined {
  const lanes: Lane[] = [];
  for (const taskId of taskIds) {
    if (lanes.some((l) => l.task_id === taskId)) continue;
    const found = laneFor(conn, taskId, lanes.length + 1);
    if (found) lanes.push(found);
  }
  const head = lanes[0];
  if (!head) return undefined;
  const area =
    head.area_id === null
      ? undefined
      : first(conn, "SELECT break_min FROM area_items WHERE id = ?", [head.area_id]);
  return {
    block_id: null,
    area_id: head.area_id,
    task_id: head.task_id,
    title: runTitle(lanes),
    focus_min: Math.max(minutes ?? RUN_MIN, 1),
    break_min: area ? Number(area.break_min) : 5,
    lanes,
  };
}

/** context_for_area */
export function contextForArea(conn: Conn, areaId: string): Context {
  const row = first(
    conn,
    "SELECT name, focus_min, break_min FROM area_items WHERE id = ? AND deleted_at IS NULL",
    [areaId],
  );
  if (!row) return plain();
  return {
    block_id: null,
    area_id: areaId,
    task_id: null,
    title: String(row.name),
    focus_min: Number(row.focus_min),
    break_min: Number(row.break_min),
    lanes: [],
  };
}

/** context_for_target: a block wins over an area; neither is a plain session. */
export function contextForTarget(conn: Conn, blockId: string | null, areaId: string | null) {
  return blockId !== null || areaId === null
    ? contextFor(conn, blockId)
    : contextForArea(conn, areaId);
}

/** today_blocks */
export function todayBlocks(conn: Conn, now: number) {
  const [date] = logicalDay(now);
  return conn
    .all(
      `SELECT id, title, start_at, end_at, kind, area_id FROM day_blocks
       WHERE logical_date = ? AND deleted_at IS NULL AND status NOT IN ('skipped', 'moved')
       ORDER BY start_at, end_at, title`,
      [date],
    )
    .map((row) => ({
      id: String(row.id),
      title: String(row.title),
      start_at: Number(row.start_at),
      end_at: Number(row.end_at),
      kind: String(row.kind),
      area_id: row.area_id as string | null,
    }));
}

/** area_choices */
export function areaChoices(conn: Conn) {
  return conn
    .all(
      "SELECT id, name FROM area_items WHERE active = 1 AND deleted_at IS NULL ORDER BY priority_rank, name",
    )
    .map((row) => ({ id: String(row.id), name: String(row.name) }));
}

export const otherContext = (blockId: string) => `focus:${blockId}`;

/** add_other_block: a neutral block now, logged so it can be undone. */
export function addOtherBlock(
  conn: Conn,
  title: string,
  minutes: number,
  now: number,
  counter: number,
): string {
  const id = newId(now, counter).replace("fs-", "fb-");
  const [date] = logicalDay(now);
  applyOps(
    conn,
    "user",
    otherContext(id),
    [
      {
        op: "insert",
        table: "day_blocks",
        id,
        values: {
          logical_date: date,
          start_at: now,
          end_at: now + Math.max(minutes, 1) * MINUTE_MS,
          kind: "area",
          area_id: null,
          title: title.trim(),
          source: "user",
        },
      },
    ],
    now,
  );
  return id;
}

export function removeOtherBlock(conn: Conn, blockId: string, now: number) {
  try {
    undoContext(conn, "user", otherContext(blockId), now);
  } catch (error) {
    console.warn("could not take back the focus block:", error);
  }
}

/** restore: the open session (if any) and the current row, as after a restart. */
export function restore(conn: Conn, now: number): Machine {
  const open = first(
    conn,
    `SELECT s.id, s.kind, s.started_at, s.planned_min, s.paused_at, s.paused_ms, s.block_id,
            s.area_id, s.task_id, s.extended, s.distractions, s.run_of,
            COALESCE(f.intent_text, b.title) AS named, COALESCE(a.name, 'Focus') AS area_name,
            COALESCE(a.break_min, 5) AS break_min
     FROM focus_sessions AS s
     LEFT JOIN day_blocks AS b ON b.id = s.block_id
     LEFT JOIN area_items AS a ON a.id = s.area_id
     LEFT JOIN focus_sessions AS f ON f.id = replace(s.id, '-break', '') AND f.kind = 'focus'
     WHERE s.ended_at IS NULL ORDER BY s.started_at DESC LIMIT 1`,
  );
  const current: Session | null = open
    ? {
        id: String(open.id),
        kind: open.kind === "break" || open.kind === "long_break" ? open.kind : "focus",
        started_at: Number(open.started_at),
        planned_min: Number(open.planned_min),
        paused_at: open.paused_at === null ? null : Number(open.paused_at),
        paused_ms: Number(open.paused_ms),
        block_id: open.block_id as string | null,
        area_id: open.area_id as string | null,
        task_id: open.task_id as string | null,
        extended: Number(open.extended) === 1,
        title: String(open.area_name),
        break_min: Number(open.break_min),
        distractions: Number(open.distractions),
        lanes: [],
        run_of: open.run_of as string | null,
      }
    : null;
  if (current) {
    current.lanes =
      current.kind === "focus"
        ? loadLanes(conn, current.id, true)
        : current.id.endsWith("-break")
          ? loadLanes(conn, current.id.slice(0, -"-break".length), false)
          : [];
    if (open?.named !== null && open?.named !== undefined) current.title = String(open.named);
    else if (current.lanes.length > 0) current.title = runTitle(current.lanes);
  }
  const recent = conn.all(
    `SELECT started_at, ended_at FROM focus_sessions
     WHERE kind = 'focus' AND outcome = 'completed' AND ended_at > ? ORDER BY started_at DESC LIMIT 8`,
    [now - 6 * 60 * MINUTE_MS],
  );
  let inRow = 0;
  let previousStart = now;
  for (const row of recent) {
    if (previousStart - Number(row.ended_at) > ROW_GAP_MS) break;
    inRow += 1;
    previousStart = Number(row.started_at);
  }
  return {
    current,
    in_row: inRow,
    last_focus_end: recent[0] ? Number(recent[0].ended_at) : null,
  };
}

/** load_lanes: a run's lanes in order with their time run; `live` with their open span too. */
export function loadLanes(conn: Conn, sessionId: string, live: boolean): Lane[] {
  return conn
    .all(
      `SELECT r.task_id, t.title, r.area_id, a.name, r.position,
              t.status = 'done' AS done,
              (SELECT MIN(p.start_at) FROM focus_lane_spans AS p
               WHERE p.session_id = r.session_id AND p.task_id = r.task_id AND p.end_at IS NULL) AS running_since,
              (SELECT COALESCE(SUM(p.end_at - p.start_at), 0) FROM focus_lane_spans AS p
               WHERE p.session_id = r.session_id AND p.task_id = r.task_id AND p.end_at IS NOT NULL) AS closed_ms
       FROM focus_run_tasks AS r
       JOIN task_items AS t ON t.id = r.task_id
       LEFT JOIN area_items AS a ON a.id = r.area_id
       WHERE r.session_id = ?
       ORDER BY r.position`,
      [sessionId],
    )
    .map((row) => ({
      task_id: String(row.task_id),
      title: String(row.title),
      area_id: row.area_id as string | null,
      area: row.name as string | null,
      position: Number(row.position),
      done: Number(row.done) === 1,
      running_since: live && row.running_since !== null ? Number(row.running_since) : null,
      closed_ms: Number(row.closed_ms),
    }));
}

/** set_intent's write: the intent becomes the session's title and is stored. */
export function setIntent(machine: Machine, conn: Conn, intent: string): boolean {
  const session = machine.current;
  if (!session || session.kind !== "focus") return false;
  session.title = intent;
  conn.run("UPDATE focus_sessions SET intent_text = ? WHERE id = ?", [intent, session.id]);
  return true;
}

/** last_target: what the last focus session was for (its block, else its area). */
export function lastTarget(conn: Conn): [string | null, string | null] {
  const row = first(
    conn,
    "SELECT block_id, area_id FROM focus_sessions WHERE kind = 'focus' ORDER BY started_at DESC LIMIT 1",
  );
  if (!row) return [null, null];
  const block = row.block_id as string | null;
  return block !== null ? [block, null] : [null, row.area_id as string | null];
}

// --- guard.rs ---------------------------------------------------------------------

const DEFAULT_CAP_MIN = 4 * 60;
const DEFAULT_HARD_STOP_MIN = 22 * 60 + 30;

const FOCUSED_TODAY_SQL = `
  SELECT COALESCE(SUM(MAX(0, (COALESCE(f.ended_at, ?2) - f.started_at - f.paused_ms) / 60000)), 0) AS n
  FROM focus_sessions AS f
  LEFT JOIN day_blocks AS b ON b.id = f.block_id
  WHERE f.kind = 'focus' AND f.started_at >= ?1 AND COALESCE(b.kind, '') != 'fixed'`;

export function focusedToday(conn: Conn, now: number): number {
  const [, dayStart] = logicalDay(now);
  return Number(first(conn, FOCUSED_TODAY_SQL, [dayStart, now])?.n ?? 0);
}

function capMin(conn: Conn): number {
  const row = first(conn, "SELECT value_json FROM core_settings WHERE key = 'focus.daily_cap_min'");
  const text = typeof row?.value_json === "string" ? row.value_json.trim() : "";
  return /^[+-]?\d+$/.test(text) ? Number(text) : DEFAULT_CAP_MIN;
}

const atCap = (focusedMin: number, cap: number) => cap > 0 && focusedMin >= cap;

/** guard::stopped_now: past the hard stop, before the day ends at 03:00. */
export function stoppedNow(conn: Conn, now: number): boolean {
  const text = settingString(conn, "day.hard_stop");
  const stop = (text !== undefined ? parseHhmm(text) : undefined) ?? DEFAULT_HARD_STOP_MIN;
  return logicalMinutes(localMinutes(now)) >= logicalMinutes(stop);
}

/** guard::after_start: mark the session overrun past the cap. */
export function afterStart(conn: Conn, sessionId: string, now: number) {
  if (atCap(focusedToday(conn, now), capMin(conn)))
    conn.run("UPDATE focus_sessions SET overrun = 1 WHERE id = ?", [sessionId]);
}

/** guard::after_complete: the once-a-day cap flag; the toast text when it is due. */
export function afterComplete(conn: Conn, now: number): string | undefined {
  const [date] = logicalDay(now);
  const cap = capMin(conn);
  if (!atCap(focusedToday(conn, now), cap)) return undefined;
  if (settingString(conn, "guard.cap_toasted") === date) return undefined;
  conn.run(
    `INSERT INTO core_settings (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    ["guard.cap_toasted", `"${date}"`, now],
  );
  const hours = cap % 60 === 0 ? String(cap / 60) : (cap / 60).toFixed(1);
  return `That's ${hours} h. Stop here; tomorrow is planned.`;
}

// --- kit.rs and the sheet (commands.rs) -------------------------------------------

function list(json: unknown): string[] {
  try {
    const value: unknown = JSON.parse(String(json));
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return [];
    return value.map((item: string) => item.trim()).filter((item) => item !== "");
  } catch {
    return [];
  }
}

/** kit::load */
export function loadKit(conn: Conn, areaId: string | null) {
  const empty = { open: [] as string[], minimize: [] as string[], checklist: [] as string[] };
  if (areaId === null) return empty;
  const row = first(
    conn,
    "SELECT open_json, minimize_json, checklist_json FROM focus_kits WHERE area_id = ?",
    [areaId],
  );
  if (!row) return empty;
  return {
    open: list(row.open_json),
    minimize: list(row.minimize_json),
    checklist: list(row.checklist_json),
  };
}

/** cheat_lines: the area's cheat lines in card order, at most 12. */
export function cheatLines(conn: Conn, areaId: string | null): string[] {
  if (areaId === null) return [];
  return conn
    .all(
      `SELECT body FROM note_items
       WHERE kind = 'cheat' AND status = 'kept' AND deleted_at IS NULL AND area_id = ?
       ORDER BY sort_order IS NULL, sort_order, created_at, id
       LIMIT ?`,
      [areaId, 12],
    )
    .map((row) => String(row.body));
}

export interface SetupTarget {
  blockId?: string | null;
  areaId?: string | null;
  other?: string | null;
}

/** SetupTarget::resolve */
export function resolveTarget(
  target: SetupTarget | null,
  openedFor: string | null,
): [string | null, string | null] {
  return target === null ? [openedFor, null] : [target.blockId ?? null, target.areaId ?? null];
}

/** SetupTarget::other_name */
export function otherName(target: SetupTarget | null): string | null {
  const name = target?.other?.trim();
  return name ? name : null;
}

/** setup_info (dnd is false: Do not disturb isn't probed in a browser). */
export function setupInfo(
  conn: Conn,
  target: SetupTarget | null,
  openedFor: string | null,
  now: number,
) {
  const [block, area] = resolveTarget(target, openedFor);
  const context = contextForTarget(conn, block, area);
  const name = otherName(target);
  if (name !== null) context.title = name;
  return {
    kit: loadKit(conn, context.area_id),
    title: context.title,
    minutes: context.focus_min,
    dnd: false,
    notes: cheatLines(conn, context.area_id),
    block_id: openedFor,
    blocks: todayBlocks(conn, now),
    areas: areaChoices(conn),
  };
}

/** start_result */
export function startResult(effects: readonly Effect[]): string {
  if (effects.some((e) => e.type === "past_hard_stop")) return "confirm-stop";
  if (effects.some((e) => e.type === "need_confirm")) return "confirm";
  if (effects.some((e) => e.type === "already_focusing")) return "already";
  return "started";
}
