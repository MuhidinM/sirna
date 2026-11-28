import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openTestDb } from "../../test/sqlite";
import fixture from "./fixtures/up_next.sql?raw";
import { upNextParams, upNextSql } from "./upNext";

const now = Date.parse("2026-11-11T12:00:00+03:00");

/** The order the fixture must give; tasks.rs asserts the same list. */
const EXPECTED = [
  "hand",
  "due-past",
  "due-tom",
  "pinned",
  "stale",
  "planned",
  "ja1",
  "jb1",
  "due-far",
  "c1",
  "n1",
  "ja2",
  "jb2",
  "old-run",
  "step1",
];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(() => vi.useRealTimers());

const order = (db: ReturnType<typeof openTestDb>, limit = 50) =>
  db
    .prepare(upNextSql)
    .all(...upNextParams(Date.now(), limit))
    .map((row) => row.id);

describe("Up next", () => {
  it("orders in hand, due soon, pinned, planned, then jobs taking turns, then oldest", () => {
    const db = openTestDb();
    db.exec(fixture);
    expect(order(db)).toEqual(EXPECTED);
  });

  it("says why each task is where it is", () => {
    const db = openTestDb();
    db.exec(fixture);
    const tiers = db
      .prepare(upNextSql)
      .all(...upNextParams(Date.now(), 7))
      .map((row) => row.tier);
    expect(tiers).toEqual([0, 1, 1, 2, 3, 3, 4]);
  });

  it("stops at the limit", () => {
    const db = openTestDb();
    db.exec(fixture);
    expect(order(db, 3)).toEqual(EXPECTED.slice(0, 3));
  });

  it("keeps a task in hand when its lane's done was undone, and offers a timed task once its time passes", () => {
    const db = openTestDb();
    db.exec(fixture);
    // The lane said done, then the task was reopened (undo): it is open work again.
    db.exec("UPDATE focus_run_tasks SET result = 'done' WHERE task_id = 'hand'");
    vi.setSystemTime(Date.parse("2026-11-11T15:30:00+03:00"));
    const ids = order(db);
    expect(ids[0]).toBe("hand");
    // Now past 15:00 and 14:00: both are offered.
    expect(ids).toContain("timed-later");
    expect(ids).toContain("remind-later");
    // A task done in its lane is not offered at all.
    db.exec("UPDATE task_items SET status = 'done' WHERE id = 'hand'");
    expect(order(db)[0]).toBe("due-past");
  });

  it("gives every job a turn before any job gets a second", () => {
    const db = openTestDb();
    const add = db.prepare(
      "INSERT INTO task_items (id, title, area_id, created_at, updated_at) VALUES (?, ?, ?, ?, 0)",
    );
    add.run("a1", "a1", "joba", 1);
    add.run("a2", "a2", "joba", 2);
    add.run("a3", "a3", "joba", 3);
    add.run("b1", "b1", "jobb", 4);
    add.run("h1", "h1", "jobhunt", 0);
    expect(order(db)).toEqual(["a1", "b1", "h1", "a2", "a3"]);
  });
});
