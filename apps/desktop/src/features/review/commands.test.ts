import { describe, expect, it } from "vitest";

import { localToEpoch } from "../../capture/when";
import { openTestDb } from "../../test/sqlite";
import {
  type CommandBlock,
  type CommandContext,
  COMMAND_TASKS_SQL,
  planCommand,
  readCommand,
  readLines,
  readTime,
} from "./commands";

const TODAY = "2026-11-23";
const TOMORROW = "2026-11-24";

const block = (
  id: string,
  date: string,
  title: string,
  startMin: number,
  minutes = 60,
  extra: Partial<CommandBlock> = {},
): CommandBlock => ({
  id,
  start_at: localToEpoch(date, startMin),
  end_at: localToEpoch(date, startMin + minutes),
  title,
  kind: "routine",
  area_id: null,
  task_id: null,
  status: "planned",
  task_title: null,
  ...extra,
});

function context(): CommandContext {
  let n = 0;
  return {
    today: TODAY,
    tomorrow: TOMORROW,
    blocks: {
      today: [block("g0", TODAY, "Gym", 17 * 60)],
      tomorrow: [
        block("g1", TOMORROW, "Gym", 7 * 60),
        block("q1", TOMORROW, "Quran", 5 * 60, 30),
        block("e1", TOMORROW, "Job hunt", 10 * 60, 90, { task_title: "Check email" }),
        block("r1", TOMORROW, "Sleep", 3 * 60, 180, { kind: "rest" }),
      ],
    },
    tasks: [
      { id: "t1", title: "Call bank", area_id: null, planned_date: null, estimate_min: null },
      {
        id: "t2",
        title: "Read chapter 6",
        area_id: "coding",
        planned_date: TODAY,
        estimate_min: 45,
      },
    ],
    newId: () => `n${++n}`,
  };
}

describe("readTime", () => {
  it("reads the ways people say a time", () => {
    expect(readTime("9am")).toBe(540);
    expect(readTime("9:30 pm")).toBe(21 * 60 + 30);
    expect(readTime("18:00")).toBe(1080);
    expect(readTime("6")).toBe(18 * 60);
    expect(readTime("9")).toBe(540);
    expect(readTime("6 p.m.")).toBe(1080);
    expect(readTime("noon")).toBe(720);
    expect(readTime("12am")).toBe(1440);
    expect(readTime("1:30am")).toBe(1530);
    expect(readTime("25")).toBeNull();
  });
});

describe("readCommand", () => {
  it("reads move with and without a day", () => {
    expect(readCommand("move gym to 6pm")).toEqual({
      kind: "move",
      target: "gym",
      day: null,
      minutes: 1080,
    });
    expect(readCommand("move tomorrow's check email to 9am")).toEqual({
      kind: "move",
      target: "check email",
      day: "tomorrow",
      minutes: 540,
    });
    expect(readCommand("Move the gym to 7:30 tomorrow.")).toMatchObject({
      target: "gym",
      day: "tomorrow",
      minutes: 450,
    });
    expect(readCommand("move quran to today at 8pm")).toMatchObject({ day: "today" });
  });

  it("reads skip", () => {
    expect(readCommand("skip quran tomorrow")).toEqual({
      kind: "skip",
      target: "quran",
      day: "tomorrow",
    });
    expect(readCommand("skip today's gym")).toEqual({ kind: "skip", target: "gym", day: "today" });
  });

  it("leaves other words for the AI", () => {
    expect(readCommand("I felt tired after lunch")).toBeNull();
    expect(readCommand("move on from this")).toBeNull();
  });
});

describe("planCommand", () => {
  it("moves tomorrow's block when no day is given, and can undo it", () => {
    const ctx = context();
    const result = planCommand({ kind: "move", target: "gym", day: null, minutes: 1080 }, ctx);
    expect(result?.said).toBe("Moved Gym to 18:00 tomorrow.");
    expect(result?.ops).toEqual([
      {
        op: "update",
        table: "day_blocks",
        id: "g1",
        values: { start_at: localToEpoch(TOMORROW, 1080), end_at: localToEpoch(TOMORROW, 1140) },
      },
    ]);
    expect(result?.undo).toEqual([
      {
        op: "update",
        table: "day_blocks",
        id: "g1",
        values: { start_at: localToEpoch(TOMORROW, 420), end_at: localToEpoch(TOMORROW, 480) },
      },
    ]);
  });

  it("moves today's block when asked", () => {
    const result = planCommand(
      { kind: "move", target: "gym", day: "today", minutes: 19 * 60 },
      context(),
    );
    expect(result?.ops[0]).toMatchObject({ id: "g0" });
  });

  it("finds a block by its task", () => {
    const result = planCommand(
      { kind: "move", target: "check email", day: "tomorrow", minutes: 540 },
      context(),
    );
    expect(result?.ops[0]).toMatchObject({ id: "e1" });
    expect(result?.said).toBe("Moved Job hunt to 09:00 tomorrow.");
  });

  it("skips a block, undoably", () => {
    const result = planCommand({ kind: "skip", target: "quran", day: "tomorrow" }, context());
    expect(result?.said).toBe("Skipped Quran tomorrow.");
    expect(result?.ops).toEqual([
      { op: "update", table: "day_blocks", id: "q1", values: { status: "skipped" } },
    ]);
    expect(result?.undo).toEqual([
      { op: "update", table: "day_blocks", id: "q1", values: { status: "planned" } },
    ]);
  });

  it("gives a task with no block its own block at that time (rule 1)", () => {
    const result = planCommand(
      { kind: "move", target: "read chapter 6", day: null, minutes: 540 },
      context(),
    );
    expect(result?.said).toBe("Put “Read chapter 6” at 09:00 tomorrow.");
    expect(result?.ops).toEqual([
      { op: "update", table: "task_items", id: "t2", values: { planned_date: TOMORROW } },
      {
        op: "insert",
        table: "day_blocks",
        id: "n1",
        values: {
          logical_date: TOMORROW,
          start_at: localToEpoch(TOMORROW, 540),
          end_at: localToEpoch(TOMORROW, 585),
          kind: "area",
          area_id: "coding",
          task_id: "t2",
          title: "Read chapter 6",
          source: "user",
          status: "planned",
        },
      },
    ]);
    expect(result?.undo).toEqual([
      { op: "delete", table: "day_blocks", id: "n1" },
      { op: "update", table: "task_items", id: "t2", values: { planned_date: TODAY } },
    ]);
  });

  it("skipping a task moves it a day on", () => {
    const result = planCommand({ kind: "skip", target: "call bank", day: "tomorrow" }, context());
    expect(result?.ops).toEqual([
      { op: "update", table: "task_items", id: "t1", values: { planned_date: "2026-11-25" } },
    ]);
    expect(result?.said).toBe("Moved “Call bank” to Wed 25 Nov.");
  });

  it("never touches rest, and returns null when nothing matches", () => {
    expect(planCommand({ kind: "skip", target: "sleep", day: null }, context())).toBeNull();
    expect(planCommand({ kind: "skip", target: "piano", day: null }, context())).toBeNull();
  });

  it("says so when the block is already there", () => {
    const result = planCommand({ kind: "move", target: "gym", day: null, minutes: 420 }, context());
    expect(result).toEqual({ ops: [], undo: [], said: "Gym is already at 07:00." });
  });
});

describe("readLines", () => {
  it("splits commands from what goes to the AI", () => {
    const { commands, rest } = readLines(
      "skip quran tomorrow\nworried about rent; move gym to 6pm",
    );
    expect(commands.map((c) => c.line)).toEqual(["skip quran tomorrow", "move gym to 6pm"]);
    expect(rest).toEqual(["worried about rent"]);
  });
});

describe("COMMAND_TASKS_SQL", () => {
  it("reads open tasks only", () => {
    const db = openTestDb();
    db.exec(`INSERT INTO task_items (id, title, status, created_at, updated_at) VALUES
      ('a', 'Open', 'todo', 1, 0), ('b', 'Done', 'done', 2, 0)`);
    expect(
      db
        .prepare(COMMAND_TASKS_SQL)
        .all()
        .map((r) => r.id),
    ).toEqual(["a"]);
  });
});
