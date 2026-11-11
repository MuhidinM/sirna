import { describe, expect, it } from "vitest";

import { openTestDb } from "../../test/sqlite";
import { logicalDayStart, todayParams, todayTopSql } from "./today";

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
    db.prepare("INSERT INTO task_daily_top (logical_date, position, task_id) VALUES (?, 1, ?)").run(
      "2026-11-11",
      "chosen",
    );
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
