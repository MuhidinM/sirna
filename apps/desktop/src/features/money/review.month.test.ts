import { describe, expect, it } from "vitest";

import { type AccountRow } from "./accounts";
import { type PersonBalance } from "./loans";
import { type MonthSummary } from "./money";
import { isFirstSunday, monthReview } from "./review";

const summary: MonthSummary = {
  in: 3_900_000,
  out: 2_100_000,
  saved: 500_000,
  left: 1_300_000,
  sources: [],
  categories: [
    { id: "cat_food", name: "Food", spent: 520_000, usual: 380_000 },
    { id: "cat_housing", name: "Housing", spent: 600_000, usual: 600_000 },
    { id: "cat_transport", name: "Transport", spent: 40_000, usual: 100_000 },
    { id: "cat_phone", name: "Phone", spent: 60_000, usual: 50_000 },
    { id: "cat_shopping", name: "Shopping", spent: 300_000, usual: null },
  ],
  day: 30,
  days: 30,
  perDay: null,
};
const account = (opening_minor: number, opening_date: string | null): AccountRow => ({
  id: String(opening_minor),
  name: "A",
  kind: "bank",
  opening_minor,
  opening_date,
  pays_in: 0,
  sort_order: 0,
  moved_minor: 0,
});
const person = (owedToMe: number, iOwe: number): PersonBalance => ({
  person: "x",
  owedToMe,
  iOwe,
  since: null,
  followUp: null,
  events: [],
});

describe("the month review (T-066)", () => {
  it("is shown on the first Sunday of a month", () => {
    expect(isFirstSunday("2026-12-06")).toBe(true);
    expect(isFirstSunday("2026-11-01")).toBe(true);
    expect(isFirstSunday("2026-11-08")).toBe(false);
    expect(isFirstSunday("2026-12-05")).toBe(false);
  });

  it("adds up the month that ended", () => {
    const review = monthReview({
      summary,
      caps: [
        { id: "cat_food", name: "Food", cap_minor: 400_000 },
        { id: "cat_housing", name: "Housing", cap_minor: 600_000 },
      ],
      accounts: [account(2_000_000, "2026-11-01"), account(999, null)],
      people: [person(60_000, 0), person(0, 150_000)],
    });
    expect(review).toEqual({
      in: 3_900_000,
      out: 2_100_000,
      // 5,000 of 39,000 = 12.8% → 12.
      savingsRate: 12,
      changes: [
        { name: "Food", spent: 520_000, usual: 380_000, diff: 140_000 },
        { name: "Transport", spent: 40_000, usual: 100_000, diff: -60_000 },
        { name: "Phone", spent: 60_000, usual: 50_000, diff: 10_000 },
      ],
      capsOver: [{ name: "Food", spent: 520_000, cap: 400_000 }],
      // 20,000 + 600 owed to you − 1,500 you owe.
      netWorth: 1_910_000,
      notes: { approx: false, rate: null, missing: null },
    });
  });

  it("has no rate without income and no net worth without a balance", () => {
    const review = monthReview({
      summary: { ...summary, in: 0 },
      caps: [],
      accounts: [account(0, null)],
      people: [],
    });
    expect(review.savingsRate).toBeNull();
    expect(review.netWorth).toBeNull();
  });

  it("counts a category you stopped spending on, and only caps that existed then", () => {
    const review = monthReview({
      summary: {
        ...summary,
        categories: [{ id: "cat_food", name: "Food", spent: 400_000, usual: 380_000 }],
      },
      caps: [
        { id: "cat_food", name: "Food", cap_minor: 300_000, cap_since: "2026-11-02" },
        { id: "cat_x", name: "X", cap_minor: 1, cap_since: null },
      ],
      accounts: [],
      people: [],
      usual: new Map<string, number | null>([
        ["cat_food", 380_000],
        ["cat_transport", 300_000],
        ["", 50_000],
      ]),
      names: new Map([["cat_transport", "Transport"]]),
      monthEnd: "2026-10-31",
    });
    // Transport dropped from 3,000 to 0: the biggest change.
    expect(review.changes.map((change) => [change.name, change.diff])).toEqual([
      ["Transport", -300_000],
      ["Food", 20_000],
    ]);
    // The Food cap began in November, so October isn't judged by it.
    expect(review.capsOver).toEqual([]);
  });
});
