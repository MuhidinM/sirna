import { describe, expect, it } from "vitest";

import { learnKey, monthSummary, type TxnRow, txnEditOps, TXNS_SQL } from "../features/money/money";
import { openTestDb } from "../test/sqlite";
import { echo, toOps } from "./ops";
import { type ParseOptions, parseCapture } from "./parse";

const nowMs = Date.parse("2026-11-14T12:00:00+03:00");
const options: ParseOptions = {
  nowMs,
  categories: [
    { id: "cat_food", name: "Food", kind: "expense" },
    { id: "cat_transport", name: "Transport", kind: "expense" },
    { id: "cat_phone", name: "Phone and internet", kind: "expense" },
    { id: "cat_fuel", name: "Fuel", kind: "expense" },
    { id: "cat_salary", name: "Salary", kind: "income" },
    { id: "cat_income", name: "Other income", kind: "income" },
  ],
  jobs: [
    { id: "joba", name: "Job A" },
    { id: "jobb", name: "Job B" },
  ],
  learned: { bajaj: "cat_transport" },
};
const read = (text: string, extra: Partial<ParseOptions> = {}) =>
  parseCapture(text, { ...options, ...extra });

describe("income per job (T-056)", () => {
  it("reads got, received and earned, and names the job", () => {
    expect(read("got 18k job a")).toMatchObject({
      kind: "income",
      amount: 1_800_000,
      jobId: "joba",
      jobName: "Job A",
      categoryId: "cat_salary",
    });
    expect(echo(read("got 18k job a"), nowMs)).toBe("Income · 18,000 ETB · Job A");
    expect(read("got paid 21000 Job B")).toMatchObject({ kind: "income", jobId: "jobb" });
    expect(read("received 3000 tutoring")).toMatchObject({
      kind: "income",
      amount: 300_000,
      categoryId: "cat_income",
    });
    expect(read("earned 1.5k freelance")).toMatchObject({ kind: "income", amount: 150_000 });
    // Not pay: a small unmarked number with no job or pay word.
    expect(read("got 3 tickets for the concert").kind).not.toBe("income");
    expect(read("got 50 birr change")).toMatchObject({ kind: "income", amount: 5_000 });
  });

  it("names the job on salary and + lines too", () => {
    expect(read("salary 25k job b")).toMatchObject({ kind: "income", jobId: "jobb" });
    expect(read("+5000 freelance")).toMatchObject({ kind: "income", categoryId: "cat_income" });
    expect(read("+5000 freelance")).not.toHaveProperty("jobId");
  });

  it("writes the job on the entry", () => {
    const [op] = toOps(read("got 18k job a"), { nowMs, newId: () => "m1" });
    expect(op).toMatchObject({
      op: "insert",
      table: "money_txns",
      values: { amount_minor: 1_800_000, area_id: "joba", category_id: "cat_salary" },
    });
  });
});

describe("several items on one line (T-056)", () => {
  it("splits on commas when every piece is money", () => {
    const parsed = read("lunch 120, taxi 40");
    expect(parsed).toMatchObject({
      kind: "money",
      items: [
        { kind: "expense", description: "lunch", amount: 12_000, categoryId: "cat_food" },
        { kind: "expense", description: "taxi", amount: 4_000, categoryId: "cat_transport" },
      ],
    });
    expect(echo(parsed, nowMs)).toBe("2 entries · lunch 120, taxi 40 · 160 ETB out");
    let n = 0;
    expect(toOps(parsed, { nowMs, newId: () => `m${++n}` }).map((op) => op.id)).toEqual([
      "m1",
      "m2",
    ]);
  });

  it("keeps a thousands comma and lines that aren't all money", () => {
    expect(read("rent 1,200")).toMatchObject({ kind: "expense", amount: 120_000 });
    expect(read("lunch 120, call mom").kind).not.toBe("money");
    expect(read("t: buy bread, milk").kind).toBe("task");
  });
});

describe("the category a line lands in (T-056)", () => {
  it("takes a #tag that names a category, by name or first word", () => {
    const fuel = read("benzine 500 #fuel");
    expect(fuel).toMatchObject({ kind: "expense", categoryId: "cat_fuel", categoryName: "Fuel" });
    expect(fuel).not.toHaveProperty("area");
    expect(read("card 100 #phone")).toMatchObject({ categoryId: "cat_phone" });
    expect(echo(read("benzine 500 #fuel"), nowMs)).toBe("500 ETB · Fuel");
  });

  it("keeps a #tag that isn't a category as the area", () => {
    expect(read("lunch 120 #jobhunt")).toMatchObject({ categoryId: "cat_food", area: "jobhunt" });
  });

  it("remembers a category you corrected, and a tag still wins", () => {
    expect(read("bajaj 50")).toMatchObject({ categoryId: "cat_transport" });
    expect(read("Bajaj 50 #food")).toMatchObject({ categoryId: "cat_food" });
    // A remembered category that was since removed is ignored.
    expect(read("bajaj 50", { learned: { bajaj: "cat_gone" } }).kind).toBe("expense");
    expect(read("bajaj 50", { learned: { bajaj: "cat_gone" } })).not.toMatchObject({
      categoryId: "cat_gone",
    });
  });
});

describe("learning from the ledger (T-056)", () => {
  const row: TxnRow = {
    id: "t",
    local_date: "2026-11-14",
    occurred_at: 0,
    amount_minor: -5_000,
    description: "Bajaj",
    category_id: "cat_other",
    category: "Other",
    account: "cash",
    origin: "capture",
  };
  const draft = {
    kind: "out" as const,
    amount: 5_000,
    description: " Bajaj ",
    categoryId: "cat_transport",
    date: "2026-11-14",
  };

  it("remembers a new category for that description", () => {
    expect(txnEditOps(row, draft)[0]).toEqual({
      op: "upsert",
      table: "money_learned",
      id: "bajaj",
      values: { category_id: "cat_transport" },
    });
    expect(learnKey(" Bajaj ")).toBe("bajaj");
    // Same category: nothing to learn.
    expect(txnEditOps(row, { ...draft, categoryId: "cat_other" })).toHaveLength(1);
  });

  it("groups income by job on the Money page", () => {
    const db = openTestDb();
    const add = db.prepare(
      "INSERT INTO money_txns (id, occurred_at, local_date, amount_minor, description, category_id, area_id, created_at, updated_at) VALUES (?, 0, '2026-11-10', ?, ?, 'cat_salary', ?, 0, 0)",
    );
    db.prepare(
      "INSERT INTO area_items (id, name, kind, color, priority_rank, created_at, updated_at) VALUES ('joba', 'Job A', 'work', 'work', 1, 0, 0) ON CONFLICT(id) DO NOTHING",
    ).run();
    add.run("a", 1_800_000, "job a", "joba");
    add.run("b", 50_000, "gift", null);
    const txns = db.prepare(TXNS_SQL).all("2026-11-01", "2026-11-30") as unknown as TxnRow[];
    const summary = monthSummary({ txns, saved: 0, history: [], today: "2026-11-14" });
    expect(summary.sources.map((source) => source.name)).toContain(
      (db.prepare("SELECT name FROM area_items WHERE id = 'joba'").get() as { name: string }).name,
    );
    expect(summary.sources.map((source) => source.name)).toContain("Salary");
  });
});
