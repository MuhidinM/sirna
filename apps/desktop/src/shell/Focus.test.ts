import { describe, expect, it } from "vitest";

import { distractedLabel } from "./Focus";

describe("the Distracted button", () => {
  it("shows the count once there is one", () => {
    expect(distractedLabel(0)).toBe("Distracted (+1)");
    expect(distractedLabel(2)).toBe("Distracted · 2");
  });
});
