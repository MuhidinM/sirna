import { describe, expect, it } from "vitest";

import { pageOf } from "./paging";

describe("pageOf", () => {
  it("shows the 10 newest first, with only Older", () => {
    expect(pageOf(37, 0)).toEqual({
      page: 0,
      start: 0,
      end: 10,
      hasNewer: false,
      hasOlder: true,
      label: "1–10 of 37",
    });
  });

  it("the last page is short and has only Newer", () => {
    const last = pageOf(37, 3);
    expect([last.start, last.end, last.label]).toEqual([30, 37, "31–37 of 37"]);
    expect([last.hasNewer, last.hasOlder]).toEqual([true, false]);
  });

  it("a middle page has both buttons", () => {
    const mid = pageOf(37, 1);
    expect(mid.label).toBe("11–20 of 37");
    expect([mid.hasNewer, mid.hasOlder]).toEqual([true, true]);
  });

  it("exactly 10 calls fit one page with no buttons", () => {
    const one = pageOf(10, 0);
    expect(one.label).toBe("1–10 of 10");
    expect([one.hasNewer, one.hasOlder]).toEqual([false, false]);
  });

  it("a page past the end falls back to the last page", () => {
    expect(pageOf(12, 5).page).toBe(1);
    expect(pageOf(12, -2).page).toBe(0);
  });

  it("nothing sent has no label and no buttons", () => {
    expect(pageOf(0, 0)).toEqual({
      page: 0,
      start: 0,
      end: 0,
      hasNewer: false,
      hasOlder: false,
      label: "",
    });
  });
});
