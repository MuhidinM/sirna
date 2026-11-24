import { type DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { type Op } from "../../kernel/db";
import { openTestDb } from "../../test/sqlite";
import { loadMoneyContext } from "../money/parseContext";
import { type Query } from "../projects/capacity";
import {
  asksToShrink,
  carryOps,
  CHIPS_SQL,
  chipOps,
  chipsSince,
  finishOps,
  INBOX_COUNT_SQL,
  INBOX_TWO_SQL,
  inboxBadge,
  nextDate,
  OPEN_DUE_SQL,
  readSpending,
  REVIEW_SQL,
  sortInbox,
  sortInboxOps,
  SPENT_LIST_SQL,
} from "./review";

const night = Date.parse("2026-11-11T21:10:00+03:00");

type Input = string | number | null;

/** Applies ops the way tx.rs does, enough to check them against the schema. */
function apply(db: DatabaseSync, ops: Op[]) {
  for (const op of ops) {
    if (op.op === "insert") {
      const values = { id: op.id, ...op.values, created_at: 0, updated_at: 0 };
      const names = Object.keys(values);
      db.prepare(
        `INSERT INTO ${op.table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
      ).run(...(Object.values(values) as Input[]));
    } else if (op.op === "update") {
      const names = Object.keys(op.values);
      db.prepare(
        `UPDATE ${op.table} SET ${names.map((n) => `${n} = ?`).join(", ")} WHERE id = ?`,
      ).run(...(Object.values(op.values) as Input[]), op.id);
    } else if (op.op === "delete") {
      db.prepare(`UPDATE ${op.table} SET deleted_at = 1 WHERE id = ?`).run(op.id);
    }
  }
}

describe("nextDate", () => {
  it("crosses months and years", () => {
    expect(nextDate("2026-11-11")).toBe("2026-11-12");
    expect(nextDate("2026-11-30")).toBe("2026-12-01");
    expect(nextDate("2026-12-31")).toBe("2027-01-01");
  });
});

describe("readSpending", () => {
  it("splits on commas and reads each as spending today", () => {
    const lines = readSpending("lunch 120, taxi 40,  ", { nowMs: night });
    expect(lines.map((l) => [l.text, l.parsed?.amount, l.parsed?.date])).toEqual([
      ["lunch 120", 12000, "2026-11-11"],
      ["taxi 40", 4000, "2026-11-11"],
    ]);
  });

  it("keeps a line it can't read", () => {
    const [line] = readSpending("call mum", { nowMs: night });
    expect(line?.parsed).toBeUndefined();
  });

  it("reads @account and currency as the capture bar does (F3)", async () => {
    const db = openTestDb();
    const query: Query = (sql, params = []) =>
      Promise.resolve(db.prepare(sql).all(...params) as never);
    const context = await loadMoneyContext(query);
    const lines = readSpending("taxi 40 @telebirr, kitfo 300, coffee $3", {
      nowMs: night,
      ...context,
    });
    expect(
      lines.map((l) => [l.parsed?.description, l.parsed?.account, l.parsed?.currency]),
    ).toEqual([
      ["taxi", "telebirr", undefined],
      ["kitfo", "cash", undefined],
      ["coffee", "wise", "USD"],
    ]);
    // Toss away the dollar account: "$3" can't land on birr Cash.
    db.exec("UPDATE money_accounts SET deleted_at = 1 WHERE id = 'wise'");
    const [coffee] = readSpending("coffee $3", {
      nowMs: night,
      ...(await loadMoneyContext(query)),
    });
    expect(coffee?.parsed).toBeUndefined();
    expect(coffee?.why).toMatch(/USD/);
  });

  it("counts after midnight as the same evening", () => {
    const late = Date.parse("2026-11-12T01:00:00+03:00");
    expect(readSpending("tea 15", { nowMs: late })[0]?.parsed?.date).toBe("2026-11-11");
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

  it("can be taken back: the note returns to the inbox, a new task goes", () => {
    const back = {
      op: "update",
      table: "note_items",
      id: "n1",
      values: { kind: "inbox", status: "inbox" },
    };
    expect(sortInbox(note, "drop", () => "x").undo).toEqual([back]);
    expect(sortInbox(note, "note", () => "x").undo).toEqual([back]);
    expect(sortInbox(note, "task", () => "t1").undo).toEqual([
      { op: "delete", table: "task_items", id: "t1" },
      back,
    ]);
  });

  it("applied and undone, leaves the note a loose end again", () => {
    const db = openTestDb();
    db.exec(
      "INSERT INTO note_items (id, kind, status, body, created_at, updated_at) VALUES ('n1', 'inbox', 'inbox', 'renew passport', 0, 0)",
    );
    const sorted = sortInbox(note, "task", () => "t1");
    apply(db, sorted.ops);
    expect(db.prepare(INBOX_COUNT_SQL).get()).toEqual({ n: 0 });
    apply(db, sorted.undo);
    expect(db.prepare(INBOX_COUNT_SQL).get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT deleted_at FROM task_items WHERE id = 't1'").get()).not.toEqual({
      deleted_at: null,
    });
  });
});

describe("loose ends badge", () => {
  it("counts every loose end, while two show", () => {
    const db = openTestDb();
    const add = db.prepare(
      "INSERT INTO note_items (id, kind, status, body, created_at, updated_at) VALUES (?, 'inbox', 'inbox', ?, ?, 0)",
    );
    ["a", "b", "c", "d", "e"].forEach((id, index) => add.run(id, id, index));
    expect(db.prepare(INBOX_TWO_SQL).all()).toHaveLength(2);
    expect(db.prepare(INBOX_COUNT_SQL).get()).toEqual({ n: 5 });
    expect(inboxBadge(2, 5)).toBe("2 of 5");
    expect(inboxBadge(2, 2)).toBe("2");
  });
});

describe("carrying a timed task (an appointment)", () => {
  // 'call bank at 2pm' on Tue 24 Nov: due 24 Nov, starts 14:00.
  const two = Date.parse("2026-11-24T14:00:00+03:00");
  it("moves it whole to the same time tomorrow", () => {
    expect(carryOps([{ id: "bank", carries: 0, due_at: two }], "2026-11-25")).toEqual([
      {
        op: "update",
        table: "task_items",
        id: "bank",
        values: {
          planned_date: "2026-11-25",
          due_date: "2026-11-25",
          due_at: two + 24 * 60 * 60 * 1000,
          remind_at: two + 24 * 60 * 60 * 1000,
          carries: 1,
        },
      },
    ]);
  });

  it("keeps an older time as a deadline (T-050)", () => {
    const yesterday = Date.parse("2026-11-23T14:00:00+03:00");
    expect(carryOps([{ id: "old", carries: 1, due_at: yesterday }], "2026-11-25")).toEqual([
      {
        op: "update",
        table: "task_items",
        id: "old",
        values: { planned_date: "2026-11-25", remind_at: null, carries: 2 },
      },
    ]);
  });
});

describe("finishing the review", () => {
  const blocks = [
    { id: "rv", kind: "routine", area_id: null, title: "Night review", status: "planned" },
    { id: "gym", kind: "routine", area_id: "gym", title: "Gym", status: "planned" },
  ];
  it("marks tonight's Night review block done with the row", () => {
    expect(finishOps("2026-11-24", { status: "done" }, blocks)).toEqual([
      { op: "upsert", table: "day_reviews", id: "2026-11-24", values: { status: "done" } },
      { op: "update", table: "day_blocks", id: "rv", values: { status: "done" } },
    ]);
  });

  it("leaves the block alone when the review is skipped", () => {
    expect(finishOps("2026-11-24", { status: "skipped" }, blocks)).toHaveLength(1);
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

  it("keeps each expense and chip in its own currency and account (F3, F4)", () => {
    const db = openTestDb();
    const add = db.prepare(
      `INSERT INTO money_txns (id, account, occurred_at, local_date, amount_minor, description, category_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'cat_food', 0, 0)`,
    );
    add.run("a", "wise", 1, "2026-11-11", -500, "netflix");
    add.run("b", "wise", 2, "2026-11-04", -500, "netflix");
    add.run("c", "wise", 3, "2026-10-28", -500, "netflix");
    add.run("d", "cash", 4, "2026-11-11", -500, "netflix");
    expect(db.prepare(SPENT_LIST_SQL).all("2026-11-11")).toEqual([
      { id: "d", description: "netflix", amount_minor: -500, currency: "ETB" },
      { id: "a", description: "netflix", amount_minor: -500, currency: "USD" },
    ]);
    const [chip, ...rest] = db.prepare(CHIPS_SQL).all(chipsSince("2026-11-11")) as {
      description: string;
      amount_minor: number;
      category_id: string | null;
      account: string;
      currency: string;
    }[];
    expect(rest).toEqual([]);
    expect(chip).toMatchObject({ account: "wise", currency: "USD", amount_minor: -500 });
    if (!chip) throw new Error("no chip");
    expect(chipOps(chip, "2026-11-11", 9, "e")[0]).toMatchObject({
      values: { account: "wise", currency: "USD", amount_minor: -500 },
    });
  });

  it("makes one chip per item, at its most used price", () => {
    const db = openTestDb();
    const add = db.prepare(
      `INSERT INTO money_txns (id, occurred_at, local_date, amount_minor, description, category_id, created_at, updated_at)
       VALUES (?, ?, '2026-11-05', ?, 'lunch', 'cat_food', 0, 0)`,
    );
    add.run("a", 1, -12000);
    add.run("b", 2, -15000);
    add.run("c", 3, -15000);
    add.run("d", 4, -17000);
    const chips = db.prepare(CHIPS_SQL).all(chipsSince("2026-11-11"));
    expect(chips.map((c) => [c.description, c.amount_minor, c.uses])).toEqual([
      ["lunch", -15000, 4],
    ]);
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
