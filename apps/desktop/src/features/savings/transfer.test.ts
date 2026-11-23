/** A transfer into a savings account is saving, written with it (time-first §4). */
import { describe, expect, it } from "vitest";

import { moveOps, onlyActiveGoal, transferSaving, transferSavingOps } from "./savings";

const rates = { USD: { rate: "132.50", set_on: "2026-11-23" } };
const cbo = { id: "cbo", currency: "ETB", is_savings: 0 };
const cash = { id: "cash", is_savings: 0 };
const jar = { id: "cbo-savings", currency: "ETB", is_savings: 1 };
const usdJar = { id: "wise-jar", currency: "USD", is_savings: 1 };

describe("transferSaving", () => {
  it("is saved going in and taken out coming back", () => {
    expect(transferSaving({ from: cbo, to: jar, sent: 500, received: 500, rates })).toEqual({
      account: "cbo-savings",
      minor: 500,
    });
    expect(transferSaving({ from: jar, to: cash, sent: 500, received: 500, rates })).toEqual({
      account: "cbo-savings",
      minor: -500,
    });
  });

  it("is nothing between two of a kind", () => {
    expect(transferSaving({ from: cbo, to: cash, sent: 5, received: 5, rates })).toBeNull();
    expect(transferSaving({ from: jar, to: usdJar, sent: 5, received: 5, rates })).toBeNull();
  });

  it("counts dollars at their birr, and nothing without a rate", () => {
    const wise = { id: "wise", currency: "USD", is_savings: 0 };
    expect(transferSaving({ from: wise, to: usdJar, sent: 5_000, received: 5_000, rates })).toEqual(
      { account: "wise-jar", minor: 662_500 },
    );
    expect(
      transferSaving({ from: wise, to: usdJar, sent: 5_000, received: 5_000, rates: {} }),
    ).toBeNull();
  });
});

describe("transferSavingOps and the goal", () => {
  it("writes the saving tied to the transfer", () => {
    expect(
      transferSavingOps({
        saving: { account: "cbo-savings", minor: 500 },
        goalId: "g1",
        transferId: "t1",
        nowMs: 1,
        date: "2026-11-23",
        id: "e1",
        origin: "capture",
      }),
    ).toEqual([
      {
        op: "insert",
        table: "savings_entries",
        id: "e1",
        values: {
          goal_id: "g1",
          occurred_at: 1,
          local_date: "2026-11-23",
          amount_minor: 500,
          note: null,
          origin: "capture",
          account: "cbo-savings",
          transfer_id: "t1",
        },
      },
    ]);
    expect(
      transferSavingOps({
        saving: null,
        goalId: "g1",
        transferId: "t1",
        nowMs: 1,
        date: "2026-11-23",
        id: "e1",
        origin: "capture",
      }),
    ).toEqual([]);
  });

  it("goes to the only active goal, else waits", () => {
    expect(onlyActiveGoal([{ id: "a", status: "active" }])).toBe("a");
    expect(
      onlyActiveGoal([
        { id: "a", status: "active" },
        { id: "b", status: "done" },
      ]),
    ).toBe("a");
    expect(
      onlyActiveGoal([
        { id: "a", status: "active" },
        { id: "b", status: "active" },
      ]),
    ).toBeNull();
    expect(onlyActiveGoal([])).toBeNull();
  });

  it("lets Put aside wait for a goal and carry the capture's origin", () => {
    const ops = moveOps({
      goal: null,
      sign: 1,
      amount: 500,
      spend: { id: "cbo", name: "CBO", currency: "ETB" },
      savings: { id: "cbo-savings", name: "CBO savings", currency: "ETB" },
      nowMs: 1,
      date: "2026-11-23",
      ids: { entry: "e", halves: ["h1", "h2"], transfer: "t" },
      origin: "capture",
      note: "laptop",
    });
    expect(ops.map((op) => ("values" in op ? op.values.origin : null))).toEqual([
      "capture",
      "capture",
      "capture",
    ]);
    expect(ops[2]).toMatchObject({ values: { goal_id: null, note: "laptop", transfer_id: "t" } });
  });
});
