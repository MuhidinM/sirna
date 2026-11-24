import { describe, expect, it } from "vitest";

import { distractedLabel, newestOnly } from "./Focus";

describe("the Distracted button", () => {
  it("shows the count once there is one", () => {
    expect(distractedLabel(0)).toBe("Distracted (+1)");
    expect(distractedLabel(2)).toBe("Distracted · 2");
  });
});

describe("the focus card's status (F64-new)", () => {
  it("keeps the newest answer when an older one comes back late", async () => {
    const answers: ((value: string) => void)[] = [];
    const shown: string[] = [];
    const load = newestOnly(
      () => new Promise<string>((resolve) => answers.push(resolve)),
      (value) => shown.push(value),
    );
    load(); // before the session started
    load(); // after the start event
    answers[1]?.("running");
    answers[0]?.("idle");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shown).toEqual(["running"]);
  });
});
