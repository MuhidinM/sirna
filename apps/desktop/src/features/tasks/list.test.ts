import { type DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { type Op } from "../../kernel/db";
import { openTestDb } from "../../test/sqlite";
import {
  checkTask,
  COUNTS_SQL,
  filterTasks,
  statusOps,
  taskDraftOf,
  taskEditOps,
  type TaskListRow,
  TASKS_SQL,
  viewParams,
} from "./list";

const NOW = Date.parse("2026-11-12T06:00:00Z");
type Input = string | number | null;

function apply(db: DatabaseSync, ops: Op[]) {
  for (const op of ops) {
    if (op.op !== "update") throw new Error("only updates here");
    const names = Object.keys(op.values);
    db.prepare(
      `UPDATE ${op.table} SET ${names.map((n) => `${n} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
    ).run(...(Object.values(op.values) as Input[]), NOW, op.id);
  }
}

function seeded() {
  const db = openTestDb();
  db.exec(`
    INSERT INTO project_items (id, title, status, created_at, updated_at)
      VALUES ('p1', 'Portfolio site', 'active', 0, 0);
    INSERT INTO task_items (id, title, status, area_id, project_id, due_date, due_at, remind_at, estimate_min, waiting_on, created_at, updated_at) VALUES
      ('a', 'Write the report', 'todo', 'jobhunt', NULL, '2026-11-14', 1794641400000, 1794641400000, 180, NULL, 1, ${NOW}),
      ('b', 'Pick a theme', 'todo', 'coding', 'p1', NULL, NULL, NULL, NULL, NULL, 2, ${NOW}),
      ('c', 'Recruiter reply', 'waiting', 'jobhunt', NULL, NULL, NULL, NULL, NULL, 'Daniel', 3, ${NOW}),
      ('d', 'Learn Go', 'someday', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 4, ${NOW}),
      ('e', 'Old done thing', 'done', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 5, 0),
      ('f', 'Recent done', 'done', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 6, ${NOW});
  `);
  return db;
}

const list = (db: DatabaseSync, view: Parameters<typeof viewParams>[0]) =>
  db.prepare(TASKS_SQL).all(...viewParams(view, NOW)) as unknown as TaskListRow[];

describe("listing tasks", () => {
  it("shows each view, with area and project names", () => {
    const db = seeded();
    expect(list(db, "open").map((t) => [t.id, t.area_name, t.project_title])).toEqual([
      ["a", "Job hunt", null],
      ["b", "Coding skills", "Portfolio site"],
    ]);
    expect(list(db, "waiting").map((t) => t.waiting_on)).toEqual(["Daniel"]);
    expect(list(db, "someday").map((t) => t.id)).toEqual(["d"]);
    expect(list(db, "done").map((t) => t.id)).toEqual(["f"]);
    expect(db.prepare(COUNTS_SQL).all(NOW - 60 * 86_400_000)).toEqual(
      expect.arrayContaining([
        { status: "todo", n: 2 },
        { status: "done", n: 1 },
      ]),
    );
  });

  it("searches and filters by area", () => {
    const rows = list(seeded(), "open");
    expect(filterTasks(rows, "portfolio", "").map((t) => t.id)).toEqual(["b"]);
    expect(filterTasks(rows, "", "jobhunt").map((t) => t.id)).toEqual(["a"]);
    expect(filterTasks(rows, "write report", "").map((t) => t.id)).toEqual(["a"]);
    expect(filterTasks(list(seeded(), "someday"), "", "none").map((t) => t.id)).toEqual(["d"]);
  });
});

describe("editing a task", () => {
  it("saves a new date, estimate and area, and drops the old reminder time", () => {
    const db = seeded();
    const [row] = list(db, "open");
    if (!row) throw new Error("no task");
    apply(
      db,
      taskEditOps(
        row,
        {
          ...taskDraftOf(row),
          due: "2026-11-20",
          estimateHours: "4",
          areaId: "coding",
        },
        NOW,
      ),
    );
    const saved = db.prepare("SELECT * FROM task_items WHERE id = 'a'").get() as Record<
      string,
      Input
    >;
    expect(saved).toMatchObject({
      due_date: "2026-11-20",
      due_at: null,
      remind_at: null,
      estimate_min: 240,
      area_id: "coding",
    });
  });

  it("keeps waiting fields only while waiting", () => {
    const db = seeded();
    const [row] = list(db, "waiting");
    if (!row) throw new Error("no task");
    apply(db, taskEditOps(row, { ...taskDraftOf(row), status: "todo" }, NOW));
    expect(db.prepare("SELECT status, waiting_on FROM task_items WHERE id = 'c'").get()).toEqual({
      status: "todo",
      waiting_on: null,
    });
  });

  it("checks the draft", () => {
    const row = list(seeded(), "open")[0];
    if (!row) throw new Error("no task");
    const draft = taskDraftOf(row);
    expect(checkTask(draft)).toBeNull();
    expect(checkTask({ ...draft, title: " " })).toMatch(/name/);
    expect(checkTask({ ...draft, due: "2026-02-30" })).toMatch(/Due/);
    expect(checkTask({ ...draft, estimateHours: "0" })).toMatch(/Estimate/);
    expect(checkTask({ ...draft, status: "waiting", waitingOn: "" })).toMatch(/whom/);
  });

  it("finishes, parks, drops and restores", () => {
    const db = seeded();
    apply(db, statusOps({ id: "b" }, "done", NOW));
    apply(db, statusOps({ id: "a" }, "someday", NOW));
    apply(db, statusOps({ id: "d" }, "dropped", NOW));
    expect(
      list(db, "done")
        .map((t) => t.id)
        .sort(),
    ).toEqual(["b", "f"]);
    expect(list(db, "someday").map((t) => t.id)).toEqual(["a"]);
    expect(list(db, "dropped").map((t) => t.id)).toEqual(["d"]);
    apply(db, statusOps({ id: "d" }, "todo", NOW));
    expect(list(db, "open").map((t) => t.id)).toEqual(["d"]);
  });
});

describe("review fixes", () => {
  it("keeps a finished task finished when its title is fixed", () => {
    const db = seeded();
    const [row] = list(db, "done");
    if (!row) throw new Error("no task");
    apply(db, taskEditOps(row, { ...taskDraftOf(row), title: "Recent done (fixed)" }, NOW));
    expect(list(db, "done").map((t) => t.title)).toEqual(["Recent done (fixed)"]);
    apply(db, taskEditOps(row, { ...taskDraftOf(row), status: "todo" }, NOW));
    expect(db.prepare("SELECT status, completed_at FROM task_items WHERE id = 'f'").get()).toEqual({
      status: "todo",
      completed_at: null,
    });
  });

  it("keeps a split project task on its project", async () => {
    const { splitOps } = await import("../ai/facts");
    const ops = splitOps(
      { id: "b", area_id: "coding", due_date: null, project_id: "p1" },
      [
        { title: "Shortlist themes", minutes: 30 },
        { title: "Try the best two", minutes: 90 },
      ],
      () => "s1",
    );
    expect(ops[0]).toMatchObject({ values: { project_id: "p1" } });
  });
});
