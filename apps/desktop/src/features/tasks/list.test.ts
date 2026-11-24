import { type DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { type Op } from "../../kernel/db";
import { openTestDb } from "../../test/sqlite";
import {
  checkTask,
  COUNTS_SQL,
  filterTasks,
  LATER_STEPS_SQL,
  SPLIT_STEPS_SQL,
  statusOps,
  taskDraftOf,
  taskEditOps,
  type TaskListRow,
  TASKS_SQL,
  undoSplitOps,
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
  it("saves a new date, estimate and area; the time and reminder move to the new date", () => {
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
      due_at: 1794641400000 + 6 * 86_400_000,
      remind_at: 1794641400000 + 6 * 86_400_000,
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

  it("keeps the task's part of the day on every step (time first §1 rule 2)", async () => {
    const { splitOps } = await import("../ai/facts");
    const db = seeded();
    db.prepare("UPDATE task_items SET planned_window = 'evening' WHERE id = 'b'").run();
    const row = list(db, "open").find((t) => t.id === "b");
    expect(row?.planned_window).toBe("evening");
    if (!row) throw new Error("expected task b");
    let n = 0;
    const ops = splitOps(
      row,
      [
        { title: "Shortlist themes", minutes: 30 },
        { title: "Try the best two", minutes: 90 },
      ],
      () => `s${++n}`,
    );
    const inserts = ops.filter((op) => op.op === "insert");
    expect(inserts).toHaveLength(2);
    for (const op of inserts) expect(op).toMatchObject({ values: { planned_window: "evening" } });
    // A task with no part of the day gives its steps none.
    expect(
      splitOps(
        { id: "x", area_id: null, due_date: null },
        [{ title: "a", minutes: 5 }],
        () => "s9",
      )[0],
    ).toMatchObject({
      values: { planned_window: null },
    });
  });
});

describe("splitting from the Tasks page (review fixes)", () => {
  /** Inserts and updates, as tx.rs applies them. */
  function write(db: DatabaseSync, ops: Op[]) {
    for (const op of ops) {
      if (op.op === "insert") {
        const all = { id: op.id, ...op.values, created_at: NOW, updated_at: NOW };
        const keys = Object.keys(all);
        db.prepare(
          `INSERT INTO task_items (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
        ).run(...(Object.values(all) as Input[]));
      } else apply(db, [op]);
    }
  }

  it("keeps a timed task's time on its first step, so its block stays", async () => {
    const { splitOps } = await import("../ai/facts");
    const db = seeded();
    const row = list(db, "open").find((t) => t.id === "a");
    if (!row) throw new Error("expected task a");
    expect(row.due_at).toBe(1794641400000);
    let n = 0;
    const ops = splitOps(
      row,
      [
        { title: "Outline", minutes: 60 },
        { title: "Write", minutes: 120 },
      ],
      () => `s${++n}`,
    );
    const inserts = ops.filter((op) => op.op === "insert");
    expect(inserts.map((op) => op.op === "insert" && op.values.due_at)).toEqual([
      1794641400000,
      null,
    ]);
  });

  it("splits a step in its place: the new steps take its slot and later ones move down", async () => {
    const { manualSplitOps } = await import("./split");
    const db = seeded();
    db.exec(`
      INSERT INTO task_items (id, title, status, parent_id, step_no, created_at, updated_at) VALUES
        ('s1', 'Plan', 'todo', 'big', 1, 7, 7),
        ('s2', 'Build', 'todo', 'big', 2, 8, 8),
        ('s3', 'Ship', 'todo', 'big', 3, 9, 9);
    `);
    const row = list(db, "open").find((t) => t.id === "s2");
    if (!row) throw new Error("expected step s2");
    expect(row).toMatchObject({ parent_id: "big", step_no: 2 });
    const later = db.prepare(LATER_STEPS_SQL).all(row.parent_id, row.step_no) as {
      id: string;
      step_no: number;
    }[];
    let n = 0;
    write(
      db,
      manualSplitOps(
        row,
        [
          { title: "Build the page", minutes: 60 },
          { title: "Build the form", minutes: null },
        ],
        () => `n${++n}`,
        later,
      ),
    );
    const order = db
      .prepare(
        "SELECT id, step_no FROM task_items WHERE parent_id = 'big' AND status = 'todo' ORDER BY step_no",
      )
      .all();
    expect(order).toEqual([
      { id: "s1", step_no: 1 },
      { id: "n1", step_no: 2 },
      { id: "n2", step_no: 3 },
      { id: "s3", step_no: 4 },
    ]);
    // The split step leaves the count: 4 steps, not 5.
    expect(list(db, "open").find((t) => t.id === "n1")?.step_total).toBe(4);
  });

  it("F61: a split task in Dropped says so, and undoing the split takes its steps back", async () => {
    const { manualSplitOps } = await import("./split");
    const db = seeded();
    const row = list(db, "open").find((t) => t.id === "a");
    if (!row) throw new Error("expected task a");
    let n = 0;
    const steps = [
      { title: "Outline", minutes: 60 },
      { title: "Write", minutes: 120 },
    ];
    write(
      db,
      manualSplitOps(row, steps, () => `s${++n}`),
    );
    const dropped = list(db, "dropped").find((t) => t.id === "a");
    expect(dropped).toMatchObject({ split_steps: 2, split_settled: 0 });

    const ids = (db.prepare(SPLIT_STEPS_SQL).all("a") as { id: string }[]).map((r) => r.id);
    expect(ids.sort()).toEqual(["s1", "s2"]);
    for (const op of undoSplitOps({ id: "a" }, ids, NOW)) {
      if (op.op === "delete")
        db.prepare("UPDATE task_items SET deleted_at = ? WHERE id = ?").run(NOW, op.id);
      else apply(db, [op]);
    }
    const open = list(db, "open").map((t) => t.id);
    expect(open).toContain("a");
    expect(open).not.toContain("s1");
    expect(open).not.toContain("s2");
  });

  it("F61: a split with a step done can't be undone from Dropped", async () => {
    const { manualSplitOps } = await import("./split");
    const db = seeded();
    const row = list(db, "open").find((t) => t.id === "a");
    if (!row) throw new Error("expected task a");
    let n = 0;
    const steps = [
      { title: "Outline", minutes: 60 },
      { title: "Write", minutes: 120 },
    ];
    write(
      db,
      manualSplitOps(row, steps, () => `s${++n}`),
    );
    apply(db, statusOps({ id: "s1" }, "done", NOW));
    expect(list(db, "dropped").find((t) => t.id === "a")).toMatchObject({
      split_steps: 2,
      split_settled: 1,
    });
    // A task that was only dropped has no steps.
    apply(db, statusOps({ id: "b" }, "dropped", NOW));
    expect(list(db, "dropped").find((t) => t.id === "b")).toMatchObject({ split_steps: 0 });
  });
});
