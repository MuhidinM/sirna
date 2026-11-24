import { describe, expect, it } from "vitest";

import { openTestDb } from "../../test/sqlite";
import { type AccountRow, ACCOUNTS_SQL, balanceOf } from "./accounts";
import {
  checkRegular,
  regularDraftOf,
  type DueItem,
  dueItems,
  dueLines,
  dueWindow,
  LATE_KEEP_DAYS,
  occurrences,
  parseRule,
  pauseOps,
  readRule,
  type RegularRow,
  regularOps,
  REGULARS_SQL,
  REGULAR_TXNS_SQL,
  type RegularTxn,
  ruleText,
  settleOps,
  skipOps,
} from "./regulars";

describe("repeat rules (T-059)", () => {
  it("reads monthly, last day, weekly and weekdays", () => {
    expect(parseRule("monthly 10")).toEqual({ every: "month", day: 10 });
    expect(parseRule("Monthly on the 21st")).toEqual({ every: "month", day: 21 });
    expect(parseRule("monthly last")).toEqual({ every: "month", day: 31 });
    expect(parseRule("every mon, thu")).toEqual({ every: "week", days: [1, 4] });
    expect(parseRule("every friday")).toEqual({ every: "week", days: [5] });
    expect(parseRule("every weekday")).toEqual({ every: "week", days: [1, 2, 3, 4, 5] });
    expect(parseRule("monthly 32")).toBeNull();
    expect(parseRule("sometimes")).toBeNull();
    expect(ruleText({ every: "month", day: 1 })).toBe("monthly on the 1st");
    expect(ruleText({ every: "month", day: 22 })).toBe("monthly on the 22nd");
    expect(ruleText({ every: "month", day: 11 })).toBe("monthly on the 11th");
    expect(ruleText({ every: "week", days: [1, 4] })).toBe("every mon, thu");
  });

  it("falls on the right dates across month ends and short months", () => {
    expect(occurrences({ every: "month", day: 31 }, "2027-01-15", "2027-04-30")).toEqual([
      "2027-01-31",
      "2027-02-28",
      "2027-03-31",
      "2027-04-30",
    ]);
    expect(occurrences({ every: "month", day: 10 }, "2026-11-11", "2026-12-31")).toEqual([
      "2026-12-10",
    ]);
    // 2026-11-16 is a Monday.
    expect(occurrences({ every: "week", days: [1, 4] }, "2026-11-16", "2026-11-26")).toEqual([
      "2026-11-16",
      "2026-11-19",
      "2026-11-23",
      "2026-11-26",
    ]);
  });
});

const regular = (over: Partial<RegularRow>): RegularRow => ({
  id: "rent",
  kind: "bill",
  name: "Rent",
  amount_minor: 600_000,
  rule_json: JSON.stringify({ every: "month", day: 1 }),
  category_id: "cat_housing",
  account: "cbo",
  area_id: null,
  active: 1,
  job: null,
  created_at: 0,
  ...over,
});
const jobA = regular({
  id: "paya",
  kind: "pay",
  name: "Job A pay",
  amount_minor: 1_800_000,
  rule_json: JSON.stringify({ every: "month", day: 10 }),
  category_id: "cat_salary",
  area_id: "joba",
  job: "Job A",
});
const jobB = regular({
  ...jobA,
  id: "payb",
  name: "Job B pay",
  amount_minor: 2_100_000,
  rule_json: JSON.stringify({ every: "month", day: 21 }),
  area_id: "jobb",
  job: "Job B",
});
const txn = (over: Partial<RegularTxn>): RegularTxn => ({
  regular_id: null,
  due_date: null,
  area_id: null,
  amount_minor: 0,
  local_date: "2026-11-10",
  ...over,
});
const states = (items: DueItem[]) =>
  items.map((item) => [item.regular.id, item.date, item.state, item.left]);

describe("what is due (T-059, T-060)", () => {
  it("knows paid, due, late and upcoming bills", () => {
    const water = regular({
      id: "water",
      name: "Water",
      amount_minor: 20_000,
      rule_json: JSON.stringify({ every: "month", day: 14 }),
    });
    const net = regular({
      id: "net",
      name: "Internet",
      amount_minor: 120_000,
      rule_json: JSON.stringify({ every: "month", day: 20 }),
    });
    const items = dueItems(
      [regular({}), water, net],
      [txn({ regular_id: "rent", due_date: "2026-11-01", amount_minor: -600_000 })],
      "2026-11-01",
      "2026-11-30",
      "2026-11-14",
    );
    expect(states(items)).toEqual([
      ["rent", "2026-11-01", "paid", 0],
      ["water", "2026-11-14", "due", 20_000],
      ["net", "2026-11-20", "upcoming", 120_000],
    ]);
    const late = dueItems([water], [], "2026-11-01", "2026-11-30", "2026-11-15");
    expect(late[0]?.state).toBe("late");
    expect(dueLines(items)).toEqual(["Water 200 ETB due today"]);
    expect(dueLines(late)).toEqual(["Water 200 ETB was due 14 Nov"]);
  });

  it("doesn't ask about dates before you added it", () => {
    const added = Date.parse("2026-11-14T09:00:00+03:00");
    const items = dueItems(
      [regular({ created_at: added })],
      [],
      "2026-11-01",
      "2026-12-31",
      "2026-11-14",
    );
    expect(states(items)).toEqual([["rent", "2026-12-01", "upcoming", 600_000]]);
  });

  it("matches pay to its job from income you captured, and flags it 3 days late", () => {
    const captured = [txn({ area_id: "joba", amount_minor: 1_200_000, local_date: "2026-11-11" })];
    const items = dueItems([jobA, jobB], captured, "2026-11-01", "2026-11-30", "2026-11-14");
    // 12,000 of 18,000 came: 6,000 outstanding, 4 days after the 10th → late.
    expect(states(items)).toEqual([
      ["paya", "2026-11-10", "late", 600_000],
      ["payb", "2026-11-21", "upcoming", 2_100_000],
    ]);
    expect(dueLines(items)).toEqual(["Job A pay is late: 6,000 ETB expected on 10 Nov"]);
    const onTime = dueItems([jobA], captured, "2026-11-01", "2026-11-30", "2026-11-13");
    expect(onTime[0]?.state).toBe("due");
    const full = dueItems(
      [jobA],
      [...captured, txn({ area_id: "joba", amount_minor: 600_000, local_date: "2026-11-12" })],
      "2026-11-01",
      "2026-11-30",
      "2026-11-14",
    );
    expect(full[0]?.state).toBe("paid");
  });

  it("doesn't let an entry in another currency settle a regular (F7)", () => {
    const figma = regular({
      id: "figma",
      name: "Figma",
      amount_minor: 1_500,
      rule_json: JSON.stringify({ every: "month", day: 26 }),
      category_id: "cat_shopping",
      account: "wise",
      currency: "USD",
    });
    const birr = txn({ amount_minor: -1_500, description: "figma", local_date: "2026-11-24" });
    const open = dueItems([figma], [birr], "2026-11-01", "2026-11-30", "2026-11-24");
    expect(states(open)).toEqual([["figma", "2026-11-26", "upcoming", 1_500]]);
    const dollars = dueItems(
      [figma],
      [{ ...birr, currency: "USD" }],
      "2026-11-01",
      "2026-11-30",
      "2026-11-24",
    );
    expect(states(dollars)).toEqual([["figma", "2026-11-26", "paid", 0]]);
    // Pay too: birr from the job doesn't settle dollar pay.
    const usdPay = { ...jobA, currency: "USD" };
    const got = [txn({ area_id: "joba", amount_minor: 1_800_000, local_date: "2026-11-10" })];
    expect(dueItems([usdPay], got, "2026-11-01", "2026-11-30", "2026-11-10")[0]?.state).toBe("due");
  });

  it("reads each entry's currency from its account (F7)", () => {
    const db = openTestDb();
    db.exec(`INSERT INTO money_txns
      (id, account, occurred_at, local_date, amount_minor, description, origin, created_at, updated_at)
      VALUES ('t1', 'wise', 0, '2026-11-24', -1500, 'figma', 'capture', 0, 0),
             ('t2', 'cash', 0, '2026-11-24', -1500, 'figma', 'capture', 0, 0)`);
    const rows = db
      .prepare(REGULAR_TXNS_SQL)
      .all("2026-11-01", "2026-11-30") as unknown as RegularTxn[];
    expect(rows.map((row) => row.currency)).toEqual(["USD", "ETB"]);
  });

  it("keeps an unpaid date until it is paid or skipped, whatever its day of month (F84)", () => {
    // Added on 14 Oct: earlier dates were never yours to pay.
    const added = Date.parse("2026-10-14T12:00:00+03:00");
    const iddir = regular({
      id: "iddir",
      name: "Iddir",
      amount_minor: 20_000,
      rule_json: JSON.stringify({ every: "month", day: 24 }),
      category_id: "cat_family",
      created_at: added,
    });
    const at = (today: string, txns: RegularTxn[] = []) => {
      const window = dueWindow(today);
      return states(dueItems([iddir], txns, window.from, window.to, today, window.shownFrom));
    };
    expect(at("2026-11-24")[0]).toEqual(["iddir", "2026-10-24", "late", 20_000]);
    // Past the month's change and a month on, it is still there (it used to drop silently).
    expect(at("2026-12-01")[0]).toEqual(["iddir", "2026-10-24", "late", 20_000]);
    expect(at("2026-12-26")[0]).toEqual(["iddir", "2026-10-24", "late", 20_000]);
    expect(at("2027-03-01").filter((row) => row[2] === "late")).toHaveLength(5);
    // Paid late, it goes.
    const paid: RegularTxn = {
      regular_id: "iddir",
      due_date: "2026-10-24",
      area_id: null,
      amount_minor: -20_000,
      local_date: "2026-12-20",
    };
    expect(at("2026-12-26", [paid])[0]?.[1]).toBe("2026-11-24");
    // The list keeps a year of unpaid dates.
    expect(LATE_KEEP_DAYS).toBeGreaterThanOrEqual(365);
  });

  it("skips one date, keeps the skip when changed, and pauses (F29)", () => {
    const iddir = regular({
      id: "iddir",
      name: "Iddir",
      amount_minor: 20_000,
      rule_json: JSON.stringify({ every: "month", day: 24 }),
    });
    const [late] = dueItems([iddir], [], "2026-10-01", "2026-11-30", "2026-11-24", "2026-11-01");
    if (!late) throw new Error("no late item");
    expect(late.date).toBe("2026-10-24");
    const [op] = skipOps(late, "2026-11-24");
    expect(op).toEqual({
      op: "update",
      table: "money_regulars",
      id: "iddir",
      values: { rule_json: '{"every":"month","day":24,"skip":["2026-10-24"]}' },
    });
    if (!op || op.op !== "update") throw new Error("no update");
    const skipped = { ...iddir, rule_json: String(op.values.rule_json) };
    expect(readRule(skipped.rule_json)).toEqual({ every: "month", day: 24 });
    expect(
      states(dueItems([skipped], [], "2026-10-01", "2026-11-30", "2026-11-24", "2026-11-01")),
    ).toEqual([["iddir", "2026-11-24", "due", 20_000]]);
    // Changing it keeps what was skipped.
    const draft = { ...regularDraftOf(skipped), amount: 25_000 };
    expect(draft.ruleText).toBe("monthly on the 24th");
    expect(regularOps(draft, "iddir", true)[0]).toMatchObject({
      op: "update",
      values: {
        amount_minor: 25_000,
        rule_json: '{"every":"month","day":24,"skip":["2026-10-24"]}',
      },
    });
    expect(pauseOps(iddir)[0]).toMatchObject({ values: { active: 0 } });
    expect(pauseOps({ ...iddir, active: 0 })[0]).toMatchObject({ values: { active: 1 } });
  });

  it("dates a late payment from an earlier month on its own date (F29)", () => {
    const iddir = regular({
      id: "iddir",
      name: "Iddir",
      amount_minor: 20_000,
      rule_json: JSON.stringify({ every: "month", day: 24 }),
    });
    const [october, november] = dueItems(
      [iddir],
      [],
      "2026-10-01",
      "2026-11-30",
      "2026-11-24",
      "2026-11-01",
    );
    if (!october || !november) throw new Error("no items");
    expect(settleOps(october, "2026-11-24", 5, "e")[0]).toMatchObject({
      values: { local_date: "2026-10-24", due_date: "2026-10-24" },
    });
    expect(settleOps(november, "2026-11-25", 5, "e")[0]).toMatchObject({
      values: { local_date: "2026-11-25", due_date: "2026-11-24" },
    });
  });

  it("never books a late payment before the account's opening date, so the balance drops", () => {
    const iddir = regular({
      id: "iddir",
      name: "Iddir",
      amount_minor: 20_000,
      rule_json: JSON.stringify({ every: "month", day: 24 }),
    });
    const [october] = dueItems([iddir], [], "2026-10-01", "2026-11-30", "2026-11-24", "2026-11-01");
    if (!october) throw new Error("no item");
    // CBO's balance was typed on 20 Nov; Paid on 24 Nov for 24 Oct.
    const db = openTestDb();
    db.prepare(
      "UPDATE money_accounts SET opening_minor = 500000, opening_date = '2026-11-20' WHERE id = 'cbo'",
    ).run();
    const [op] = settleOps(october, "2026-11-24", 5, "e", "2026-11-20");
    if (op?.op !== "insert") throw new Error("insert only");
    expect(op.values).toMatchObject({ local_date: "2026-11-20", due_date: "2026-10-24" });
    const cols = Object.keys(op.values);
    db.prepare(
      `INSERT INTO money_txns (id, ${cols.join(", ")}, created_at, updated_at) VALUES (?, ${cols.map(() => "?").join(", ")}, 0, 0)`,
    ).run(op.id, ...(Object.values(op.values) as (string | number | null)[]));
    const cbo = (db.prepare(ACCOUNTS_SQL).all() as unknown as AccountRow[]).find(
      (a) => a.id === "cbo",
    );
    expect(cbo && balanceOf(cbo)).toBe(480_000);
    // Opened before the due date: still booked on its own date.
    expect(settleOps(october, "2026-11-24", 5, "e", "2026-10-01")[0]).toMatchObject({
      values: { local_date: "2026-10-24" },
    });
  });

  it("records Paid and Received as entries marked with the regular", () => {
    const [bill] = dueItems([regular({})], [], "2026-11-01", "2026-11-30", "2026-11-14");
    if (!bill) throw new Error("no bill");
    expect(settleOps(bill, "2026-11-14", 5, "e1")).toEqual([
      {
        op: "insert",
        table: "money_txns",
        id: "e1",
        values: {
          account: "cbo",
          occurred_at: 5,
          local_date: "2026-11-14",
          amount_minor: -600_000,
          description: "Rent",
          category_id: "cat_housing",
          area_id: null,
          origin: "regular",
          regular_id: "rent",
          due_date: "2026-11-01",
        },
      },
    ]);
    const [pay] = dueItems([jobA], [], "2026-11-01", "2026-11-30", "2026-11-14");
    if (!pay) throw new Error("no pay");
    expect(settleOps(pay, "2026-11-14", 5, "e2")[0]).toMatchObject({
      values: { amount_minor: 1_800_000, area_id: "joba", category_id: "cat_salary" },
    });
  });
});

describe("adding regulars", () => {
  it("checks and saves a bill and a pay day", () => {
    const draft = {
      kind: "bill" as const,
      name: " Rent ",
      amount: 600_000,
      ruleText: "monthly 1",
      categoryId: "cat_housing",
      account: "cbo",
      areaId: "",
    };
    expect(checkRegular(draft)).toBeNull();
    expect(checkRegular({ ...draft, ruleText: "often" })).toMatch(/When/);
    expect(checkRegular({ ...draft, kind: "pay" })).toMatch(/Which job/);
    const db = openTestDb();
    const [op] = regularOps(draft, "rent");
    if (!op || op.op !== "insert") throw new Error("no insert");
    const cols = Object.keys(op.values);
    db.prepare(
      `INSERT INTO money_regulars (id, ${cols.join(", ")}, created_at, updated_at) VALUES ('rent', ${cols.map(() => "?").join(", ")}, 0, 0)`,
    ).run(...(Object.values(op.values) as (string | number | null)[]));
    expect(db.prepare(REGULARS_SQL).all()).toMatchObject([
      { id: "rent", name: "Rent", rule_json: '{"every":"month","day":1}', active: 1 },
    ]);
    expect(db.prepare(REGULAR_TXNS_SQL).all("2026-11-01", "2026-11-30")).toEqual([]);
  });
});
