/**
 * `pnpm eval:ai` (plan §7.6): asks the real model for the AI parts of the
 * eval set and compares the pass count with evals/baseline.json. A prompt or
 * model change ships only if the count doesn't drop.
 *
 *   GEMINI_API_KEY=… GEMINI_MODEL=gemini-3.5-flash-lite pnpm eval:ai
 *   EVAL_UPDATE=1 … pnpm eval:ai      # save this run as the baseline
 *
 * A developer tool: it calls Google directly from Node with the key from the
 * environment (the app itself only ever goes through the Rust gate). Without
 * a key the whole file is skipped.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { systemClock } from "../src/kernel/clock";
import { checkWithDate } from "../src/features/projects/capacity";
import { type CaptureCase, readJsonl, type TimingCase } from "../src/features/ai/evalset";
import { timingFacts } from "../src/features/ai/facts";
import { geminiBody } from "../src/features/ai/providers";
import { type AiTask, type LlmProvider, plain, runTask } from "../src/features/ai/task";
import { CAPTURE, TIMING } from "../src/features/ai/touchpoints";

const KEY = process.env.GEMINI_API_KEY ?? "";
const MODEL = process.env.GEMINI_MODEL ?? "";
const PACE_MS = 7000;

let last = 0;
const live: LlmProvider = {
  id: "gemini",
  privacyTier: "free-may-train",
  async generate(request) {
    const wait = last + PACE_MS - systemClock.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    last = systemClock.now();
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": KEY },
        body: JSON.stringify(geminiBody(request, true)),
        redirect: "error",
      },
    );
    const json = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      error?: { message?: string };
    };
    if (!response.ok)
      return { ok: false, code: `http:${response.status}:${json.error?.message ?? ""}` };
    const text = json.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("");
    return text ? { ok: true, text } : { ok: false, code: "http:200:no text" };
  },
};

/** Each case on its own: the app's 10-minute pause after bad replies isn't the model's score. */
function fresh<I, O>(task: AiTask<I, O>, input: I) {
  plain.bad = 0;
  plain.until = 0;
  return runTask(task, input, live);
}

interface Score {
  model: string;
  date: string;
  timing: { pass: number; total: number };
  capture: { pass: number; total: number };
}

describe.skipIf(!KEY || !MODEL)("AI evals (live)", () => {
  it(
    "scores the model and keeps the baseline",
    async () => {
      const score: Score = {
        model: MODEL,
        date: new Date(systemClock.now()).toISOString().slice(0, 10),
        timing: { pass: 0, total: 0 },
        capture: { pass: 0, total: 0 },
      };

      // Timing reasons: every dated idea must get a valid, grounded reply.
      for (const c of readJsonl<TimingCase>("timing.jsonl")) {
        if (!c.deadline) continue;
        const check = checkWithDate(c.estimateMin, c.deadline, c.today, c.week, c.projects);
        const facts = timingFacts(
          { title: c.idea, area: null },
          c.estimateMin,
          c.deadline,
          check,
          c.projects
            .filter((p) => p.status === "active")
            .map((p) => ({ title: `Project ${p.id}`, area: null })),
          false,
        );
        score.timing.total += 1;
        const result = await fresh(TIMING, facts);
        if (result.ok && result.value.reasons.length > 0) score.timing.pass += 1;
        else console.warn(`timing "${c.name}":`, result.ok ? "no reasons" : result.code);
      }

      // Capture fallback: 10 loose ends a request; the kind must match.
      const cases = readJsonl<CaptureCase>("capture.jsonl");
      const areas = [
        { id: "admin", name: "Life admin" },
        { id: "jobhunt", name: "Job hunt" },
        { id: "coding", name: "Coding skills" },
        { id: "experiments", name: "Experiments" },
        { id: "gym", name: "Gym" },
        { id: "quran", name: "Quran" },
      ];
      for (let i = 0; i < cases.length; i += 10) {
        const batch = cases.slice(i, i + 10);
        score.capture.total += batch.length;
        const result = await fresh(CAPTURE, {
          notes: batch.map((c) => ({ ref: c.ref, body: c.text })),
          areas,
        });
        if (!result.ok) {
          console.warn(`capture batch ${i / 10 + 1}:`, result.code);
          continue;
        }
        const byRef = new Map(result.value.items.map((item) => [item.ref, item]));
        for (const c of batch) if (byRef.get(c.ref)?.kind === c.kind) score.capture.pass += 1;
      }

      const file = new URL("./baseline.json", import.meta.url);
      writeFileSync(
        new URL("./last-run.json", import.meta.url),
        `${JSON.stringify(score, null, 2)}\n`,
      );
      console.warn(score);
      if (process.env.EVAL_UPDATE === "1" || !existsSync(file)) {
        writeFileSync(file, `${JSON.stringify(score, null, 2)}\n`);
        return;
      }
      const baseline = JSON.parse(readFileSync(file, "utf8")) as Score;
      expect(score.timing.pass, "timing passes dropped").toBeGreaterThanOrEqual(
        baseline.timing.pass,
      );
      expect(score.capture.pass, "capture passes dropped").toBeGreaterThanOrEqual(
        baseline.capture.pass,
      );
    },
    20 * 60 * 1000,
  );
});
