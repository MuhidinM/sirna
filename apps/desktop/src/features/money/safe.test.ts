import { describe, expect, it } from "vitest";

import { openTestDb } from "../../test/sqlite";
import { type GoalRow } from "../savings/savings";
import { type AccountRow } from "./accounts";
import { type LoanEvent } from "./loans";
import { type DueItem, type RegularRow } from "./regulars";
import {
  emergencyTarget,
  essentialMonth,
  GOAL_MONTH_SQL,
  isEmergency,
  monthsCovered,
  safeLine,
  safeToSpend,
} from "./safe";

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
const goal = (over: Partial<GoalRow>): GoalRow => ({
  id: "laptop",
  title: "Laptop",
  target_minor: 6_000_000,
  start_date: "2026-09-01",
  status: "active",
  saved_minor: 1_500_000,
  target_date: null,
  ...over,
});
const regular = (kind: "bill" | "pay"): RegularRow => ({
  id: kind,
  kind,
  name: kind,
  amount_minor: 0,
  rule_json: "{}",
  category_id: null,
  account: "cbo",
  area_id: null,
  active: 1,
  job: null,
  created_at: 0,
});
const due = (kind: "bill" | "pay", left: number): DueItem => ({
  regular: regular(kind),
  date: "2026-11-21",
  state: "upcoming",
  done: 0,
  left,
});

describe("safe to spend (T-062)", () => {
  it("sums every line and gives a daily figure, rounded down", () => {
    const safe = safeToSpend({
      accounts: [
        account({ opening_minor: 4_000_000 }),
        account({ id: "cash", opening_minor: 300_000 }),
      ],
      goals: [
        goal({}),
        goal({ id: "trip", target_date: "2027-01-31", saved_minor: 0, target_minor: 900_000 }),
      ],
      savedThisMonth: { trip: 100_000 },
      due: [due("pay", 2_100_000), due("bill", 120_000)],
      today: "2026-11-14",
      daysInMonth: 30,
    });
    expect(safe.lines).toEqual([
      { label: "In your accounts", amount: 4_300_000 },
      { label: "Put aside in goals", amount: -1_500_000 },
      { label: "Pay still to come this month", amount: 2_100_000 },
      { label: "Bills still to pay this month", amount: -120_000 },
      // Trip: 9,000 over Nov…Jan = 3,000 a month, 1,000 already this month.
      { label: "Goals still to fund this month", amount: -200_000 },
    ]);
    expect(safe.total).toBe(4_580_000);
    // 45,800 over 17 days = 2,694.11 → 2,694.
    expect(safe.perDay).toBe(269_400);
    expect(safeLine(safe)).toBe("45,800 safe to spend · about 2,694 a day");
  });

  it("isn't known until an account has a balance, and says when it is short", () => {
    const none = safeToSpend({
      accounts: [account({ opening_date: null })],
      goals: [],
      savedThisMonth: {},
      due: [],
      today: "2026-11-14",
      daysInMonth: 30,
    });
    expect(none).toMatchObject({ known: false, unknownAccounts: 1 });
    const short = safeToSpend({
      accounts: [account({ opening_minor: 100_000 })],
      goals: [],
      savedThisMonth: {},
      due: [due("bill", 600_000)],
      today: "2026-11-14",
      daysInMonth: 30,
    });
    expect(short).toMatchObject({ known: true, total: -500_000, perDay: null });
    expect(safeLine(short)).toBe("Nothing safe to spend: 5,000 short this month");
  });

  it("takes off what you still owe people, in counted accounts only (F30)", () => {
    const loan = (over: Partial<LoanEvent>): LoanEvent => ({
      id: "l",
      person: "Selam",
      kind: "borrowed",
      amount_minor: 300_000,
      local_date: "2026-11-10",
      account: "cash",
      note: null,
      follow_up_date: null,
      ...over,
    });
    const base = {
      accounts: [
        account({ id: "cash", opening_minor: 1_000_000 }),
        account({ id: "wise", currency: "USD", opening_minor: 30_000 }),
        account({ id: "telebirr", opening_date: null }),
      ],
      goals: [],
      savedThisMonth: {},
      due: [],
      today: "2026-11-14",
      daysInMonth: 30,
      rates: { USD: { rate: "132.50", set_on: "2026-11-01" } },
    };
    const safe = safeToSpend({
      ...base,
      loans: [
        // 3,000 borrowed, 1,000 paid back: 2,000 still owed.
        loan({}),
        loan({ id: "p", kind: "i_paid", amount_minor: 100_000, local_date: "2026-11-12" }),
        // $50 borrowed into Wise: 6,625 ETB at 132.50.
        loan({ id: "s", person: "Sara", amount_minor: 5_000, account: "wise", currency: "USD" }),
        // Borrowed into an account with no balance: it was never added, so not taken off.
        loan({ id: "t", person: "Abel", account: "telebirr" }),
        // Lent: owed to you is not money in hand, and is not added.
        loan({ id: "u", person: "Kebede", kind: "lent", amount_minor: 50_000 }),
      ],
    });
    expect(safe.lines).toContainEqual({ label: "You owe people", amount: -(200_000 + 662_500) });
    expect(safe.total).toBe(1_000_000 + 3_975_000 - 862_500);
    // Without a USD rate the dollar debt is left out, like the dollars themselves.
    const bare = safeToSpend({
      ...base,
      rates: {},
      loans: [loan({ id: "s", amount_minor: 5_000, account: "wise", currency: "USD" })],
    });
    expect(bare.lines.find((line) => line.label === "You owe people")).toBeUndefined();
    // Nothing owed, no line.
    expect(safeToSpend(base).lines.map((line) => line.label)).toEqual(["In your accounts"]);
    // Borrowed into Cash, paid back through Telebirr (no balance): nothing is owed.
    const repaid = safeToSpend({
      ...base,
      loans: [
        loan({}),
        loan({ id: "p", kind: "i_paid", amount_minor: 300_000, account: "telebirr" }),
      ],
    });
    expect(repaid.lines.find((line) => line.label === "You owe people")).toBeUndefined();
    // Half paid back through Telebirr: the other half is still owed.
    const half = safeToSpend({
      ...base,
      loans: [
        loan({}),
        loan({ id: "p", kind: "i_paid", amount_minor: 150_000, account: "telebirr" }),
      ],
    });
    expect(half.lines).toContainEqual({ label: "You owe people", amount: -150_000 });
  });
});

describe("the emergency fund (T-062)", () => {
  it("measures months of essentials and sets a 3-month target", () => {
    const usual = new Map<string, number | null>([
      ["cat_housing", 600_000],
      ["cat_food", 380_000],
      ["cat_transport", 60_000],
      ["cat_shopping", 200_000],
    ]);
    expect(essentialMonth(usual)).toBe(1_040_000);
    expect(essentialMonth(new Map())).toBeNull();
    expect(monthsCovered(1_500_000, 1_040_000)).toBe(1.4);
    expect(monthsCovered(1_500_000, null)).toBeNull();
    // 3 × 10,400 = 31,200 → 32,000.
    expect(emergencyTarget(1_040_000)).toBe(3_200_000);
    expect(isEmergency({ title: " emergency FUND " })).toBe(true);
  });

  it("counts your regular bills as essentials, without counting rent twice (F100)", () => {
    const bill = (over: Partial<RegularRow>): RegularRow => ({
      ...regular("bill"),
      rule_json: '{"every":"month","day":1}',
      ...over,
    });
    const usual = new Map<string, number | null>([
      ["cat_food", 294_000],
      ["cat_transport", 23_000],
    ]);
    const bills = [
      bill({ id: "rent", amount_minor: 1_200_000, category_id: "cat_housing" }),
      // Outside the essential categories: added as the comment promises.
      bill({ id: "net", amount_minor: 120_000, category_id: "cat_shopping" }),
      // $15 a month at 132.50 = 1,987.50 ETB.
      bill({ id: "figma", amount_minor: 1_500, category_id: null, currency: "USD" }),
      // Weekly on Mon and Thu: 100 × 2 × 52 / 12 ≈ 866.67 a month.
      bill({
        id: "maid",
        amount_minor: 10_000,
        category_id: "cat_food",
        rule_json: '{"every":"week","days":[1,4]}',
      }),
      // Paused or pay: not counted.
      bill({ id: "old", amount_minor: 999_900, category_id: "cat_housing", active: 0 }),
      { ...bill({ id: "pay", amount_minor: 999_900 }), kind: "pay" as const },
    ];
    const rates = { USD: { rate: "132.50", set_on: "2026-11-01" } };
    // Food: the larger of usual 2,940 and bills 866.67 = 2,940.
    expect(essentialMonth(usual, bills, rates)).toBe(
      294_000 + 23_000 + 1_200_000 + 120_000 + 198_750,
    );
    // Rent already in the usual month: the larger, not the sum.
    expect(
      essentialMonth(new Map([["cat_housing", 1_200_000]]), [bills[0] as RegularRow], rates),
    ).toBe(1_200_000);
    // No history yet: the bills alone.
    expect(essentialMonth(new Map(), [bills[0] as RegularRow])).toBe(1_200_000);
    // 15,170 a month × 3 = 45,510 → 46,000.
    expect(emergencyTarget(essentialMonth(usual, [bills[0] as RegularRow]) ?? 0)).toBe(4_600_000);
  });

  it("reads this month's saving per goal", () => {
    const db = openTestDb();
    const add = db.prepare(
      "INSERT INTO savings_entries (id, goal_id, occurred_at, local_date, amount_minor, created_at, updated_at) VALUES (?, ?, 0, ?, ?, 0, 0)",
    );
    db.prepare(
      "INSERT INTO savings_goals (id, title, target_minor, start_date, created_at, updated_at) VALUES ('trip', 'Trip', 900000, '2026-11-01', 0, 0)",
    ).run();
    add.run("a", "trip", "2026-11-03", 50_000);
    add.run("b", "trip", "2026-11-10", 50_000);
    add.run("c", "trip", "2026-10-30", 70_000);
    expect(db.prepare(GOAL_MONTH_SQL).all("2026-11-01", "2026-11-30")).toEqual([
      { goal_id: "trip", minor: 100_000 },
    ]);
  });
});
