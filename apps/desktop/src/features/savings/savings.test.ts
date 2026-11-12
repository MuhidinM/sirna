import { type DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { echo, toOps } from "../../capture/ops";
import { parseCapture } from "../../capture/parse";
import { type Op } from "../../kernel/db";
import { openTestDb } from "../../test/sqlite";
import {
  addGoalOps,
  checkGoal,
  entryOps,
  type GoalRow,
  GOALS_SQL,
  assignOps,
  checkTakeOut,
  goalStatusOps,
  matchGoal,
  shareSaved,
  stageOf,
  UNASSIGNED_SQL,
  WEEK_SAVED_SQL,
} from "./savings";

const NOW = Date.parse("2026-11-12T09:00:00Z");
type Input = string | number | null;

function apply(db: DatabaseSync, ops: Op[]) {
  for (const op of ops) {
    if (op.op === "insert") {
      const values = { id: op.id, ...op.values, created_at: 0, updated_at: 0 };
      const names = Object.keys(values);
      db.prepare(
        `INSERT INTO ${op.table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
      ).run(...(Object.values(values) as Input[]));
    } else if (op.op === "update") {
      const names = Object.keys(op.values);
      db.prepare(
        `UPDATE ${op.table} SET ${names.map((n) => `${n} = ?`).join(", ")} WHERE id = ?`,
      ).run(...(Object.values(op.values) as Input[]), op.id);
    }
  }
}

const goals = (db: DatabaseSync) => db.prepare(GOALS_SQL).all() as unknown as GoalRow[];

describe("the plant", () => {
  it("grows through 6 stages and never goes below a seed", () => {
    const at = (saved: number) =>
      stageOf(shareSaved({ saved_minor: saved, target_minor: 100_000 }));
    expect([0, 9_999, 10_000, 25_000, 50_000, 75_000, 99_999, 100_000, 150_000].map(at)).toEqual([
      0, 0, 1, 2, 3, 4, 4, 5, 5,
    ]);
    expect(shareSaved({ saved_minor: -5_000, target_minor: 100_000 })).toBe(0);
  });
});

describe("goals and entries", () => {
  it("adds a goal, saves, takes out, and sums against the target", () => {
    const db = openTestDb();
    apply(db, addGoalOps({ title: " Laptop ", target: "100k" }, "2026-11-12", "g1"));
    apply(db, entryOps("g1", 4_500_000, NOW, "2026-11-12", "e1", "dashboard"));
    apply(db, entryOps("g1", -200_000, NOW, "2026-11-12", "e2", "dashboard"));
    expect(goals(db)).toEqual([
      {
        id: "g1",
        title: "Laptop",
        target_minor: 10_000_000,
        start_date: "2026-11-12",
        status: "active",
        saved_minor: 4_300_000,
      },
    ]);
    apply(db, goalStatusOps("g1", "done"));
    expect(goals(db)[0]?.status).toBe("done");
  });

  it("gives savings made before any goal to the first goal", () => {
    const db = openTestDb();
    apply(db, entryOps(null, 50_000, NOW, "2026-11-12", "e1", "capture"));
    expect(db.prepare(UNASSIGNED_SQL).get()).toEqual({ minor: 50_000, n: 1 });
    apply(
      db,
      addGoalOps({ title: "Laptop", target: "100,000" }, "2026-11-12", "g1", [{ id: "e1" }]),
    );
    expect(goals(db)[0]?.saved_minor).toBe(50_000);
    expect(db.prepare(UNASSIGNED_SQL).get()).toEqual({ minor: 0, n: 0 });
  });

  it("refuses a goal without a name or a real target, and a zero entry", () => {
    expect(checkGoal({ title: "", target: "100" })).toMatch(/Name/);
    expect(checkGoal({ title: "Laptop", target: "lots" })).toMatch(/Target/);
    expect(checkGoal({ title: "Laptop", target: "0" })).toMatch(/Target/);
    const db = openTestDb();
    expect(() => apply(db, entryOps(null, 0, NOW, "2026-11-12", "e1", "x"))).toThrow(/CHECK/);
  });

  it("counts this week's saving for the Sunday question", () => {
    const db = openTestDb();
    apply(db, entryOps(null, 30_000, NOW, "2026-11-12", "a", "week"));
    apply(db, entryOps(null, 99_000, NOW, "2026-11-02", "b", "week"));
    expect(db.prepare(WEEK_SAVED_SQL).get("2026-11-09", "2026-11-16")).toEqual({ minor: 30_000 });
  });
});

describe("capturing savings", () => {
  const list = [
    { id: "g1", title: "Laptop", status: "active" as const },
    { id: "g2", title: "Emergency fund", status: "active" as const },
    { id: "g3", title: "Old bike", status: "done" as const },
  ];

  const goalsNow = { nowMs: NOW, goals: ["laptop", "emergency fund"] };

  it("reads saved and took", () => {
    expect(parseCapture("saved 500 laptop", goalsNow)).toEqual({
      kind: "saving",
      amount: 50_000,
      goal: "laptop",
    });
    expect(parseCapture("took 2k from emergency fund", goalsNow)).toEqual({
      kind: "saving",
      amount: -200_000,
      goal: "emergency fund",
    });
    expect(parseCapture("put aside 1,500", goalsNow)).toEqual({ kind: "saving", amount: 150_000 });
    expect(parseCapture("saved ETB 500", goalsNow)).toEqual({ kind: "saving", amount: 50_000 });
    expect(parseCapture("saved 500 etb rent", goalsNow)).toEqual({
      kind: "saving",
      amount: 50_000,
      goal: "rent",
    });
  });

  it("leaves ordinary lines alone", () => {
    for (const line of [
      "saved the file",
      "took 500 for taxi",
      "saved 500 for lunch",
      "took 2 hours to fix the build",
      "took 3 pills",
      "saved 10 photos",
    ])
      expect(parseCapture(line, goalsNow).kind, line).not.toBe("saving");
    expect(parseCapture("took 500 for taxi", goalsNow)).toMatchObject({
      kind: "expense",
      amount: 50_000,
    });
  });

  it("finds the goal by name, or the only one", () => {
    expect(matchGoal(list, "laptop")).toBe("g1");
    expect(matchGoal(list, "emergency")).toBe("g2");
    expect(matchGoal(list, "bike")).toBeNull();
    expect(matchGoal(list, undefined)).toBeNull();
    expect(matchGoal([{ id: "g1", title: "Laptop", status: "active" }], undefined)).toBe("g1");
  });

  it("writes one entry and says where it went", () => {
    const parsed = parseCapture("saved 500 laptop", { nowMs: NOW, goals: ["laptop"] });
    const goal = { id: "g1", title: "Laptop" };
    expect(toOps(parsed, { nowMs: NOW, newId: () => "e1", savingGoal: goal })).toEqual([
      {
        op: "insert",
        table: "savings_entries",
        id: "e1",
        values: {
          goal_id: "g1",
          occurred_at: NOW,
          local_date: "2026-11-12",
          amount_minor: 50_000,
          note: "laptop",
          origin: "capture",
        },
      },
    ]);
    expect(echo(parsed, NOW, undefined, goal)).toBe("Saved 500 ETB · Laptop");
    expect(echo(parsed, NOW, undefined, null)).toBe(
      "Saved 500 ETB · no goal yet: add one on the Dashboard",
    );
  });
});

describe("review fixes", () => {
  it("won't take out more than a goal holds", () => {
    expect(checkTakeOut({ saved_minor: 100_000 }, 200_000)).toMatch(/more than/);
    expect(checkTakeOut({ saved_minor: 100_000 }, 100_000)).toBeNull();
    expect(checkTakeOut({ saved_minor: -5 }, 1)).toMatch(/more than/);
  });

  it("gives waiting savings to a goal", () => {
    const db = openTestDb();
    apply(db, addGoalOps({ title: "Laptop", target: "100k" }, "2026-11-12", "g1"));
    apply(db, entryOps(null, 50_000, NOW, "2026-11-12", "e1", "capture"));
    apply(db, assignOps(["e1"], "g1"));
    expect(goals(db)[0]?.saved_minor).toBe(50_000);
  });
});
