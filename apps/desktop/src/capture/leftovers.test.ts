/** Capture lines issue #174 found still misread ("words" leftovers). */
import { describe, expect, it } from "vitest";

import { type ParseOptions, parseCapture } from "./parse";
import { localToEpoch } from "./when";

const at = (local: string) => Date.parse(`${local}+03:00`);
/** Tuesday 24 Nov 2026, 09:30 in Addis Ababa. */
const nowMs = at("2026-11-24T09:30:00");

const accounts = [
  { id: "cash", name: "Cash", kind: "cash", pays_in: 0 },
  { id: "cbo", name: "CBO", kind: "bank", pays_in: 1 },
];
const options: ParseOptions = { nowMs, accounts };
const read = (text: string) => parseCapture(text, options);

describe("a bare hour with tonight / this evening is the evening (#174)", () => {
  it.each(["call mom tonight at 8", "call mom at 8 tonight", "call mom this evening at 8"])(
    "%j",
    (text) => {
      expect(read(text)).toMatchObject({
        kind: "task",
        title: "call mom",
        dueDate: "2026-11-24",
        dueAt: localToEpoch("2026-11-24", 20 * 60),
      });
    },
  );

  it("an am/pm hour is kept as written", () => {
    expect(read("call mom tonight at 11pm")).toMatchObject({
      dueAt: localToEpoch("2026-11-24", 23 * 60),
    });
  });
});

describe("a bare hour right after a day word is the time (#174)", () => {
  it("'tomorrow 9 call abel'", () => {
    expect(read("tomorrow 9 call abel")).toMatchObject({
      kind: "task",
      title: "call abel",
      dueDate: "2026-11-25",
      dueAt: localToEpoch("2026-11-25", 9 * 60),
    });
  });

  it("'mon 10 dentist'", () => {
    expect(read("mon 10 dentist")).toMatchObject({
      kind: "task",
      title: "dentist",
      dueDate: "2026-11-30",
      dueAt: localToEpoch("2026-11-30", 10 * 60),
    });
  });

  it("'tomorrow 3 call abel' is the afternoon", () => {
    expect(read("tomorrow 3 call abel")).toMatchObject({
      dueAt: localToEpoch("2026-11-25", 15 * 60),
    });
  });

  it("amounts stay amounts", () => {
    expect(read("lunch 120")).toMatchObject({ kind: "expense", amount: 12000 });
    expect(read("tomorrow pay rent 9000")).toMatchObject({ kind: "expense", amount: 900000 });
    expect(read("tomorrow 9000 rent")).not.toHaveProperty("dueAt");
    expect(read("mon 3 days off")).not.toHaveProperty("dueAt");
  });
});

describe("'dec 25, 2027' is a date, not amounts (#174)", () => {
  it("'dec 25, 2027 renew passport'", () => {
    expect(read("dec 25, 2027 renew passport")).toMatchObject({
      kind: "task",
      title: "renew passport",
      dueDate: "2027-12-25",
    });
  });

  it("'renew passport dec 25, 2027'", () => {
    expect(read("renew passport dec 25, 2027")).toMatchObject({
      kind: "task",
      title: "renew passport",
      dueDate: "2027-12-25",
    });
  });

  it("a real money list still splits", () => {
    expect(read("lunch 120, taxi 40")).toMatchObject({ kind: "money" });
  });
});

describe("the @account never stays in the title (#174)", () => {
  it.each([
    "pay electricity 800 @cash tomorrow",
    "pay electricity @cash 800 tomorrow",
    "pay electricity 800 tomorrow @cash",
  ])("%j", (text) => {
    expect(read(text)).toMatchObject({
      kind: "task",
      title: "pay electricity 800",
      dueDate: "2026-11-25",
    });
  });
});

describe("review of #174: nearby lines", () => {
  it("'tonight at 8:30' is 20:30, '08:30' stays the 24-hour clock", () => {
    expect(read("call mom tonight at 8:30")).toMatchObject({
      dueAt: localToEpoch("2026-11-24", 20 * 60 + 30),
    });
    expect(read("call mom tonight at 08:30")).toMatchObject({
      dueAt: localToEpoch("2026-11-24", 8 * 60 + 30),
    });
  });

  it("a count after a day mid-line is not a time", () => {
    const parsed = read("buy eggs tomorrow 12 pieces");
    expect(parsed).toMatchObject({
      kind: "task",
      title: "buy eggs 12 pieces",
      dueDate: "2026-11-25",
    });
    expect(parsed).not.toHaveProperty("dueAt", expect.any(Number));
  });

  it("an @account before a count keeps its words", () => {
    expect(read("call @cbo 2 times")).toMatchObject({ kind: "task", title: "call @cbo 2 times" });
  });
});
