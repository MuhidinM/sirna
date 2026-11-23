/** Transfers and questions across currencies (time-first §3). */
import { describe, expect, it } from "vitest";

import { parseCapture } from "../../capture/parse";
import { type SqlValue } from "../../kernel/db";
import { openTestDb } from "../../test/sqlite";
import { transferAmounts } from "./accounts";
import { affordAnswer } from "./affordLoad";
import { exchangeAt, fromEtb, RATES_KEY } from "./currency";
import { loanPeople } from "./loans";

const rates = { USD: { rate: "132.50", set_on: "2026-11-23" } };
const cbo = { name: "CBO", currency: "ETB" };
const wise = { name: "Wise", currency: "USD" };
const cash = { name: "Cash" };

describe("fromEtb and exchangeAt", () => {
  it("turns birr into dollars at the rate, half up", () => {
    expect(fromEtb(2_650_000, "USD", rates)).toBe(20_000);
    expect(fromEtb(66, "USD", rates)).toBe(0); // 0.66 ETB = 0.498 cents
    expect(fromEtb(67, "USD", rates)).toBe(1);
    expect(fromEtb(-2_650_000, "USD", rates)).toBe(-20_000);
    expect(fromEtb(500, "ETB", rates)).toBe(500);
    expect(fromEtb(500, "EUR", rates)).toBeNull();
  });

  it("goes through birr, and names a missing rate", () => {
    expect(exchangeAt(20_000, "USD", "ETB", rates)).toEqual({ minor: 2_650_000 });
    expect(exchangeAt(2_650_000, "ETB", "USD", rates)).toEqual({ minor: 20_000 });
    expect(exchangeAt(100, "USD", "USD", {})).toEqual({ minor: 100 });
    expect(exchangeAt(100, "USD", "EUR", rates)).toEqual({ missing: "EUR" });
    expect(exchangeAt(100, "USD", "ETB", {})).toEqual({ missing: "USD" });
  });
});

describe("transferAmounts", () => {
  it("keeps one currency as typed", () => {
    expect(transferAmounts({ from: cbo, to: cash, amount: 500, rates: {} })).toEqual({
      sent: 500,
      received: 500,
    });
  });

  it("converts the other half at the saved rate", () => {
    expect(transferAmounts({ from: wise, to: cbo, amount: 20_000, rates })).toEqual({
      sent: 20_000,
      received: 2_650_000,
    });
    // The dollars typed are what arrives in Wise.
    expect(
      transferAmounts({ from: cbo, to: wise, amount: 20_000, rates, typed: "USD", word: "$" }),
    ).toEqual({ sent: 2_650_000, received: 20_000 });
  });

  it("says why it can't", () => {
    expect(transferAmounts({ from: wise, to: cbo, amount: 20_000, rates: {} })).toEqual({
      problem: "Set a USD rate in Money → Accounts first",
    });
    expect(
      transferAmounts({ from: cbo, to: wise, amount: 100, rates, typed: "EUR", word: "eur" }),
    ).toEqual({ problem: "CBO is in ETB and Wise in USD; drop the eur" });
    expect(transferAmounts({ from: cbo, to: wise, amount: 1, rates })).toEqual({
      problem: "Too small to move at that rate",
    });
  });
});

describe("afford in another currency", () => {
  const nowMs = Date.parse("2026-11-15T12:00:00+03:00");

  it("reads the currency off the question", () => {
    expect(parseCapture("afford $200", { nowMs })).toEqual({
      kind: "afford",
      amount: 20_000,
      currency: "USD",
    });
    expect(parseCapture("afford 200 usd headphones", { nowMs })).toMatchObject({
      kind: "afford",
      what: "headphones",
      currency: "USD",
    });
  });

  it("answers in birr at the rate, or asks for one", async () => {
    const db = openTestDb();
    const query = <T>(sql: string, params: SqlValue[] = []) =>
      Promise.resolve(db.prepare(sql).all(...(params as (string | number | null)[])) as T[]);
    db.prepare(
      "INSERT INTO money_txns (id, account, occurred_at, local_date, amount_minor, description, created_at, updated_at) VALUES ('pay', 'cbo', 0, '2026-11-10', 6000000, 'salary', 0, 0)",
    ).run();
    expect(await affordAnswer(query as never, nowMs, 20_000, "headphones", "USD")).toBe(
      "Set a USD rate in Money → Accounts first, then ask again.",
    );
    db.prepare("INSERT INTO core_settings (key, value_json, updated_at) VALUES (?, ?, 0)").run(
      RATES_KEY,
      JSON.stringify(rates),
    );
    const answer = await affordAnswer(query as never, nowMs, 20_000, "headphones", "USD");
    expect(answer).toMatch(/^Tight for headphones · \$200 ≈ 26,500 ETB at 132\.50 · /);
    // 60,000 − 26,500 left: the verdict used the birr.
    expect(answer).toContain("It leaves 33,500 ETB");
  });
});

describe("loanPeople", () => {
  it("lists each person once, even with loans in two currencies", () => {
    expect(
      loanPeople([
        { person: "Abel", owedToMe: 150_000, iOwe: 0 },
        { person: "abel", owedToMe: 0, iOwe: 5_000 },
        { person: "Sara", owedToMe: 0, iOwe: 2_000 },
      ]),
    ).toEqual([
      { name: "Abel", owedToMe: 150_000, iOwe: 5_000 },
      { name: "Sara", owedToMe: 0, iOwe: 2_000 },
    ]);
  });
});
