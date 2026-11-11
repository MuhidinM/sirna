import { beforeEach, describe, expect, it } from "vitest";

import { groundText } from "./ground";
import { mock } from "./providers";
import { s } from "./schema";
import { type AiTask, plain, prompt, runTask } from "./task";

interface Input {
  title: string;
  load: number;
}
interface Output {
  reasons: string[];
}

const TASK: AiTask<Input, Output> = {
  id: "timing",
  version: "1",
  schema: s.object({ reasons: s.array(s.string({ maxLength: 160 }), { maxItems: 3 }) }),
  system: "Explain the numbers. Never change them.",
  facts: (input) => `idea: ${input.title}\nload: ${input.load}%`,
  ask: () => "Give up to 3 short reasons.",
  ground: (output, input) => groundText(output.reasons, TASK.facts(input)),
};
const INPUT = { title: "CLI tool", load: 96 };

beforeEach(() => {
  plain.bad = 0;
  plain.until = 0;
});

describe("runTask", () => {
  it("returns a checked, grounded reply", async () => {
    const provider = mock({ timing: '{"reasons":["Load reaches 96%."]}' });
    expect(await runTask(TASK, INPUT, provider)).toEqual({
      ok: true,
      value: { reasons: ["Load reaches 96%."] },
    });
    expect(provider.requests[0]).toMatchObject({ task: "timing", promptVersion: "timing@1" });
    expect(provider.requests[0]?.prompt).toContain("load: 96%");
  });

  it("passes the gate's codes through for the template fallback", async () => {
    expect(await runTask(TASK, INPUT, mock({}))).toEqual({ ok: false, code: "no-key" });
    const limited = mock({ timing: () => ({ ok: false, code: "budget:15" }) });
    expect(await runTask(TASK, INPUT, limited)).toEqual({ ok: false, code: "budget:15" });
  });

  it("throws away invalid and ungrounded replies", async () => {
    expect(await runTask(TASK, INPUT, mock({ timing: "nope" }))).toEqual({
      ok: false,
      code: "invalid:reply: not JSON",
    });
    expect(
      await runTask(TASK, INPUT, mock({ timing: '{"reasons":["Load reaches 104%."]}' })),
    ).toEqual({ ok: false, code: "ungrounded:numbers not in the facts: 104" });
  });

  it("stops asking for 10 minutes after 3 bad replies in a row", async () => {
    let now = 1_000;
    const clock = () => now;
    const bad = mock({ timing: "nope" });
    for (let i = 0; i < 3; i++) await runTask(TASK, INPUT, bad, clock);
    expect(await runTask(TASK, INPUT, bad, clock)).toEqual({
      ok: false,
      code: "plain-mode:local",
    });
    expect(bad.requests).toHaveLength(3);
    now += 10 * 60 * 1000;
    expect((await runTask(TASK, INPUT, mock({ timing: '{"reasons":[]}' }), clock)).ok).toBe(true);
  });

  it("puts facts, task and schema in the prompt", () => {
    const text = prompt(TASK, INPUT);
    expect(text).toMatch(/^FACTS\nidea: CLI tool\nload: 96%\n\nTASK\nGive up to 3/);
    expect(text).toContain('"type":"object"');
  });
});
