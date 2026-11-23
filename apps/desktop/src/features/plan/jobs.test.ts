import { describe, expect, it } from "vitest";

import { openTestDb } from "../../test/sqlite";
import {
  AREA_TASKS_SQL,
  JOB_TASKS_SQL,
  type JobTask,
  blockTaskLists,
  listBlockIds,
  tasksByArea,
  tasksByJob,
} from "./jobs";

describe("work tasks inside job blocks (T-067)", () => {
  it("lists each job's open tasks, deadline first, then planned, then oldest", () => {
    const task = (
      id: string,
      area: string,
      due: string | null,
      planned: string | null,
      created: number,
    ): JobTask => ({
      id,
      title: id,
      area_id: area,
      status: "todo",
      due_date: due,
      planned_date: planned,
      created_at: created,
    });
    const byJob = tasksByJob([
      task("later", "joba", null, null, 1),
      task("soon", "joba", "2026-11-16", null, 5),
      task("planned", "joba", null, "2026-11-15", 9),
      task("b1", "jobb", null, null, 1),
      ...["x1", "x2", "x3", "x4", "x5", "x6"].map((id, i) => task(id, "jobc", null, null, 10 + i)),
    ]);
    expect(byJob.get("joba")?.map((t) => t.id)).toEqual(["soon", "planned", "later"]);
    expect(byJob.get("jobb")?.map((t) => t.id)).toEqual(["b1"]);
    expect(byJob.get("jobc")).toHaveLength(5);
  });

  it("puts the list under the job's next block that hasn't ended", () => {
    const blocks = [
      { id: "a1", area_id: "joba", kind: "fixed", end_at: 100 },
      { id: "a2", area_id: "joba", kind: "fixed", end_at: 300 },
      { id: "b1", area_id: "jobb", kind: "fixed", end_at: 50 },
      { id: "g", area_id: "gym", kind: "routine", end_at: 400 },
    ];
    expect([...listBlockIds(blocks, new Set(["joba", "jobb"]), 150)]).toEqual(["a2"]);
    expect([...listBlockIds(blocks, new Set(["joba", "jobb"]), 0)].sort()).toEqual(["a1", "b1"]);
  });

  it("gives every area block a list when no areas are named (time first, rule 6)", () => {
    const blocks = [
      { id: "q", area_id: "quran", kind: "routine", end_at: 100 },
      { id: "a", area_id: "joba", kind: "fixed", end_at: 300 },
      { id: "g", area_id: "gym", kind: "routine", end_at: 400 },
      { id: "c", area_id: "coding", kind: "area", end_at: 500 },
      { id: "off", area_id: "rest", kind: "rest", end_at: 500 },
      { id: "none", area_id: null, kind: "fixed", end_at: 500 },
    ];
    expect([...listBlockIds(blocks, undefined, 0)].sort()).toEqual(["a", "c", "g", "q"]);
  });

  it("puts the list under an area block, not a task's own block, when there is one", () => {
    const own = {
      id: "own",
      area_id: "coding",
      kind: "area",
      end_at: 100,
      task_id: "t1",
      title: "Fix bug",
      task_title: "Fix bug",
    };
    const focus = {
      id: "focus",
      area_id: "coding",
      kind: "area",
      end_at: 300,
      task_id: "t2",
      title: "Coding: Read docs",
      task_title: "Read docs",
    };
    expect([...listBlockIds([own, focus], undefined, 0)]).toEqual(["focus"]);
    expect([...listBlockIds([own], undefined, 0)]).toEqual(["own"]);
  });

  it("leaves out tasks shown elsewhere", () => {
    const row: JobTask = {
      id: "t1",
      title: "Fix bug",
      area_id: "coding",
      status: "todo",
      due_date: null,
      planned_date: null,
      created_at: 0,
    };
    expect(tasksByArea([row], new Set(["t1"])).get("coding")).toBeUndefined();
    expect(tasksByArea([row]).get("coding")).toHaveLength(1);
  });

  it("reads tasks of any area, a third job included", () => {
    const db = openTestDb();
    db.prepare(
      "INSERT INTO area_items (id, name, kind, color, priority_rank, created_at, updated_at) VALUES ('jobc', 'Job C', 'work', 'work', 9, 0, 0)",
    ).run();
    const add = db.prepare(
      "INSERT INTO task_items (id, title, status, area_id, due_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 0)",
    );
    add.run("c1", "Report", "todo", "jobc", "2026-11-17");
    add.run("far", "Far", "todo", "jobc", "2026-12-30");
    add.run("done", "Done", "done", "jobc", null);
    add.run("gym", "Gym task", "todo", "gym", null);
    add.run("nodate", "Inbox", "todo", "joba", null);
    const ids = (db.prepare(JOB_TASKS_SQL).all("2026-11-22") as { id: string }[])
      .map((r) => r.id)
      .sort();
    // A third job and the gym count; too far ahead or done: left out.
    expect(ids).toEqual(["c1", "gym", "nodate"]);
    expect(AREA_TASKS_SQL).toBe(JOB_TASKS_SQL);
  });
});

describe("task lists inside blocks", () => {
  const row = (id: string, area: string): JobTask => ({
    id,
    title: id,
    area_id: area,
    status: "todo",
    due_date: null,
    planned_date: null,
    created_at: 0,
  });
  const block = (
    id: string,
    area: string | null,
    end: number,
    task: string | null = null,
    title = id,
  ) => ({
    id,
    area_id: area,
    kind: "area",
    end_at: end,
    task_id: task,
    title,
    task_title: task,
  });

  it("doesn't list a task that has its own block in an area block", () => {
    const blocks = [
      block("admin", "admin", 200),
      block("bank", "admin", 300, "Call bank", "Call bank"),
    ];
    const lists = blockTaskLists(blocks, [row("Call bank", "admin"), row("Pay rent", "admin")], 0);
    expect(lists.get("admin")?.map((t) => t.id)).toEqual(["Pay rent"]);
    // The task's own block doesn't hold the area's list while the area has another block.
    expect(lists.has("bank")).toBe(false);
  });

  it("lists an area's tasks once, in its first block still to come", () => {
    const blocks = [block("c1", "coding", 100), block("c2", "coding", 300)];
    const lists = blockTaskLists(blocks, [row("Read docs", "coding")], 150);
    expect([...lists.keys()]).toEqual(["c2"]);
  });

  it("leaves out a task already picked for an area block", () => {
    const blocks = [block("c1", "coding", 300, "Read docs", "Coding: Read docs")];
    const lists = blockTaskLists(blocks, [row("Read docs", "coding"), row("Fix bug", "coding")], 0);
    expect(lists.get("c1")?.map((t) => t.id)).toEqual(["Fix bug"]);
  });
});
