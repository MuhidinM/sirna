import { describe, expect, it } from "vitest";

import { openTestDb } from "../../test/sqlite";
import {
  cleanOutcomes,
  outcomeOps,
  outcomesText,
  planKey,
  planningWeek,
  readPlan,
  skipStepOps,
  WEEK_PLAN_SQL,
} from "./outcomes";

const json = (ops: ReturnType<typeof outcomeOps>) => {
  const op = ops[0];
  return op?.op === "upsert" ? String(op.values.value_json) : null;
};

describe("the Sunday planning step (T-076)", () => {
  it("plans next week on Sunday and this week otherwise", () => {
    expect(planningWeek("2026-11-15")).toBe("2026-11-16"); // Sunday
    expect(planningWeek("2026-11-16")).toBe("2026-11-16"); // Monday
    expect(planningWeek("2026-11-19")).toBe("2026-11-16"); // Thursday
  });

  it("keeps up to 3 outcomes, trimmed and without repeats", () => {
    expect(
      cleanOutcomes([
        " Ship the invoice ",
        "",
        "ship  the invoice",
        "Gym 3 times",
        "Call mum",
        "Fourth",
      ]),
    ).toEqual(["Ship the invoice", "Gym 3 times", "Call mum"]);
  });

  it("stores outcomes per week and keeps skipped steps", () => {
    const skipped = json(skipStepOps(null, "2026-11-16", "triage"));
    expect(skipStepOps(skipped, "2026-11-16", "triage")).toEqual([]);
    const ops = outcomeOps(skipped, "2026-11-16", ["Ship the invoice", "Gym 3 times"]);
    expect(ops[0]).toMatchObject({
      op: "upsert",
      table: "core_settings",
      id: "week.plan.2026-11-16",
    });
    const plan = readPlan(json(ops));
    expect(plan).toEqual({ outcomes: ["Ship the invoice", "Gym 3 times"], skipped: ["triage"] });
    expect(outcomesText(plan)).toBe("Ship the invoice · Gym 3 times");
    expect(outcomesText(readPlan(null))).toBeNull();
    // Clearing them all counts as skipping.
    expect(readPlan(json(outcomeOps(json(ops), "2026-11-16", ["", " "])))).toEqual({
      outcomes: [],
      skipped: ["triage", "outcomes"],
    });
    expect(readPlan("not json")).toEqual({ outcomes: [], skipped: [] });
    expect(readPlan('{"outcomes":[1,"a"],"skipped":["x","outcomes"]}')).toEqual({
      outcomes: ["a"],
      skipped: ["outcomes"],
    });

    // Each week has its own row.
    const db = openTestDb();
    const put = db.prepare(
      "INSERT INTO core_settings (key, value_json, updated_at) VALUES (?, ?, 0)",
    );
    put.run(planKey("2026-11-16"), json(ops));
    put.run(planKey("2026-11-23"), JSON.stringify({ outcomes: ["Other"], skipped: [] }));
    const row = db.prepare(WEEK_PLAN_SQL).get(planKey("2026-11-16")) as { value_json: string };
    expect(readPlan(row.value_json).outcomes).toEqual(["Ship the invoice", "Gym 3 times"]);
  });
});
