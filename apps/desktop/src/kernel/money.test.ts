import { describe, expect, it } from "vitest";

import { formatAmount, formatNumber, formatWhole, parseAmount } from "./money";

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

describe("formatAmount in other currencies", () => {
  it.each([
    [120_050, "USD", "$1,200.50"],
    [5_000, "EUR", "€50"],
    [2_000, "GBP", "£20"],
    [-1_550, "USD", "-$15.50"],
    [120_050, "CHF", "1,200.50 CHF"],
    [1_200_000, "ETB", "12,000 ETB"],
  ])("formats %i in %s as %j", (minor, currency, text) => {
    expect(formatAmount(minor, currency)).toBe(text);
  });

  it("gives the number alone", () => {
    expect(formatNumber(1_200_050)).toBe("12,000.50");
    expect(formatNumber(-35_000)).toBe("-350");
  });
});

describe("formatWhole (F108)", () => {
  it("shows an estimate in whole units", () => {
    expect(formatWhole(596_250)).toBe("5,963 ETB");
    expect(formatWhole(16_750)).toBe("168 ETB");
    expect(formatWhole(2_504_750)).toBe("25,048 ETB");
    expect(formatWhole(-2_049)).toBe("-20 ETB");
    expect(formatWhole(-49)).toBe("0 ETB");
    expect(formatWhole(3_050, "USD")).toBe("$31");
  });
});
