import { describe, expect, it } from "vitest";

import { localToEpoch } from "../../capture/when";
import { openTestDb } from "../../test/sqlite";
import {
  addOps,
  BOARD_TASKS_SQL,
  type BoardTask,
  blockBefore,
  changeOps,
  clockOf,
  deleteOps,
  draftOf,
  editorKey,
  type EditBlock,
  focusAfterDelete,
  minuteOf,
  moveOps,
  moveSpan,
  newDraft,
  PLANNED_RANGE_SQL,
  readClock,
  readDraft,
  resizeOps,
  resizeSpan,
  snap,
  todayTask,
  undoOps,
  weekColumn,
} from "./edit";

const DATE = "2026-11-25";
const at = (minutes: number) => localToEpoch(DATE, minutes);

const gym: EditBlock = {
  id: "b1",
  start_at: at(17 * 60),
  end_at: at(18 * 60),
  title: "Gym",
  kind: "routine",
  area_id: "gym",
  task_id: null,
  status: "planned",
};

describe("clock reading", () => {
  it("reads times on the logical day, after midnight as the night after", () => {
    expect(readClock("07:30")).toBe(450);
    expect(readClock("7.05")).toBe(425);
    expect(readClock("01:00")).toBe(1500);
    expect(readClock("03:00")).toBe(180);
    expect(readClock("25:00")).toBeNull();
    expect(readClock("7")).toBeNull();
  });

  it("reads an end not after the start as the night after", () => {
    expect(readClock("00:00", 22 * 60)).toBe(1440);
    expect(readClock("03:00", 23 * 60)).toBe(1620);
    expect(readClock("10:00", 9 * 60)).toBe(600);
  });

  it("writes minutes back as a clock", () => {
    expect(clockOf(450)).toBe("07:30");
    expect(clockOf(1500)).toBe("01:00");
    expect(minuteOf(DATE, at(1500))).toBe(1500);
  });
});

describe("move and resize (15-minute steps)", () => {
  it("snaps to the nearest 15 minutes", () => {
    expect(snap(52)).toBe(45);
    expect(snap(53)).toBe(60);
  });

  it("moves the whole block and keeps its length", () => {
    expect(moveSpan({ startMin: 600, endMin: 660 }, 37)).toEqual({ startMin: 630, endMin: 690 });
    expect(moveOps(DATE, gym, 60)).toEqual([
      {
        op: "update",
        table: "day_blocks",
        id: "b1",
        values: { start_at: at(18 * 60), end_at: at(19 * 60) },
      },
    ]);
  });

  it("stays inside the logical day", () => {
    expect(moveSpan({ startMin: 200, endMin: 260 }, -120)).toEqual({ startMin: 180, endMin: 240 });
    expect(moveSpan({ startMin: 1560, endMin: 1600 }, 120)).toEqual({
      startMin: 1580,
      endMin: 1620,
    });
  });

  it("moves, resizes and edits a block that crosses midnight on the same logical day", () => {
    const late: EditBlock = {
      ...gym,
      id: "b9",
      start_at: at(23 * 60 + 30),
      end_at: at(24 * 60 + 30),
    };
    expect(moveOps(DATE, late, 30)).toEqual([
      {
        op: "update",
        table: "day_blocks",
        id: "b9",
        values: { start_at: at(1440), end_at: at(1500) },
      },
    ]);
    expect(resizeOps(DATE, late, 1500 + 60)[0]).toMatchObject({
      values: { start_at: at(1410), end_at: at(1560) },
    });
    const draft = draftOf(DATE, late);
    expect(draft).toMatchObject({ start: "23:30", end: "00:30" });
    expect(readDraft(draft)).toEqual({ startMin: 1410, endMin: 1470 });
    expect(changeOps(DATE, late, draft)).toEqual([]);
    // 01:00 to 02:00 is the night after, still this logical day.
    expect(readDraft({ ...draft, start: "01:00", end: "02:00" })).toEqual({
      startMin: 1500,
      endMin: 1560,
    });
  });

  it("writes nothing when the block doesn't move", () => {
    expect(moveOps(DATE, gym, 5)).toEqual([]);
  });

  it("resizes the end, never shorter than 15 minutes", () => {
    expect(resizeSpan({ startMin: 600, endMin: 660 }, 692)).toEqual({ startMin: 600, endMin: 690 });
    expect(resizeSpan({ startMin: 600, endMin: 660 }, 500)).toEqual({ startMin: 600, endMin: 615 });
    expect(resizeOps(DATE, gym, 18 * 60 + 30)).toEqual([
      {
        op: "update",
        table: "day_blocks",
        id: "b1",
        values: { start_at: at(1020), end_at: at(1110) },
      },
    ]);
  });
});

describe("the edit popover", () => {
  it("starts from the block", () => {
    expect(draftOf(DATE, gym)).toEqual({
      title: "Gym",
      start: "17:00",
      end: "18:00",
      areaId: "gym",
      taskId: null,
    });
  });

  it("checks what you typed", () => {
    expect(readDraft({ ...draftOf(DATE, gym), start: "5pm" })).toBe("Times look like 07:30.");
    expect(readDraft({ ...draftOf(DATE, gym), end: "16:00" })).toBe(
      "It has to end after it starts.",
    );
    expect(
      readDraft({ title: " ", start: "09:00", end: "10:00", areaId: null, taskId: null }),
    ).toBe("Give it a name, an area or a task.");
    expect(readDraft({ ...draftOf(DATE, gym), end: "00:00", start: "23:00" })).toEqual({
      startMin: 1380,
      endMin: 1440,
    });
  });

  it("changes only what changed", () => {
    const ops = changeOps(DATE, gym, {
      ...draftOf(DATE, gym),
      title: "Gym, legs",
      end: "18:30",
      taskId: "t1",
    });
    expect(ops).toEqual([
      {
        op: "update",
        table: "day_blocks",
        id: "b1",
        values: { title: "Gym, legs", end_at: at(1110), task_id: "t1" },
      },
    ]);
    expect(changeOps(DATE, gym, draftOf(DATE, gym))).toEqual([]);
    expect(() => changeOps(DATE, gym, { ...draftOf(DATE, gym), start: "x" })).toThrow();
  });

  it("names an untitled block after its task or area", () => {
    const [op] = changeOps(
      DATE,
      gym,
      { ...draftOf(DATE, gym), title: "", taskId: "t1" },
      { task: "Leg day", area: "Gym" },
    );
    expect(op).toMatchObject({ values: { title: "Leg day" } });
  });

  it("adds a block you own, an hour from the line above where you clicked", () => {
    expect(newDraft(9 * 60 + 40)).toMatchObject({ start: "09:30", end: "10:30" });
    expect(newDraft(1615)).toMatchObject({ start: "02:45", end: "03:00" });
    const ops = addOps(DATE, { ...newDraft(600), title: "Read" }, "n1");
    expect(ops).toEqual([
      {
        op: "insert",
        table: "day_blocks",
        id: "n1",
        values: {
          logical_date: DATE,
          start_at: at(600),
          end_at: at(660),
          kind: "area",
          area_id: null,
          task_id: null,
          title: "Read",
          source: "user",
          status: "planned",
        },
      },
    ]);
  });

  it("deletes after marking the block yours, so the planner doesn't make it again", () => {
    expect(deleteOps(gym)).toEqual([
      { op: "update", table: "day_blocks", id: "b1", values: {} },
      { op: "delete", table: "day_blocks", id: "b1" },
    ]);
  });

  it("moves focus to the next block after a delete, else the one before, else the board", () => {
    const blocks = [
      { id: "c", start_at: 300 },
      { id: "a", start_at: 100 },
      { id: "b", start_at: 200 },
    ];
    expect(focusAfterDelete(blocks, "a")).toBe("b");
    expect(focusAfterDelete(blocks, "c")).toBe("b");
    expect(focusAfterDelete([{ id: "a", start_at: 1 }], "a")).toBeNull();
    expect(focusAfterDelete(blocks, "gone")).toBeNull();
  });
});

describe("undo", () => {
  it("puts each edit back", () => {
    const before = { b1: blockBefore(gym) };
    expect(undoOps(moveOps(DATE, gym, 60), before)).toEqual([
      {
        op: "update",
        table: "day_blocks",
        id: "b1",
        values: { start_at: gym.start_at, end_at: gym.end_at },
      },
    ]);
    expect(undoOps(addOps(DATE, { ...newDraft(600), title: "Read" }, "n1"), {})).toEqual([
      { op: "delete", table: "day_blocks", id: "n1" },
    ]);
    expect(undoOps(deleteOps(gym), before)).toEqual([
      { op: "upsert", table: "day_blocks", id: "b1", values: blockBefore(gym) },
    ]);
  });
});

describe("the database side", () => {
  it("edits overlapping blocks without complaint and keeps them from the planner", () => {
    const db = openTestDb();
    db.prepare(
      "INSERT INTO day_blocks (id, logical_date, start_at, end_at, kind, title, created_at, updated_at) VALUES ('b1', ?, ?, ?, 'routine', 'Gym', 0, 0), ('b2', ?, ?, ?, 'fixed', 'Job A', 0, 0)",
    ).run(DATE, at(1020), at(1080), DATE, at(540), at(1020));
    const [op] = moveOps(DATE, { ...gym }, -60);
    if (op?.op !== "update") throw new Error("expected an update");
    // What tx.rs does for the user: the values plus user_edited_at.
    db.prepare(
      "UPDATE day_blocks SET start_at = ?, end_at = ?, user_edited_at = 1 WHERE id = ?",
    ).run(op.values.start_at as number, op.values.end_at as number, op.id);
    const kept = db
      .prepare(
        "SELECT id FROM day_blocks WHERE logical_date = ? AND deleted_at IS NULL AND (source = 'user' OR user_edited_at IS NOT NULL)",
      )
      .all(DATE);
    expect(kept).toEqual([{ id: "b1" }]);
    expect(db.prepare(PLANNED_RANGE_SQL).all(DATE, DATE)).toHaveLength(2);
  });

  it("lists open tasks for the picker, with or without an area", () => {
    const db = openTestDb();
    db.exec(
      "INSERT INTO area_items (id, name, kind, color, priority_rank, created_at, updated_at) VALUES ('gym', 'Gym', 'health', 'gym', 5, 0, 0) ON CONFLICT(id) DO NOTHING",
    );
    db.exec(`INSERT INTO task_items (id, title, status, area_id, due_date, planned_date, created_at, updated_at) VALUES
      ('t1', 'Legs', 'todo', 'gym', NULL, NULL, 1, 0),
      ('t2', 'Arms', 'todo', 'gym', '2026-11-26', NULL, 2, 0),
      ('t3', 'Far off', 'todo', 'gym', NULL, '2027-01-10', 3, 0),
      ('t4', 'Call bank', 'todo', NULL, NULL, NULL, 4, 0),
      ('t5', 'Done one', 'done', 'gym', NULL, NULL, 5, 0)`);
    const rows = db.prepare(BOARD_TASKS_SQL).all() as unknown as BoardTask[];
    expect(rows.map((r) => r.id)).toEqual(["t1", "t2", "t3", "t4"]);
  });
});

describe("Add for today", () => {
  const now = Date.parse("2026-11-25T10:00:00+03:00");

  it("dates the task today", () => {
    expect(todayTask("call bank", DATE, now)).toMatchObject({
      kind: "task",
      title: "call bank",
      dueDate: DATE,
    });
    expect(todayTask("  ", DATE, now)).toBeNull();
  });

  it("keeps a time you typed", () => {
    const task = todayTask("call bank 3pm", DATE, now);
    expect(task).toMatchObject({ kind: "task", dueDate: DATE, dueAt: at(15 * 60) });
  });

  it("is a task even when the words read like money", () => {
    expect(todayTask("lunch 120", DATE, now)).toMatchObject({
      kind: "task",
      title: "lunch 120",
      dueDate: DATE,
    });
  });

  // F83: the same reading as the capture bar.
  const areas = [
    { id: "joba", name: "Job A" },
    { id: "jobb", name: "Job B" },
  ];

  it("reads `for job a` as the area", () => {
    expect(todayTask("update cv for job a", DATE, now, { areas })).toMatchObject({
      kind: "task",
      title: "update cv",
      area: "joba",
      dueDate: DATE,
    });
  });

  it("reads a wait: line as a task without its prefix", () => {
    const task = todayTask("wait: recruiter reply", DATE, now, { areas });
    expect(task).toMatchObject({ kind: "task", dueDate: DATE });
    expect(task?.kind === "task" && task.title).not.toMatch(/^wait\s*:/i);
  });

  it("drops a capture prefix from the title", () => {
    expect(todayTask("idea: learn go", DATE, now, { areas })).toMatchObject({
      kind: "task",
      title: "learn go",
      dueDate: DATE,
    });
    expect(todayTask("n: send CV for job b", DATE, now, { areas })).toMatchObject({
      kind: "task",
      title: "send CV",
      area: "jobb",
      dueDate: DATE,
    });
  });

  it("reads Ethiopian times when that is your clock", () => {
    // `at 9` in Ethiopian time is 15:00.
    const task = todayTask("call bank at 9", DATE, now, { clockStyle: "ethiopian" });
    expect(task).toMatchObject({ kind: "task", dueDate: DATE, dueAt: at(15 * 60) });
  });
});

describe("Next 7 days columns", () => {
  const routine = [
    { start_min: 540, duration_min: 480, kind: "fixed", area_id: "joba", title: "Job A" },
    { start_min: 1020, duration_min: 60, kind: "routine", area_id: "gym", title: "Gym" },
    { start_min: 0, duration_min: 1440, kind: "rest", area_id: null, title: "Rest" },
    { start_min: 1140, duration_min: 90, kind: "area", area_id: null, title: "Free slot" },
  ];
  const forecast = [{ startMin: 1140, durationMin: 90, areaId: "coding", title: "Coding" }];

  it("shows every block of a day not yet planned: routine plus forecast", () => {
    expect(weekColumn(DATE, [], routine, forecast).map((b) => b.title)).toEqual([
      "Job A",
      "Gym",
      "Coding",
    ]);
  });

  it("doesn't show a block twice when the forecast already has it", () => {
    const twin = [{ startMin: 1020, durationMin: 60, areaId: "gym", title: "Gym" }, ...forecast];
    expect(weekColumn(DATE, [], routine, twin)).toHaveLength(3);
  });

  it("shows a planned day as planned, edits included", () => {
    const planned = [
      { start_at: at(600), end_at: at(690), kind: "area", area_id: null, title: "Read" },
      { start_at: at(180), end_at: at(360), kind: "rest", area_id: null, title: "Sleep" },
    ];
    expect(weekColumn(DATE, planned, routine, forecast)).toEqual([
      { startMin: 600, durationMin: 90, areaId: null, title: "Read" },
    ]);
  });
});

describe("the add popover's key", () => {
  it("changes with another empty hour or another click, so the fields show the new time", () => {
    const nine = { mode: "add" as const, draft: newDraft(9 * 60), opened: 1 };
    const eleven = { mode: "add" as const, draft: newDraft(11 * 60), opened: 2 };
    expect(editorKey(nine)).not.toBe(editorKey(eleven));
    // The same hour clicked again opens a fresh popover too.
    expect(editorKey(nine)).not.toBe(editorKey({ ...nine, opened: 3 }));
    expect(editorKey({ mode: "edit", block: { id: "b1" } })).toBe("edit:b1");
  });
});
