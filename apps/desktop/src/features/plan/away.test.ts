import { describe, expect, it } from "vitest";

import { awayUntil, returnLabel } from "./away";

describe("awayUntil", () => {
  it("is the return date while it is later than today", () => {
    expect(awayUntil('"2026-11-16"', "2026-11-11")).toBe("2026-11-16");
    expect(awayUntil('"2026-11-16"', "2026-11-16")).toBeUndefined();
    expect(awayUntil('""', "2026-11-11")).toBeUndefined();
    expect(awayUntil(undefined, "2026-11-11")).toBeUndefined();
    expect(awayUntil("not json", "2026-11-11")).toBeUndefined();
  });

  it("labels the return day", () => {
    expect(returnLabel("2026-11-16")).toBe("Mon 16 Nov");
  });
});
