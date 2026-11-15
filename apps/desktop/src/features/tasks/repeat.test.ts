import { describe, expect, it } from "vitest";

import { echo, toOps } from "../../capture/ops";
import { parseCapture } from "../../capture/parse";
import { type Op } from "../../kernel/db";
import { openTestDb } from "../../test/sqlite";
import {
  checkTask,
  repeatText,
  taskDraftOf,
  taskEditOps,
  type TaskListRow,
  TASKS_SQL,
} from "./list";
import {
  ensureRepeats,
  nextAfter,
  nextCopyOps,
  onOrAfter,
  REPEAT_DUE_SQL,
  type RepeatRow,
} from "./repeat";

const FRI = { every: "week" as const, days: [5] };
// 2026-11-15 is a Sunday.
const nowMs = Date.parse("2026-11-15T12:00:00+03:00");

describe("repeating tasks (T-068)", () => {
  it("finds the next date, across month ends", () => {
    expect(nextAfter(FRI, "2026-11-20")).toBe("2026-11-27");
    expect(onOrAfter(FRI, "2026-11-20")).toBe("2026-11-20");
    expect(nextAfter({ every: "month", day: 31 }, "2026-11-30")).toBe("2026-12-31");
    expect(nextAfter({ every: "month", day: 1 }, "2026-12-01")).toBe("2027-01-01");
  });

  it("makes the next copy after the date just done, or from today if that is past", () => {
    const task: RepeatRow = {
      id: "t1",
      title: "Timesheet",
      area_id: "joba",
      project_id: null,
      estimate_min: 30,
      repeat_json: JSON.stringify(FRI),
      due_date: "2026-11-13",
      completed_at: 0,
    };
    expect(nextCopyOps(task, "2026-11-15", "t2")).toEqual([
      {
        op: "insert",
        table: "task_items",
        id: "t2",
        values: {
          title: "Timesheet",
          status: "todo",
          area_id: "joba",
          project_id: null,
          estimate_min: 30,
          due_date: "2026-11-20",
          repeat_json: JSON.stringify(FRI),
          repeat_of: "t1",
          origin: "repeat",
        },
      },
    ]);
    // Done long ago: the next one is from today, not a pile of late ones.
    const old = nextCopyOps({ ...task, due_date: "2026-10-02" }, "2026-11-15", "t3");
    expect(old[0]).toMatchObject({ values: { due_date: "2026-11-20" } });
    expect(nextCopyOps({ ...task, repeat_json: "nonsense" }, "2026-11-15", "x")).toEqual([]);
  });

  it("makes exactly one next copy per finished task, and stops when dropped", async () => {
    const db = openTestDb();
    const add = db.prepare(
      "INSERT INTO task_items (id, title, status, due_date, repeat_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 0)",
    );
    add.run("done", "Timesheet", "done", "2026-11-13", JSON.stringify(FRI));
    add.run(
      "dropped",
      "Laundry",
      "dropped",
      "2026-11-14",
      JSON.stringify({ every: "week", days: [6] }),
    );
    add.run("open", "Apply", "todo", "2026-11-16", JSON.stringify({ every: "week", days: [1] }));
    const query = <T>(sql: string, params: (string | number | null)[] = []) =>
      Promise.resolve(db.prepare(sql).all(...params) as T[]);
    const transact = (ops: Op[]) => {
      for (const op of ops) {
        if (op.op !== "insert") throw new Error("insert only");
        const cols = Object.keys(op.values);
        db.prepare(
          `INSERT INTO task_items (id, ${cols.join(", ")}, created_at, updated_at) VALUES (?, ${cols.map(() => "?").join(", ")}, 0, 0)`,
        ).run(op.id, ...(Object.values(op.values) as (string | number | null)[]));
      }
      return Promise.resolve();
    };
    let n = 0;
    expect(await ensureRepeats(query as never, transact, "2026-11-15", () => `n${++n}`)).toBe(1);
    expect(await ensureRepeats(query as never, transact, "2026-11-15", () => `n${++n}`)).toBe(0);
    expect(db.prepare(REPEAT_DUE_SQL).all()).toEqual([]);
    expect(
      db.prepare("SELECT title, status, due_date, repeat_of FROM task_items WHERE id = 'n1'").get(),
    ).toEqual({
      title: "Timesheet",
      status: "todo",
      due_date: "2026-11-20",
      repeat_of: "done",
    });
  });
});

describe("repeats in capture and the Tasks page (T-068)", () => {
  it("reads every fri, monthly 1, every weekday and daily", () => {
    expect(parseCapture("t: timesheet every fri", { nowMs })).toMatchObject({
      kind: "task",
      title: "timesheet",
      repeat: FRI,
      dueDate: "2026-11-20",
    });
    expect(parseCapture("t: pay rent monthly 1", { nowMs })).toMatchObject({
      title: "pay rent",
      repeat: { every: "month", day: 1 },
      dueDate: "2026-12-01",
    });
    expect(parseCapture("t: standup notes every weekday", { nowMs })).toMatchObject({
      repeat: { every: "week", days: [1, 2, 3, 4, 5] },
      dueDate: "2026-11-16",
    });
    expect(parseCapture("t: water plants daily", { nowMs })).toMatchObject({
      dueDate: "2026-11-15",
    });
    expect(echo(parseCapture("t: timesheet every fri", { nowMs }), nowMs)).toMatch(/every fri/);
    const [op] = toOps(parseCapture("t: timesheet every fri", { nowMs }), {
      nowMs,
      newId: () => "t",
    });
    expect(op).toMatchObject({ values: { repeat_json: JSON.stringify(FRI), status: "todo" } });
    // Not a repeat: stays a plain task.
    expect(parseCapture("t: read every page", { nowMs })).not.toHaveProperty("repeat");
  });

  it("sets and clears the repeat in the edit form", () => {
    const db = openTestDb();
    db.prepare(
      "INSERT INTO task_items (id, title, status, created_at, updated_at) VALUES ('t', 'Laundry', 'todo', 0, 0)",
    ).run();
    const [row] = db.prepare(TASKS_SQL).all('["todo"]', 0) as unknown as TaskListRow[];
    if (!row) throw new Error("no row");
    const draft = { ...taskDraftOf(row), repeat: "every sat" };
    expect(checkTask(draft)).toBeNull();
    expect(checkTask({ ...draft, repeat: "sometimes" })).toMatch(/Repeat/);
    expect(taskEditOps(row, draft, 0)[0]).toMatchObject({
      values: { repeat_json: JSON.stringify({ every: "week", days: [6] }) },
    });
    expect(taskEditOps(row, { ...draft, repeat: "" }, 0)[0]).toMatchObject({
      values: { repeat_json: null },
    });
    expect(repeatText(JSON.stringify(FRI))).toBe("every fri");
    expect(repeatText(null)).toBe("");
  });
});
