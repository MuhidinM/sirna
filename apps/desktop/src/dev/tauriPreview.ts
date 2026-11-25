/**
 * Dev-only: lets every page run in a plain browser (`pnpm dev`, then
 * http://localhost:1420) for design work and user tests. It stands in for
 * Tauri's IPC with ports of the Rust commands (tx.ts, commands.ts, focus.ts,
 * runtime.ts) over one database shared by all pages of the browser context
 * (store.ts), built from dev-data/sirna.db by scripts/preview-db.mjs.
 *
 *   ?now=2026-11-16T09:30   Addis time, held still until __sirna.advance()
 *   ?fresh=1                start again from dev-data/sirna.db
 *   ?screen=review          the screen take_screen hands the main window
 *
 * The three are read once and removed from the address, so a reload keeps
 * the shared clock and database.
 *
 * `window.__sirna` is for test drivers (scripts/user-test/README.md).
 * Never part of a build: each page entry imports this only when
 * `import.meta.env.DEV` and Tauri is absent.
 */
import {
  captureCommit,
  captureReplace,
  captureUndo,
  clearAway,
  dbQuery,
  dbTx,
  type Done,
  notesUndo,
  setAway,
  settingString,
} from "./commands";
import { emptyMachine, restore, setupInfo, status, type SetupTarget } from "./focus";
import {
  focusControl,
  focusStart,
  setupStart,
  tickThrough,
  toastAction,
  type World,
} from "./runtime";
import { type Emitted, moveClock, now, setNow, type SharedState, Store } from "./store";
import { applyOps, TABLES } from "./tx";

type Args = Record<string, unknown>;
type Callback = (payload: unknown) => void;

const callbacks = new Map<number, Callback>();
const listeners = new Map<string, Set<number>>();
let nextId = 1;

function deliver({ event, payload }: Emitted) {
  for (const handler of listeners.get(event) ?? [])
    callbacks.get(handler)?.({ event, id: handler, payload });
}

/** This page's window label, as Tauri names the windows. */
function label(): string {
  const page = location.pathname.split("/").pop() ?? "";
  return (
    { "capture.html": "capture", "setup.html": "setup", "widget.html": "widget" }[page] ?? "main"
  );
}

const pageOf = (windowLabel: string) =>
  windowLabel === "main" ? "index.html" : `${windowLabel}.html`;

/** Every table the app reads, for "data-changed" after a reset. */
const ALL_TABLES = [
  ...TABLES.map((table) => table.name),
  "core_raw_items",
  "core_activity",
  "focus_sessions",
];

export async function install(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const at = params.get("now");
  if (at) setNow(at);
  const realNow = Date.now.bind(Date);
  Date.now = now;
  const store = await Store.open(deliver, params.get("fresh") === "1");
  const everything: Emitted[] = [
    { event: "data-changed", payload: ALL_TABLES },
    { event: "focus-changed", payload: null },
  ];
  store.onReset(() => everything.forEach(deliver));
  /** The timer as it stands; before its first use, restored from the database as at app start. */
  const machine = () => store.state().machine ?? restore(store.conn, now());
  let screen = params.get("screen");
  // One-shot: a reload keeps the shared clock and database instead of resetting them.
  if (at || params.has("fresh") || screen !== null) {
    for (const name of ["now", "fresh", "screen"]) params.delete(name);
    const query = params.toString();
    history.replaceState(
      history.state,
      "",
      `${location.pathname}${query ? `?${query}` : ""}${location.hash}`,
    );
  }

  const world = (state: SharedState, emit: World["emit"]): World => ({
    conn: store.conn,
    machine: (state.machine ??= emptyMachine()),
    nextCounter: () => state.counter++,
    emit,
    toast: (toast) => state.toasts.push(toast),
  });

  /** A Rust command that writes: under the lock, then "data-changed" as Rust emits it. */
  const command =
    <T>(run: (args: Args, time: number) => Done<T>) =>
    (args: Args) =>
      store.write((_state, emit) => {
        const done = run(args, now());
        if (done.changed) emit("data-changed", done.changed);
        return done.result;
      });

  /** A command that opens or closes a window: logged for the test to follow. */
  const windowEvent = (
    command: string,
    page: string,
    args: Args,
    also?: (s: SharedState) => void,
  ) =>
    store.write((state) => {
      state.windows.push({ at: now(), command, page, args });
      also?.(state);
      return null;
    });

  const commands: Record<string, (args: Args) => unknown> = {
    db_query: async (a) => {
      await store.sync();
      return dbQuery(store.conn, String(a.sql), (a.params as unknown[] | null) ?? []);
    },
    db_tx: command((a, time) => dbTx(store.conn, a, time)),
    capture_commit: command((a, time) => captureCommit(store.conn, a, time)),
    capture_replace: command((a, time) => captureReplace(store.conn, a, time)),
    capture_undo: command((a, time) => captureUndo(store.conn, a, time)),
    notes_undo: command((a, time) => notesUndo(store.conn, a, time)),
    set_away: command((a, time) => setAway(store.conn, a, time)),
    clear_away: command((a, time) => clearAway(store.conn, a, time)),
    hotkey_set: (a) =>
      store.write((_state, emit) => {
        const key = String(a.key ?? "").trim();
        applyOps(
          store.conn,
          "user",
          "settings",
          [
            {
              op: "upsert",
              table: "core_settings",
              id: "capture.hotkey",
              values: { value_json: JSON.stringify(key) },
            },
          ],
          now(),
        );
        emit("data-changed", ["core_settings"]);
        return key || "Ctrl+Alt+J";
      }),
    hotkey_current: async () => {
      await store.sync();
      return settingString(store.conn, "capture.hotkey") || "Ctrl+Alt+J";
    },

    // The focus timer.
    focus_status: async () => {
      await store.sync();
      return status(machine(), now());
    },
    focus_start: (a) => store.write((state, emit) => focusStart(world(state, emit), a, now())),
    focus_control: (a) => store.write((state, emit) => focusControl(world(state, emit), a, now())),
    setup_info: async (a) => {
      await store.sync();
      const state = store.state();
      return setupInfo(
        store.conn,
        (a.target ?? null) as SetupTarget | null,
        state.pendingSetup,
        now(),
      );
    },
    setup_start: (a) =>
      store.write((state, emit) => {
        const { result, closed } = setupStart(world(state, emit), a, state.pendingSetup, now());
        if (closed) {
          state.pendingSetup = null;
          state.windows.push({ at: now(), command: "close_window", page: "setup.html", args: {} });
        }
        return result;
      }),

    // Windows: nothing opens; the log says where a test should navigate.
    open_capture: (a) => windowEvent("open_capture", "capture.html", a),
    open_main: (a) => windowEvent("open_main", "index.html", a),
    focus_setup_open: (a) =>
      windowEvent("focus_setup_open", "setup.html", a, (state) => {
        state.pendingSetup = typeof a.blockId === "string" ? a.blockId : null;
      }),
    open_notes: (a) => {
      const pending = `notes:${[...String(a.query ?? "")].slice(0, 200).join("")}`;
      return store
        .write((state, emit) => {
          state.pendingScreen = pending;
          state.windows.push({ at: now(), command: "open_notes", page: "index.html", args: a });
          emit("show-screen", pending);
          return null;
        })
        .then(() => null);
    },
    take_screen: async () => {
      if (screen !== null) {
        const taken = screen;
        screen = null;
        return taken;
      }
      if (store.state().pendingScreen === null) return null;
      return store.write((state) => {
        const taken = state.pendingScreen;
        state.pendingScreen = null;
        return taken;
      });
    },
    close_window: () => windowEvent("close_window", pageOf(label()), {}),
    widget_apply: (a) => windowEvent("widget_apply", "widget.html", a),
    title_bar: () => null,
    capture_ready: () => null,
    brief_ready: () => null,

    "plugin:event|listen": (a) => {
      const handler = Number(a.handler);
      const event = String(a.event);
      listeners.set(event, (listeners.get(event) ?? new Set()).add(handler));
      return handler;
    },
    "plugin:event|unlisten": (a) => {
      listeners.get(String(a.event))?.delete(Number(a.eventId));
      return null;
    },
    "plugin:event|emit": (a) => deliver({ event: String(a.event), payload: a.payload }),

    // No Windows, no network, no secrets in the browser: quiet defaults.
    brief_checks: () => ({ notificationsMuted: false, autostartOff: false }),
    ai_usage: () => ({
      has_key: true,
      model: "gemini-flash-lite-latest",
      used: 3,
      cap: 15,
      quota_day: "",
    }),
    secret_status: () => true,
    secret_set: () => null,
    autostart_status: () => true,
    autostart_set: (a) => a.enabled === true,
    calendar_fetch: () => Promise.reject("offline"),
    ai_models: () => [],
    ai_send: () => Promise.reject("no-key"),
  };

  const windowLabel = label();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: windowLabel },
      currentWebview: { label: windowLabel, windowLabel },
    },
    transformCallback: (callback: Callback) => {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
    unregisterCallback: (id: number) => callbacks.delete(id),
    convertFileSrc: (path: string) => path,
    invoke: async (cmd: string, args: Args = {}) => {
      const run = commands[cmd];
      if (!run) {
        console.debug("[harness] ignored", cmd, args);
        return null;
      }
      return run(args);
    },
  };
  (window as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: (event: string, id: number) => listeners.get(event)?.delete(id),
  };

  // With a running clock (no ?now), the timer ends sessions as time passes.
  setInterval(() => {
    const session = machine().current;
    if (!session || session.paused_at !== null) return;
    const ends = session.started_at + session.planned_min * 60_000 + session.paused_ms;
    if (ends <= now())
      void store.write((state, emit) => tickThrough(world(state, emit), now(), now()));
  }, 5_000);

  /** For test drivers: see scripts/user-test/README.md. */
  const harness = {
    /** Any read query against the shared database. */
    query: async (sql: string, params: unknown[] = []) => {
      await store.sync();
      return dbQuery(store.conn, sql, params);
    },
    /** Moves the clock; the focus timer ticks at every deadline on the way. Returns the new now. */
    advance: (minutes: number) =>
      store.write((state, emit) => {
        const from = now();
        moveClock(minutes * 60_000);
        tickThrough(world(state, emit), from, now());
        return now();
      }),
    now: () => now(),
    /** The time as Addis wall-clock text, "2026-11-16T09:30". */
    nowText: () => new Date(now() + 3 * 3_600_000).toISOString().slice(0, 16),
    realNow,
    /** Back to dev-data/sirna.db in every page; the clock stays. */
    reset: () => store.reset(everything),
    /** open_capture, open_main, open_notes, focus_setup_open, widget_apply, in order. */
    get openedWindows() {
      return store.state().windows.filter((entry) => entry.command !== "close_window");
    },
    /** Every window event, close_window included. */
    get windowLog() {
      return store.state().windows;
    },
    /** Toasts Rust would have shown (break started, break over, daily cap). */
    get toasts() {
      return store.state().toasts;
    },
    /** Presses a button on the newest toast that has it ("extend", "start", "done:yes"…). */
    pressToast: (action: string) =>
      store.write((state, emit) => {
        const toast = [...state.toasts]
          .reverse()
          .find((entry) => entry.buttons.some((button) => button.action === action));
        if (!toast) throw new Error(`No toast with a "${action}" button`);
        toastAction(world(state, emit), toast, action, now());
        return null;
      }),
    /** focus_status, synchronously. */
    focus: () => status(machine(), now()),
  };
  (window as unknown as Record<string, unknown>).__sirna = harness;
}
