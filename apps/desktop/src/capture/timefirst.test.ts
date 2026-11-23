/** Capture rules from docs/proposals/time-first.md §1 (rules 1–3) and §2. */
import { describe, expect, it } from "vitest";

import { type Op } from "../kernel/db";
import { openTestDb } from "../test/sqlite";
import { affordState, echo, toOps } from "./ops";
import { type ParseOptions, parseCapture } from "./parse";
import { readWhen } from "./when";

const at = (local: string) => Date.parse(`${local}+03:00`);
/** Sunday 15 Nov 2026, 15:12 in Addis Ababa: when the bug was found. */
const sunday = at("2026-11-15T15:12:00");
const epoch = (local: string) => at(`${local}:00`);

const areas = [
  { id: "joba", name: "Job A" },
  { id: "jobb", name: "Job B" },
  { id: "jobhunt", name: "Job hunt" },
  { id: "coding", name: "Coding skills" },
  { id: "gym", name: "Gym" },
];
const accounts = [
  { id: "cash", name: "Cash", kind: "cash", pays_in: 0 },
  { id: "cbo", name: "CBO", kind: "bank", pays_in: 1 },
  { id: "telebirr", name: "telebirr", kind: "mobile", pays_in: 0 },
  { id: "cbo-savings", name: "CBO savings", kind: "bank", pays_in: 0, is_savings: 1 },
  { id: "wise", name: "Wise", kind: "other", pays_in: 0, currency: "USD" },
];

describe("time ranges (rule 1)", () => {
  it("lands 'from 3pm to 4pm' typed at 15:12 on a Sunday on that Sunday", () => {
    const parsed = parseCapture("lets read a book from 3pm to 4pm", { nowMs: sunday });
    expect(parsed).toEqual({
      kind: "task",
      title: "lets read a book",
      dueDate: "2026-11-15",
      dueAt: epoch("2026-11-15T15:00"),
      estimateMin: 60,
    });
    expect(echo(parsed, sunday)).toBe("Task · Today 15:00–16:00");
  });

  it("moves a range to tomorrow only once it has ended", () => {
    const late = at("2026-11-15T16:30:00");
    expect(parseCapture("read from 3pm to 4pm", { nowMs: late })).toMatchObject({
      dueDate: "2026-11-16",
    });
  });

  it.each([
    ["call bank 3-4:30pm", "2026-11-15T15:00", 90],
    ["call bank 3pm-4pm", "2026-11-15T15:00", 60],
    ["call bank 3pm to 4pm", "2026-11-15T15:00", 60],
    ["call bank 11-1pm", "2026-11-16T11:00", 120],
    ["call bank 15:00-16:15", "2026-11-15T15:00", 75],
    ["call bank at 15:00 for 45 min", "2026-11-15T15:00", 45],
    ["call bank at 4pm for 2h", "2026-11-15T16:00", 120],
    ["call bank at 4pm for an hour", "2026-11-15T16:00", 60],
    ["call bank from 9 to 11", "2026-11-16T09:00", 120],
  ])("%j", (text, start, length) => {
    expect(parseCapture(text, { nowMs: sunday })).toMatchObject({
      kind: "task",
      title: "call bank",
      dueAt: epoch(start),
      estimateMin: length,
    });
  });

  it("keeps a marked estimate over the range's length", () => {
    expect(parseCapture("write ~3h tomorrow 3-4pm", { nowMs: sunday })).toMatchObject({
      estimateMin: 180,
      dueDate: "2026-11-16",
    });
  });

  it("leaves bare number ranges alone", () => {
    expect(readWhen("read chapters 3-4", sunday)).toEqual({ rest: "read chapters 3-4" });
    expect(readWhen("pages 10 to 20", sunday)).toEqual({ rest: "pages 10 to 20" });
  });

  it("writes the start and length on the task", () => {
    const [op] = toOps(parseCapture("lets read a book from 3pm to 4pm", { nowMs: sunday }), {
      nowMs: sunday,
      newId: () => "t1",
    });
    expect(op).toMatchObject({
      table: "task_items",
      values: {
        due_date: "2026-11-15",
        due_at: epoch("2026-11-15T15:00"),
        estimate_min: 60,
        status: "todo",
      },
    });
  });
});

describe("parts of the day (rule 2)", () => {
  it.each([
    ["call mom tomorrow morning", "call mom", "2026-11-16", "morning"],
    ["call mom this evening", "call mom", "2026-11-15", "evening"],
    ["call mom tonight", "call mom", "2026-11-15", "evening"],
    ["call mom this afternoon", "call mom", "2026-11-15", "afternoon"],
    ["call mom fri afternoon", "call mom", "2026-11-20", "afternoon"],
    ["call mom in the evening", "call mom", "2026-11-15", "evening"],
    // The morning is over at 15:12: the next one.
    ["call mom in the morning", "call mom", "2026-11-16", "morning"],
    ["call mom morning", "call mom", "2026-11-16", "morning"],
  ])("%j", (text, title, date, window) => {
    const parsed = parseCapture(text, { nowMs: sunday });
    expect(parsed).toMatchObject({ kind: "task", title, dueDate: date, plannedWindow: window });
    expect(parsed).not.toHaveProperty("dueAt");
  });

  it("leaves 'morning' mid-line as a word", () => {
    expect(parseCapture("plan morning routine", { nowMs: sunday })).toMatchObject({
      title: "plan morning routine",
    });
  });

  it("lets a time win over the part of the day", () => {
    const parsed = parseCapture("call mom tomorrow morning at 9", { nowMs: sunday });
    expect(parsed).toMatchObject({ dueAt: epoch("2026-11-16T09:00") });
    expect(parsed).not.toHaveProperty("plannedWindow");
  });

  it("stores planned_window and planned_date, and says it", () => {
    const parsed = parseCapture("call mom tomorrow morning", { nowMs: sunday });
    const [op] = toOps(parsed, { nowMs: sunday, newId: () => "t1" });
    expect(op).toMatchObject({
      values: {
        planned_window: "morning",
        planned_date: "2026-11-16",
        due_date: "2026-11-16",
        due_at: null,
      },
    });
    expect(echo(parsed, sunday)).toBe("Task · Tomorrow morning");
  });

  it("can be stored in the real schema", () => {
    const db = openTestDb();
    const parsed = parseCapture("call mom tonight", { nowMs: sunday });
    insertAll(db, toOps(parsed, { nowMs: sunday, newId: () => "t1" }));
    expect(db.prepare("SELECT planned_window, planned_date FROM task_items").get()).toEqual({
      planned_window: "evening",
      planned_date: "2026-11-15",
    });
  });
});

describe("areas only when named (rule 3)", () => {
  const read = (text: string) => parseCapture(text, { nowMs: sunday, areas });

  it.each([
    ["update CV for job hunt tomorrow", "update CV", "jobhunt"],
    ["fix login bug for job a", "fix login bug", "joba"],
    ["leetcode for coding by fri", "leetcode", "coding"],
    ["standup notes #joba", "standup notes", "joba"],
    ["send report #Job-B", "send report", "jobb"],
  ])("%j", (text, title, area) => {
    expect(read(text)).toMatchObject({ kind: "task", title, area });
  });

  it("guesses nothing from other words", () => {
    expect(read("call bank tomorrow")).not.toHaveProperty("area");
    expect(read("go to the gym tomorrow")).not.toHaveProperty("area");
    expect(read("pay for gym membership tomorrow")).not.toHaveProperty("area");
    expect(read("buy gift for mom tomorrow")).toMatchObject({ title: "buy gift for mom" });
  });

  it("keeps the title whole when one word would be left", () => {
    expect(read("pay for gym")).toMatchObject({ kind: "task", title: "pay for gym", area: "gym" });
  });

  it("makes a named-area line a task even without a verb", () => {
    expect(read("cover letter for job hunt")).toMatchObject({ kind: "task", area: "jobhunt" });
  });
});

describe("several money items on one line", () => {
  const goals = ["laptop"];
  const options: ParseOptions = { nowMs: sunday, accounts, goals };
  const line = "+25000 salary, saved 500 laptop, lent Abel 1500, moved 2000 from cbo to cash";

  it("reads four records and lists them", () => {
    const parsed = parseCapture(line, options);
    expect(parsed).toMatchObject({
      kind: "money",
      items: [
        { kind: "income", amount: 2_500_000, description: "salary", account: "cbo" },
        { kind: "saving", amount: 50_000, goal: "laptop" },
        { kind: "loan", loanKind: "lent", person: "Abel", amount: 150_000 },
        { kind: "transfer", amount: 200_000, from: "cbo", to: "cash" },
      ],
    });
    expect(echo(parsed, sunday)).toBe(
      "4 entries · +25,000 salary, saved 500 laptop, lent Abel 1,500, moved 2,000 CBO → Cash",
    );
  });

  it("saves each as its own record", () => {
    const db = openTestDb();
    db.exec(
      "INSERT INTO savings_goals (id, title, target_minor, start_date, status, created_at, updated_at) VALUES ('g1', 'Laptop', 100000, '2026-11-01', 'active', 0, 0)",
    );
    let n = 0;
    const ops = toOps(parseCapture(line, options), {
      nowMs: sunday,
      newId: () => `id${++n}`,
      goalOf: (words) => (words === "laptop" ? { id: "g1", title: "Laptop" } : null),
    });
    insertAll(db, ops);
    const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    // Pay, the saving's two halves (CBO → CBO savings) and the transfer's two halves.
    expect(count("SELECT COUNT(*) AS n FROM money_txns WHERE origin = 'capture'")).toBe(5);
    expect(count("SELECT COUNT(*) AS n FROM money_loans")).toBe(1);
    expect(
      count(
        "SELECT COUNT(*) AS n FROM savings_entries e JOIN money_txns m ON m.transfer_id = e.transfer_id AND m.account = 'cbo-savings' WHERE e.goal_id = 'g1' AND e.account = 'cbo-savings'",
      ),
    ).toBe(1);
  });

  it("splits on ' and ' too, but not inside a single item", () => {
    expect(parseCapture("lunch 120 and taxi 40", options)).toMatchObject({
      kind: "money",
      items: [{ description: "lunch" }, { description: "taxi" }],
    });
    expect(parseCapture("bread and butter 50", options)).toMatchObject({
      kind: "expense",
      description: "bread and butter",
    });
    expect(parseCapture("call mom and dad tomorrow", options).kind).toBe("task");
  });
});

describe("currencies", () => {
  const options: ParseOptions = {
    nowMs: sunday,
    accounts: [
      ...accounts,
      { id: "revolut", name: "Revolut", kind: "other", pays_in: 0, currency: "EUR" },
      { id: "monzo", name: "Monzo", kind: "other", pays_in: 0, currency: "GBP" },
    ],
  };

  it.each([
    ["lunch $20", "USD", 2_000],
    ["lunch 20 usd", "USD", 2_000],
    ["lunch usd 20", "USD", 2_000],
    ["hosting €50", "EUR", 5_000],
    ["hosting 50 eur", "EUR", 5_000],
    ["book £20", "GBP", 2_000],
    ["book 20 gbp", "GBP", 2_000],
  ])("%j", (text, currency, amount) => {
    expect(parseCapture(text, options)).toMatchObject({ kind: "expense", currency, amount });
  });

  it("uses the account kept in that currency when none is named", () => {
    expect(parseCapture("domain $12", options)).toMatchObject({ account: "wise", currency: "USD" });
  });

  it("takes the currency of @account", () => {
    const parsed = parseCapture("figma 15 @wise", options);
    expect(parsed).toMatchObject({ account: "wise", currency: "USD", amount: 1_500 });
    expect(echo(parsed, sunday)).toBe("$15 · Other · Wise");
    const [op] = toOps(parsed, { nowMs: sunday, newId: () => "m1" });
    expect(op).toMatchObject({ values: { currency: "USD", amount_minor: -1_500 } });
  });

  it("leaves birr unmarked", () => {
    const [op] = toOps(parseCapture("lunch 120", options), { nowMs: sunday, newId: () => "m1" });
    expect(op && "values" in op ? op.values : {}).not.toHaveProperty("currency");
  });

  it("puts the currency on a loan and its money", () => {
    const parsed = parseCapture("lent abel $50", options);
    expect(parsed).toMatchObject({ kind: "loan", currency: "USD", amount: 5_000 });
    let n = 0;
    const ops = toOps(parsed, { nowMs: sunday, newId: () => `l${++n}` });
    expect(ops.map((op) => ("values" in op ? op.values.currency : undefined))).toEqual([
      "USD",
      "USD",
    ]);
    const db = openTestDb();
    insertAll(db, ops);
    expect(db.prepare("SELECT currency FROM money_loans").get()).toEqual({ currency: "USD" });
  });

  it("reads a task with a price in it as typed", () => {
    expect(parseCapture("ask about the $200 refund tomorrow", options)).toMatchObject({
      kind: "task",
      title: "ask about the $200 refund",
    });
  });
});

describe("afford colours", () => {
  it.each([
    ["Fine · 3,000 ETB a day after", "fine"],
    ["Tight for shoes · it's half of what's left", "tight"],
    ["Not now · Wait for next month's pay", "notnow"],
    ["Couldn't work it out.", undefined],
  ])("%j → %j", (answer, state) => {
    expect(affordState(answer)).toBe(state);
  });
});

/** Inserts capture ops the way the Rust writer does, with its timestamps. */
function insertAll(db: ReturnType<typeof openTestDb>, ops: Op[]) {
  for (const op of ops) {
    if (op.op !== "insert") throw new Error(`unexpected ${op.op}`);
    const columns = new Set(
      (db.prepare(`PRAGMA table_info(${op.table})`).all() as { name: string }[]).map((c) => c.name),
    );
    const values: Record<string, string | number | null> = {
      id: op.id,
      ...(op.values as Record<string, string | number | null>),
    };
    if (columns.has("created_at")) values.created_at = 0;
    if (columns.has("updated_at")) values.updated_at = 0;
    const names = Object.keys(values);
    db.prepare(
      `INSERT INTO ${op.table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
    ).run(...Object.values(values));
  }
}

describe("the night after midnight (logical day starts 03:00)", () => {
  /** Monday 16 Nov 00:30: still Sunday's logical day. */
  const lateSunday = at("2026-11-16T00:30:00");

  it("puts 'study 1am-2am' on the logical day it falls in, at the same moment", () => {
    const parsed = parseCapture("study 1am-2am", { nowMs: lateSunday });
    expect(parsed).toMatchObject({
      kind: "task",
      title: "study",
      dueDate: "2026-11-15",
      dueAt: epoch("2026-11-16T01:00"),
      estimateMin: 60,
    });
    expect(echo(parsed, lateSunday)).toBe("Task · Today 01:00–02:00");
  });

  it("reads 'tonight' after midnight as the coming evening", () => {
    expect(parseCapture("read tonight", { nowMs: lateSunday })).toMatchObject({
      dueDate: "2026-11-16",
      plannedWindow: "evening",
    });
  });

  it("keeps a block crossing midnight in one piece", () => {
    const late = at("2026-11-15T22:00:00");
    expect(parseCapture("party 11pm-1am", { nowMs: late })).toMatchObject({
      dueDate: "2026-11-15",
      dueAt: epoch("2026-11-15T23:00"),
      estimateMin: 120,
    });
  });
});

describe("a weekday before a part of the day", () => {
  it("reads 'fri afternoon dentist' as Friday afternoon", () => {
    expect(parseCapture("fri afternoon dentist", { nowMs: sunday })).toMatchObject({
      kind: "task",
      title: "dentist",
      dueDate: "2026-11-20",
      plannedWindow: "afternoon",
    });
  });
});

describe("' and ' inside a several-item line", () => {
  const options: ParseOptions = { nowMs: sunday, accounts };

  it("splits on commas first, and keeps 'salt and pepper' one item", () => {
    expect(parseCapture("salt and pepper 50, coffee 30", options)).toMatchObject({
      kind: "money",
      items: [
        { kind: "expense", description: "salt and pepper", amount: 5_000 },
        { kind: "expense", description: "coffee", amount: 3_000 },
      ],
    });
  });

  it("gives a verbless piece after a loan the loan's verb", () => {
    expect(parseCapture("lent abel 1500 and kebede 200", options)).toMatchObject({
      kind: "money",
      items: [
        { kind: "loan", loanKind: "lent", person: "abel", amount: 150_000 },
        { kind: "loan", loanKind: "lent", person: "kebede", amount: 20_000 },
      ],
    });
  });

  it("keeps a known spending word after a loan an expense", () => {
    expect(parseCapture("lent abel 1500 and lunch 120", options)).toMatchObject({
      kind: "money",
      items: [
        { kind: "loan", loanKind: "lent", person: "abel", amount: 150_000 },
        { kind: "expense", description: "lunch", amount: 12_000 },
      ],
    });
  });
});

describe("a bare part of the day at the end of a line", () => {
  it("leaves a line that is not a task undated", () => {
    expect(parseCapture("good morning", { nowMs: sunday })).not.toHaveProperty("dueDate");
    const movie = parseCapture("watched a movie in the evening", { nowMs: sunday });
    expect(movie).not.toHaveProperty("dueDate");
    expect(movie).not.toHaveProperty("plannedWindow");
  });

  it("still reads it after a task verb or a day", () => {
    expect(parseCapture("call mom in the evening", { nowMs: sunday })).toMatchObject({
      dueDate: "2026-11-15",
      plannedWindow: "evening",
    });
    expect(parseCapture("dentist 20 dec morning", { nowMs: sunday })).toMatchObject({
      title: "dentist",
      dueDate: "2026-12-20",
      plannedWindow: "morning",
    });
    expect(readWhen("evening", sunday).window).toBe("evening");
  });
});
