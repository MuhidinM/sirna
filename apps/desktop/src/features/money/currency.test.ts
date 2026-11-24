import { describe, expect, it } from "vitest";

import { openTestDb } from "../../test/sqlite";
import { type GoalRow } from "../savings/savings";
import { type AccountRow, ACCOUNTS_SQL, inEtb, transferOps, checkTransfer } from "./accounts";
import {
  checkRate,
  conversionNotes,
  convert,
  newConversion,
  type Rates,
  RATES_KEY,
  rateOps,
  readRates,
  switchCurrency,
  toEtb,
} from "./currency";
import { balances, type LoanEvent, LOANS_SQL, loanOps, owedInEtb } from "./loans";
import { HISTORY_SQL, monthSummary, type TxnRow, TXNS_SQL, usualByCategory } from "./money";
import { jobRates } from "./rate";
import { monthReview } from "./review";
import { safeToSpend } from "./safe";

const RATES: Rates = { USD: { rate: "132.50", set_on: "2026-11-23" } };

const account = (over: Partial<AccountRow>): AccountRow => ({
  id: "cbo",
  name: "CBO",
  kind: "bank",
  opening_minor: 0,
  opening_date: "2026-11-01",
  pays_in: 1,
  sort_order: 1,
  moved_minor: 0,
  ...over,
});

describe("rates (time-first §3)", () => {
  it("keeps the value, not the number, when an entry moves to another currency (F71)", () => {
    expect(switchCurrency(400, "USD", "ETB", RATES)).toEqual({
      minor: 53_000,
      note: "Converted $4 to 530 ETB at 132.50.",
    });
    expect(switchCurrency(53_000, "ETB", "USD", RATES)).toEqual({
      minor: 400,
      note: "Converted 530 ETB to $4 at 132.50.",
    });
    expect(switchCurrency(400, "USD", "ETB", {})).toEqual({
      minor: 400,
      note: "No USD rate set: check the amount.",
    });
    expect(switchCurrency(400, "ETB", "ETB", RATES)).toEqual({ minor: 400, note: null });
    expect(switchCurrency(null, "USD", "ETB", RATES)).toEqual({ minor: null, note: null });
  });

  it("converts with integers, rounding half up", () => {
    expect(toEtb(10_000, "USD", RATES)).toBe(1_325_000); // $100 → 13,250 ETB
    expect(toEtb(12_345, "USD", RATES)).toBe(1_635_713); // $123.45 × 132.50 = 16,357.125
    expect(toEtb(-12_345, "USD", RATES)).toBe(-1_635_713);
    expect(toEtb(1, "EUR", { EUR: { rate: "0.4", set_on: "x" } })).toBe(0);
    expect(toEtb(5, "EUR", { EUR: { rate: "0.5", set_on: "x" } })).toBe(3);
    expect(toEtb(5_000, "ETB", {})).toBe(5_000);
    expect(toEtb(5_000, null, {})).toBe(5_000);
    expect(toEtb(5_000, "EUR", RATES)).toBeNull();
  });

  it("reads only good rates, and sets or removes one", () => {
    expect(readRates('{"USD":{"rate":"132.50","set_on":"2026-11-23"},"EUR":{"rate":"x"}}')).toEqual(
      RATES,
    );
    expect(readRates("not json")).toEqual({});
    expect(readRates(null)).toEqual({});
    expect(checkRate("132.50")).toBeNull();
    expect(checkRate("0")).toMatch(/rate/);
    expect(checkRate("12,5")).toMatch(/rate/);
    const [set] = rateOps(RATES, "EUR", " 150 ", "2026-11-24");
    expect(set).toEqual({
      op: "upsert",
      table: "core_settings",
      id: RATES_KEY,
      values: {
        value_json: JSON.stringify({ ...RATES, EUR: { rate: "150", set_on: "2026-11-24" } }),
      },
    });
    const [gone] = rateOps(RATES, "USD", "", "2026-11-24");
    expect(gone?.op === "upsert" && gone.values.value_json).toBe("{}");
  });

  it("says what was converted and what was left out", () => {
    const conversion = newConversion();
    convert(conversion, RATES, 10_000, "USD");
    convert(conversion, RATES, 5_000, "EUR");
    convert(conversion, RATES, 3_000, "ETB");
    expect(conversionNotes(conversion, RATES)).toEqual({
      approx: true,
      rate: "at 132.50 (23 Nov)",
      missing: "Left out: €50 (no EUR rate yet; set one under Accounts).",
    });
    expect(conversionNotes(newConversion(), RATES)).toEqual({
      approx: false,
      rate: null,
      missing: null,
    });
    const two = newConversion();
    const both: Rates = { ...RATES, EUR: { rate: "150", set_on: "2026-11-20" } };
    convert(two, both, 1, "EUR");
    convert(two, both, 1, "USD");
    expect(conversionNotes(two, both).rate).toBe("EUR at 150 (20 Nov) · USD at 132.50 (23 Nov)");
  });
});

describe("totals in ETB", () => {
  it("converts a foreign balance and leaves one with no rate out", () => {
    const wise = account({ id: "wise", currency: "USD", opening_minor: 20_000, pays_in: 0 });
    const conversion = newConversion();
    expect(inEtb([wise], RATES, conversion)).toEqual([
      { ...wise, opening_minor: 2_650_000, moved_minor: 0, currency: "ETB" },
    ]);
    const none = newConversion();
    expect(inEtb([wise], {}, none)).toEqual([]);
    expect(conversionNotes(none, {}).missing).toBe(
      "Left out: $200 (no USD rate yet; set one under Accounts).",
    );
    // No balance yet: kept, so it still counts as unknown.
    expect(inEtb([{ ...wise, opening_date: null }], {}, newConversion())).toHaveLength(1);
  });

  it("safe to spend: savings accounts out, foreign money at its rate", () => {
    const goal: GoalRow = {
      id: "laptop",
      title: "Laptop",
      target_minor: 10_000_000,
      start_date: "2026-11-01",
      status: "active",
      saved_minor: 800_000,
      held_minor: 500_000,
      target_date: null,
    };
    const safe = safeToSpend({
      accounts: [
        account({ opening_minor: 1_000_000 }),
        account({ id: "cbo-savings", is_savings: 1, opening_minor: 500_000, pays_in: 0 }),
        account({ id: "wise", currency: "USD", opening_minor: 10_000, pays_in: 0 }),
      ],
      goals: [goal],
      savedThisMonth: {},
      due: [],
      today: "2026-11-23",
      daysInMonth: 30,
      rates: RATES,
    });
    // 10,000 + $100 (13,250) − the 3,000 put aside but still in CBO.
    expect(safe.lines).toEqual([
      { label: "In your accounts", amount: 2_325_000 },
      { label: "Put aside in goals", amount: -300_000 },
    ]);
    expect(safe.notes).toEqual({ approx: true, rate: "at 132.50 (23 Nov)", missing: null });
    const noRate = safeToSpend({
      accounts: [
        account({ opening_minor: 1_000_000 }),
        account({ id: "wise", currency: "USD", opening_minor: 10_000, pays_in: 0 }),
      ],
      goals: [],
      savedThisMonth: {},
      due: [],
      today: "2026-11-23",
      daysInMonth: 30,
    });
    expect(noRate.total).toBe(1_000_000);
    expect(noRate.notes?.missing).toMatch(/Left out: \$100/);
  });

  it("the month: foreign entries converted, transfers still out of in and out", () => {
    const row = (over: Partial<TxnRow>): TxnRow => ({
      id: "x",
      local_date: "2026-11-10",
      occurred_at: 0,
      amount_minor: 0,
      description: "x",
      category_id: null,
      category: null,
      account: "cash",
      origin: null,
      ...over,
    });
    const summary = monthSummary({
      txns: [
        row({ amount_minor: 1_800_000 }),
        row({ amount_minor: 50_000, currency: "USD", account: "wise" }),
        row({ amount_minor: -2_000, currency: "EUR" }),
        row({ amount_minor: -1_000, currency: "USD", transfer_id: "t" }),
      ],
      saved: 0,
      history: [],
      today: "2026-11-23",
      rates: RATES,
    });
    expect(summary.in).toBe(1_800_000 + 6_625_000);
    expect(summary.out).toBe(0);
    expect(summary.notes?.approx).toBe(true);
    expect(summary.notes?.missing).toMatch(/€20/);
    // ETB alone: the same numbers as before, nothing to say.
    const plain = monthSummary({
      txns: [row({ amount_minor: 1_800_000 })],
      saved: 0,
      history: [],
      today: "2026-11-23",
    });
    expect(plain.notes).toEqual({ approx: false, rate: null, missing: null });
  });

  it("usual months merge converted spending into its category", () => {
    const usual = usualByCategory(
      [
        { month: "2026-10", category_id: "cat_food", out_minor: 100_000, currency: "ETB" },
        { month: "2026-10", category_id: "cat_food", out_minor: 1_000, currency: "USD" },
        { month: "2026-10", category_id: "cat_food", out_minor: 1_000, currency: "EUR" },
      ],
      RATES,
    );
    expect(usual.get("cat_food")).toBe(232_500);
  });

  it("net worth counts savings accounts and owed money in each currency", () => {
    const people = balances([
      {
        id: "1",
        person: "Abel",
        kind: "lent",
        amount_minor: 10_000,
        local_date: "2026-11-01",
        account: "wise",
        note: null,
        follow_up_date: null,
        currency: "USD",
      },
      {
        id: "2",
        person: "abel",
        kind: "lent",
        amount_minor: 60_000,
        local_date: "2026-11-02",
        account: "cash",
        note: null,
        follow_up_date: null,
      },
    ]);
    expect(people.map((p) => [p.person, p.currency, p.owedToMe])).toEqual([
      ["Abel", "USD", 10_000],
      ["abel", "ETB", 60_000],
    ]);
    expect(owedInEtb(people, RATES, newConversion())).toBe(1_385_000);
    const review = monthReview({
      summary: monthSummary({ txns: [], saved: 0, history: [], today: "2026-11-23" }),
      caps: [],
      accounts: [
        account({ opening_minor: 100_000 }),
        account({ id: "cbo-savings", is_savings: 1, opening_minor: 500_000 }),
      ],
      people,
      rates: RATES,
    });
    expect(review.netWorth).toBe(100_000 + 500_000 + 1_385_000);
    expect(review.notes.rate).toBe("at 132.50 (23 Nov)");
  });

  it("job pay in dollars counts at its rate", () => {
    const [rate] = jobRates(
      [{ area_id: "joba", name: "Job A", minutes: 600 }],
      [
        { area_id: "joba", minor: 1_000_000, currency: "ETB" },
        { area_id: "joba", minor: 10_000, currency: "USD" },
      ],
      RATES,
    );
    expect(rate?.pay).toBe(2_325_000);
  });
});

describe("currency in the database", () => {
  it("Wise is in dollars, CBO savings is a savings account", () => {
    const db = openTestDb();
    const rows = db.prepare(ACCOUNTS_SQL).all() as unknown as AccountRow[];
    expect(rows.find((row) => row.id === "wise")).toMatchObject({ currency: "USD", is_savings: 0 });
    expect(rows.find((row) => row.id === "cbo-savings")).toMatchObject({
      currency: "ETB",
      is_savings: 1,
    });
  });

  it("an entry and a loan take their account's currency", () => {
    const db = openTestDb();
    db.prepare(
      "INSERT INTO money_txns (id, account, occurred_at, local_date, amount_minor, description, created_at, updated_at) VALUES ('w', 'wise', 0, '2026-11-10', 5000, 'client', 0, 0)",
    ).run();
    const txns = db.prepare(TXNS_SQL).all("2026-11-01", "2026-11-30") as unknown as TxnRow[];
    expect(txns[0]?.currency).toBe("USD");
    expect(db.prepare(HISTORY_SQL).all("2026-11-01", "2026-12-01")).toEqual([
      { month: "2026-11", category_id: null, out_minor: 0, currency: "USD" },
    ]);
    for (const op of loanOps({
      person: "Abel",
      kind: "lent",
      amount: 2_000,
      date: "2026-11-10",
      account: "wise",
      nowMs: 0,
      id: "l1",
      txnId: "t1",
      currency: "USD",
    })) {
      if (op.op !== "insert") continue;
      const cols = Object.keys(op.values);
      db.prepare(
        `INSERT INTO ${op.table} (id, ${cols.join(", ")}, created_at, updated_at) VALUES (?, ${cols.map(() => "?").join(", ")}, 0, 0)`,
      ).run(op.id, ...(Object.values(op.values) as (string | number | null)[]));
    }
    const loans = db.prepare(LOANS_SQL).all() as unknown as LoanEvent[];
    expect(loans[0]?.currency).toBe("USD");
    expect(
      (db.prepare("SELECT currency FROM money_txns WHERE id = 't1'").get() as { currency: string })
        .currency,
    ).toBe("USD");
  });

  it("an entry that names its own currency keeps it, even in a birr account", () => {
    const db = openTestDb();
    db.prepare(
      "INSERT INTO money_txns (id, account, occurred_at, local_date, amount_minor, description, currency, created_at, updated_at) VALUES ('e', 'cash', 0, '2026-11-10', -2000, 'lunch', 'EUR', 0, 0), ('b', 'cash', 0, '2026-11-10', -500, 'tea', 'ETB', 0, 0)",
    ).run();
    const txns = db.prepare(TXNS_SQL).all("2026-11-01", "2026-11-30") as unknown as TxnRow[];
    expect(Object.fromEntries(txns.map((row) => [row.id, row.currency]))).toEqual({
      e: "EUR",
      b: "ETB",
    });
  });

  it("a transfer between currencies records what arrived", () => {
    const ops = transferOps({
      from: { id: "wise", name: "Wise", currency: "USD" },
      to: { id: "cbo", name: "CBO", currency: "ETB" },
      amount: 10_000,
      received: 1_300_000,
      date: "2026-11-23",
      nowMs: 0,
      ids: ["a", "b"],
      transferId: "t",
    });
    expect(
      ops.map((op) => op.op === "insert" && [op.values.amount_minor, op.values.currency]),
    ).toEqual([
      [-10_000, "USD"],
      [1_300_000, "ETB"],
    ]);
    expect(checkTransfer("wise", "cbo", 10_000, null)).toMatch(/arrived/);
    expect(checkTransfer("wise", "cbo", 10_000, 1_300_000)).toBeNull();
    expect(checkTransfer("cash", "cbo", 10_000)).toBeNull();
  });
});
