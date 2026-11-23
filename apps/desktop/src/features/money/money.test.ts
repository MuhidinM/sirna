import { describe, expect, it } from "vitest";

import { openTestDb } from "../../test/sqlite";
import {
  byDay,
  checkTxn,
  filterLedger,
  HISTORY_SQL,
  historyParams,
  median,
  monthOf,
  moneyLine,
  monthSummary,
  SAVED_SQL,
  toCsv,
  type TxnRow,
  txnDeleteOps,
  txnEditOps,
  txnRestoreOps,
  TXNS_SQL,
  usualByCategory,
} from "./money";

const row = (over: Partial<TxnRow>): TxnRow => ({
  id: "x",
  local_date: "2026-11-10",
  occurred_at: 0,
  amount_minor: -12000,
  description: "lunch",
  category_id: "cat_food",
  category: "Food",
  account: "cash",
  origin: "capture",
  ...over,
});

describe("months", () => {
  it("knows each month's days, leap years included", () => {
    expect(monthOf("2026-11-14")).toEqual({
      from: "2026-11-01",
      to: "2026-11-30",
      days: 30,
      key: "2026-11",
    });
    expect(monthOf("2028-02-03").days).toBe(29);
    expect(historyParams("2026-01-20")).toEqual(["2025-10-01", "2026-01-01"]);
  });
});

describe("the month at a glance", () => {
  const txns = [
    row({
      id: "pay",
      amount_minor: 1_800_000,
      description: "salary",
      category: "Salary",
      category_id: "cat_salary",
    }),
    row({
      id: "side",
      amount_minor: 500_000,
      description: "freelance",
      category: "Other income",
      category_id: "cat_income",
    }),
    row({ id: "l1", amount_minor: -12_000 }),
    row({ id: "l2", amount_minor: -18_000 }),
    row({
      id: "rent",
      amount_minor: -600_000,
      description: "rent",
      category: "Housing",
      category_id: "cat_housing",
    }),
  ];

  it("adds in, out, saved and what is left, with a rounded-down daily figure", () => {
    const summary = monthSummary({ txns, saved: 200_000, history: [], today: "2026-11-14" });
    expect(summary).toMatchObject({ in: 2_300_000, out: 630_000, saved: 200_000, left: 1_470_000 });
    // 14,700 birr over 17 days left (14th to 30th) = 864.70 → 864.
    expect(summary.perDay).toBe(86_400);
    expect(summary.sources).toEqual([
      { name: "Salary", amount: 1_800_000 },
      { name: "Other income", amount: 500_000 },
    ]);
    expect(summary.categories.map((c) => [c.name, c.spent, c.usual])).toEqual([
      ["Housing", 600_000, null],
      ["Food", 30_000, null],
    ]);
  });

  it("compares each category with your usual month (the median)", () => {
    const history = [
      { month: "2026-08", category_id: "cat_food", out_minor: 40_000 },
      { month: "2026-09", category_id: "cat_food", out_minor: 90_000 },
      { month: "2026-10", category_id: "cat_food", out_minor: 50_000 },
      { month: "2026-10", category_id: "cat_transport", out_minor: 10_000 },
    ];
    expect(usualByCategory(history).get("cat_food")).toBe(50_000);
    // No transport in Aug and Sep counts as 0 there.
    expect(usualByCategory(history).get("cat_transport")).toBe(0);
    const summary = monthSummary({ txns, saved: 0, history, today: "2026-11-14" });
    expect(summary.categories.find((c) => c.name === "Housing")?.usual).toBe(0);
    expect(summary.categories.find((c) => c.name === "Food")?.usual).toBe(50_000);
    expect([median([]), median([3]), median([1, 9, 4, 6])]).toEqual([null, 3, 4]);
  });

  it("says when the month is over, and has no daily figure then", () => {
    const summary = monthSummary({
      txns: [row({ amount_minor: -50_000 })],
      saved: 0,
      history: [],
      today: "2026-11-30",
    });
    expect(summary.left).toBe(-50_000);
    expect(summary.perDay).toBeNull();
    expect(moneyLine(summary, 12_000)).toBe("Spent 120 today · 500 over this month");
  });

  it("writes Today's line", () => {
    const summary = monthSummary({ txns, saved: 200_000, history: [], today: "2026-11-14" });
    expect(moneyLine(summary, 30_000)).toBe(
      "Spent 300 today · 14,700 left this month · about 864 a day",
    );
    const empty = monthSummary({ txns: [], saved: 0, history: [], today: "2026-11-14" });
    expect(moneyLine(empty, 0)).toBe("Spent 0 today");
  });
});

describe("the ledger", () => {
  const rows = [
    row({ id: "a", local_date: "2026-11-12", description: "lunch at Kaldis" }),
    row({
      id: "b",
      local_date: "2026-11-12",
      amount_minor: 1_800_000,
      description: "salary",
      category_id: "cat_salary",
      category: "Salary",
    }),
    row({
      id: "c",
      local_date: "2026-11-13",
      description: "taxi",
      category_id: "cat_transport",
      category: "Transport",
    }),
  ];

  it("filters by words, category and in or out", () => {
    const f = (over: Partial<Parameters<typeof filterLedger>[1]>) =>
      filterLedger(rows, { text: "", categoryId: "", kind: "", ...over }).map((r) => r.id);
    expect(f({ text: "kaldis" })).toEqual(["a"]);
    expect(f({ text: "transport" })).toEqual(["c"]);
    expect(f({ categoryId: "cat_food" })).toEqual(["a"]);
    expect(f({ kind: "in" })).toEqual(["b"]);
    expect(f({ kind: "out" })).toEqual(["a", "c"]);
  });

  it("groups by day with the day's net", () => {
    expect(byDay(rows).map((d) => [d.date, d.rows.length, d.net])).toEqual([
      ["2026-11-13", 1, -12_000],
      ["2026-11-12", 2, 1_788_000],
    ]);
  });

  it("edits, deletes and puts back an entry", () => {
    const db = openTestDb();
    db.prepare(
      "INSERT INTO money_txns (id, occurred_at, local_date, amount_minor, description, category_id, origin, created_at, updated_at) VALUES ('a', 5, '2026-11-12', -12000, 'lunch', 'cat_food', 'capture', 0, 0)",
    ).run();
    const [stored] = db.prepare(TXNS_SQL).all("2026-11-01", "2026-11-30") as unknown as TxnRow[];
    if (!stored) throw new Error("no row");
    const draft = {
      kind: "out" as const,
      amount: 15_000,
      description: " lunch ",
      categoryId: "cat_food",
      date: "2026-11-11",
    };
    expect(checkTxn(draft)).toBeNull();
    expect(checkTxn({ ...draft, amount: 0 })).toMatch(/above zero/);
    expect(txnEditOps(stored, draft)[0]).toMatchObject({
      op: "update",
      values: { amount_minor: -15_000, description: "lunch", local_date: "2026-11-11" },
    });
    expect(txnEditOps(stored, { ...draft, kind: "in" })[0]).toMatchObject({
      values: { amount_minor: 15_000 },
    });
    expect(txnDeleteOps(stored)).toEqual([{ op: "delete", table: "money_txns", id: "a" }]);
    expect(txnRestoreOps(stored)[0]).toMatchObject({
      op: "upsert",
      id: "a",
      values: { amount_minor: -12000, occurred_at: 5, local_date: "2026-11-12", origin: "capture" },
    });
  });

  it("exports CSV in birr, oldest first, quoting what needs it", () => {
    const csv = toCsv([
      row({
        id: "a",
        local_date: "2026-11-12",
        amount_minor: -12_050,
        description: 'lunch, "big"',
      }),
      row({
        id: "b",
        local_date: "2026-11-11",
        amount_minor: 1_800_000,
        description: "salary",
        category: "Salary",
      }),
    ]);
    expect(csv).toBe(
      [
        "date,kind,amount,currency,category,description,account",
        "2026-11-11,in,18000.00,ETB,Salary,salary,cash",
        '2026-11-12,out,120.50,ETB,Food,"lunch, ""big""",cash',
        "",
      ].join("\n"),
    );
  });
});

describe("the queries", () => {
  it("read this month, the history and savings", () => {
    const db = openTestDb();
    const add = db.prepare(
      "INSERT INTO money_txns (id, occurred_at, local_date, amount_minor, description, category_id, created_at, updated_at, deleted_at) VALUES (?, 0, ?, ?, ?, ?, 0, 0, ?)",
    );
    add.run("now", "2026-11-03", -5000, "tea", "cat_food", null);
    add.run("gone", "2026-11-04", -9000, "x", "cat_food", 1);
    add.run("oct", "2026-10-20", -7000, "bus", "cat_transport", null);
    add.run("octpay", "2026-10-21", 9000, "pay", "cat_salary", null);
    expect(
      (db.prepare(TXNS_SQL).all("2026-11-01", "2026-11-30") as unknown as TxnRow[]).map(
        (r) => r.id,
      ),
    ).toEqual(["now"]);
    expect(db.prepare(HISTORY_SQL).all(...historyParams("2026-11-14"))).toEqual([
      { month: "2026-10", category_id: "cat_salary", out_minor: 0, currency: "ETB" },
      { month: "2026-10", category_id: "cat_transport", out_minor: 7000, currency: "ETB" },
    ]);
    db.prepare(
      "INSERT INTO savings_entries (id, occurred_at, local_date, amount_minor, created_at, updated_at) VALUES ('s', 0, '2026-11-05', 30000, 0, 0)",
    ).run();
    expect(db.prepare(SAVED_SQL).get("2026-11-01", "2026-11-30")).toEqual({ minor: 30000 });
  });
});
