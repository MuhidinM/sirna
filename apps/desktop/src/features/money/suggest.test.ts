import { describe, expect, it } from "vitest";

import { openTestDb } from "../../test/sqlite";
import {
  notAgainOps,
  readDismissed,
  suggestRegulars,
  suggestSince,
  SUGGEST_SQL,
  type SuggestRow,
  trackOps,
} from "./suggest";

describe("payments that look regular (T-072)", () => {
  it("finds the same amount about once a month in 2 of the last 3 months", () => {
    const db = openTestDb();
    const add = db.prepare(
      "INSERT INTO money_txns (id, account, occurred_at, local_date, amount_minor, description, category_id, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?, ?, 0, 0)",
    );
    let n = 0;
    const spend = (
      date: string,
      minor: number,
      what: string,
      category = "cat_housing",
      account = "cbo",
    ) => add.run(`x${++n}`, account, date, -minor, what, category);
    spend("2026-09-01", 600_000, "Rent");
    spend("2026-10-01", 600_000, "rent");
    spend("2026-11-02", 600_000, "Rent");
    spend("2026-10-05", 120_000, "Internet", "cat_phone");
    spend("2026-11-05", 120_000, "internet", "cat_phone");
    // Daily lunch is not a bill.
    for (const date of ["2026-10-01", "2026-10-02", "2026-11-01", "2026-11-02", "2026-11-03"])
      spend(date, 12_000, "lunch", "cat_food", "cash");
    // Once only.
    spend("2026-11-10", 300_000, "Shoes", "cat_shopping");
    expect(suggestSince("2026-11-14")).toBe("2026-09-01");
    const rows = db.prepare(SUGGEST_SQL).all("2026-09-01") as unknown as SuggestRow[];
    const suggestions = suggestRegulars(rows, [], []);
    expect(suggestions.map((s) => s.text)).toEqual([
      "Rent 6,000 ETB around the 2nd looks regular.",
      "Internet 1,200 ETB around the 5th looks regular.",
    ]);
    // Already tracked as a bill, or said No to: not offered.
    expect(
      suggestRegulars(
        rows,
        [{ kind: "bill", name: "Rent", amount_minor: 600_000 }],
        [suggestions[1]?.key ?? ""],
      ),
    ).toEqual([]);
  });

  it("tracks one as a monthly bill, or never asks again", () => {
    const suggestion = {
      key: "rent|600000",
      name: "Rent",
      amount: 600_000,
      day: 1,
      categoryId: "cat_housing",
      account: "cbo",
      text: "",
    };
    expect(trackOps(suggestion, "r")[0]).toMatchObject({
      op: "insert",
      table: "money_regulars",
      values: {
        kind: "bill",
        name: "Rent",
        amount_minor: 600_000,
        rule_json: '{"every":"month","day":1}',
        category_id: "cat_housing",
        account: "cbo",
      },
    });
    const [op] = notAgainOps(null, "rent|600000");
    const json = String(op?.op === "upsert" ? op.values.value_json : "");
    expect(readDismissed(json)).toEqual(["rent|600000"]);
    expect(readDismissed("not json")).toEqual([]);
  });
});
