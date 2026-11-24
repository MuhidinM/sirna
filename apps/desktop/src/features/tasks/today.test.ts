import { describe, expect, it } from "vitest";

import { openTestDb } from "../../test/sqlite";
import { logicalDayStart, SPENT_TODAY_SQL, taskMeta, todayParams, todayTopSql } from "./today";

const now = Date.parse("2026-11-11T12:00:00+03:00");

function task(
  db: ReturnType<typeof openTestDb>,
  id: string,
  values: Partial<{
    title: string;
    status: string;
    due_date: string | null;
    due_at: number | null;
    completed_at: number | null;
    deleted_at: number | null;
  }>,
) {
  db.prepare(
    `INSERT INTO task_items (id, title, status, due_date, due_at, completed_at, deleted_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)`,
  ).run(
    id,
    values.title ?? id,
    values.status ?? "todo",
    values.due_date ?? null,
    values.due_at ?? null,
    values.completed_at ?? null,
    values.deleted_at ?? null,
  );
}

const top = (db: ReturnType<typeof openTestDb>) =>
  db
    .prepare(todayTopSql)
    .all(...todayParams(now))
    .map((row) => row.id);

describe("logicalDayStart", () => {
  it("is 03:00 local, which is midnight UTC in Addis Ababa", () => {
    expect(logicalDayStart("2026-11-11")).toBe(Date.parse("2026-11-11T03:00:00+03:00"));
  });
});

describe("today's top 3", () => {
  it("puts overdue and due-today tasks first, timed ones by time", () => {
    const db = openTestDb();
    task(db, "late", { due_date: "2026-11-09" });
    task(db, "today-untimed", { due_date: "2026-11-11" });
    task(db, "today-10", {
      due_date: "2026-11-11",
      due_at: Date.parse("2026-11-11T10:00:00+03:00"),
    });
    task(db, "tomorrow", { due_date: "2026-11-12" });
    task(db, "someday", { status: "someday" });
    expect(top(db)).toEqual(["late", "today-10", "today-untimed"]);
  });

  it("lets tasks chosen for today come first", () => {
    const db = openTestDb();
    task(db, "due", { due_date: "2026-11-11" });
    task(db, "chosen", { status: "todo" });
    db.prepare(
      "INSERT INTO task_daily_top (id, logical_date, position, task_id, created_at, updated_at) VALUES (?, ?, 1, ?, 0, 0)",
    ).run("2026-11-11:1", "2026-11-11", "chosen");
    expect(top(db)[0]).toBe("chosen");
  });

  it("keeps a task done today but not one done yesterday", () => {
    const db = openTestDb();
    task(db, "done-today", {
      status: "done",
      due_date: "2026-11-11",
      completed_at: Date.parse("2026-11-11T09:00:00+03:00"),
    });
    task(db, "done-yesterday", {
      status: "done",
      due_date: "2026-11-10",
      completed_at: Date.parse("2026-11-10T09:00:00+03:00"),
    });
    expect(top(db)).toEqual(["done-today"]);
  });

  it("skips deleted tasks and shows at most 3", () => {
    const db = openTestDb();
    for (const id of ["a", "b", "c", "d"]) task(db, id, { due_date: "2026-11-11" });
    task(db, "gone", { due_date: "2026-11-01", deleted_at: 1 });
    expect(top(db)).toHaveLength(3);
    expect(top(db)).not.toContain("gone");
  });
});

describe("SPENT_TODAY_SQL", () => {
  it("keeps dollars apart from birr (F4)", () => {
    const db = openTestDb();
    const add = db.prepare(
      `INSERT INTO money_txns (id, account, occurred_at, local_date, amount_minor, description, created_at, updated_at)
       VALUES (?, ?, 1, '2026-11-11', ?, 'x', 0, 0)`,
    );
    add.run("a", "cash", -18000);
    add.run("b", "wise", -400);
    add.run("c", "cash", -1500);
    db.prepare("UPDATE money_txns SET currency = 'USD' WHERE id = 'c'").run();
    const rows = db.prepare(SPENT_TODAY_SQL).all("2026-11-11") as {
      currency: string;
      spent: number;
    }[];
    expect(rows.sort((x, y) => x.currency.localeCompare(y.currency))).toEqual([
      { currency: "ETB", spent: 18000 },
      { currency: "USD", spent: 1900 },
    ]);
  });
});

describe("the line under a task (taskMeta)", () => {
  const plain = { estimate_min: null, due_date: null, due_at: null };
  it("has no dangling dot when there is only an estimate", () => {
    expect(taskMeta({ ...plain, estimate_min: 45, due_date: "2026-11-24" }, "2026-11-24")).toBe(
      "~45 min · due today",
    );
    expect(taskMeta({ ...plain, estimate_min: 45, due_date: "2026-11-30" }, "2026-11-24")).toBe(
      "~45 min",
    );
    expect(taskMeta(plain, "2026-11-24")).toBe("");
  });

  it("dates a late time after midnight by the moment, not the logical day", () => {
    // 'fix bike at 1am' at 00:30 on 25 Nov: logical due date 24 Nov, due 25 Nov 01:00.
    const task = {
      ...plain,
      due_date: "2026-11-24",
      due_at: Date.parse("2026-11-25T01:00:00+03:00"),
    };
    expect(taskMeta(task, "2026-11-25")).toBe("since 25 Nov 01:00");
    expect(taskMeta({ ...plain, estimate_min: 30, due_date: "2026-11-23" }, "2026-11-25")).toBe(
      "~30 min · since 23 Nov",
    );
  });
});
