import { describe, expect, it } from "vitest";

import { openTestDb } from "../../test/sqlite";
import {
  asksToShrink,
  carryOps,
  CHIPS_SQL,
  chipsSince,
  nextDate,
  OPEN_DUE_SQL,
  readSpending,
  REVIEW_SQL,
  sortInboxOps,
} from "./review";

const night = Date.parse("2026-11-11T21:10:00+03:00");

describe("nextDate", () => {
  it("crosses months and years", () => {
    expect(nextDate("2026-11-11")).toBe("2026-11-12");
    expect(nextDate("2026-11-30")).toBe("2026-12-01");
    expect(nextDate("2026-12-31")).toBe("2027-01-01");
  });
});

describe("readSpending", () => {
  it("splits on commas and reads each as spending today", () => {
    const lines = readSpending("lunch 120, taxi 40,  ", night);
    expect(lines.map((l) => [l.text, l.parsed?.amount, l.parsed?.date])).toEqual([
      ["lunch 120", 12000, "2026-11-11"],
      ["taxi 40", 4000, "2026-11-11"],
    ]);
  });

  it("keeps a line it can't read", () => {
    const [line] = readSpending("call mum", night);
    expect(line?.parsed).toBeUndefined();
  });

  it("counts after midnight as the same evening", () => {
    const late = Date.parse("2026-11-12T01:00:00+03:00");
    expect(readSpending("tea 15", late)[0]?.parsed?.date).toBe("2026-11-11");
  });
});

describe("carries", () => {
  it("asks to shrink on the third carry", () => {
    expect([0, 1, 2, 5].map(asksToShrink)).toEqual([false, false, true, true]);
  });

  it("moves tasks to tomorrow and counts the carry", () => {
    expect(carryOps([{ id: "t1", carries: 2 }], "2026-11-12")).toEqual([
      {
        op: "update",
        table: "task_items",
        id: "t1",
        values: { planned_date: "2026-11-12", remind_at: null, carries: 3 },
      },
    ]);
  });
});

describe("sortInboxOps", () => {
  const note = { id: "n1", body: "renew passport" };
  it("turns a note into a task and marks it converted", () => {
    expect(sortInboxOps(note, "task", () => "t1")).toEqual([
      {
        op: "insert",
        table: "task_items",
        id: "t1",
        values: { title: "renew passport", status: "todo", origin: "note:n1" },
      },
      { op: "update", table: "note_items", id: "n1", values: { status: "converted" } },
    ]);
  });
  it("keeps or drops", () => {
    expect(sortInboxOps(note, "note", () => "x")[0]).toMatchObject({
      values: { kind: "note", status: "kept" },
    });
    expect(sortInboxOps(note, "drop", () => "x")[0]).toMatchObject({
      values: { status: "dropped" },
    });
  });
});

describe("queries", () => {
  it("chips need three repeats in the last 60 days", () => {
    const db = openTestDb();
    const add = db.prepare(
      `INSERT INTO money_txns (id, occurred_at, local_date, amount_minor, description, category_id, created_at, updated_at)
       VALUES (?, 0, ?, ?, ?, 'cat_food', 0, 0)`,
    );
    add.run("a", "2026-11-01", -12000, "Lunch");
    add.run("b", "2026-11-05", -12000, "lunch");
    add.run("c", "2026-11-10", -12000, "lunch");
    add.run("d", "2026-11-10", -4000, "taxi");
    add.run("e", "2026-11-10", -4000, "taxi");
    add.run("f", "2026-08-01", -4000, "taxi");
    const chips = db.prepare(CHIPS_SQL).all(chipsSince("2026-11-11"));
    expect(chips.map((c) => [String(c.description).toLowerCase(), c.amount_minor, c.uses])).toEqual(
      [["lunch", -12000, 3]],
    );
  });

  it("lists open tasks due today or before", () => {
    const db = openTestDb();
    const add = db.prepare(
      "INSERT INTO task_items (id, title, status, due_date, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)",
    );
    add.run("old", "old", "todo", "2026-11-09");
    add.run("today", "today", "todo", "2026-11-11");
    add.run("done", "done", "done", "2026-11-11");
    add.run("later", "later", "todo", "2026-11-12");
    expect(
      db
        .prepare(OPEN_DUE_SQL)
        .all("2026-11-11")
        .map((r) => r.id),
    ).toEqual(["old", "today"]);
  });

  it("reads the review row", () => {
    const db = openTestDb();
    db.prepare(
      "INSERT INTO day_reviews (logical_date, status, energy, created_at, updated_at) VALUES ('2026-11-11', 'done', 2, 0, 0)",
    ).run();
    expect(db.prepare(REVIEW_SQL).get("2026-11-11")).toMatchObject({ status: "done", energy: 2 });
  });
});
