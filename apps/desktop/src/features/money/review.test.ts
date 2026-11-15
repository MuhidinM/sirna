/** Regression tests for the Milestone 2 review (accounts, pay and bills, loans, safe to spend). */
import { describe, expect, it } from "vitest";

import { type GoalRow } from "../savings/savings";
import { type AccountRow, checkHide } from "./accounts";
import { balances, type LoanEvent, loanIdOf, loanRestoreOps, personFollowUpOps } from "./loans";
import { dueItems, dueWindow, type RegularRow, type RegularTxn } from "./regulars";
import { safeToSpend } from "./safe";

const regular = (over: Partial<RegularRow>): RegularRow => ({
  id: "r",
  kind: "pay",
  name: "Job A pay",
  amount_minor: 1_800_000,
  rule_json: JSON.stringify({ every: "month", day: 30 }),
  category_id: "cat_salary",
  account: "cbo",
  area_id: "joba",
  active: 1,
  job: "Job A",
  created_at: 0,
  ...over,
});
const txn = (over: Partial<RegularTxn>): RegularTxn => ({
  regular_id: null,
  due_date: null,
  area_id: null,
  amount_minor: 0,
  local_date: "2026-11-02",
  description: null,
  category_id: null,
  ...over,
});
const view = (items: ReturnType<typeof dueItems>) =>
  items.map((item) => [item.regular.id, item.date, item.state, item.left]);

describe("pay that comes after its month ends", () => {
  it("settles last month's date, not this month's", () => {
    const { from, txnFrom, to, shownFrom } = dueWindow("2026-11-14");
    expect([from, txnFrom, shownFrom]).toEqual(["2026-10-01", "2026-09-24", "2026-11-01"]);
    const items = dueItems(
      [regular({})],
      [txn({ area_id: "joba", amount_minor: 1_800_000, local_date: "2026-11-02" })],
      from,
      to,
      "2026-11-14",
      shownFrom,
    );
    // October's 30th is paid (and hidden as done); November's 30th still to come.
    expect(view(items)).toEqual([["r", "2026-11-30", "upcoming", 1_800_000]]);
  });

  it("keeps last month's pay on show while it is still missing", () => {
    const { from, to, shownFrom } = dueWindow("2026-11-02");
    const items = dueItems([regular({})], [], from, to, "2026-11-04", shownFrom);
    expect(view(items)).toEqual([
      ["r", "2026-10-30", "late", 1_800_000],
      ["r", "2026-11-30", "upcoming", 1_800_000],
    ]);
  });

  it("counts an early payment just before the window, and late rent against its own month (leftovers review)", () => {
    const internet = regular({
      id: "net",
      kind: "bill",
      name: "Internet",
      amount_minor: 120_000,
      rule_json: JSON.stringify({ every: "month", day: 25 }),
      category_id: "cat_phone",
      area_id: null,
    });
    const paid = (date: string, what: string, minor: number) =>
      txn({ amount_minor: -minor, local_date: date, description: what });
    // November's paid 5 days early (Nov 20), December's on Dec 20: nothing is due.
    const w = dueWindow("2026-12-24");
    const items = dueItems(
      [internet],
      [paid("2026-11-20", "internet", 120_000), paid("2026-12-20", "internet", 120_000)],
      w.from,
      w.to,
      "2026-12-24",
      w.shownFrom,
    );
    expect(view(items)).toEqual([["net", "2026-12-25", "paid", 0]]);
    expect(w.txnFrom <= "2026-11-20").toBe(true);

    const rent = regular({
      id: "rent",
      kind: "bill",
      name: "Rent",
      amount_minor: 600_000,
      rule_json: JSON.stringify({ every: "month", day: 1 }),
      category_id: "cat_housing",
      area_id: null,
    });
    const on = (today: string, entries: RegularTxn[]) => {
      const win = dueWindow(today);
      return view(dueItems([rent], entries, win.from, win.to, today, win.shownFrom));
    };
    // October never recorded: November's payment still pays November (second review).
    expect(on("2026-11-15", [paid("2026-11-01", "rent", 600_000)])).toEqual([
      ["rent", "2026-11-01", "paid", 0],
    ]);
    // Paid 11 days late: too early for December, so it is November's.
    expect(on("2026-12-02", [paid("2026-11-12", "rent", 600_000)])).toEqual([
      ["rent", "2026-12-01", "late", 600_000],
    ]);
    // Always paid on the 28th, a few days ahead: each counts for the coming 1st,
    // on any day, at the window's edge too.
    const ahead = ["2026-09-28", "2026-10-28", "2026-11-28"].map((d) => paid(d, "rent", 600_000));
    expect(on("2026-11-30", ahead)).toEqual([["rent", "2026-11-01", "paid", 0]]);
    expect(on("2026-12-02", ahead)).toEqual([["rent", "2026-12-01", "paid", 0]]);
    // Catching up: two payments on Dec 1 pay December and the missed November.
    expect(
      on("2026-12-02", [paid("2026-12-01", "rent", 600_000), paid("2026-12-01", "rent", 600_000)]),
    ).toEqual([["rent", "2026-12-01", "paid", 0]]);
    expect(on("2026-12-02", [paid("2026-12-01", "rent", 600_000)])).toEqual([
      ["rent", "2026-12-01", "paid", 0],
    ]);
  });

  it("hands a payment to same-day bills by name ignoring case, as bills.rs does", () => {
    const bill = (id: string, name: string) =>
      regular({
        id,
        kind: "bill",
        name,
        amount_minor: 20_000,
        rule_json: JSON.stringify({ every: "month", day: 5 }),
        category_id: "cat_utilities",
        area_id: null,
      });
    const items = dueItems(
      [bill("net", "Internet"), bill("iddir", "iddir")],
      [txn({ amount_minor: -20_000, local_date: "2026-12-03", category_id: "cat_utilities" })],
      "2026-12-01",
      "2026-12-31",
      "2026-12-04",
    );
    expect(view(items)).toEqual([
      ["iddir", "2026-12-05", "paid", 0],
      ["net", "2026-12-05", "upcoming", 20_000],
    ]);
  });

  it("hands a payment to same-named bills by id, as bills.rs does", () => {
    const iddir = (id: string, minor: number) =>
      regular({
        id,
        kind: "bill",
        name: "Iddir",
        amount_minor: minor,
        rule_json: JSON.stringify({ every: "month", day: 5 }),
        category_id: "cat_utilities",
        area_id: null,
      });
    const items = dueItems(
      [iddir("iddir_b", 30_000), iddir("iddir_a", 20_000)],
      [txn({ amount_minor: -20_000, local_date: "2026-12-03", description: "iddir" })],
      "2026-12-01",
      "2026-12-31",
      "2026-12-04",
    );
    expect(view(items)).toEqual([
      ["iddir_a", "2026-12-05", "paid", 0],
      ["iddir_b", "2026-12-05", "upcoming", 30_000],
    ]);
  });

  it("fills two pay days from one job in date order, not by name", () => {
    const bonus = regular({ id: "bonus", name: "A bonus", amount_minor: 500_000 });
    const salary = regular({
      id: "salary",
      name: "B salary",
      amount_minor: 900_000,
      rule_json: JSON.stringify({ every: "month", day: 15 }),
    });
    const items = dueItems(
      [bonus, salary],
      [txn({ area_id: "joba", amount_minor: 900_000, local_date: "2026-11-15" })],
      "2026-11-01",
      "2026-11-30",
      "2026-11-20",
    );
    expect(view(items)).toEqual([
      ["salary", "2026-11-15", "paid", 0],
      ["bonus", "2026-11-30", "upcoming", 500_000],
    ]);
  });
});

describe("bills you paid without the Paid button", () => {
  const rent = regular({
    id: "rent",
    kind: "bill",
    name: "Rent",
    amount_minor: 600_000,
    rule_json: JSON.stringify({ every: "month", day: 1 }),
    category_id: "cat_housing",
    area_id: null,
  });

  it("counts `paid rent 6000` (by name) and a same-category, same-amount entry", () => {
    const byName = dueItems(
      [rent],
      [txn({ amount_minor: -600_000, description: "rent", local_date: "2026-11-01" })],
      "2026-11-01",
      "2026-11-30",
      "2026-11-14",
    );
    expect(byName[0]?.state).toBe("paid");
    const byCategory = dueItems(
      [rent],
      [txn({ amount_minor: -600_000, description: "landlord", category_id: "cat_housing" })],
      "2026-11-01",
      "2026-11-30",
      "2026-11-14",
    );
    expect(byCategory[0]?.state).toBe("paid");
    const other = dueItems(
      [rent],
      [txn({ amount_minor: -12_000, description: "lunch", category_id: "cat_food" })],
      "2026-11-01",
      "2026-11-30",
      "2026-11-14",
    );
    expect(other[0]?.state).toBe("late");
  });
});

const account = (over: Partial<AccountRow>): AccountRow => ({
  id: "cbo",
  name: "CBO",
  kind: "bank",
  opening_minor: 0,
  opening_date: "2026-11-01",
  pays_in: 0,
  sort_order: 1,
  moved_minor: 0,
  ...over,
});

describe("safe to spend after the review", () => {
  const goal = (over: Partial<GoalRow>): GoalRow => ({
    id: "g",
    title: "Laptop",
    target_minor: 1_000_000,
    start_date: "2026-11-01",
    status: "paused",
    saved_minor: 200_000,
    target_date: null,
    ...over,
  });

  it("puts aside paused goals and savings with no goal yet", () => {
    const safe = safeToSpend({
      accounts: [account({ opening_minor: 1_000_000 })],
      goals: [goal({}), goal({ id: "done", status: "done", saved_minor: 999_999 })],
      savedThisMonth: {},
      due: [],
      today: "2026-11-14",
      daysInMonth: 30,
      unassigned: 300_000,
    });
    expect(safe.lines).toContainEqual({ label: "Put aside in goals", amount: -500_000 });
    expect(safe.total).toBe(500_000);
  });

  it("leaves out pay and bills of accounts without a balance", () => {
    const [pay] = dueItems(
      [regular({ account: "cbe" })],
      [],
      "2026-11-01",
      "2026-11-30",
      "2026-11-14",
    );
    if (!pay) throw new Error("no pay");
    const safe = safeToSpend({
      accounts: [account({ opening_minor: 100_000 }), account({ id: "cbe", opening_date: null })],
      goals: [],
      savedThisMonth: {},
      due: [pay],
      today: "2026-11-14",
      daysInMonth: 30,
    });
    expect(safe.total).toBe(100_000);
  });
});

describe("accounts and loans after the review", () => {
  it("won't hide an account with money, pay, or a regular on it", () => {
    expect(checkHide(account({ opening_minor: 50_000 }), [])).toMatch(/still holds 500 ETB/);
    expect(checkHide(account({ pays_in: 1 }), [])).toMatch(/Pay lands here/);
    expect(checkHide(account({}), [{ account: "cbo", name: "Rent", active: 1 }])).toMatch(
      /Rent uses CBO/,
    );
    expect(checkHide(account({ opening_date: null }), [])).toBeNull();
    expect(checkHide(account({}), [{ account: "cbo", name: "Old", active: 0 }])).toBeNull();
  });

  const event = (over: Partial<LoanEvent>): LoanEvent => ({
    id: "e1",
    person: "Abel",
    kind: "lent",
    amount_minor: 100_000,
    local_date: "2026-11-01",
    account: "cash",
    note: null,
    follow_up_date: null,
    ...over,
  });

  it("keeps one follow-up date per person, so it can be moved or cleared", () => {
    const [abel] = balances([
      event({ follow_up_date: "2026-11-20" }),
      event({ id: "e2", amount_minor: 50_000, local_date: "2026-11-05" }),
    ]);
    if (!abel) throw new Error("no Abel");
    expect(personFollowUpOps(abel, "2026-11-16")).toEqual([
      { op: "update", table: "money_loans", id: "e1", values: { follow_up_date: null } },
      { op: "update", table: "money_loans", id: "e2", values: { follow_up_date: "2026-11-16" } },
    ]);
    expect(personFollowUpOps(abel, null).at(-1)).toMatchObject({
      values: { follow_up_date: null },
    });
  });

  it("finds a ledger entry's loan and can put it back", () => {
    expect(loanIdOf("loan:abc")).toBe("abc");
    expect(loanIdOf("t123")).toBeNull();
    expect(loanIdOf(null)).toBeNull();
    expect(loanRestoreOps(event({}))[0]).toMatchObject({
      op: "upsert",
      table: "money_loans",
      id: "e1",
      values: { person: "Abel", kind: "lent", amount_minor: 100_000 },
    });
  });
});
