import { describe, expect, it } from "vitest";

import { createFakeClock } from "./clock";
import { localDate, logicalDate } from "./dates";

// Addis Ababa is UTC+3, so local 03:00 on 11 Nov is 00:00 UTC on 11 Nov.
const at = (iso: string) => Date.parse(iso);

describe("logicalDate", () => {
  it("keeps a daytime instant on its own local date", () => {
    expect(logicalDate(at("2026-11-11T09:00:00Z"))).toBe("2026-11-11"); // 12:00 local
  });

  it("puts 00:30 local on the evening before", () => {
    expect(logicalDate(at("2026-11-10T21:30:00Z"))).toBe("2026-11-10"); // 00:30 on 11 Nov local
  });

  it("starts the new logical day exactly at 03:00 local", () => {
    expect(logicalDate(at("2026-11-10T23:59:59Z"))).toBe("2026-11-10"); // 02:59:59 local
    expect(logicalDate(at("2026-11-11T00:00:00Z"))).toBe("2026-11-11"); // 03:00 local
  });

  it("uses the local date, not the UTC date, late in the evening", () => {
    // 23:00 local on 11 Nov is 20:00 UTC on 11 Nov; 01:00 local on 12 Nov is 22:00 UTC on 11 Nov.
    expect(localDate(at("2026-11-11T22:00:00Z"))).toBe("2026-11-12");
    expect(logicalDate(at("2026-11-11T22:00:00Z"))).toBe("2026-11-11");
  });

  it("crosses month and year boundaries", () => {
    expect(logicalDate(at("2026-12-31T22:00:00Z"))).toBe("2026-12-31"); // 01:00 on 1 Jan local
    expect(logicalDate(at("2027-01-01T00:00:00Z"))).toBe("2027-01-01"); // 03:00 on 1 Jan local
  });

  it("follows a fake clock across the boundary", () => {
    const clock = createFakeClock(at("2026-11-10T23:30:00Z")); // 02:30 local
    expect(logicalDate(clock.now())).toBe("2026-11-10");
    clock.advance(30 * 60 * 1000);
    expect(logicalDate(clock.now())).toBe("2026-11-11");
  });
});
