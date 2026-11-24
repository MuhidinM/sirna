/**
 * Money capture across currencies and savings (time-first §3–§4): an entry's
 * currency is always its account's, transfers convert at the saved rate, and
 * saving from the capture box is Put aside.
 */
import { describe, expect, it } from "vitest";

import { type Op } from "../kernel/db";
import { ACCOUNTS_SQL } from "../features/money/accounts";
import { SAVINGS_TRANSFERS_SQL } from "../features/savings/savings";
import { openTestDb } from "../test/sqlite";
import { echo, type SavingGoal, toOps } from "./ops";
import { type ParseOptions, parseCapture } from "./parse";

const nowMs = Date.parse("2026-11-23T12:00:00+03:00");
const TODAY = "2026-11-23";
const rates = { USD: { rate: "132.50", set_on: TODAY } };

type Db = ReturnType<typeof openTestDb>;
type AccountOption = NonNullable<ParseOptions["accounts"]>[number];

/** The accounts as the capture box loads them (CBO, Cash, CBO savings, Wise in USD…). */
function accountsOf(db: Db): AccountOption[] {
  return db
    .prepare(
      "SELECT id, name, kind, pays_in, currency, is_savings FROM money_accounts WHERE deleted_at IS NULL ORDER BY sort_order",
    )
    .all() as unknown as AccountOption[];
}

function setup(extra: Partial<ParseOptions> = {}) {
  const db = openTestDb();
  db.exec(
    "INSERT INTO savings_goals (id, title, target_minor, start_date, status, created_at, updated_at) VALUES ('g1', 'Laptop', 10000000, '2026-11-01', 'active', 0, 0)",
  );
  const options: ParseOptions = {
    nowMs,
    accounts: accountsOf(db),
    goals: ["laptop"],
    rates,
    ...extra,
  };
  let n = 0;
  const save = (text: string, goal: SavingGoal | null = null) => {
    const parsed = parseCapture(text, options);
    const ops = toOps(parsed, {
      nowMs,
      newId: () => `${text.replace(/\W+/g, "")}-${++n}`,
      goalOf: () => goal,
      savingGoal: goal,
    });
    insertAll(db, ops);
    return { parsed, ops, echo: echo(parsed, nowMs, undefined, goal) };
  };
  return { db, options, save };
}

/** A goal holding 100,000 ETB, all of it in CBO savings: a take-out may move it. */
const rich: SavingGoal = {
  id: "g1",
  title: "Laptop",
  saved_minor: 10_000_000,
  held_minor: 10_000_000,
  room: { "cbo-savings": 10_000_000 },
};

const all = (db: Db, sql: string, ...params: (string | number)[]) =>
  db.prepare(sql).all(...params) as Record<string, string | number | null>[];

describe("a bare account word at the end (F118)", () => {
  it("names the account and leaves the description", () => {
    const { save } = setup();
    const rent = save("paid rent 8000 cash");
    expect(rent.parsed).toMatchObject({ kind: "expense", description: "rent", account: "cash" });
    const lunch = save("lunch 300 telebirr");
    expect(lunch.parsed).toMatchObject({
      kind: "expense",
      description: "lunch",
      account: "telebirr",
    });
    expect(lunch.echo).toBe("300 ETB · Food · telebirr");
  });

  it("names the account on a loan too, and leaves a lone word alone", () => {
    const { save } = setup();
    expect(save("lent abel 500 telebirr").parsed).toMatchObject({
      kind: "loan",
      person: "abel",
      account: "telebirr",
    });
    expect(save("lunch 300").parsed).toMatchObject({ description: "lunch", account: "cash" });
  });
});

describe("an entry's currency is its account's", () => {
  it("puts a dollar amount with no @account in the first dollar account", () => {
    const { save } = setup();
    expect(save("domain $12").parsed).toMatchObject({ account: "wise", currency: "USD" });
  });

  it("keeps a line as a loose end when no account holds that currency", () => {
    const { db, save } = setup();
    const { parsed, echo: line } = save("hosting €50");
    expect(parsed).toMatchObject({ kind: "inbox", body: "hosting €50" });
    expect(line).toBe("No EUR account yet: add one in Money → Accounts");
    expect(all(db, "SELECT id FROM money_txns")).toEqual([]);
    expect(all(db, "SELECT kind, status, body FROM note_items")).toEqual([
      { kind: "inbox", status: "inbox", body: "hosting €50" },
    ]);
  });

  it("refuses @account in another currency and names the right one", () => {
    const { db, save } = setup();
    expect(save("salary 500 usd @cbo").echo).toBe("CBO is in ETB; use @wise or drop the usd");
    expect(save("lunch $5 @cash").echo).toBe("Cash is in ETB; use @wise or drop the $");
    expect(save("figma €15 @wise").echo).toBe("Wise is in USD; drop the €");
    expect(all(db, "SELECT id FROM money_txns")).toEqual([]);
  });

  it("keeps a several-item line whole when one piece can't be saved", () => {
    const { db, save } = setup();
    const { parsed, echo: line } = save("lunch 120, hosting €50");
    expect(parsed).toMatchObject({ kind: "inbox", body: "lunch 120, hosting €50" });
    expect(line).toBe("No EUR account yet: add one in Money → Accounts");
    expect(all(db, "SELECT id FROM money_txns")).toEqual([]);
  });

  it("never mixes currencies in an account (guard)", () => {
    const { db, save } = setup();
    for (const text of [
      "lunch 120",
      "+25000 salary",
      "domain $12",
      "figma 15 @wise",
      "lent abel $50",
      "lent kebede 300",
      "moved $200 from wise to cbo",
      "moved 2650 from cbo to wise",
      "moved 2000 from cbo to cash",
      "saved 500 laptop",
      "saved $50 laptop",
      "took 200 from laptop",
      "lunch 80, saved 100 laptop and moved 50 from cash to cbo",
      "salary 500 usd @cbo",
      "hosting €50",
      "lunch $5 @cash",
    ])
      save(text, rich);
    expect(
      all(
        db,
        `SELECT m.id, m.currency, a.currency AS account_currency FROM money_txns m
         LEFT JOIN money_accounts a ON a.id = m.account
         WHERE a.id IS NULL OR m.currency <> a.currency`,
      ),
    ).toEqual([]);
    expect(
      all(
        db,
        `SELECT l.id FROM money_loans l JOIN money_accounts a ON a.id = l.account
         WHERE l.currency <> a.currency`,
      ),
    ).toEqual([]);
    // Wise's balance is dollars only: −12 −15 −50 −200 +20 (2,650 ETB at 132.50).
    const wise = all(db, ACCOUNTS_SQL).find((row) => row.id === "wise");
    expect(wise?.moved_minor).toBe(-1_200 - 1_500 - 5_000 - 20_000 + 2_000);
  });
});

describe("transfers across currencies", () => {
  it("sends dollars and lands birr at the saved rate", () => {
    const { db, save } = setup();
    const { parsed, echo: line } = save("moved $200 from wise to cbo");
    expect(parsed).toMatchObject({
      kind: "transfer",
      amount: 20_000,
      currency: "USD",
      received: 2_650_000,
      toCurrency: "ETB",
    });
    expect(line).toBe("Moved $200 · Wise → CBO (26,500 ETB at 132.50)");
    expect(
      all(db, "SELECT account, amount_minor, currency FROM money_txns ORDER BY amount_minor"),
    ).toEqual([
      { account: "wise", amount_minor: -20_000, currency: "USD" },
      { account: "cbo", amount_minor: 2_650_000, currency: "ETB" },
    ]);
  });

  it("works the other way, and when the dollars are the arriving side", () => {
    const { save } = setup();
    expect(save("moved 2650 from cbo to wise").parsed).toMatchObject({
      amount: 265_000,
      received: 2_000,
      toCurrency: "USD",
    });
    expect(save("moved $20 from cbo to wise").parsed).toMatchObject({
      amount: 265_000,
      received: 2_000,
    });
  });

  it("rounds to the santim", () => {
    const { save } = setup({ rates: { USD: { rate: "132.555", set_on: TODAY } } });
    // 0.01 USD = 1.32555 ETB → 1.33 ETB.
    expect(save("moved $0.01 from wise to cbo").parsed).toMatchObject({ received: 133 });
  });

  it("refuses without a rate, or in a currency neither account is in", () => {
    const { db, save } = setup({ rates: {} });
    expect(save("moved $200 from wise to cbo").echo).toBe(
      "Set a USD rate in Money → Accounts first",
    );
    expect(save("moved €50 from cbo to cash").echo).toBe("CBO and Cash are in ETB; drop the €");
    expect(all(db, "SELECT id FROM money_txns")).toEqual([]);
  });
});

describe("saving from the capture box is Put aside", () => {
  it("moves the money into the savings account and ties the goal's entry to it", () => {
    const { db, save } = setup();
    const { echo: line } = save("saved 500 laptop", { id: "g1", title: "Laptop" });
    expect(line).toBe("Saved 500 ETB · Laptop · CBO → CBO savings");
    const halves = all(
      db,
      "SELECT account, amount_minor, transfer_id FROM money_txns ORDER BY amount_minor",
    );
    expect(halves).toMatchObject([
      { account: "cbo", amount_minor: -50_000 },
      { account: "cbo-savings", amount_minor: 50_000 },
    ]);
    expect(
      all(db, "SELECT goal_id, amount_minor, account, transfer_id FROM savings_entries"),
    ).toEqual([
      {
        goal_id: "g1",
        amount_minor: 50_000,
        account: "cbo-savings",
        transfer_id: halves[0]?.transfer_id ?? "",
      },
    ]);
  });

  it("takes from @account, and does the same inside a several-item line", () => {
    const { db, save } = setup();
    save("saved 500 laptop @telebirr", { id: "g1", title: "Laptop" });
    save("+25000 salary, saved 300 laptop", { id: "g1", title: "Laptop" });
    expect(
      all(
        db,
        "SELECT account, amount_minor FROM money_txns WHERE transfer_id IS NOT NULL ORDER BY account, amount_minor",
      ),
    ).toEqual([
      { account: "cbo", amount_minor: -30_000 },
      { account: "cbo-savings", amount_minor: 30_000 },
      { account: "cbo-savings", amount_minor: 50_000 },
      { account: "telebirr", amount_minor: -50_000 },
    ]);
    expect(
      all(db, "SELECT count(*) AS n FROM savings_entries WHERE transfer_id IS NOT NULL"),
    ).toEqual([{ n: 2 }]);
  });

  it("reverses for took … from", () => {
    const { db, save } = setup();
    expect(save("took 2000 from laptop", rich).echo).toBe(
      "Took out 2,000 ETB · Laptop · CBO savings → CBO",
    );
    expect(all(db, "SELECT account, amount_minor FROM money_txns ORDER BY amount_minor")).toEqual([
      { account: "cbo-savings", amount_minor: -200_000 },
      { account: "cbo", amount_minor: 200_000 },
    ]);
    expect(all(db, "SELECT amount_minor, account FROM savings_entries")).toEqual([
      { amount_minor: -200_000, account: "cbo-savings" },
    ]);
  });

  it("puts dollars into a dollar savings account, the goal counting their birr", () => {
    const { db } = setup();
    db.exec(
      "INSERT INTO money_accounts (id, name, kind, pays_in, sort_order, currency, is_savings, created_at, updated_at) VALUES ('wise-jar', 'Wise jar', 'other', 0, 8, 'USD', 1, 0, 0)",
    );
    const options: ParseOptions = { nowMs, accounts: accountsOf(db), goals: ["laptop"], rates };
    let n = 0;
    const ops = toOps(parseCapture("saved $50 laptop", options), {
      nowMs,
      newId: () => `s${++n}`,
      savingGoal: { id: "g1", title: "Laptop" },
    });
    insertAll(db, ops);
    expect(
      all(db, "SELECT account, amount_minor, currency FROM money_txns ORDER BY amount_minor"),
    ).toEqual([
      { account: "wise", amount_minor: -5_000, currency: "USD" },
      { account: "wise-jar", amount_minor: 5_000, currency: "USD" },
    ]);
    expect(all(db, "SELECT amount_minor, account FROM savings_entries")).toEqual([
      { amount_minor: 662_500, account: "wise-jar" },
    ]);
  });

  it("falls back to a marked saving with no savings account in that currency, and says so", () => {
    const { db, save } = setup();
    const { echo: line } = save("saved $50 laptop", { id: "g1", title: "Laptop" });
    expect(line).toBe(
      "Saved $50 · Laptop · no USD savings account, so the money stays where it is",
    );
    expect(all(db, "SELECT id FROM money_txns")).toEqual([]);
    expect(all(db, "SELECT goal_id, amount_minor, account FROM savings_entries")).toEqual([
      { goal_id: "g1", amount_minor: 662_500, account: null },
    ]);
  });

  it("says so inside a several-item line too", () => {
    const { db, save } = setup();
    const { echo: line } = save("lunch 120, saved $50 laptop", { id: "g1", title: "Laptop" });
    expect(line).toBe(
      "2 entries · lunch 120, saved $50 laptop (no USD savings account, money stays put) · 120 ETB out",
    );
    expect(all(db, "SELECT amount_minor, account FROM savings_entries")).toEqual([
      { amount_minor: 662_500, account: null },
    ]);
  });

  it("asks for a rate before saving dollars", () => {
    const { db, save } = setup({ rates: {} });
    expect(save("saved $50 laptop").echo).toBe("Set a USD rate in Money → Accounts first");
    expect(all(db, "SELECT id FROM savings_entries")).toEqual([]);
  });
});

describe("a transfer into a savings account counts at once", () => {
  it("goes to the one active goal, in the same write, with nothing left for the sync", () => {
    const { db, save } = setup();
    const { echo: line } = save("moved 2000 from cbo to cbo-savings", {
      id: "g1",
      title: "Laptop",
    });
    expect(line).toBe("Moved 2,000 ETB · CBO → CBO savings · counts as saving");
    expect(all(db, "SELECT goal_id, amount_minor, account FROM savings_entries")).toEqual([
      { goal_id: "g1", amount_minor: 200_000, account: "cbo-savings" },
    ]);
    expect(all(db, SAVINGS_TRANSFERS_SQL)).toEqual([]);
  });

  it("waits unassigned with several goals", () => {
    const { db, save } = setup();
    save("moved 2000 from cbo to cbo-savings", null);
    expect(all(db, "SELECT goal_id, amount_minor FROM savings_entries")).toEqual([
      { goal_id: null, amount_minor: 200_000 },
    ]);
  });

  it("takes out when money leaves the savings account", () => {
    const { db, save } = setup();
    save("moved 500 from cbo-savings to cash", { id: "g1", title: "Laptop" });
    expect(all(db, "SELECT goal_id, amount_minor FROM savings_entries")).toEqual([
      { goal_id: "g1", amount_minor: -50_000 },
    ]);
  });

  it("is not saving between two spending accounts", () => {
    const { db, save } = setup();
    save("moved 2000 from cbo to cash", { id: "g1", title: "Laptop" });
    expect(all(db, "SELECT id FROM savings_entries")).toEqual([]);
  });
});

/** Inserts capture ops the way the Rust writer does, with its timestamps. */
function insertAll(db: Db, ops: Op[]) {
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
