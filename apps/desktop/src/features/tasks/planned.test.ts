import { describe, expect, it } from "vitest";

import { type Op } from "../../kernel/db";
import { migrations, openTestDb } from "../../test/sqlite";
import { splitOps } from "../ai/facts";
import { OPEN_TASKS_SQL } from "../plan/dayplan";
import { carryOps, OPEN_DUE_SQL } from "../review/review";
import { type TaskListRow, taskDraftOf, taskEditOps, TASKS_SQL } from "./list";
import { DUE_SQL, todayTopSql } from "./today";

/** Applies update ops the way db_tx does for these columns. */
function apply(db: ReturnType<typeof openTestDb>, ops: Op[]) {
  for (const op of ops) {
    if (op.op !== "update") throw new Error(`unexpected ${op.op}`);
    const cols = Object.keys(op.values);
    db.prepare(`UPDATE ${op.table} SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).run(
      ...(Object.values(op.values) as (string | number | null)[]),
      op.id,
    );
  }
}

const ids = (rows: unknown[]) => rows.map((row) => (row as { id: string }).id);

function withTask(due: string | null) {
  const db = openTestDb();
  db.prepare(
    "INSERT INTO task_items (id, title, status, due_date, created_at, updated_at) VALUES ('cv', 'Send CV', 'todo', ?, 0, 0)",
  ).run(due);
  return db;
}

describe("a task's day apart from its deadline (T-050)", () => {
  it("keeps the deadline when the night review moves a task to tomorrow", () => {
    const db = withTask("2026-11-12");
    apply(db, carryOps([{ id: "cv", carries: 0 }], "2026-11-13"));
    const row = db.prepare("SELECT due_date, planned_date, carries FROM task_items").get();
    expect(row).toEqual({ due_date: "2026-11-12", planned_date: "2026-11-13", carries: 1 });
  });

  it("puts a moved task on the new day's lists, not today's", () => {
    const db = withTask("2026-11-12");
    apply(db, carryOps([{ id: "cv", carries: 0 }], "2026-11-13"));
    const dayStart = (date: string) => Date.parse(`${date}T03:00:00+03:00`);
    for (const [date, expected] of [
      ["2026-11-12", []],
      ["2026-11-13", ["cv"]],
    ] as const) {
      expect(ids(db.prepare(OPEN_DUE_SQL).all(date))).toEqual(expected);
      expect(ids(db.prepare(DUE_SQL).all(date))).toEqual(expected);
      expect(ids(db.prepare(todayTopSql).all(date, dayStart(date)))).toEqual(expected);
    }
  });

  it("keeps a task moved to a later day out of today's plan", () => {
    const db = withTask("2026-11-30");
    apply(db, carryOps([{ id: "cv", carries: 0 }], "2026-11-13"));
    expect(ids(db.prepare(OPEN_TASKS_SQL).all("2026-11-12"))).toEqual([]);
    expect(ids(db.prepare(OPEN_TASKS_SQL).all("2026-11-13"))).toEqual(["cv"]);
    // A task with no planned day is planned whenever there is time.
    const free = withTask(null);
    expect(ids(free.prepare(OPEN_TASKS_SQL).all("2026-11-12"))).toEqual(["cv"]);
  });

  it("puts the task on the date you type when you edit its deadline, and trusts it again", () => {
    const db = withTask("2026-11-12");
    db.prepare("UPDATE task_items SET planned_date = '2026-11-14', deadline_stale = 1").run();
    const [row] = db.prepare(TASKS_SQL).all('["todo"]', 0) as unknown as TaskListRow[];
    if (!row) throw new Error("no row");
    apply(db, taskEditOps(row, { ...taskDraftOf(row), due: "2026-11-20" }, 0));
    expect(
      db.prepare("SELECT due_date, planned_date, deadline_stale FROM task_items").get(),
    ).toEqual({ due_date: "2026-11-20", planned_date: null, deadline_stale: 0 });
  });

  it("saving the form without a new date only confirms the deadline", () => {
    const db = withTask("2026-11-12");
    db.prepare("UPDATE task_items SET planned_date = '2026-11-14', deadline_stale = 1").run();
    const [row] = db.prepare(TASKS_SQL).all('["todo"]', 0) as unknown as TaskListRow[];
    if (!row) throw new Error("no row");
    apply(db, taskEditOps(row, taskDraftOf(row), 0));
    expect(db.prepare("SELECT planned_date, deadline_stale FROM task_items").get()).toEqual({
      planned_date: "2026-11-14",
      deadline_stale: 0,
    });
  });

  it("marks only tasks whose last date change was a carry, when upgrading", () => {
    const db = openTestDb({ migrate: false });
    const all = migrations();
    const upTo = all.findIndex((m) => m.name.startsWith("0017"));
    for (const migration of all.slice(0, upTo)) db.exec(migration.sql);
    const add = db.prepare(
      "INSERT INTO task_items (id, title, status, due_date, carries, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 0)",
    );
    const log = db.prepare(
      "INSERT INTO core_activity (at, actor, context, entity_type, entity_id, action, before_json, after_json) VALUES (?, 'user', ?, 'task_items', ?, 'update', ?, ?)",
    );
    const moved = (id: string, at: number, context: string | null, from: string, to: string) =>
      log.run(
        at,
        context,
        id,
        JSON.stringify({ due_date: from }),
        JSON.stringify({ due_date: to }),
      );
    // Carried twice by the night review.
    add.run("carried", "carried", "todo", "2026-11-13", 2);
    moved("carried", 1, "review", "2026-11-11", "2026-11-12");
    moved("carried", 2, "review", "2026-11-12", "2026-11-13");
    // Carried, then "Smaller" reset the count: still a carry date.
    add.run("smaller", "smaller", "todo", "2026-11-13", 0);
    moved("smaller", 1, "review", "2026-11-12", "2026-11-13");
    // Carried, then you typed a real deadline on the Tasks page.
    add.run("redated", "redated", "todo", "2026-11-30", 1);
    moved("redated", 1, "review", "2026-11-12", "2026-11-13");
    moved("redated", 2, "tasks", "2026-11-13", "2026-11-30");
    add.run("fresh", "fresh", "todo", "2026-11-20", 0);
    add.run("done", "done", "done", "2026-11-01", 1);
    moved("done", 1, "review", "2026-10-31", "2026-11-01");
    for (const migration of all.slice(upTo)) db.exec(migration.sql);
    expect(
      db.prepare("SELECT id, planned_date, deadline_stale FROM task_items ORDER BY id").all(),
    ).toEqual([
      { id: "carried", planned_date: "2026-11-13", deadline_stale: 1 },
      { id: "done", planned_date: null, deadline_stale: 0 },
      { id: "fresh", planned_date: null, deadline_stale: 0 },
      { id: "redated", planned_date: null, deadline_stale: 0 },
      { id: "smaller", planned_date: "2026-11-13", deadline_stale: 1 },
    ]);
  });

  it("doesn't show or rank a date an old carry wrote as a deadline", () => {
    const db = withTask("2026-11-13");
    db.prepare("UPDATE task_items SET planned_date = '2026-11-14', deadline_stale = 1").run();
    const dayStart = Date.parse("2026-11-14T03:00:00+03:00");
    const [top] = db.prepare(todayTopSql).all("2026-11-14", dayStart);
    expect(top).toMatchObject({ id: "cv", due_date: null, deadline_stale: 1 });
    expect(db.prepare(DUE_SQL).all("2026-11-14")[0]).toMatchObject({ due_date: null });
    expect(db.prepare(OPEN_TASKS_SQL).all("2026-11-14")[0]).toMatchObject({ due_date: null });
  });

  it("keeps a moved task's steps on the day it was moved to when it is split", () => {
    const ops = splitOps(
      {
        id: "cv",
        area_id: null,
        due_date: "2026-11-12",
        planned_date: "2026-11-15",
        deadline_stale: 1,
      },
      [
        { title: "Draft", minutes: 60 },
        { title: "Send", minutes: 30 },
      ],
      (() => {
        let n = 0;
        return () => `s${++n}`;
      })(),
    );
    const steps = ops.filter((op) => op.op === "insert");
    expect(steps).toHaveLength(2);
    for (const step of steps)
      expect(step.op === "insert" && step.values).toMatchObject({
        due_date: "2026-11-12",
        planned_date: "2026-11-15",
        deadline_stale: 1,
      });
  });
});
