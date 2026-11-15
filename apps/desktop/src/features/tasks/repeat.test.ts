import { describe, expect, it } from "vitest";

import { echo, toOps } from "../../capture/ops";
import { parseCapture } from "../../capture/parse";
import { parseRule, type Rule, ruleText } from "../money/regulars";
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
    expect(nextCopyOps(task, "2026-11-15")).toEqual([
      {
        op: "upsert",
        table: "task_items",
        id: "t1~next",
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
    // Like db_tx: an upsert inserts or updates (and revives); a delete is soft.
    const transact = (ops: Op[]) => {
      for (const op of ops) {
        if (op.op === "delete") {
          db.prepare("UPDATE task_items SET deleted_at = 1 WHERE id = ?").run(op.id);
          continue;
        }
        if (op.op !== "upsert") throw new Error(`unexpected ${op.op}`);
        const cols = Object.keys(op.values);
        const vals = Object.values(op.values) as (string | number | null)[];
        if (db.prepare("SELECT 1 FROM task_items WHERE id = ?").get(op.id))
          db.prepare(
            `UPDATE task_items SET ${cols.map((c) => `${c} = ?`).join(", ")}, deleted_at = NULL WHERE id = ?`,
          ).run(...vals, op.id);
        else
          db.prepare(
            `INSERT INTO task_items (id, ${cols.join(", ")}, created_at, updated_at) VALUES (?, ${cols.map(() => "?").join(", ")}, 0, 0)`,
          ).run(op.id, ...vals);
      }
      return Promise.resolve();
    };
    // Two runs at once (React runs effects twice) still make one copy.
    const [first, second] = await Promise.all([
      ensureRepeats(query as never, transact, "2026-11-15"),
      ensureRepeats(query as never, transact, "2026-11-15"),
    ]);
    expect([first, second]).toEqual([1, 1]);
    expect(await ensureRepeats(query as never, transact, "2026-11-15")).toBe(0);
    expect(db.prepare(REPEAT_DUE_SQL).all()).toEqual([]);
    const copy = () =>
      db
        .prepare(
          "SELECT title, status, due_date, repeat_of, deleted_at FROM task_items WHERE id = 'done~next'",
        )
        .get();
    expect(copy()).toEqual({
      title: "Timesheet",
      status: "todo",
      due_date: "2026-11-20",
      repeat_of: "done",
      deleted_at: null,
    });
    expect(
      db.prepare("SELECT count(*) AS n FROM task_items WHERE repeat_of = 'done'").get(),
    ).toEqual({ n: 1 });

    // Un-tick the timesheet: its untouched copy goes, so there aren't two open.
    db.prepare("UPDATE task_items SET status = 'todo' WHERE id = 'done'").run();
    await ensureRepeats(query as never, transact, "2026-11-15");
    expect(copy()).toMatchObject({ deleted_at: 1 });
    // Tick it again: the copy comes back.
    db.prepare("UPDATE task_items SET status = 'done' WHERE id = 'done'").run();
    await ensureRepeats(query as never, transact, "2026-11-15");
    expect(copy()).toMatchObject({ status: "todo", deleted_at: null });
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
    // "every month" isn't Monday, "every sunset" isn't Sunday.
    expect(parseCapture("t: pay rent every month", { nowMs })).not.toHaveProperty("repeat");
    expect(parseCapture("t: water plants every sunset", { nowMs })).not.toHaveProperty("repeat");
    expect(parseCapture("t: gym every mon, thursday", { nowMs })).toMatchObject({
      repeat: { every: "week", days: [1, 4] },
    });
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
    // Every rule's words read back as the same rule, so a saved form saves again.
    const rules: Rule[] = [
      { every: "month", day: 31 },
      { every: "month", day: 1 },
      { every: "month", day: 22 },
      { every: "week", days: [1, 2, 3, 4, 5] },
      { every: "week", days: [1, 4] },
    ];
    for (const rule of rules) expect(parseRule(ruleText(rule))).toEqual(rule);
    expect(repeatText(null)).toBe("");
  });
});
