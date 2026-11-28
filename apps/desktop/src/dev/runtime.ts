/**
 * Dev-only port of the focus runtime around the Machine: focus::dispatch,
 * start_for, the toasts' buttons, and the commands setup_start,
 * focus_start, focus_control, run_start and the lane commands. It runs on a
 * World the harness supplies
 * (one shared database and machine), so tests can drive it in node too.
 */
import { type Conn, first, inTransaction } from "./conn";
import {
  addOtherBlock,
  afterComplete,
  afterStart,
  applyDb,
  type Context,
  contextFor,
  contextForRun,
  contextForTarget,
  endsAt,
  type Effect,
  type Event,
  handle,
  laneFor,
  lastTarget,
  type Machine,
  newId,
  otherName,
  refreshDone,
  removeOtherBlock,
  resolveTarget,
  setIntent,
  type SetupTarget,
  startResult,
  stoppedNow,
} from "./focus";

export interface Toast {
  at: number;
  title: string;
  body: string;
  buttons: { label: string; action: string }[];
  /** What the buttons act on (the session whose intent is asked about). */
  intentId?: string | null;
}

export interface World {
  conn: Conn;
  machine: Machine;
  /** focus::new_id's process-wide counter. */
  nextCounter(): number;
  emit(event: string, payload: unknown): void;
  /** A toast Rust would show; the harness keeps a log of them. */
  toast(toast: Toast): void;
}

/** open_intent: the intent of the session that just ended, if unanswered. */
export function openIntent(conn: Conn): [string, string] | undefined {
  const row = first(
    conn,
    `SELECT id, intent_text FROM (
       SELECT id, intent_text, intent_done FROM focus_sessions
       WHERE kind = 'focus' AND ended_at IS NOT NULL
       ORDER BY ended_at DESC LIMIT 1
     ) WHERE intent_text IS NOT NULL AND intent_done IS NULL`,
  );
  return row ? [String(row.id), String(row.intent_text)] : undefined;
}

function toastFor(world: World, effect: Effect, now: number): Toast | undefined {
  if (effect.type === "break_started") {
    const title = effect.long
      ? `Long break · ${effect.minutes} min`
      : `Break · ${effect.minutes} min`;
    const rest = effect.long
      ? "Four sessions done. Walk around, drink water, rest your eyes."
      : "Stand up, drink water, look away from the screen.";
    const intent = openIntent(world.conn);
    const buttons = intent
      ? [
          { label: "Yes", action: "done:yes" },
          { label: "Partly", action: "done:partly" },
          { label: "No", action: "done:no" },
        ]
      : [];
    if (effect.can_extend) buttons.push({ label: "+5 min work, once", action: "extend" });
    return {
      at: now,
      title,
      body: intent ? `Done with: ${intent[1]}? ${rest}` : rest,
      buttons,
      intentId: intent?.[0] ?? null,
    };
  }
  if (effect.type === "break_over")
    return {
      at: now,
      title: "Break over",
      body: "Start the next session?",
      buttons: [
        { label: "Start", action: "start" },
        { label: "Done for now", action: "done" },
      ],
    };
  return undefined;
}

/** focus::dispatch: runs an event, saves, and reports what Rust would emit. */
export function dispatch(world: World, event: Event, now: number): Effect[] {
  refreshDone(world.conn, world.machine);
  const effects = handle(world.machine, event, now);
  try {
    applyDb(world.conn, effects);
  } catch (error) {
    console.error("could not save the focus session:", error);
  }
  for (const effect of effects) {
    const toast = toastFor(world, effect, now);
    if (toast) world.toast(toast);
  }
  if (effects.some((e) => e.type === "close" && e.outcome === "completed")) {
    const capText = afterComplete(world.conn, now);
    if (capText) world.toast({ at: now, title: "Daily focus cap", body: capText, buttons: [] });
  }
  const tables = changedTables(effects);
  if (tables.length > 0) {
    world.emit("focus-changed", null);
    world.emit("data-changed", tables);
  }
  return effects;
}

/** changed_tables: what a set of effects wrote, for "data-changed". */
export function changedTables(effects: readonly Effect[]): string[] {
  const tables = new Set<string>();
  for (const effect of effects) {
    if (effect.type === "save" || effect.type === "close" || effect.type === "add_distraction")
      ["focus_sessions", "focus_run_tasks", "focus_lane_spans"].forEach((t) => tables.add(t));
    else if (
      effect.type === "span_open" ||
      effect.type === "span_close" ||
      effect.type === "lane_removed"
    )
      ["focus_run_tasks", "focus_lane_spans"].forEach((t) => tables.add(t));
    else if (effect.type === "task_done")
      ["focus_run_tasks", "task_items"].forEach((t) => tables.add(t));
  }
  return [...tables];
}

/** focus::start_for: a session for a block, an area with no block, or nothing. */
export function startFor(
  world: World,
  blockId: string | null,
  areaId: string | null,
  force: boolean,
  now: number,
): Effect[] {
  return startContext(world, contextForTarget(world.conn, blockId, areaId), force, now);
}

/** start_context: the hard stop, the machine, the cap. */
function startContext(world: World, context: Context, force: boolean, now: number): Effect[] {
  if (!force && stoppedNow(world.conn, now)) return [{ type: "past_hard_stop" }];
  const id = newId(now, world.nextCounter());
  const effects = dispatch(world, { type: "start", context, force, id }, now);
  if (effects.some((e) => e.type === "save" && e.session.id === id))
    afterStart(world.conn, id, now);
  return effects;
}

/**
 * The timer thread: Rust wakes at each deadline, so moving the clock from
 * `from` to `to` ticks at every session end in between, then at `to`.
 */
export function tickThrough(world: World, from: number, to: number) {
  for (let guard = 0; guard < 1000; guard++) {
    const session = world.machine.current;
    if (!session || session.paused_at !== null) break;
    const deadline = endsAt(session);
    if (deadline > to) break;
    dispatch(world, { type: "tick" }, Math.max(deadline, from));
    if (world.machine.current === session) break;
  }
  dispatch(world, { type: "tick" }, to);
  world.emit("focus-tick", null);
}

/** focus_start */
export function focusStart(
  world: World,
  args: { blockId?: unknown; force?: unknown },
  now: number,
): string {
  const block = typeof args.blockId === "string" ? args.blockId : null;
  return startResult(startFor(world, block, null, args.force === true, now));
}

/** run_start: a run of tasks, the first task's lane running at once. */
export function runStart(
  world: World,
  args: { taskIds?: unknown; minutes?: unknown; force?: unknown },
  now: number,
): string {
  const ids = Array.isArray(args.taskIds) ? args.taskIds.map(String) : [];
  const minutes = typeof args.minutes === "number" ? args.minutes : null;
  const context = contextForRun(world.conn, ids, minutes);
  if (!context) throw "Pick at least one task for the run.";
  return startResult(startContext(world, context, args.force === true, now));
}

/** lane_start, lane_pause, lane_done, lane_add and lane_remove. */
export function laneCommand(
  world: World,
  command: "lane_start" | "lane_pause" | "lane_done" | "lane_add" | "lane_remove",
  args: { taskId?: unknown },
  now: number,
) {
  const taskId = String(args.taskId);
  if (command === "lane_add") {
    const lane = laneFor(world.conn, taskId, 0);
    if (!lane) throw "That task is gone.";
    dispatch(world, { type: "lane_add", lane }, now);
  } else {
    dispatch(world, { type: command, task_id: taskId }, now);
  }
  return null;
}

/** focus_control */
export function focusControl(world: World, args: { action?: unknown }, now: number) {
  const action = String(args.action);
  const events: Record<string, Event> = {
    pause: { type: "pause" },
    resume: { type: "resume" },
    stop: { type: "stop" },
    distracted: { type: "distracted" },
  };
  const event = events[action];
  if (!event) throw `Unknown focus action: ${action}`;
  dispatch(world, event, now);
  return null;
}

export interface SetupStartArgs {
  intent?: unknown;
  force?: unknown;
  target?: unknown;
}

/**
 * setup_start: "Other…" adds its block first; then the session starts. On
 * "started" the sheet closes (`closed` is true) and the intent is saved.
 */
export function setupStart(
  world: World,
  args: SetupStartArgs,
  openedFor: string | null,
  now: number,
): { result: string; closed: boolean } {
  const target = (args.target ?? null) as SetupTarget | null;
  const name = otherName(target);
  if (target?.other !== undefined && target.other !== null && name === null)
    throw "Type what this session is for.";
  let added: string | null = null;
  if (name !== null) {
    const minutes = contextFor(world.conn, null).focus_min;
    try {
      added = inTransaction(world.conn, () =>
        addOtherBlock(world.conn, name, minutes, now, world.nextCounter()),
      );
    } catch (error) {
      throw error instanceof Error ? error.message : String(error);
    }
  }
  const [block, area] = added !== null ? [added, null] : resolveTarget(target, openedFor);
  const effects = startFor(world, block, area, args.force === true, now);
  const result = startResult(effects);
  if (result !== "started") {
    if (added !== null) removeOtherBlock(world.conn, added, now);
    return { result, closed: false };
  }
  if (added !== null) world.emit("data-changed", ["day_blocks"]);
  const intent = typeof args.intent === "string" ? args.intent.trim() : "";
  if (intent !== "" && setIntent(world.machine, world.conn, intent))
    world.emit("focus-changed", null);
  return { result, closed: true };
}

/** A toast button, as notify::show's callback would get it. */
export function toastAction(world: World, toast: Toast, action: string, now: number) {
  if (action === "extend") {
    dispatch(world, { type: "extend", id: newId(now, world.nextCounter()) }, now);
  } else if (action === "start") {
    const [block, area] = lastTarget(world.conn);
    startFor(world, block, area, false, now);
  } else if (action.startsWith("done:") && toast.intentId) {
    world.conn.run(
      "UPDATE focus_sessions SET intent_done = ? WHERE id = ? AND intent_done IS NULL",
      [action.slice("done:".length), toast.intentId],
    );
    world.emit("data-changed", ["focus_sessions"]);
  }
}
