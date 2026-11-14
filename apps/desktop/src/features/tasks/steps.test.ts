import { describe, expect, it } from "vitest";

import { type Op } from "../../kernel/db";
import { migrations, openTestDb } from "../../test/sqlite";
import { splitOps } from "../ai/facts";
import { OPEN_TASKS_SQL } from "../plan/dayplan";
import { stepLabel, TASKS_SQL } from "./list";
import { DUE_SQL, todayTopSql } from "./today";

const DAY = "2026-11-14";
const DAY_START = Date.parse(`${DAY}T03:00:00+03:00`);
const ids = (rows: unknown[]) => rows.map((row) => (row as { id: string }).id);

/** A big task split into three steps, written the way db_tx would. */
function split() {
  const db = openTestDb();
  db.prepare(
    "INSERT INTO task_items (id, title, status, due_date, created_at, updated_at) VALUES ('big', 'Portfolio', 'todo', ?, 0, 0)",
  ).run(DAY);
  let n = 0;
  const ops: Op[] = splitOps(
    { id: "big", area_id: null, due_date: DAY },
    [
      { title: "Outline", minutes: 30 },
      { title: "Build", minutes: 120 },
      { title: "Publish", minutes: 30 },
    ],
    () => `s${++n}`,
  );
  for (const op of ops) {
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
  const finish = (id: string) =>
    db
      .prepare("UPDATE task_items SET status = 'done', completed_at = ? WHERE id = ?")
      .run(DAY_START + 1, id);
  return { db, finish };
}

describe("the steps of a split task (T-051)", () => {
  it("offers one step at a time, in order", () => {
    const { db, finish } = split();
    const open = () => ({
      due: ids(db.prepare(DUE_SQL).all(DAY)),
      plan: ids(db.prepare(OPEN_TASKS_SQL).all(DAY)),
      top: ids(
        (db.prepare(todayTopSql).all(DAY, DAY_START) as { id: string; status: string }[]).filter(
          (row) => row.status === "todo",
        ),
      ),
    });
    expect(open()).toEqual({ due: ["s1"], plan: ["s1"], top: ["s1"] });
    finish("s1");
    expect(open()).toEqual({ due: ["s2"], plan: ["s2"], top: ["s2"] });
    // A dropped step doesn't hold up the next one.
    db.prepare("UPDATE task_items SET status = 'dropped' WHERE id = 's2'").run();
    expect(open()).toEqual({ due: ["s3"], plan: ["s3"], top: ["s3"] });
  });

  it("labels each step with its place", () => {
    const { db } = split();
    const rows = db.prepare(TASKS_SQL).all('["todo"]', 0) as {
      id: string;
      step_no: number;
      step_total: number;
    }[];
    expect(rows.map((row) => [row.id, stepLabel(row.step_no, row.step_total)]).sort()).toEqual([
      ["s1", "1/3"],
      ["s2", "2/3"],
      ["s3", "3/3"],
    ]);
    expect([stepLabel(null, null), stepLabel(1, 1)]).toEqual(["", ""]);
  });

  it("puts splits made before the upgrade in the order they were written", () => {
    const db = openTestDb({ migrate: false });
    const all = migrations();
    const upTo = all.findIndex((m) => m.name.startsWith("0018"));
    for (const migration of all.slice(0, upTo)) db.exec(migration.sql);
    const add = db.prepare(
      "INSERT INTO task_items (id, title, status, origin, created_at, updated_at) VALUES (?, ?, 'todo', ?, 0, 0)",
    );
    add.run("a", "first", "split:big");
    add.run("other", "other", "split:else");
    add.run("b", "second", "split:big");
    add.run("plain", "plain", null);
    for (const migration of all.slice(upTo)) db.exec(migration.sql);
    expect(db.prepare("SELECT id, parent_id, step_no FROM task_items ORDER BY id").all()).toEqual([
      { id: "a", parent_id: "big", step_no: 1 },
      { id: "b", parent_id: "big", step_no: 2 },
      { id: "other", parent_id: "else", step_no: 1 },
      { id: "plain", parent_id: null, step_no: null },
    ]);
  });
});
