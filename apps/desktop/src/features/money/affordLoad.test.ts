import { describe, expect, it } from "vitest";

import { toOps, echo } from "../../capture/ops";
import { parseCapture } from "../../capture/parse";
import { type SqlValue } from "../../kernel/db";
import { openTestDb } from "../../test/sqlite";
import { affordAnswer } from "./affordLoad";

const nowMs = Date.parse("2026-11-15T12:00:00+03:00");

describe("afford in the capture box (T-074)", () => {
  it("reads the question and writes nothing but the line", () => {
    expect(parseCapture("afford 4500 shoes", { nowMs })).toEqual({
      kind: "afford",
      amount: 450_000,
      what: "shoes",
    });
    expect(parseCapture("can I afford 2k?", { nowMs })).toEqual({
      kind: "afford",
      amount: 200_000,
    });
    expect(parseCapture("afford a new laptop", { nowMs }).kind).not.toBe("afford");
    const parsed = parseCapture("afford 4500 shoes", { nowMs });
    expect(toOps(parsed, { nowMs, newId: () => "x" })).toEqual([]);
    expect(echo(parsed, nowMs)).toBe("Checking…");
  });

  it("answers from the month before any balance, and from safe to spend after", async () => {
    const db = openTestDb();
    const query = <T>(sql: string, params: SqlValue[] = []) =>
      Promise.resolve(db.prepare(sql).all(...(params as (string | number | null)[])) as T[]);
    db.prepare(
      "INSERT INTO money_txns (id, account, occurred_at, local_date, amount_minor, description, created_at, updated_at) VALUES ('pay', 'cbo', 0, '2026-11-10', 1800000, 'salary', 0, 0)",
    ).run();
    // 18,000 left this month, 16 days: 4,500 is 25% → Fine.
    expect(await affordAnswer(query as never, nowMs, 450_000, "shoes")).toBe(
      "Fine for shoes · It leaves 13,500 ETB left this month for 16 days, about 843 ETB a day (now 1,125 ETB).",
    );
    // Once CBO has a balance, safe to spend decides: 3,000 there → Not now.
    db.prepare(
      "UPDATE money_accounts SET opening_minor = 300000, opening_date = '2026-11-11' WHERE id = 'cbo'",
    ).run();
    expect(await affordAnswer(query as never, nowMs, 450_000)).toBe(
      "Not now · It is 1,500 ETB more than you have safe to spend this month.",
    );
  });
});
