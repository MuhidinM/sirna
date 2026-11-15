import { describe, expect, it } from "vitest";

import { afford } from "./afford";

describe("can I afford it? (T-065)", () => {
  const base = { available: 4_580_000, daysLeft: 16, basis: "safe" as const };

  it("is fine for a small part of what is left", () => {
    const answer = afford({ ...base, amount: 450_000 });
    expect(answer.verdict).toBe("Fine");
    // 41,300 left over 16 days = 2,581.25 → 2,581; before 2,862.5 → 2,862.
    expect(answer).toMatchObject({ after: 4_130_000, perDayAfter: 258_100, perDayBefore: 286_200 });
    expect(answer.reasons[0]).toBe(
      "It leaves 41,300 ETB safe to spend for 16 days, about 2,581 ETB a day (now 2,862 ETB).",
    );
  });

  it("is tight for a big share, or when the daily figure halves", () => {
    const big = afford({ ...base, amount: 1_500_000 });
    expect(big.verdict).toBe("Tight");
    expect(big.reasons[1]).toBe("That is 33% of what you have safe to spend.");
    expect(afford({ ...base, available: 100_000, amount: 20_000 }).verdict).toBe("Fine");
    expect(afford({ ...base, available: 100_000, amount: 26_000 }).verdict).toBe("Tight");
  });

  it("is not now when it is more than you have", () => {
    const answer = afford({ ...base, amount: 5_000_000 });
    expect(answer).toMatchObject({ verdict: "Not now", after: -420_000, perDayAfter: null });
    expect(answer.reasons).toEqual([
      "It is 4,200 ETB more than you have safe to spend this month.",
      "Wait for next month's pay, or save for it as a goal.",
    ]);
  });

  it("says when it only knows the month's in and out", () => {
    const answer = afford({ amount: 10_000, available: 1_000_000, daysLeft: 10, basis: "month" });
    expect(answer.reasons.at(-1)).toMatch(/Set your account balances/);
    expect(answer.reasons[0]).toMatch(/left this month/);
  });
});
