// The unit tests of src-tauri/src/commands.rs and away.rs, run against the port.
import { describe, expect, it } from "vitest";

import { openTestDb } from "../test/sqlite";
import { type Conn, nodeConn } from "./conn";
import {
  AWAY_KEY,
  captureCommit,
  captureOpsAllowed,
  captureReplace,
  captureUndo,
  isReadQuery,
  logicalDay,
  notesUndo,
  replaceIn,
  returnDate,
  setAway,
  settingString,
  storeCapture,
  validDate,
} from "./commands";
import { cheatLines, otherName, resolveTarget } from "./focus";
import { applyOps, type Op, undoContext } from "./tx";

const conn = (): Conn => nodeConn(openTestDb());
const insert = (table: string): Op => ({ op: "insert", table, id: "x", values: {} });
const taskOp = (id: string, title: string): Op[] => [
  { op: "insert", table: "task_items", id, values: { title } },
];
const T0 = 1_794_387_600_000; // 2026-11-11 12:00 Addis

describe("captures", () => {
  it("may only insert tasks, notes, money and ideas", () => {
    expect(
      captureOpsAllowed(
        ["task_items", "money_txns", "note_items", "project_items", "savings_entries"].map(insert),
      ),
    ).toBe(true);
    expect(captureOpsAllowed([insert("area_items")])).toBe(false);
    expect(captureOpsAllowed([insert("core_settings")])).toBe(false);
    expect(captureOpsAllowed([{ op: "delete", table: "task_items", id: "x" }])).toBe(false);
    expect(captureOpsAllowed([{ op: "update", table: "task_items", id: "x", values: {} }])).toBe(
      false,
    );
    // `gym done`: a block's status, and nothing else about it.
    const block = (values: Record<string, string>): Op => ({
      op: "update",
      table: "day_blocks",
      id: "b",
      values,
    });
    expect(captureOpsAllowed([block({ status: "done" })])).toBe(true);
    expect(captureOpsAllowed([block({ status: "skipped" })])).toBe(true);
    expect(captureOpsAllowed([block({ status: "planned" })])).toBe(false);
    expect(captureOpsAllowed([block({ title: "x" })])).toBe(false);
  });

  it("stores the line, its records and the parser, and reports the tables", () => {
    const c = conn();
    const done = captureCommit(
      c,
      { rawText: "call bank", ops: taskOp("t1", "call bank"), parser: "capture@3" },
      T0,
    );
    expect(done.changed).toEqual(["task_items", "core_raw_items"]);
    const [raw] = c.all("SELECT * FROM core_raw_items WHERE id = ?", [done.result]);
    expect(raw).toMatchObject({
      body: "call bank",
      parse_status: "parsed",
      parser_id: "capture",
      parser_version: 3,
      parsed_at: T0,
    });
    const [log] = c.all("SELECT context, actor FROM core_activity WHERE entity_id = 't1'");
    expect(log).toMatchObject({ context: `capture:${done.result}`, actor: "user" });
    expect(() => captureCommit(c, { rawText: "  " }, T0)).toThrow("Nothing to save");
  });

  it("undo marks the capture ignored and soft-deletes its records", () => {
    const c = conn();
    const { result: raw } = captureCommit(c, { rawText: "x", ops: taskOp("t1", "x") }, T0);
    expect(captureUndo(c, { rawId: raw }, T0 + 1).result).toBe(1);
    expect(
      c.all("SELECT parse_status FROM core_raw_items WHERE id = ?", [raw])[0]?.parse_status,
    ).toBe("ignored");
    expect(c.all("SELECT deleted_at FROM task_items WHERE id = 't1'")[0]?.deleted_at).toBe(T0 + 1);
  });

  it("a fix replaces the old records", () => {
    const c = conn();
    const { result: raw } = captureCommit(c, { rawText: "a", ops: taskOp("t1", "a") }, T0);
    const fixed = captureReplace(c, { rawId: raw, rawText: "b", ops: taskOp("t2", "b") }, T0 + 1);
    expect(fixed.result).toBeGreaterThan(raw);
    expect(
      c.all("SELECT id FROM task_items WHERE id IN ('t1', 't2') AND deleted_at IS NULL"),
    ).toEqual([{ id: "t2" }]);
  });

  it("fixing a task capture keeps its project, parent and steps", () => {
    const c = conn();
    const raw = storeCapture(c, "read chapter 5", taskOp("t5", "read chapter 5"), null, 1);
    c.exec(`UPDATE task_items SET project_id = 'p1', parent_id = 'big', step_no = 2 WHERE id = 't5';
      INSERT INTO task_items (id, title, parent_id, step_no, created_at, updated_at)
        VALUES ('s1', 'take notes', 't5', 1, 0, 0);`);
    const fixed = replaceIn(c, raw, "read chapter 6", taskOp("t6", "read chapter 6"), null, 2);
    expect(
      c.all("SELECT title, project_id, parent_id, step_no FROM task_items WHERE id = 't6'")[0],
    ).toEqual({ title: "read chapter 6", project_id: "p1", parent_id: "big", step_no: 2 });
    expect(c.all("SELECT parent_id FROM task_items WHERE id = 's1'")[0]?.parent_id).toBe("t6");
    undoContext(c, "user", `capture:${fixed}`, 3);
    expect(c.all("SELECT parent_id FROM task_items WHERE id = 's1'")[0]?.parent_id).toBe("t5");
  });

  it("fixing a fixed capture still keeps its project, parent and steps", () => {
    const c = conn();
    const raw = storeCapture(c, "read ch 5", taskOp("t5", "read ch 5"), null, 1);
    c.exec(`UPDATE task_items SET project_id = 'p1', parent_id = 'big', step_no = 2 WHERE id = 't5';
      INSERT INTO task_items (id, title, parent_id, step_no, created_at, updated_at)
        VALUES ('s1', 'take notes', 't5', 1, 0, 0);`);
    const once = replaceIn(c, raw, "read ch 6", taskOp("t6", "read ch 6"), null, 2);
    replaceIn(c, once, "read ch 7", taskOp("t7", "read ch 7"), null, 3);
    expect(
      c.all("SELECT project_id, parent_id, step_no FROM task_items WHERE id = 't7'")[0],
    ).toEqual({ project_id: "p1", parent_id: "big", step_no: 2 });
    expect(c.all("SELECT parent_id FROM task_items WHERE id = 's1'")[0]?.parent_id).toBe("t7");
  });

  it("undoing a fix keeps later edits to its steps", () => {
    const c = conn();
    const raw = storeCapture(c, "read ch 5", taskOp("t5", "read ch 5"), null, 1);
    c.exec(`INSERT INTO task_items (id, title, parent_id, step_no, created_at, updated_at)
        VALUES ('s1', 'take notes', 't5', 1, 0, 0);`);
    const fixed = replaceIn(c, raw, "read ch 6", taskOp("t6", "read ch 6"), null, 2);
    applyOps(
      c,
      "user",
      null,
      [
        {
          op: "update",
          table: "task_items",
          id: "s1",
          values: { title: "take good notes", status: "done" },
        },
      ],
      3,
    );
    undoContext(c, "user", `capture:${fixed}`, 4);
    expect(c.all("SELECT title, status, parent_id FROM task_items WHERE id = 's1'")[0]).toEqual({
      title: "take good notes",
      status: "done",
      parent_id: "t5",
    });
  });
});

describe("reads", () => {
  it("are allowed after comments", () => {
    expect(isReadQuery("SELECT 1")).toBe(true);
    expect(isReadQuery("  with x as (select 1) select * from x")).toBe(true);
    expect(isReadQuery("-- note\n-- more\nSELECT 1")).toBe(true);
    expect(isReadQuery("/* block */ select 1")).toBe(true);
  });

  it("refuse writes", () => {
    expect(isReadQuery("DELETE FROM task_items")).toBe(false);
    expect(isReadQuery("-- SELECT\nUPDATE x SET y = 1")).toBe(false);
    expect(isReadQuery("-- only a comment")).toBe(false);
  });
});

describe("notes undo", () => {
  it("only undoes notes: contexts", () => {
    const c = conn();
    expect(() => notesUndo(c, { context: "capture:1" }, 1)).toThrow(
      "only a Notes edit can be undone here",
    );
    applyOps(
      c,
      "user",
      "notes:1",
      [{ op: "insert", table: "note_items", id: "n1", values: { kind: "cheat", body: "x" } }],
      1,
    );
    expect(notesUndo(c, { context: "notes:1" }, 2)).toEqual({
      result: { changes: 1, kept: 0 },
      changed: ["note_items"],
    });
  });
});

describe("away", () => {
  it("return dates", () => {
    expect(returnDate("2026-11-16", "2026-11-11", "2026-11-12")).toBe("2026-11-16");
    expect(returnDate(null, "2026-11-11", "2026-11-12")).toBe("2026-11-12");
    expect(returnDate("2026-11-11", "2026-11-11", "2026-11-12")).toBe("2026-11-12");
    expect(returnDate("junk", "2026-11-11", "2026-11-12")).toBe("2026-11-12");
    expect(validDate("2026-13-01")).toBe(false);
    expect(validDate("2026-1-01")).toBe(false);
    expect(validDate("2027-01-31")).toBe(true);
  });

  it("set_away stores tomorrow by default, under the capture", () => {
    const c = conn();
    expect(setAway(c, { rawId: 7 }, T0).result).toBe("2026-11-12");
    expect(settingString(c, AWAY_KEY)).toBe("2026-11-12");
    expect(
      c.all("SELECT context FROM core_activity WHERE entity_id = ?", [AWAY_KEY])[0]?.context,
    ).toBe("capture:7");
  });

  it("undoing the capture ends away; an earlier away survives", () => {
    const c = conn();
    const set = (date: string, context: string) =>
      applyOps(
        c,
        "user",
        context,
        [
          {
            op: "upsert",
            table: "core_settings",
            id: AWAY_KEY,
            values: { value_json: JSON.stringify(date) },
          },
        ],
        1,
      );
    set("2026-11-16", "capture:7");
    expect(settingString(c, AWAY_KEY)).toBe("2026-11-16");
    undoContext(c, "user", "capture:7", 2);
    expect((settingString(c, AWAY_KEY) ?? "") > "2026-11-11").toBe(false);
    set("2026-11-13", "away");
    set("2026-11-20", "capture:8");
    undoContext(c, "user", "capture:8", 3);
    expect(settingString(c, AWAY_KEY)).toBe("2026-11-13");
  });
});

describe("the set-up sheet", () => {
  it("shows the area's cheat lines in card order", () => {
    const c = conn();
    c.exec(`INSERT INTO note_items (id, kind, status, body, area_id, sort_order, created_at, updated_at, deleted_at) VALUES
      ('a', 'cheat', 'kept', 'pinned later', 'coding', NULL, 30, 0, NULL),
      ('b', 'cheat', 'kept', 'first by hand', 'coding', 0, 20, 0, NULL),
      ('c', 'cheat', 'kept', 'pinned first', 'coding', NULL, 10, 0, NULL),
      ('d', 'cheat', 'kept', 'deleted', 'coding', NULL, 5, 0, 1),
      ('e', 'cheat', 'kept', 'other area', 'quran', NULL, 1, 0, NULL),
      ('f', 'note', 'kept', 'not a cheat', 'coding', NULL, 1, 0, NULL);`);
    expect(cheatLines(c, "coding")).toEqual(["first by hand", "pinned first", "pinned later"]);
    expect(cheatLines(c, null)).toEqual([]);
  });

  it("picks the block, the area or nothing", () => {
    expect(resolveTarget(null, "b1")).toEqual(["b1", null]);
    expect(resolveTarget({}, "b1")).toEqual([null, null]);
    expect(resolveTarget({ areaId: "coding" }, "b1")).toEqual([null, "coding"]);
    expect(otherName({ other: "  " })).toBeNull();
    expect(otherName({ blockId: "b2", other: " Read " })).toBe("Read");
  });
});

describe("time", () => {
  it("the logical day starts at 03:00 Addis", () => {
    expect(logicalDay(T0)).toEqual(["2026-11-11", Date.parse("2026-11-11T03:00:00+03:00")]);
    expect(logicalDay(Date.parse("2026-11-12T02:59:00+03:00"))[0]).toBe("2026-11-11");
    expect(logicalDay(Date.parse("2026-11-12T03:00:00+03:00"))[0]).toBe("2026-11-12");
  });
});
