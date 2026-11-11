import { type DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { type Op } from "../../kernel/db";
import { openTestDb } from "../../test/sqlite";
import {
  addTaskOp,
  checkDraft,
  columnOf,
  draftOf,
  EMPTY_DRAFT,
  openStep,
  realDate,
  groupBoard,
  moveOps,
  type ProjectRow,
  projectOps,
  PROJECT_TASKS_SQL,
  PROJECTS_SQL,
  type ProjectTask,
  weeklyLabel,
} from "./projects";

const NOW = 1_794_400_000_000;

/** Applies ops the way tx.rs does, enough to check them against the real schema. */
function apply(db: DatabaseSync, ops: Op[]) {
  for (const op of ops) {
    if (op.op === "insert") {
      const values = { id: op.id, ...op.values, created_at: NOW, updated_at: NOW };
      const names = Object.keys(values);
      db.prepare(
        `INSERT INTO ${op.table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
      ).run(...(Object.values(values) as Input[]));
    } else if (op.op === "update") {
      const names = Object.keys(op.values);
      db.prepare(
        `UPDATE ${op.table} SET ${names.map((name) => `${name} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
      ).run(...(Object.values(op.values) as Input[]), NOW, op.id);
    } else throw new Error(`not used here: ${op.op}`);
  }
}

type Input = string | number | null;

function first<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined) throw new Error("expected a row");
  return row;
}

const projects = (db: DatabaseSync) => db.prepare(PROJECTS_SQL).all() as unknown as ProjectRow[];
const tasks = (db: DatabaseSync, id: string) =>
  db.prepare(PROJECT_TASKS_SQL).all(id) as unknown as ProjectTask[];

function ids() {
  let n = 0;
  return () => `id${String(++n).padStart(3, "0")}`;
}

const task = (change: Partial<ProjectTask> = {}): ProjectTask => ({
  id: "t1",
  title: "Write the README",
  status: "todo",
  started_at: null,
  completed_at: null,
  due_date: null,
  waiting_on: null,
  area_id: null,
  ...change,
});

describe("columns", () => {
  it("puts each status in its column", () => {
    expect(columnOf(task())).toBe("todo");
    expect(columnOf(task({ started_at: NOW }))).toBe("doing");
    expect(columnOf(task({ status: "waiting" }))).toBe("waiting");
    expect(columnOf(task({ status: "done" }))).toBe("done");
    expect(columnOf(task({ status: "dropped" }))).toBeNull();
  });

  it("groups a board", () => {
    const board = groupBoard([
      task({ id: "a" }),
      task({ id: "b", started_at: NOW }),
      task({ id: "c", status: "done" }),
      task({ id: "d", status: "someday" }),
    ]);
    expect(Object.values(board).map((column) => column.map((t) => t.id))).toEqual([
      ["a"],
      ["b"],
      [],
      ["c"],
    ]);
  });
});

describe("moving a card updates the task status", () => {
  it("moves through every column", () => {
    expect(moveOps(task(), "doing", NOW)).toEqual([
      {
        op: "update",
        table: "task_items",
        id: "t1",
        values: { status: "todo", started_at: NOW, completed_at: null },
      },
    ]);
    expect(moveOps(task({ started_at: 5 }), "waiting", NOW)[0]).toMatchObject({
      values: { status: "waiting", completed_at: null },
    });
    expect(moveOps(task(), "done", NOW)[0]).toMatchObject({
      values: { status: "done", completed_at: NOW },
    });
    expect(moveOps(task({ status: "done", completed_at: 5 }), "todo", NOW)[0]).toMatchObject({
      values: { status: "todo", started_at: null, completed_at: null },
    });
  });

  it("keeps when work started if it moves back to Doing", () => {
    expect(moveOps(task({ status: "waiting", started_at: 7 }), "doing", NOW)[0]).toMatchObject({
      values: { started_at: 7 },
    });
  });

  it("writes nothing when the card stays put", () => {
    expect(moveOps(task({ started_at: NOW }), "doing", NOW)).toEqual([]);
  });

  it("round-trips through the schema", () => {
    const db = openTestDb();
    const newId = ids();
    const { ops, projectId } = projectOps({ ...EMPTY_DRAFT, title: "Portfolio" }, null, newId);
    apply(db, ops);
    const project = first(projects(db));
    apply(db, [addTaskOp(project, "Pick a theme", "t1")]);
    for (const column of ["doing", "waiting", "done", "todo"] as const) {
      const current = first(tasks(db, projectId));
      apply(db, moveOps(current, column, NOW));
      expect(columnOf(first(tasks(db, projectId)))).toBe(column);
    }
  });
});

describe("projects", () => {
  it("creates a project with its next step as a To do card", () => {
    const db = openTestDb();
    const { ops, projectId } = projectOps(
      {
        ...EMPTY_DRAFT,
        title: " Portfolio site ",
        areaId: "coding",
        weeklyHours: "2.5",
        deadline: "2026-12-20",
        nextStep: "Sketch the home page",
      },
      null,
      ids(),
    );
    apply(db, ops);
    const project = first(projects(db));
    expect(project).toMatchObject({
      id: projectId,
      title: "Portfolio site",
      area_id: "coding",
      weekly_min: 150,
      deadline: "2026-12-20",
      status: "active",
      next_step_title: "Sketch the home page",
      open_count: 1,
    });
    expect(columnOf(first(tasks(db, projectId)))).toBe("todo");
    expect(draftOf(project).weeklyHours).toBe("2.5");
  });

  it("adds a new card only when the next step changes", () => {
    const db = openTestDb();
    const newId = ids();
    apply(db, projectOps({ ...EMPTY_DRAFT, title: "P", nextStep: "One" }, null, newId).ops);
    let project = first(projects(db));

    const same = projectOps({ ...draftOf(project), goal: "Ship it" }, project, newId).ops;
    expect(same.filter((op) => op.table === "task_items")).toEqual([]);

    apply(db, projectOps({ ...draftOf(project), nextStep: "Two" }, project, newId).ops);
    project = first(projects(db));
    expect(project.next_step_title).toBe("Two");
    expect(project.open_count).toBe(2);

    apply(db, projectOps({ ...draftOf(project), nextStep: "" }, project, newId).ops);
    project = first(projects(db));
    expect(project.next_step_task_id).toBeNull();
    expect(project.open_count).toBe(2);
  });

  it("asks for a new next step once the old one is done", () => {
    const db = openTestDb();
    apply(db, projectOps({ ...EMPTY_DRAFT, title: "P", nextStep: "One" }, null, ids()).ops);
    let project = first(projects(db));
    const step = first(tasks(db, project.id));
    apply(db, moveOps(step, "done", NOW));
    project = first(projects(db));
    expect(project.next_step_status).toBe("done");
    expect(draftOf(project).nextStep).toBe("");
  });

  it("orders active projects first", () => {
    const db = openTestDb();
    const newId = ids();
    apply(db, projectOps({ ...EMPTY_DRAFT, title: "Later", status: "idea" }, null, newId).ops);
    apply(db, projectOps({ ...EMPTY_DRAFT, title: "Now" }, null, newId).ops);
    expect(projects(db).map((p) => p.title)).toEqual(["Now", "Later"]);
  });

  it("rejects a status the schema doesn't know", () => {
    const db = openTestDb();
    const { ops } = projectOps({ ...EMPTY_DRAFT, title: "P" }, null, ids());
    const bad = ops.map((op) =>
      op.op === "insert" ? { ...op, values: { ...op.values, status: "someday" } } : op,
    );
    expect(() => apply(db, bad)).toThrow(/CHECK/);
  });
});

describe("review fixes", () => {
  it("keeps a next step that is waiting", () => {
    const db = openTestDb();
    const newId = ids();
    apply(db, projectOps({ ...EMPTY_DRAFT, title: "P", nextStep: "Email Abebe" }, null, newId).ops);
    let project = first(projects(db));
    apply(db, moveOps(first(tasks(db, project.id)), "waiting", NOW));
    project = first(projects(db));
    expect(openStep(project)).toBe("Email Abebe");
    apply(db, projectOps({ ...draftOf(project), deadline: "2026-12-20" }, project, newId).ops);
    project = first(projects(db));
    expect(project.next_step_title).toBe("Email Abebe");
    expect(project.open_count).toBe(1);
  });

  it("moves open cards with the project's area", () => {
    const db = openTestDb();
    const newId = ids();
    apply(
      db,
      projectOps({ ...EMPTY_DRAFT, title: "P", areaId: "coding", nextStep: "One" }, null, newId)
        .ops,
    );
    let project = first(projects(db));
    apply(db, [
      {
        op: "insert",
        table: "task_items",
        id: "t9",
        values: { title: "Elsewhere", status: "todo", project_id: project.id, area_id: "admin" },
      },
    ]);
    const open = tasks(db, project.id);
    apply(db, projectOps({ ...draftOf(project), areaId: "experiments" }, project, newId, open).ops);
    project = first(projects(db));
    const areas = Object.fromEntries(tasks(db, project.id).map((t) => [t.title, t.area_id]));
    expect(areas).toEqual({ One: "experiments", Elsewhere: "admin" });
  });

  it("shows weekly hours shortly", () => {
    const db = openTestDb();
    apply(db, projectOps({ ...EMPTY_DRAFT, title: "P", weeklyHours: "0.83" }, null, ids()).ops);
    expect(draftOf(first(projects(db))).weeklyHours).toBe("0.83");
  });

  it("only takes real dates", () => {
    expect(realDate("2026-12-20")).toBe(true);
    expect(realDate("2028-02-29")).toBe(true);
    expect(realDate("2026-02-30")).toBe(false);
    expect(realDate("2026-13-45")).toBe(false);
    expect(checkDraft({ ...EMPTY_DRAFT, title: "P", deadline: "2026-02-30" })).toMatch(/Deadline/);
  });
});

describe("checks and labels", () => {
  it("checks the draft", () => {
    expect(checkDraft(EMPTY_DRAFT)).toMatch(/name/);
    expect(checkDraft({ ...EMPTY_DRAFT, title: "P", weeklyHours: "50" })).toMatch(/Weekly/);
    expect(checkDraft({ ...EMPTY_DRAFT, title: "P", weeklyHours: "x" })).toMatch(/Weekly/);
    expect(checkDraft({ ...EMPTY_DRAFT, title: "P", deadline: "20 dec" })).toMatch(/Deadline/);
    expect(
      checkDraft({ ...EMPTY_DRAFT, title: "P", weeklyHours: "3", deadline: "2026-12-20" }),
    ).toBeNull();
  });

  it("labels weekly hours", () => {
    expect(weeklyLabel(150)).toBe("2 h 30 min / week");
    expect(weeklyLabel(120)).toBe("2 h / week");
    expect(weeklyLabel(45)).toBe("45 min / week");
    expect(weeklyLabel(null)).toBe("");
  });
});
