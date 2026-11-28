// The unit tests of src-tauri/src/tx.rs, run against the dev harness port.
import { describe, expect, it } from "vitest";

import { openTestDb } from "../test/sqlite";
import { type Conn, nodeConn } from "./conn";
import { applyOps, type Op, parseOps, rowJson, spec, TABLES, undoContext, type Values } from "./tx";

const conn = (): Conn => nodeConn(openTestDb());

const insertTask = (c: Conn, id: string, title: string) =>
  applyOps(
    c,
    "user",
    "capture:1",
    [{ op: "insert", table: "task_items", id, values: { title } }],
    100,
  );

const task = (c: Conn, id: string) => {
  const row = rowJson(c, spec("task_items"), id);
  if (!row) throw new Error(`no task ${id}`);
  return row;
};

describe("tx port", () => {
  it("allowlists only columns the schema has", () => {
    const c = conn();
    for (const table of TABLES) {
      const names = new Set(
        c.all(`PRAGMA table_info(${table.name})`).map((column) => String(column.name)),
      );
      expect(names.size, table.name).toBeGreaterThan(0);
      for (const column of table.columns)
        expect(names.has(column), `${table.name}.${column}`).toBe(true);
    }
  });

  it("parses ops as the webview sends them", () => {
    expect(
      parseOps("db_tx", [
        { op: "insert", table: "task_items", id: "01T", values: { title: "Call bank" } },
      ]),
    ).toEqual([{ op: "insert", table: "task_items", id: "01T", values: { title: "Call bank" } }]);
    expect(() => parseOps("db_tx", [{ op: "insert", table: "task_items", id: "x" }])).toThrow();
  });

  it("insert stamps times and logs the row", () => {
    const c = conn();
    insertTask(c, "t1", "Call bank");
    const row = task(c, "t1");
    expect(row.title).toBe("Call bank");
    expect(row.created_at).toBe(100);
    expect(row.status).toBe("todo");
    const [log] = c.all("SELECT action, after_json FROM core_activity WHERE entity_id = 't1'");
    expect(log?.action).toBe("insert");
    expect(String(log?.after_json)).toContain("Call bank");
    // serde_json (no preserve_order) writes keys sorted.
    const keys = Object.keys(JSON.parse(String(log?.after_json)) as object);
    expect(keys).toEqual([...keys].sort());
  });

  it("rejects unknown tables and columns", () => {
    const c = conn();
    expect(() =>
      applyOps(c, "user", null, [{ op: "insert", table: "core_activity", id: "x", values: {} }], 1),
    ).toThrow("table not writable: core_activity");
    expect(() =>
      applyOps(
        c,
        "user",
        null,
        [{ op: "insert", table: "task_items", id: "x", values: { title: "x", created_at: 5 } }],
        1,
      ),
    ).toThrow("column not writable: task_items.created_at");
  });

  it("rejects nested values", () => {
    expect(() =>
      applyOps(
        conn(),
        "user",
        null,
        [{ op: "insert", table: "task_items", id: "x", values: { title: ["a"] } }],
        1,
      ),
    ).toThrow("value for title must be text, a number, a boolean or null");
  });

  it("a user update marks the row as user edited", () => {
    const c = conn();
    insertTask(c, "t1", "Call bank");
    applyOps(
      c,
      "user",
      null,
      [{ op: "update", table: "task_items", id: "t1", values: { title: "Call CBE" } }],
      200,
    );
    const row = task(c, "t1");
    expect([row.title, row.user_edited_at, row.updated_at]).toEqual(["Call CBE", 200, 200]);
  });

  it("a parser update does not mark user edited", () => {
    const c = conn();
    insertTask(c, "t1", "Call bank");
    applyOps(
      c,
      "parser:capture@1",
      null,
      [{ op: "update", table: "task_items", id: "t1", values: { notes: "x" } }],
      200,
    );
    expect(task(c, "t1").user_edited_at).toBeNull();
  });

  it("delete is soft", () => {
    const c = conn();
    insertTask(c, "t1", "Call bank");
    applyOps(c, "user", null, [{ op: "delete", table: "task_items", id: "t1" }], 300);
    expect(task(c, "t1").deleted_at).toBe(300);
  });

  it("updating a missing row fails", () => {
    expect(() =>
      applyOps(
        conn(),
        "user",
        null,
        [{ op: "update", table: "task_items", id: "nope", values: {} }],
        1,
      ),
    ).toThrow("no task_items row with id nope");
  });

  it("undo reverses a capture", () => {
    const c = conn();
    insertTask(c, "t1", "Call bank");
    expect(undoContext(c, "user", "capture:1", 500)).toEqual({ changes: 1, kept: 0 });
    expect(task(c, "t1").deleted_at).toBe(500);
  });

  it("undo restores an update", () => {
    const c = conn();
    insertTask(c, "t1", "Call bank");
    applyOps(
      c,
      "user",
      "capture:2",
      [{ op: "update", table: "task_items", id: "t1", values: { title: "Wrong" } }],
      200,
    );
    undoContext(c, "user", "capture:2", 300);
    const row = task(c, "t1");
    expect([row.title, row.deleted_at]).toEqual(["Call bank", null]);
  });

  const update = (c: Conn, context: string, values: Values, at: number) =>
    applyOps(c, "user", context, [{ op: "update", table: "task_items", id: "t1", values }], at);

  it("undoing an old update keeps a newer edit to another column", () => {
    const c = conn();
    insertTask(c, "t1", "Call bank");
    update(c, "edit:1", { title: "Call the bank" }, 200);
    update(c, "edit:2", { status: "done" }, 300);
    expect(undoContext(c, "user", "edit:1", 400)).toEqual({ changes: 1, kept: 0 });
    const row = task(c, "t1");
    expect([row.title, row.status]).toEqual(["Call bank", "done"]);
  });

  it("undo keeps a column edited again since", () => {
    const c = conn();
    insertTask(c, "t1", "Call bank");
    update(c, "edit:1", { title: "Wrong", status: "done" }, 200);
    update(c, "edit:2", { title: "Call bank today" }, 300);
    expect(undoContext(c, "user", "edit:1", 400)).toEqual({ changes: 1, kept: 1 });
    const row = task(c, "t1");
    expect(row.title).toBe("Call bank today");
    expect(row.status).not.toBe("done");
  });

  it("undo restores a delete", () => {
    const c = conn();
    insertTask(c, "t1", "Call bank");
    applyOps(c, "user", "edit:1", [{ op: "delete", table: "task_items", id: "t1" }], 200);
    expect(task(c, "t1").deleted_at).toBe(200);
    undoContext(c, "user", "edit:1", 300);
    expect(task(c, "t1").deleted_at).toBeNull();
  });

  it("settings upsert by key", () => {
    const c = conn();
    applyOps(
      c,
      "user",
      null,
      [
        {
          op: "insert",
          table: "core_settings",
          id: "capture.at3",
          values: { value_json: '"15:00"' },
        },
      ],
      1,
    );
    expect(
      c.all("SELECT value_json FROM core_settings WHERE key = 'capture.at3'")[0]?.value_json,
    ).toBe('"15:00"');
  });

  it("upsert inserts then updates", () => {
    const c = conn();
    const set = (value: string): Op => ({
      op: "upsert",
      table: "core_settings",
      id: "ui.theme",
      values: { value_json: value },
    });
    const before = Number(c.all("SELECT count(*) AS n FROM core_settings")[0]?.n);
    applyOps(c, "user", null, [set('"dark"')], 1);
    applyOps(c, "user", null, [set('"light"')], 2);
    expect(
      c.all("SELECT value_json FROM core_settings WHERE key = 'ui.theme'")[0]?.value_json,
    ).toBe('"light"');
    expect(Number(c.all("SELECT count(*) AS n FROM core_settings")[0]?.n)).toBe(before + 1);
  });

  it("upsert revives a soft-deleted row", () => {
    const c = conn();
    const put = (summary: string): Op => ({
      op: "upsert",
      table: "cal_occurrences",
      id: "e|1",
      values: {
        ical_uid: "e",
        summary,
        start_at: 1,
        end_at: 2,
        local_date: "2026-11-12",
        all_day: 0,
      },
    });
    const deleted = () =>
      c.all("SELECT deleted_at FROM cal_occurrences WHERE id = 'e|1'")[0]?.deleted_at;
    applyOps(c, "system", null, [put("A")], 1);
    applyOps(c, "system", null, [{ op: "delete", table: "cal_occurrences", id: "e|1" }], 2);
    expect(deleted()).toBe(2);
    applyOps(c, "system", null, [put("B")], 3);
    expect(deleted()).toBeNull();
  });

  it("areas and routine blocks are writable", () => {
    const c = conn();
    applyOps(
      c,
      "user",
      "setup",
      [
        { op: "update", table: "area_items", id: "coding", values: { weekly_target_min: 300 } },
        {
          op: "insert",
          table: "routine_blocks",
          id: "b1",
          values: {
            weekday: 1,
            start_min: 360,
            duration_min: 20,
            kind: "routine",
            area_id: "quran",
            title: "Quran",
          },
        },
      ],
      1,
    );
    expect(
      c.all("SELECT weekly_target_min FROM area_items WHERE id = 'coding'")[0]?.weekly_target_min,
    ).toBe(300);
  });

  it("a failed op inside a command leaves nothing behind", async () => {
    const { dbTx } = await import("./commands");
    const c = conn();
    expect(() =>
      dbTx(
        c,
        {
          actor: "user",
          ops: [
            { op: "insert", table: "task_items", id: "ok", values: { title: "fine" } },
            { op: "update", table: "task_items", id: "missing", values: { title: "x" } },
          ],
        },
        1,
      ),
    ).toThrow("no task_items row with id missing");
    expect(c.all("SELECT id FROM task_items WHERE id = 'ok'")).toEqual([]);
  });
});
