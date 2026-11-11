/**
 * The offline half of the eval set (plan §7.6): `evals/timing.jsonl` holds 20
 * ideas with fixed fact sheets and the verdict or slot the app must give.
 * `pnpm test` checks the numbers here; `pnpm eval:ai` asks the model for the
 * words (evals/ai.eval.ts).
 */
import { describe, expect, it } from "vitest";

import { checkWithDate, findSlot } from "../projects/capacity";
import { type CaptureCase, readJsonl, type TimingCase } from "./evalset";

const timing = readJsonl<TimingCase>("timing.jsonl");
const capture = readJsonl<CaptureCase>("capture.jsonl");

describe("eval set", () => {
  it("has 20 timing ideas and 60 loose captures", () => {
    expect(timing).toHaveLength(20);
    expect(capture).toHaveLength(60);
    expect(new Set(capture.map((c) => c.ref)).size).toBe(60);
  });

  it.each(timing.map((c) => [c.name, c] as const))("timing: %s", (_, c) => {
    if (c.deadline) {
      expect(checkWithDate(c.estimateMin, c.deadline, c.today, c.week, c.projects).verdict).toBe(
        c.verdict,
      );
    } else {
      const slot = findSlot(c.estimateMin, c.today, c.week, c.projects, c.weeklyMin ?? null);
      if (c.slot === null) expect(slot).toBeNull();
      else expect(slot).toMatchObject(c.slot ?? {});
    }
  });
});
