// The unit tests of src-tauri/src/focus.rs and guard.rs, run against the port,
// plus the runtime the harness drives (setup_start, ticking through time).
import { describe, expect, it } from "vitest";

import { openTestDb } from "../test/sqlite";
import { type Conn, nodeConn } from "./conn";
import {
  addOtherBlock,
  applyDb,
  areaChoices,
  type Context,
  contextFor,
  contextForTarget,
  type Effect,
  emptyMachine,
  endsAt,
  EXTEND_MIN,
  focusedToday,
  handle,
  lastTarget,
  type Machine,
  removeOtherBlock,
  restore,
  status,
  todayBlocks,
} from "./focus";
import { openIntent, setupStart, tickThrough, type Toast, type World } from "./runtime";

const T0 = 1_794_387_600_000; // 2026-11-11 12:00 Addis
const minutes = (n: number) => n * 60_000;
const conn = (): Conn => nodeConn(openTestDb());

const context = (): Context => ({
  block_id: "b1",
  area_id: "coding",
  task_id: null,
  title: "Coding",
  focus_min: 25,
  break_min: 5,
});

const start = (m: Machine, now: number, n: number) =>
  handle(m, { type: "start", context: context(), force: false, id: `s${n}` }, now);

const has = (effects: Effect[], wanted: Effect) =>
  effects.some((effect) => JSON.stringify(effect) === JSON.stringify(wanted));

describe("the focus machine", () => {
  it("a session ends with a short break", () => {
    const m = emptyMachine();
    start(m, T0, 1);
    expect(handle(m, { type: "tick" }, T0 + minutes(24))).toEqual([]);
    const effects = handle(m, { type: "tick" }, T0 + minutes(25));
    expect(has(effects, { type: "break_started", minutes: 5, long: false, can_extend: true })).toBe(
      true,
    );
    expect(m.current?.kind).toBe("break");
    expect(has(handle(m, { type: "tick" }, T0 + minutes(30)), { type: "break_over" })).toBe(true);
    expect(m.current).toBeNull();
  });

  it("the fourth session in a row gets a long break", () => {
    const m = emptyMachine();
    let now = T0;
    for (let n = 1; n <= 4; n++) {
      start(m, now, n);
      now += minutes(25);
      const effects = handle(m, { type: "tick" }, now);
      const long = n === 4;
      expect(
        effects.some((e) => e.type === "break_started" && e.long === long),
        `session ${n}`,
      ).toBe(true);
      now += minutes(long ? 20 : 5);
      handle(m, { type: "tick" }, now);
    }
  });

  it("a gap of more than 15 minutes starts a new row", () => {
    const m = emptyMachine();
    let now = T0;
    for (let n = 1; n <= 3; n++) {
      start(m, now, n);
      now += minutes(25);
      handle(m, { type: "tick" }, now);
      now += minutes(5);
      handle(m, { type: "tick" }, now);
    }
    now += minutes(60);
    start(m, now, 4);
    now += minutes(25);
    expect(
      has(handle(m, { type: "tick" }, now), {
        type: "break_started",
        minutes: 5,
        long: false,
        can_extend: true,
      }),
    ).toBe(true);
  });

  it("starting early in a long break needs a second tap", () => {
    const m: Machine = { current: null, in_row: 3, last_focus_end: T0 };
    start(m, T0, 1);
    handle(m, { type: "tick" }, T0 + minutes(25));
    expect(m.current?.kind).toBe("long_break");
    expect(start(m, T0 + minutes(30), 2)).toEqual([{ type: "need_confirm" }]);
    const forced = handle(
      m,
      { type: "start", context: context(), force: true, id: "s3" },
      T0 + minutes(30),
    );
    expect(forced.some((e) => e.type === "save" && e.session.kind === "focus")).toBe(true);
    const m2: Machine = { current: null, in_row: 3, last_focus_end: T0 };
    start(m2, T0, 1);
    handle(m2, { type: "tick" }, T0 + minutes(25));
    expect(start(m2, T0 + minutes(36), 2).some((e) => e.type === "save")).toBe(true);
  });

  it("a session found long after its end closes as interrupted", () => {
    const m = emptyMachine();
    start(m, T0, 1);
    expect(handle(m, { type: "tick" }, T0 + minutes(25 + 31))).toEqual([
      { type: "close", id: "s1", at: T0 + minutes(25), outcome: "interrupted" },
    ]);
    expect([m.current, m.in_row]).toEqual([null, 0]);
  });

  it("pausing moves the end", () => {
    const m = emptyMachine();
    start(m, T0, 1);
    handle(m, { type: "pause" }, T0 + minutes(10));
    expect(handle(m, { type: "tick" }, T0 + minutes(40))).toEqual([]);
    handle(m, { type: "resume" }, T0 + minutes(15));
    expect(m.current && endsAt(m.current)).toBe(T0 + minutes(30));
  });

  it("stop, distracted and double start", () => {
    const m = emptyMachine();
    start(m, T0, 1);
    expect(start(m, T0 + 1, 2)).toEqual([{ type: "already_focusing" }]);
    expect(handle(m, { type: "distracted" }, T0 + 2)).toEqual([
      { type: "add_distraction", id: "s1" },
    ]);
    expect(handle(m, { type: "stop" }, T0 + 3)).toEqual([
      { type: "close", id: "s1", at: T0 + 3, outcome: "stopped" },
    ]);
    expect(m.current).toBeNull();
  });

  it("stopping while paused keeps the pause out of focus time", () => {
    const m = emptyMachine();
    start(m, T0, 1);
    handle(m, { type: "pause" }, T0 + minutes(5));
    const effects = handle(m, { type: "stop" }, T0 + minutes(50));
    const saved = effects.find((e) => e.type === "save");
    expect(saved?.type === "save" && [saved.session.paused_ms, saved.session.paused_at]).toEqual([
      minutes(45),
      null,
    ]);
    expect(effects.at(-1)).toEqual({
      type: "close",
      id: "s1",
      at: T0 + minutes(50),
      outcome: "stopped",
    });
  });

  it("counts distractions on the session", () => {
    const m = emptyMachine();
    start(m, T0, 1);
    expect(status(m, T0).distractions).toBe(0);
    handle(m, { type: "distracted" }, T0 + 1);
    handle(m, { type: "distracted" }, T0 + 2);
    expect(status(m, T0 + 3).distractions).toBe(2);
    handle(m, { type: "stop" }, T0 + 4);
    expect(status(m, T0 + 5).distractions).toBe(0);
  });

  it("extends once from a short break", () => {
    const m = emptyMachine();
    start(m, T0, 1);
    handle(m, { type: "tick" }, T0 + minutes(25));
    const effects = handle(m, { type: "extend", id: "x1" }, T0 + minutes(26));
    expect(
      effects.some(
        (e) => e.type === "save" && e.session.planned_min === EXTEND_MIN && e.session.extended,
      ),
    ).toBe(true);
    expect(
      has(handle(m, { type: "tick" }, T0 + minutes(31)), {
        type: "break_started",
        minutes: 5,
        long: false,
        can_extend: false,
      }),
    ).toBe(true);
    expect(handle(m, { type: "extend", id: "x2" }, T0 + minutes(32))).toEqual([]);
  });
});

describe("focus in the database", () => {
  it("sessions are saved and restored after a restart", () => {
    const c = conn();
    const m = emptyMachine();
    applyDb(
      c,
      handle(
        m,
        {
          type: "start",
          context: { ...context(), block_id: null, area_id: null, title: "Focus" },
          force: false,
          id: "s1",
        },
        T0,
      ),
    );
    const restored = restore(c, T0 + minutes(10));
    expect([restored.current?.id, restored.current?.kind]).toEqual(["s1", "focus"]);
    applyDb(c, handle(restored, { type: "tick" }, T0 + minutes(25)));
    expect(c.all("SELECT outcome FROM focus_sessions WHERE id = 's1'")[0]?.outcome).toBe(
      "completed",
    );
    expect(restore(c, T0 + minutes(26)).in_row).toBe(1);
  });

  const startPlain = (m: Machine, now: number) =>
    handle(
      m,
      {
        type: "start",
        context: { ...context(), block_id: null, area_id: null, title: "Focus" },
        force: false,
        id: "s1",
      },
      now,
    );

  it("a session stopped while paused counts only the time before the pause", () => {
    const c = conn();
    const m = emptyMachine();
    applyDb(c, startPlain(m, T0));
    applyDb(c, handle(m, { type: "pause" }, T0 + minutes(5)));
    applyDb(c, handle(m, { type: "stop" }, T0 + minutes(50)));
    const row = c.all(
      "SELECT (ended_at - started_at - paused_ms) / 60000 AS focus, paused_at FROM focus_sessions WHERE id = 's1'",
    )[0];
    expect([row?.focus, row?.paused_at]).toEqual([5, null]);
  });

  it("the distraction count survives a restart", () => {
    const c = conn();
    const m = emptyMachine();
    applyDb(c, startPlain(m, T0));
    applyDb(c, handle(m, { type: "distracted" }, T0 + 1));
    applyDb(c, handle(m, { type: "distracted" }, T0 + 2));
    expect(status(restore(c, T0 + minutes(1)), T0 + minutes(1)).distractions).toBe(2);
  });

  it("a session uses its area's lengths", () => {
    const c = conn();
    c.exec(`INSERT INTO day_blocks (id, logical_date, start_at, end_at, kind, area_id, title, created_at, updated_at)
      VALUES ('b1', '2026-11-11', 0, 1, 'area', 'coding', 'Coding skills', 0, 0);`);
    const found = contextFor(c, "b1");
    expect([found.focus_min, found.break_min, found.title]).toEqual([50, 10, "Coding skills"]);
    expect(contextFor(c, null).focus_min).toBe(25);
  });

  const ended = (c: Conn, id: string, endedAt: number, intent: string | null) =>
    c.run(
      `INSERT INTO focus_sessions (id, kind, started_at, planned_min, ended_at, outcome, intent_text)
       VALUES (?, 'focus', ?, 25, ?, 'completed', ?)`,
      [id, endedAt - minutes(25), endedAt, intent],
    );

  it("asks only about the session that just ended", () => {
    const c = conn();
    ended(c, "a", T0, "finish the login form");
    expect(openIntent(c)).toEqual(["a", "finish the login form"]);
    ended(c, "b", T0 + minutes(40), null);
    expect(openIntent(c)).toBeUndefined();
  });

  it("the intent survives a restart as the title", () => {
    const c = conn();
    c.run(
      "INSERT INTO focus_sessions (id, kind, started_at, planned_min, intent_text) VALUES ('s1', 'focus', ?, 25, 'outline the post')",
      [T0],
    );
    expect(restore(c, T0 + minutes(5)).current?.title).toBe("outline the post");
  });

  it("an area session takes the area's name and lengths", () => {
    const c = conn();
    const found = contextForTarget(c, null, "coding");
    expect([found.block_id, found.area_id, found.title, found.focus_min, found.break_min]).toEqual([
      null,
      "coding",
      "Coding skills",
      50,
      10,
    ]);
    const unknown = contextForTarget(c, null, "nope");
    expect([unknown.area_id, unknown.focus_min]).toEqual([null, 25]);
    expect(contextForTarget(c, null, null).title).toBe("Focus");
  });

  it("a block wins over an area", () => {
    const c = conn();
    c.exec(`INSERT INTO day_blocks (id, logical_date, start_at, end_at, kind, area_id, title, created_at, updated_at)
      VALUES ('b1', '2026-11-11', 0, 1, 'fixed', NULL, 'Lunch', 0, 0);`);
    const found = contextForTarget(c, "b1", "coding");
    expect([found.block_id, found.area_id, found.title]).toEqual(["b1", null, "Lunch"]);
  });

  it("the next round after a break counts for the same block or area", () => {
    const c = conn();
    expect(lastTarget(c)).toEqual([null, null]);
    c.run(
      "INSERT INTO focus_sessions (id, area_id, kind, started_at, planned_min) VALUES ('s1', 'quran', 'focus', ?, 20)",
      [T0],
    );
    expect(lastTarget(c)).toEqual([null, "quran"]);
    c.exec(`INSERT INTO day_blocks (id, logical_date, start_at, end_at, kind, area_id, title, created_at, updated_at)
      VALUES ('b1', '2026-11-11', 0, 1, 'area', 'coding', 'Coding skills', 0, 0);`);
    c.run(
      "INSERT INTO focus_sessions (id, block_id, area_id, kind, started_at, planned_min) VALUES ('s2', 'b1', 'coding', 'focus', ?, 50)",
      [T0 + minutes(30)],
    );
    expect(lastTarget(c)).toEqual(["b1", null]);
  });

  it("an area session keeps its area name after a restart", () => {
    const c = conn();
    c.run(
      "INSERT INTO focus_sessions (id, area_id, kind, started_at, planned_min) VALUES ('s1', 'quran', 'focus', ?, 20)",
      [T0],
    );
    expect(restore(c, T0 + minutes(5)).current?.title).toBe("Quran");
  });

  it("the sheet lists today's blocks and active areas", () => {
    const c = conn();
    c.exec(`INSERT INTO day_blocks (id, logical_date, start_at, end_at, kind, area_id, title, status, created_at, updated_at)
      VALUES ('late', '2026-11-11', 20, 30, 'area', 'coding', 'Coding skills', 'planned', 0, 0),
             ('early', '2026-11-11', 10, 20, 'fixed', NULL, 'Lunch', 'planned', 0, 0),
             ('skip', '2026-11-11', 5, 9, 'area', 'gym', 'Gym', 'skipped', 0, 0),
             ('other-day', '2026-11-12', 10, 20, 'area', 'gym', 'Gym', 'planned', 0, 0);
      UPDATE area_items SET active = 0 WHERE id = 'jobb';`);
    expect(todayBlocks(c, T0).map((block) => block.id)).toEqual(["early", "late"]);
    const areas = areaChoices(c);
    expect(areas[0]?.id).toBe("joba");
    expect(areas.every((area) => area.id !== "jobb")).toBe(true);
  });

  it("Other adds an undoable block now for the session length", () => {
    const c = conn();
    const id = addOtherBlock(c, "  Read a book ", 25, T0, 0);
    expect(
      c.all(
        "SELECT logical_date, start_at, end_at, kind, area_id, title, source FROM day_blocks WHERE id = ? AND deleted_at IS NULL",
        [id],
      )[0],
    ).toEqual({
      logical_date: "2026-11-11",
      start_at: T0,
      end_at: T0 + minutes(25),
      kind: "area",
      area_id: null,
      title: "Read a book",
      source: "user",
    });
    expect(contextFor(c, id).title).toBe("Read a book");
    removeOtherBlock(c, id, T0 + 1);
    expect(c.all("SELECT id FROM day_blocks WHERE id = ? AND deleted_at IS NULL", [id])).toEqual(
      [],
    );
  });

  it("counts focus outside job blocks", () => {
    const c = conn();
    const noon = T0;
    c.exec(`INSERT INTO day_blocks (id, logical_date, start_at, end_at, kind, title, created_at, updated_at)
        VALUES ('job', '2026-11-11', 0, 1, 'fixed', 'Job A', 0, 0),
               ('code', '2026-11-11', 0, 1, 'area', 'Coding', 0, 0);
      INSERT INTO focus_sessions (id, block_id, kind, started_at, planned_min, paused_ms, ended_at) VALUES
        ('a', 'code', 'focus', ${noon - minutes(120)}, 50, 0, ${noon - minutes(70)}),
        ('b', NULL, 'focus', ${noon - minutes(60)}, 25, ${minutes(5)}, ${noon - minutes(30)}),
        ('c', 'job', 'focus', ${noon - minutes(60)}, 25, 0, ${noon - minutes(30)}),
        ('d', NULL, 'break', ${noon - minutes(60)}, 5, 0, ${noon - minutes(30)}),
        ('e', NULL, 'focus', ${noon - minutes(24 * 60)}, 25, 0, ${noon - minutes(24 * 60 - 25)});`);
    expect(focusedToday(c, noon)).toBe(75);
  });
});

describe("the harness runtime", () => {
  const world = (c: Conn) => {
    let counter = 0;
    const emitted: string[] = [];
    const toasts: Toast[] = [];
    const w: World = {
      conn: c,
      machine: emptyMachine(),
      nextCounter: () => counter++,
      emit: (event) => emitted.push(event),
      toast: (toast) => toasts.push(toast),
    };
    return { w, emitted, toasts };
  };

  it("starts from the sheet with an intent and ticks through the break", () => {
    const c = conn();
    c.exec(`INSERT INTO day_blocks (id, logical_date, start_at, end_at, kind, area_id, title, created_at, updated_at)
      VALUES ('b1', '2026-11-11', ${T0}, ${T0 + minutes(120)}, 'area', 'coding', 'Coding skills', 0, 0);`);
    const { w, emitted, toasts } = world(c);
    expect(setupStart(w, { intent: " write tests ", target: null }, "b1", T0)).toEqual({
      result: "started",
      closed: true,
    });
    expect(emitted).toContain("focus-changed");
    // Coding is 50/10: advancing 65 minutes completes the session and the break.
    tickThrough(w, T0, T0 + minutes(65));
    const rows = c.all(
      "SELECT kind, block_id, area_id, started_at, planned_min, ended_at, outcome, intent_text FROM focus_sessions ORDER BY started_at, kind DESC",
    );
    expect(rows).toEqual([
      {
        kind: "focus",
        block_id: "b1",
        area_id: "coding",
        started_at: T0,
        planned_min: 50,
        ended_at: T0 + minutes(50),
        outcome: "completed",
        intent_text: "write tests",
      },
      {
        kind: "break",
        block_id: "b1",
        area_id: "coding",
        started_at: T0 + minutes(50),
        planned_min: 10,
        ended_at: T0 + minutes(60),
        outcome: "completed",
        intent_text: null,
      },
    ]);
    expect(toasts.map((toast) => toast.title)).toEqual(["Break · 10 min", "Break over"]);
    expect(toasts[0]?.body).toContain("Done with: write tests?");
  });

  it("past the hard stop asks for a second tap and takes back an Other block", () => {
    const c = conn();
    const { w } = world(c);
    const late = Date.parse("2026-11-11T23:00:00+03:00");
    expect(setupStart(w, { target: { other: "Read" } }, null, late).result).toBe("confirm-stop");
    expect(c.all("SELECT id FROM day_blocks WHERE deleted_at IS NULL")).toEqual([]);
    expect(setupStart(w, { target: { other: "Read" }, force: true }, null, late).result).toBe(
      "started",
    );
    expect(c.all("SELECT title FROM day_blocks WHERE deleted_at IS NULL")).toEqual([
      { title: "Read" },
    ]);
    expect(() => setupStart(w, { target: { other: " " } }, null, late)).toThrow(
      "Type what this session is for.",
    );
  });
});
