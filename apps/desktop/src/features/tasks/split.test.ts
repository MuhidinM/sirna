import { describe, expect, it } from "vitest";

import { type Op } from "../../kernel/db";
import { openTestDb } from "../../test/sqlite";
import { TASKS_SQL, viewParams } from "./list";
import {
  canSplit,
  canSuggest,
  checkSteps,
  manualSplitOps,
  parseSteps,
  stepsMinutes,
  stepsText,
} from "./split";

describe("which tasks can be split", () => {
  it("any open task, whatever its estimate", () => {
    expect(canSplit({ status: "todo" })).toBe(true);
    for (const status of ["done", "dropped", "someday", "waiting"])
      expect(canSplit({ status })).toBe(false);
  });

  it("the AI only suggests for an estimate it can share out", () => {
    expect(canSuggest(null)).toBe(false);
    expect(canSuggest(15)).toBe(false);
    expect(canSuggest(20)).toBe(true);
    expect(canSuggest(90)).toBe(true);
    expect(canSuggest(6 * 240)).toBe(true);
    expect(canSuggest(6 * 240 + 1)).toBe(false);
  });
});

describe("parseSteps", () => {
  it("reads one step per line, with its time", () => {
    expect(
      parseSteps("Outline — 30 min\n- Build the page (1h 30m)\n2. Publish 15m\n\n  Tell Sara: 1h"),
    ).toEqual([
      { title: "Outline", minutes: 30 },
      { title: "Build the page", minutes: 90 },
      { title: "Publish", minutes: 15 },
      { title: "Tell Sara", minutes: 60 },
    ]);
  });

  it("keeps numbers that are not a time in the title", () => {
    expect(parseSteps("Read chapter 3\nWrite 2 pages - 45 min")).toEqual([
      { title: "Read chapter 3", minutes: null },
      { title: "Write 2 pages", minutes: 45 },
    ]);
  });

  it("steps without a time share what is left of the estimate", () => {
    expect(parseSteps("Outline 30m\nBuild\nPublish", 120)).toEqual([
      { title: "Outline", minutes: 30 },
      { title: "Build", minutes: 45 },
      { title: "Publish", minutes: 45 },
    ]);
  });

  it("with nothing left, or no estimate, they stay unknown", () => {
    expect(parseSteps("Outline 2h\nBuild", 120)[1]?.minutes).toBeNull();
    expect(parseSteps("Outline\nBuild")[0]?.minutes).toBeNull();
  });

  it("reads back the AI's suggestion as it was written into the box", () => {
    const ai = [
      { title: "Draft the cover letter", minutes: 40 },
      { title: "Send it", minutes: 20 },
    ];
    expect(parseSteps(stepsText(ai))).toEqual(ai);
    expect(stepsMinutes(parseSteps(stepsText(ai)))).toBe(60);
  });
});

describe("checkSteps", () => {
  const step = (title: string, minutes: number | null = 30) => ({ title, minutes });

  it("needs at least two steps", () => {
    expect(checkSteps([])).toMatch(/two steps/);
    expect(checkSteps([step("Only")])).toMatch(/two steps/);
    expect(checkSteps([step("One"), step("Two", null)])).toBeNull();
  });

  it("refuses too many, too long or impossible steps", () => {
    expect(checkSteps(Array.from({ length: 13 }, (_, i) => step(`S${i}`)))).toMatch(/project/);
    expect(checkSteps([step("x".repeat(81)), step("Two")])).toMatch(/80 characters/);
    expect(checkSteps([step("One", 2), step("Two")])).toMatch(/5 min to 8 h/);
    expect(checkSteps([step("One", 600), step("Two")])).toMatch(/5 min to 8 h/);
  });
});

describe("manualSplitOps", () => {
  const task = { id: "big", area_id: "a1", due_date: "2026-11-25", planned_date: "2026-11-24" };

  it("turns your steps into ordered tasks and drops the big one", () => {
    let n = 0;
    const ops = manualSplitOps(
      task,
      [
        { title: " Outline ", minutes: 30 },
        { title: "Build", minutes: null },
      ],
      () => `s${++n}`,
    );
    expect(ops).toHaveLength(3);
    const [first, second, drop] = ops as [Op, Op, Op];
    expect(first).toMatchObject({
      op: "insert",
      id: "s1",
      values: {
        title: "Outline",
        estimate_min: 30,
        step_no: 1,
        parent_id: "big",
        area_id: "a1",
        due_date: "2026-11-25",
        planned_date: "2026-11-24",
        origin: "split:big",
      },
    });
    expect(second).toMatchObject({ op: "insert", values: { estimate_min: null, step_no: 2 } });
    expect(drop).toEqual({
      op: "update",
      table: "task_items",
      id: "big",
      values: { status: "dropped" },
    });
  });

  it("the steps show in Tasks in order, the first one open", () => {
    const db = openTestDb();
    db.prepare(
      "INSERT INTO task_items (id, title, status, created_at, updated_at) VALUES ('big', 'Call the bank', 'todo', 0, 0)",
    ).run();
    let n = 0;
    for (const op of manualSplitOps(
      { id: "big", area_id: null, due_date: null },
      parseSteps("Find the account number\nCall them 20m"),
      () => `s${++n}`,
    )) {
      if (op.op === "insert") {
        const cols = Object.keys(op.values);
        db.prepare(
          `INSERT INTO task_items (id, ${cols.join(", ")}, created_at, updated_at) VALUES (?, ${cols.map(() => "?").join(", ")}, 0, 0)`,
        ).run(op.id, ...(Object.values(op.values) as (string | number | null)[]));
      } else if (op.op === "update") {
        db.prepare("UPDATE task_items SET status = ? WHERE id = ?").run(
          String(op.values.status),
          op.id,
        );
      }
    }
    const open = db.prepare(TASKS_SQL).all(...viewParams("open", 0)) as {
      id: string;
      title: string;
      estimate_min: number | null;
      step_no: number | null;
    }[];
    const steps = open
      .filter((row) => row.id.startsWith("s"))
      .sort((a, b) => (a.step_no ?? 0) - (b.step_no ?? 0));
    expect(steps.map((row) => [row.title, row.estimate_min, row.step_no])).toEqual([
      ["Find the account number", null, 1],
      ["Call them", 20, 2],
    ]);
    expect(open.some((row) => row.id === "big")).toBe(false);
  });
});
