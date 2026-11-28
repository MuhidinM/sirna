/**
 * The offline half of the eval set (plan §7.6): `evals/timing.jsonl` holds 20
 * ideas with fixed fact sheets and the verdict or slot the app must give.
 * `pnpm test` checks the numbers here; `pnpm eval:ai` asks the model for the
 * words (evals/ai.eval.ts). `evals/command.jsonl` holds 30 smart-capture
 * lines: offline, each must be one the rules send to the AI.
 */
import { describe, expect, it } from "vitest";

import { checkWithDate, findSlot } from "../projects/capacity";
import { parseCapture } from "../../capture/parse";
import { needsAi } from "../../capture/smart";
import { type CaptureCase, type CommandCase, readJsonl, type TimingCase } from "./evalset";
import { COMMAND_MAX_ITEMS, INTENTS } from "./touchpoints";

const timing = readJsonl<TimingCase>("timing.jsonl");
const capture = readJsonl<CaptureCase>("capture.jsonl");
const command = readJsonl<CommandCase>("command.jsonl");
const ETHIOPIC = /\p{Script=Ethiopic}/u;

describe("eval set", () => {
  it("has 20 timing ideas and 60 loose captures", () => {
    expect(timing).toHaveLength(20);
    expect(capture).toHaveLength(60);
    expect(new Set(capture.map((c) => c.ref)).size).toBe(60);
  });

  it("has 30 smart-capture lines, mixed English and Amharic, from the closed intent list", () => {
    expect(command).toHaveLength(30);
    expect(new Set(command.map((c) => c.ref)).size).toBe(30);
    expect(command.filter((c) => ETHIOPIC.test(c.text)).length).toBeGreaterThanOrEqual(10);
    for (const c of command) {
      expect(c.intents.length).toBeGreaterThan(0);
      expect(c.intents.length).toBeLessThanOrEqual(COMMAND_MAX_ITEMS);
      for (const intent of c.intents) expect(INTENTS).toContain(intent);
    }
  });

  it.each(command.map((c) => [c.ref, c] as const))("command %s goes to the AI", (_, c) => {
    const nowMs = Date.parse("2026-11-28T10:00:00+03:00");
    expect(needsAi(parseCapture(c.text, { nowMs }), c.text)).toBe(true);
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
