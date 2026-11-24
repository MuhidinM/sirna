/**
 * Dev-only: one database shared by every page of a browser context (main
 * window, capture bar, focus sheet, widget), the way Rust shares one file.
 *
 * Each page holds a sql.js copy. A write takes a Web Lock, catches up with
 * the newest snapshot, runs, stores the new snapshot in IndexedDB, bumps a
 * version in localStorage and tells the other pages on a BroadcastChannel;
 * they reload the snapshot and replay the events Rust would have emitted.
 * Reads catch up first, so a page never reads behind a write it was told of.
 * The clock, the focus machine and the window log live in localStorage.
 */
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";

import { type Conn, sqlJsConn } from "./conn";
import { catchUp } from "./migrate";
import { emptyMachine, type Machine, restore } from "./focus";
import { type Toast } from "./runtime";

const PREFIX = "sirna.dev.";
const KEY = {
  version: `${PREFIX}version`,
  state: `${PREFIX}state`,
  clock: `${PREFIX}clock`,
};
const LOCK = "sirna-dev-db";
const IDB = { name: "sirna-dev", store: "db", key: "snapshot" };

export interface WindowEntry {
  at: number;
  /** The command that asked for it (open_capture, focus_setup_open, close_window…). */
  command: string;
  /** The page to navigate to (opens), or the page that closed (close_window). */
  page: string;
  args: Record<string, unknown>;
}

export interface SharedState {
  /** Null until first used: then restored from focus_sessions, as on app start. */
  machine: Machine | null;
  counter: number;
  /** kit::PendingSetup: the block the open sheet is for. */
  pendingSetup: string | null;
  /** review::PendingScreen: the screen the main window should open on. */
  pendingScreen: string | null;
  windows: WindowEntry[];
  toasts: Toast[];
}

const emptyState = (): SharedState => ({
  machine: null,
  counter: 0,
  pendingSetup: null,
  pendingScreen: null,
  windows: [],
  toasts: [],
});

// --- Storage helpers (every access tolerates a missing or blocked store) ------------

function readJson<T>(key: string): T | undefined {
  try {
    const text = localStorage.getItem(key);
    return text === null ? undefined : (JSON.parse(text) as T);
  } catch {
    return undefined;
  }
}

function writeJson(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value));
}

function idb<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    const open = indexedDB.open(IDB.name, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(IDB.store);
    open.onerror = () => reject(open.error ?? new Error("indexedDB open failed"));
    open.onsuccess = () => {
      const db = open.result;
      const request = work(db.transaction(IDB.store, mode).objectStore(IDB.store));
      request.onsuccess = () => {
        db.close();
        resolve(request.result);
      };
      request.onerror = () => {
        db.close();
        reject(request.error ?? new Error("indexedDB request failed"));
      };
    };
  });
}

interface Snapshot {
  version: number;
  bytes: Uint8Array;
}

const getSnapshot = () =>
  idb("readonly", (store) => store.get(IDB.key) as IDBRequest<Snapshot | undefined>);
const putSnapshot = (snapshot: Snapshot) =>
  idb("readwrite", (store) => store.put(snapshot, IDB.key));
const dropSnapshot = () => idb("readwrite", (store) => store.delete(IDB.key));

// --- The clock ----------------------------------------------------------------------

/** A fixed Addis time (from ?now, moved only by advance) or an offset on real time. */
interface ClockState {
  fixed: number | null;
  offset: number;
}

const realNow = Date.now.bind(Date);
let clock: ClockState = readJson<ClockState>(KEY.clock) ?? { fixed: null, offset: 0 };

export const now = () => clock.fixed ?? realNow() + clock.offset;

function setClock(next: ClockState) {
  clock = next;
  writeJson(KEY.clock, next);
}

/** `?now=2026-11-16T09:30`: Addis time, held still until advance() moves it. */
export function setNow(text: string) {
  const at = Date.parse(`${text.length === 16 ? `${text}:00` : text}+03:00`);
  if (Number.isNaN(at)) throw new Error(`?now=${text} is not YYYY-MM-DDTHH:MM`);
  setClock({ fixed: at, offset: 0 });
}

export function moveClock(ms: number) {
  setClock(
    clock.fixed !== null
      ? { fixed: clock.fixed + ms, offset: 0 }
      : { fixed: null, offset: clock.offset + ms },
  );
}

// --- The shared database ------------------------------------------------------------

export interface Emitted {
  event: string;
  payload: unknown;
}

type Listener = (emitted: Emitted) => void;

export class Store {
  private db!: Database;
  conn!: Conn;
  private version = 0;
  private readonly channel = new BroadcastChannel("sirna-dev");

  private constructor(
    private readonly SQL: SqlJsStatic,
    private readonly deliver: Listener,
  ) {
    this.channel.onmessage = (message: MessageEvent<{ emits: Emitted[] }>) => {
      void this.sync().then(() => {
        for (const emitted of message.data.emits) this.deliver(emitted);
      });
    };
    window.addEventListener("storage", (event) => {
      if (event.key === KEY.clock)
        clock = readJson<ClockState>(KEY.clock) ?? { fixed: null, offset: 0 };
    });
  }

  static async open(deliver: Listener, fresh: boolean): Promise<Store> {
    const SQL = await initSqlJs({ locateFile: () => wasmUrl });
    const store = new Store(SQL, deliver);
    if (fresh) await store.clear();
    const snapshot = fresh ? undefined : await getSnapshot().catch(() => undefined);
    if (snapshot) store.load(snapshot.bytes, snapshot.version);
    else store.load(await baseBytes(), 0);
    return store;
  }

  private load(bytes: Uint8Array, version: number) {
    this.db?.close();
    this.db = new this.SQL.Database(bytes);
    // db::configure: the pragmas that matter in memory.
    this.db.exec("PRAGMA foreign_keys = ON");
    this.conn = sqlJsConn(this.db);
    this.version = version;
    // A base file or snapshot from before a newer migration (F65-new).
    try {
      const applied = catchUp(this.conn);
      if (applied.length > 0) console.info("preview database migrated:", applied.join(", "));
    } catch (error) {
      console.error("could not migrate the preview database:", error);
    }
  }

  /** Catches up with the newest snapshot another page stored. */
  async sync() {
    const stored = Number(localStorage.getItem(KEY.version) ?? 0);
    if (stored <= this.version) return;
    const snapshot = await getSnapshot();
    if (snapshot && snapshot.version > this.version) this.load(snapshot.bytes, snapshot.version);
  }

  /** Shared state (call inside `write`, or for a read-only look). */
  state(): SharedState {
    return { ...emptyState(), ...readJson<SharedState>(KEY.state) };
  }

  /**
   * Runs one command under the lock with the newest database and state, then
   * stores both and tells every page (this one included) what it emitted.
   */
  async write<T>(work: (state: SharedState, emit: (event: string, payload: unknown) => void) => T) {
    return navigator.locks.request(LOCK, async () => {
      await this.sync();
      const state = this.state();
      state.machine ??= this.restoreMachine();
      const emits: Emitted[] = [];
      const result = work(state, (event, payload) => emits.push({ event, payload }));
      const version = Math.max(this.version, Number(localStorage.getItem(KEY.version) ?? 0)) + 1;
      const bytes = this.db.export();
      // export() reopens the database: put the pragmas back.
      this.db.exec("PRAGMA foreign_keys = ON");
      await putSnapshot({ version, bytes });
      writeJson(KEY.state, state);
      localStorage.setItem(KEY.version, String(version));
      this.version = version;
      this.channel.postMessage({ emits });
      for (const emitted of emits) this.deliver(emitted);
      return result;
    });
  }

  private restoreMachine(): Machine {
    try {
      return restore(this.conn, now());
    } catch (error) {
      console.error("could not restore the focus timer:", error);
      return emptyMachine();
    }
  }

  /** Back to the base database and an empty shared state (the clock stays). */
  async clear() {
    await navigator.locks.request(LOCK, async () => {
      await dropSnapshot().catch(() => undefined);
      localStorage.removeItem(KEY.state);
      localStorage.setItem(KEY.version, "0");
    });
  }

  async reset(everything: Emitted[]) {
    await this.clear();
    this.load(await baseBytes(), 0);
    this.channel.postMessage({ reset: true, emits: [] });
    for (const emitted of everything) this.deliver(emitted);
  }

  /** Another page reset: reload the base. */
  onReset(handler: () => void) {
    this.channel.addEventListener("message", (message: MessageEvent<{ reset?: boolean }>) => {
      if (message.data.reset) void baseBytes().then((bytes) => (this.load(bytes, 0), handler()));
    });
  }
}

async function baseBytes(): Promise<Uint8Array> {
  const response = await fetch("/dev-data/sirna.db");
  const bytes = new Uint8Array(await response.arrayBuffer());
  // A missing file comes back as the dev server's index.html.
  if (!response.ok || new TextDecoder().decode(bytes.slice(0, 15)) !== "SQLite format 3")
    throw new Error("No dev-data/sirna.db: run `node scripts/preview-db.mjs <backup.db>` first");
  return bytes;
}
