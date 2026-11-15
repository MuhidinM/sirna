import { describe, expect, it } from "vitest";

import { MONEY } from "../ai/touchpoints";
import { type AccountRow } from "./accounts";
import {
  dismissedToday,
  dismissOps,
  type Finding,
  findings,
  safeName,
  shownToday,
  tipFacts,
  tipOps,
  tipsToday,
} from "./advisor";
import { type MonthSummary } from "./money";
import { type DueItem, type RegularRow } from "./regulars";
import { type SafeToSpend } from "./safe";

const TODAY = "2026-11-15";
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
const regular = (over: Partial<RegularRow>): RegularRow => ({
  id: "r",
  kind: "bill",
  name: "Internet",
  amount_minor: 120_000,
  rule_json: "{}",
  category_id: null,
  account: "cbe",
  area_id: null,
  active: 1,
  job: null,
  created_at: 0,
  ...over,
});
const item = (over: Partial<DueItem>): DueItem => ({
  regular: regular({}),
  date: "2026-11-17",
  state: "upcoming",
  done: 0,
  left: 120_000,
  ...over,
});
const safe = (over: Partial<SafeToSpend>): SafeToSpend => ({
  known: true,
  total: 500_000,
  perDay: 30_000,
  daysLeft: 16,
  lines: [],
  unknownAccounts: 0,
  ...over,
});
const summary = (over: Partial<MonthSummary>): MonthSummary => ({
  in: 0,
  out: 0,
  saved: 0,
  left: 0,
  sources: [],
  categories: [],
  day: 15,
  days: 30,
  perDay: null,
  ...over,
});
let n = 0;
const base = {
  safe: safe({}),
  due: [] as DueItem[],
  accounts: [] as AccountRow[],
  caps: [] as { id: string; name: string; cap_minor: number }[],
  summary: summary({}),
  today: TODAY,
  nowMs: 0,
  newId: () => `id${++n}`,
};
const kinds = (list: Finding[]) => list.map((f) => [f.kind, f.text]);

describe("the advisor's findings (T-064)", () => {
  it("is quiet when nothing needs you", () => {
    expect(findings(base)).toEqual([]);
  });

  it("says when you're short this month", () => {
    const list = findings({ ...base, safe: safe({ total: -500_000 }) });
    expect(kinds(list)).toEqual([
      [
        "short",
        "You're 5,000 ETB short this month once bills, goals and pay still to come are counted.",
      ],
    ]);
  });

  it("flags late pay with a Received button", () => {
    const pay = item({
      regular: regular({
        id: "paya",
        kind: "pay",
        name: "Job A pay",
        job: "Job A",
        amount_minor: 1_800_000,
        account: "cbo",
      }),
      date: "2026-11-10",
      state: "late",
      done: 1_200_000,
      left: 600_000,
    });
    const [finding] = findings({ ...base, due: [pay] });
    expect(finding?.text).toBe("Job A pay is 5 days late: 6,000 ETB still to come.");
    expect(finding?.facts).toEqual({
      finding: "pay late",
      job: "Job A",
      daysLate: 5,
      percentReceived: 67,
    });
    expect(finding?.actions[0]?.label).toBe("Received");
    expect(finding?.actions[0]?.ops[0]).toMatchObject({
      table: "money_txns",
      values: { amount_minor: 600_000, regular_id: "paya" },
    });
  });

  it("warns about a bill its account can't cover, and offers to move money", () => {
    const accounts = [
      account({ id: "cbe", name: "CBE", opening_minor: 50_000 }),
      account({ id: "cbo", name: "CBO", opening_minor: 2_000_000 }),
    ];
    const [finding] = findings({ ...base, accounts, due: [item({})] });
    expect(finding?.text).toBe("Internet 1,200 ETB is due on 17 Nov; CBE has 500 ETB.");
    // 700 short, rounded up to 100 birr.
    expect(finding?.actions[0]?.label).toBe("Move 700 ETB from CBO");
    expect(
      finding?.actions[0]?.ops.map((op) => op.op === "insert" && op.values.amount_minor),
    ).toEqual([-70_000, 70_000]);
    // Not soon enough, or covered: nothing.
    expect(findings({ ...base, accounts, due: [item({ date: "2026-11-25" })] })).toEqual([]);
    expect(
      findings({
        ...base,
        accounts: [account({ id: "cbe", opening_minor: 200_000 })],
        due: [item({})],
      }),
    ).toEqual([]);
  });

  it("flags a category over its cap, or running fast", () => {
    const caps = [
      { id: "cat_food", name: "Food", cap_minor: 400_000 },
      { id: "cat_phone", name: "Phone", cap_minor: 50_000 },
    ];
    const s = summary({
      categories: [
        { id: "cat_food", name: "Food", spent: 300_000, usual: 380_000 },
        { id: "cat_phone", name: "Phone", spent: 60_000, usual: null },
        { id: "cat_transport", name: "Transport", spent: 90_000, usual: 100_000 },
      ],
    });
    const list = findings({ ...base, caps, summary: s });
    expect(kinds(list)).toEqual([
      ["cap_over", "Phone is over its cap: 600 ETB of 500 ETB, with 15 days to go."],
      ["pace", "Food: 75% of its cap with 50% of the month gone."],
      ["pace", "Transport: 900 ETB so far, 90% of a usual month with 50% of it gone."],
    ]);
    expect(list[0]?.actions[0]).toMatchObject({ label: "Raise cap to 600 ETB" });
    expect(list[2]?.actions[0]).toMatchObject({ label: "Cap Transport at 1,000 ETB" });
  });

  it("ranks, shows at most two, and hides one for the day with Not now", () => {
    const list = findings({
      ...base,
      safe: safe({ total: -100_000 }),
      caps: [{ id: "cat_phone", name: "Phone", cap_minor: 50_000 }],
      summary: summary({
        categories: [{ id: "cat_phone", name: "Phone", spent: 60_000, usual: null }],
      }),
      due: [
        item({
          regular: regular({
            id: "p",
            kind: "pay",
            name: "Job B pay",
            job: "Job B",
            amount_minor: 100,
          }),
          state: "late",
          date: "2026-11-11",
          left: 100,
        }),
      ],
    });
    expect(list.map((f) => f.kind)).toEqual(["short", "pay_late", "cap_over"]);
    expect(shownToday(list, []).map((f) => f.kind)).toEqual(["short", "pay_late"]);
    const ops = dismissOps(null, TODAY, "short");
    const json = String(ops[0]?.op === "upsert" ? ops[0].values.value_json : "");
    expect(dismissedToday(json, TODAY)).toEqual(["short"]);
    expect(dismissedToday(json, "2026-11-16")).toEqual([]);
    expect(shownToday(list, dismissedToday(json, TODAY)).map((f) => f.kind)).toEqual([
      "pay_late",
      "cap_over",
    ]);
  });

  it("never gives the AI an amount of money", () => {
    const list = findings({
      ...base,
      safe: safe({ total: -500_000 }),
      caps: [{ id: "cat_phone", name: "Phone", cap_minor: 50_000 }],
      summary: summary({
        categories: [{ id: "cat_phone", name: "Phone", spent: 60_000, usual: null }],
      }),
    });
    for (const finding of list) {
      const facts = MONEY.facts(finding.facts);
      expect(facts).not.toMatch(/500|600|ETB|birr/);
    }
  });
});

describe("the AI tip (T-064)", () => {
  const facts = { finding: "over its cap", category: "Food", percentOfCap: 112, daysLeft: 15 };
  it("takes a tip that uses only the facts", () => {
    expect(
      MONEY.ground(
        { tip: "Food is at 112% of its cap; try home meals for the next 15 days." },
        facts,
      ),
    ).toBeNull();
  });
  it("refuses an invented number or any amount of money", () => {
    expect(MONEY.ground({ tip: "Cut Food by 30% this week." }, facts)).toMatch(
      /numbers not in the facts/,
    );
    expect(MONEY.ground({ tip: "Spend under 200 birr a day." }, facts)).toMatch(/amount of money/);
  });
});

describe("after the Milestone 3 review", () => {
  it("checks bills due from one account together", () => {
    const accounts = [
      account({ id: "cbe", name: "CBE", opening_minor: 500_000 }),
      account({ id: "cbo", name: "CBO", opening_minor: 2_000_000 }),
    ];
    const rent = item({
      regular: regular({ id: "rent", name: "Rent", amount_minor: 400_000 }),
      left: 400_000,
    });
    const net = item({
      regular: regular({ id: "net", name: "Internet" }),
      date: "2026-11-18",
      left: 200_000,
    });
    const [finding] = findings({ ...base, accounts, due: [rent, net] });
    // 6,000 owed, 5,000 there: one finding for CBE, moving the 1,000 gap.
    expect(finding?.text).toBe(
      "Rent and Internet (6,000 ETB) are due by 18 Nov; CBE has 5,000 ETB.",
    );
    expect(finding?.actions[0]?.label).toBe("Move 1,000 ETB from CBO");
  });

  it("offers no cap for uncategorized or hidden spending, or once you're past your usual", () => {
    const s = summary({
      categories: [
        { id: "", name: "Other", spent: 250_000, usual: 300_000 },
        { id: "cat_taxi", name: "Taxi", spent: 90_000, usual: 100_000 },
        { id: "cat_food", name: "Food", spent: 450_000, usual: 400_000 },
      ],
    });
    const list = findings({ ...base, summary: s, hidden: ["cat_taxi"] });
    expect(list.map((f) => f.key)).toEqual(["pace:cat_food"]);
    expect(list[0]?.actions).toEqual([]);
  });

  it("keeps digits and, in strict mode, names away from the AI", () => {
    expect(safeName("Job 2 pay 5000")).toBe("Job pay");
    expect(safeName("123")).toBe("it");
    const facts = { finding: "pay late", job: "Job A", daysLate: 3 };
    expect(tipFacts(facts, true)).toEqual({ finding: "pay late", daysLate: 3 });
    expect(tipFacts(facts, false)).toBe(facts);
  });

  it("keeps one tip per finding for the day", () => {
    const [op] = tipOps(null, TODAY, "short", "Hold off on extras this week.");
    const json = String(op?.op === "upsert" ? op.values.value_json : "");
    expect(tipsToday(json, TODAY)).toEqual({ short: "Hold off on extras this week." });
    const [next] = tipOps(json, TODAY, "pace:cat_food", "");
    const both = String(next?.op === "upsert" ? next.values.value_json : "");
    expect(tipsToday(both, TODAY)).toEqual({
      short: "Hold off on extras this week.",
      "pace:cat_food": "",
    });
    expect(tipsToday(both, "2026-11-16")).toEqual({});
  });
});
