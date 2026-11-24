/**
 * Dev-only port of the focus timer: src-tauri/src/focus.rs (the Machine, its
 * database effects, contexts), guard.rs (hard stop, daily cap), kit.rs (the
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

export type Kind = "focus" | "break" | "long_break";

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
}

export type Outcome = "completed" | "stopped" | "interrupted";

export type Event =
  | { type: "start"; context: Context; force: boolean; id: string }
  | { type: "tick" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "stop" }
  | { type: "distracted" }
  | { type: "extend"; id: string };

export type Effect =
  | { type: "save"; session: Session }
  | { type: "close"; id: string; at: number; outcome: Outcome }
  | { type: "add_distraction"; id: string }
  | { type: "break_started"; minutes: number; long: boolean; can_extend: boolean }
  | { type: "break_over" }
  | { type: "need_confirm" }
  | { type: "already_focusing" }
  | { type: "past_hard_stop" };

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
        return [{ type: "save", session: { ...session } }];
      }
      return [];
    }
    case "resume": {
      const session = machine.current;
      if (session && session.paused_at !== null) {
        session.paused_ms += now - session.paused_at;
        session.paused_at = null;
        return [{ type: "save", session: { ...session } }];
      }
      return [];
    }
    case "stop": {
      const session = machine.current;
      machine.current = null;
      if (!session) return [];
      if (session.kind === "focus") machine.last_focus_end = now;
      return [{ type: "close", id: session.id, at: now, outcome: "stopped" }];
    }
    case "distracted":
      return machine.current?.kind === "focus"
        ? [{ type: "add_distraction", id: machine.current.id }]
        : [];
    case "extend":
      return extend(machine, event.id, now);
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
  };
  effects.push({ type: "save", session: { ...session } });
  machine.current = session;
  return effects;
}

function tick(machine: Machine, now: number): Effect[] {
  const session = machine.current;
  if (!session || session.paused_at !== null || remainingMs(session, now) > 0) return [];
  const ended = endsAt(session);
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
    };
    effects.push({ type: "save", session: { ...rest } });
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
  };
  machine.in_row = Math.max(0, machine.in_row - 1);
  machine.current = focus;
  return [
    { type: "close", id: current.id, at: now, outcome: "stopped" },
    { type: "save", session: { ...focus } },
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
    };
  return {
    kind: session.kind,
    title: session.title,
    remaining_ms: Math.max(remainingMs(session, now), 0),
    planned_min: session.planned_min,
    paused: session.paused_at !== null,
    in_row: machine.in_row,
    block_id: session.block_id,
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
           (id, block_id, area_id, task_id, kind, started_at, planned_min, paused_at, paused_ms, extended)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT (id) DO UPDATE SET planned_min = ?7, paused_at = ?8, paused_ms = ?9, extended = ?10`,
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
        ],
      );
    } else if (effect.type === "close") {
      conn.run(
        "UPDATE focus_sessions SET ended_at = ?, outcome = ?, paused_at = NULL WHERE id = ?",
        [effect.at, effect.outcome, effect.id],
      );
    } else if (effect.type === "add_distraction") {
      conn.run("UPDATE focus_sessions SET distractions = distractions + 1 WHERE id = ?", [
        effect.id,
      ]);
    }
  }
}

const plain = (): Context => ({
  block_id: null,
  area_id: null,
  task_id: null,
  title: "Focus",
  focus_min: 25,
  break_min: 5,
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
  return {
    block_id: blockId,
    area_id: row.area_id as string | null,
    task_id: row.task_id as string | null,
    title: String(row.title),
    focus_min: Number(row.focus_min),
    break_min: Number(row.break_min),
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
            s.area_id, s.task_id, s.extended,
            COALESCE(f.intent_text, b.title, a.name, 'Focus') AS title, COALESCE(a.break_min, 5) AS break_min
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
        title: String(open.title),
        break_min: Number(open.break_min),
      }
    : null;
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
