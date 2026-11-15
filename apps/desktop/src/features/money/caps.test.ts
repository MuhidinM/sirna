import { describe, expect, it } from "vitest";

import { openTestDb } from "../../test/sqlite";
import { acceptAllOps, CAPS_SQL, capOps, capStatus, suggestCap } from "./caps";

describe("spending caps (T-063)", () => {
  it("suggests your usual month, rounded up to 100 birr", () => {
    expect(suggestCap(380_000)).toBe(380_000);
    expect(suggestCap(380_001)).toBe(390_000);
    expect(suggestCap(5_000)).toBe(10_000);
    expect(suggestCap(0)).toBeNull();
    expect(suggestCap(null)).toBeNull();
    expect(suggestCap(undefined)).toBeNull();
  });

  it("knows over, ahead of the month, and what is left", () => {
    // Day 14 of 30 ≈ 47% through the month.
    expect(capStatus(200_000, 400_000, 14, 30)).toMatchObject({
      over: false,
      ahead: false,
      left: 200_000,
    });
    // 60% spent at 47% of the month: ahead.
    expect(capStatus(240_000, 400_000, 14, 30)).toMatchObject({ ahead: true, over: false });
    expect(capStatus(450_000, 400_000, 14, 30)).toMatchObject({
      over: true,
      ahead: false,
      left: 0,
    });
    expect(capStatus(100, 400_000, 30, 30).pace).toBe(1);
  });

  it("sets, clears and accepts every suggestion at once", () => {
    const db = openTestDb();
    const apply = (ops: ReturnType<typeof capOps>) => {
      for (const op of ops)
        if (op.op === "update")
          db.prepare("UPDATE money_categories SET cap_minor = ? WHERE id = ?").run(
            op.values.cap_minor as number | null,
            op.id,
          );
    };
    apply(capOps("cat_food", 400_000));
    expect(db.prepare(CAPS_SQL).all()).toEqual([
      { id: "cat_food", name: "Food", cap_minor: 400_000, cap_since: null },
    ]);
    const usual = new Map<string, number | null>([
      ["cat_food", 380_000],
      ["cat_transport", 61_000],
      ["cat_salary", 1_800_000],
      ["cat_health", null],
    ]);
    const categories = db.prepare("SELECT id, kind, cap_minor FROM money_categories").all() as {
      id: string;
      kind: string;
      cap_minor: number | null;
    }[];
    const ops = acceptAllOps(categories, usual);
    // Food already has a cap; income isn't capped; no history, no suggestion.
    expect(ops).toEqual([
      {
        op: "update",
        table: "money_categories",
        id: "cat_transport",
        values: { cap_minor: 70_000 },
      },
    ]);
    apply(capOps("cat_food", null));
    expect(db.prepare(CAPS_SQL).all()).toEqual([]);
  });

  it("starts a first cap on a day and keeps it when the cap changes", () => {
    expect(capOps("cat_food", 400_000, "2026-11-02")[0]).toMatchObject({
      values: { cap_minor: 400_000, cap_since: "2026-11-02" },
    });
    expect(capOps("cat_food", 500_000)[0]).toEqual({
      op: "update",
      table: "money_categories",
      id: "cat_food",
      values: { cap_minor: 500_000 },
    });
    expect(capOps("cat_food", null)[0]).toMatchObject({
      values: { cap_minor: null, cap_since: null },
    });
  });
});
