import { describe, expect, it } from "vitest";

import { formatAmount, parseAmount } from "./money";

describe("parseAmount", () => {
  it.each([
    ["350", 35_000],
    ["1,200", 120_000],
    ["12,000.50", 1_200_050],
    ["12000.5", 1_200_050],
    ["0.75", 75],
    ["12k", 1_200_000],
    ["1.5k", 150_000],
    ["ETB 350", 35_000],
    ["350 birr", 35_000],
    ["350br", 35_000],
    ["Br 1 200", 120_000],
    ["  60  ", 6_000],
  ])("reads %j as %i santim", (text, santim) => {
    expect(parseAmount(text)).toBe(santim);
  });

  it.each(["", "lunch", "12.345", "1.2.3", "12kk", "-5", "abc 12", "1e5"])("rejects %j", (text) => {
    expect(parseAmount(text)).toBeNull();
  });

  it("never goes through floating point", () => {
    // 0.1 + 0.2 style errors would show up here as 1_200_049 or similar.
    expect(parseAmount("12000.51")).toBe(1_200_051);
    expect(parseAmount("0.29")).toBe(29);
  });
});

describe("formatAmount", () => {
  it.each([
    [35_000, "350 ETB"],
    [1_200_000, "12,000 ETB"],
    [1_200_050, "12,000.50 ETB"],
    [5, "0.05 ETB"],
    [0, "0 ETB"],
    [-35_000, "-350 ETB"],
  ])("formats %i santim as %j", (santim, text) => {
    expect(formatAmount(santim)).toBe(text);
  });

  it("refuses non-integer santim", () => {
    expect(() => formatAmount(1.5)).toThrow(RangeError);
  });

  it("round-trips through parseAmount", () => {
    for (const santim of [1, 99, 100, 35_000, 1_200_050]) {
      expect(parseAmount(formatAmount(santim))).toBe(santim);
    }
  });
});
