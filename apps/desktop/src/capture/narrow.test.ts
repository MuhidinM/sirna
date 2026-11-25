/**
 * Narrow fixes to how capture reads the time: "tonight at 12" is midnight,
 * "tomorrow 12 eggs" is a count, and "call mom tonight 8" is 20:00. Every
 * other line reads exactly as before (the table at the end).
 */
import { describe, expect, it } from "vitest";

import { type ParseOptions, type Parsed, parseCapture } from "./parse";
import { type ClockStyle, localToEpoch, readWhen } from "./when";

const at = (local: string) => Date.parse(`${local}+03:00`);
/** Tuesday 24 Nov 2026, 09:30 in Addis Ababa. */
const nowMs = at("2026-11-24T09:30:00");
/** The same evening, and after midnight (still Tuesday's logical day). */
const lateMs = at("2026-11-24T23:30:00");
const smallHoursMs = at("2026-11-25T01:30:00");

const accounts = [
  { id: "cash", name: "Cash", kind: "cash", pays_in: 0 },
  { id: "cbo", name: "CBO", kind: "bank", pays_in: 1 },
];
const read = (text: string, now = nowMs, clockStyle: ClockStyle = "western") =>
  parseCapture(text, { nowMs: now, accounts, clockStyle } satisfies ParseOptions);

describe("tonight at 12 is midnight", () => {
  it.each(["tonight at 12", "this evening at 12"])("%j is 00:00 after today", (text) => {
    expect(readWhen(text, nowMs)).toMatchObject({ date: "2026-11-24", minutes: 24 * 60 });
  });

  it("'tonight at 12:30' is 00:30", () => {
    expect(readWhen("tonight at 12:30", nowMs)).toMatchObject({
      date: "2026-11-24",
      minutes: 24 * 60 + 30,
    });
  });

  it("'call mom tonight at 12' is due today, at the midnight that ends it", () => {
    expect(read("call mom tonight at 12")).toEqual({
      kind: "task",
      title: "call mom",
      dueDate: "2026-11-24",
      dueAt: localToEpoch("2026-11-25", 0),
    });
  });

  it("said at 23:30 it is the coming midnight", () => {
    expect(read("call mom tonight at 12", lateMs)).toMatchObject({
      dueDate: "2026-11-24",
      dueAt: localToEpoch("2026-11-25", 0),
    });
  });

  it("said at 01:30 it is tonight's midnight, not the one just gone", () => {
    expect(read("call mom tonight at 12", smallHoursMs)).toMatchObject({
      dueDate: "2026-11-25",
      dueAt: localToEpoch("2026-11-26", 0),
      tonight: true,
    });
  });

  it.each(["call mom tonight 12", "call mom this evening 12"])("%j is midnight too", (text) => {
    expect(read(text)).toEqual({
      kind: "task",
      title: "call mom",
      dueDate: "2026-11-24",
      dueAt: localToEpoch("2026-11-25", 0),
    });
  });

  it("'tonight at 12 noon' stays noon, without the noon in the title", () => {
    for (const clock of ["western", "ethiopian"] as const)
      expect(read("call mom tonight at 12 noon", nowMs, clock)).toEqual({
        kind: "task",
        title: "call mom",
        dueDate: "2026-11-24",
        dueAt: localToEpoch("2026-11-24", 12 * 60),
      });
  });

  it.each([
    ["today at 12", 12 * 60],
    ["at 12", 12 * 60],
    ["tonight at noon", 12 * 60],
  ])("%j is unchanged", (text, minutes) => {
    expect(readWhen(text, nowMs)).toMatchObject({ date: "2026-11-24", minutes });
  });

  it("on the Ethiopian clock 'tonight at 12' is still 18:00", () => {
    expect(readWhen("tonight at 12", nowMs, "ethiopian")).toMatchObject({ minutes: 18 * 60 });
  });
});

describe("a count after a day word stays in the title", () => {
  it("'tomorrow 12 eggs' is twelve eggs tomorrow, with no time", () => {
    expect(read("tomorrow 12 eggs")).toEqual({
      kind: "task",
      title: "12 eggs",
      dueDate: "2026-11-25",
    });
  });

  it.each([
    ["mon 2 kg sugar", "2 kg sugar", "2026-11-30"],
    ["tomorrow 2 kg sugar", "2 kg sugar", "2026-11-25"],
    ["fri 3 pieces", "3 pieces", "2026-11-27"],
    ["tomorrow 2 litres milk", "2 litres milk", "2026-11-25"],
  ])("%j", (text, title, dueDate) => {
    expect(read(text)).toEqual({ kind: "task", title, dueDate });
  });
});

describe("'<verb> ... tonight 8' is the hour", () => {
  it("'call mom tonight 8' is 20:00 today", () => {
    expect(read("call mom tonight 8")).toEqual({
      kind: "task",
      title: "call mom",
      dueDate: "2026-11-24",
      dueAt: localToEpoch("2026-11-24", 20 * 60),
    });
  });

  it("'call mom this evening 8' is 20:00 today", () => {
    expect(read("call mom this evening 8")).toMatchObject({
      title: "call mom",
      dueAt: localToEpoch("2026-11-24", 20 * 60),
    });
  });

  it("reads like 'tonight at 8' on either clock", () => {
    for (const clock of ["western", "ethiopian"] as const)
      for (const now of [nowMs, lateMs, smallHoursMs]) {
        const withAt = read("call mom tonight at 8", now, clock) as Extract<
          Parsed,
          { kind: "task" }
        >;
        expect(read("call mom tonight 8", now, clock)).toEqual(withAt);
      }
  });

  it("keeps a length after it: 'call abel tonight 9 for 30 min'", () => {
    expect(read("call abel tonight 9 for 30 min")).toEqual({
      kind: "task",
      title: "call abel",
      estimateMin: 30,
      dueDate: "2026-11-24",
      dueAt: localToEpoch("2026-11-24", 21 * 60),
    });
  });

  it.each([
    "pay abel tonight 8",
    "call mom tonight 2 kids",
    "call mom tonight 1 hour",
    "call abel tonight 08",
    "call mom tomorrow evening at 12",
  ])("%j reads as before", (text) => {
    // Pinned to what the parser gave before this change.
    expect(read(text)).toEqual(BEFORE[text]);
  });
});

const BEFORE: Record<string, Parsed> = {
  "pay abel tonight 8": {
    kind: "task",
    title: "pay abel 8",
    dueDate: "2026-11-24",
    plannedWindow: "evening",
  },
  "call mom tonight 2 kids": {
    kind: "expense",
    description: "call mom kids",
    amount: 200,
    categoryId: "cat_family",
    date: "2026-11-24",
    account: "cash",
    accountName: "Cash",
  },
  "call mom tonight 1 hour": {
    kind: "task",
    title: "call mom 1 hour",
    dueDate: "2026-11-24",
    plannedWindow: "evening",
  },
  "call abel tonight 08": {
    kind: "task",
    title: "call abel 08",
    dueDate: "2026-11-24",
    plannedWindow: "evening",
  },
  "call mom tomorrow evening at 12": {
    kind: "task",
    title: "call mom",
    dueDate: "2026-11-25",
    dueAt: localToEpoch("2026-11-25", 720),
  },
};

/**
 * What main read for each line, with both clocks, at 09:30 and (for the
 * tonight lines) 23:30 and 01:30. `dueAt` is written as local time.
 */
const MAIN: [string, ClockStyle, string, Record<string, unknown>][] = [
  [
    "tomorrow 9 call abel",
    "western",
    "2026-11-24T09:30",
    { kind: "task", title: "call abel", dueDate: "2026-11-25", dueAt: "2026-11-25T09:00" },
  ],
  [
    "tomorrow 9 call abel",
    "ethiopian",
    "2026-11-24T09:30",
    { kind: "task", title: "call abel", dueDate: "2026-11-25", dueAt: "2026-11-25T15:00" },
  ],
  [
    "mon 10 dentist",
    "western",
    "2026-11-24T09:30",
    { kind: "task", title: "dentist", dueDate: "2026-11-30", dueAt: "2026-11-30T10:00" },
  ],
  [
    "mon 10 dentist",
    "ethiopian",
    "2026-11-24T09:30",
    { kind: "task", title: "dentist", dueDate: "2026-11-30", dueAt: "2026-11-30T16:00" },
  ],
  [
    "tomorrow 10 exam",
    "western",
    "2026-11-24T09:30",
    { kind: "task", title: "exam", dueDate: "2026-11-25", dueAt: "2026-11-25T10:00" },
  ],
  [
    "tomorrow 10 exam",
    "ethiopian",
    "2026-11-24T09:30",
    { kind: "task", title: "exam", dueDate: "2026-11-25", dueAt: "2026-11-25T16:00" },
  ],
  [
    "tomorrow 9 team meeting",
    "western",
    "2026-11-24T09:30",
    { kind: "task", title: "team meeting", dueDate: "2026-11-25", dueAt: "2026-11-25T09:00" },
  ],
  [
    "tomorrow 9 team meeting",
    "ethiopian",
    "2026-11-24T09:30",
    { kind: "task", title: "team meeting", dueDate: "2026-11-25", dueAt: "2026-11-25T15:00" },
  ],
  [
    "tomorrow 9 physics",
    "western",
    "2026-11-24T09:30",
    { kind: "task", title: "physics", dueDate: "2026-11-25", dueAt: "2026-11-25T09:00" },
  ],
  [
    "tomorrow 9 physics",
    "ethiopian",
    "2026-11-24T09:30",
    { kind: "task", title: "physics", dueDate: "2026-11-25", dueAt: "2026-11-25T15:00" },
  ],
  [
    "tomorrow 4 maths",
    "western",
    "2026-11-24T09:30",
    { kind: "task", title: "maths", dueDate: "2026-11-25", dueAt: "2026-11-25T16:00" },
  ],
  [
    "tomorrow 4 maths",
    "ethiopian",
    "2026-11-24T09:30",
    { kind: "task", title: "maths", dueDate: "2026-11-25", dueAt: "2026-11-25T10:00" },
  ],
  [
    "tomorrow 9 news",
    "western",
    "2026-11-24T09:30",
    { kind: "task", title: "news", dueDate: "2026-11-25", dueAt: "2026-11-25T09:00" },
  ],
  [
    "tomorrow 9 news",
    "ethiopian",
    "2026-11-24T09:30",
    { kind: "task", title: "news", dueDate: "2026-11-25", dueAt: "2026-11-25T15:00" },
  ],
  [
    "tomorrow 9 james",
    "western",
    "2026-11-24T09:30",
    { kind: "task", title: "james", dueDate: "2026-11-25", dueAt: "2026-11-25T09:00" },
  ],
  [
    "tomorrow 9 james",
    "ethiopian",
    "2026-11-24T09:30",
    { kind: "task", title: "james", dueDate: "2026-11-25", dueAt: "2026-11-25T15:00" },
  ],
  [
    "tomorrow 9 pilates",
    "western",
    "2026-11-24T09:30",
    { kind: "task", title: "pilates", dueDate: "2026-11-25", dueAt: "2026-11-25T09:00" },
  ],
  [
    "tomorrow 9 pilates",
    "ethiopian",
    "2026-11-24T09:30",
    { kind: "task", title: "pilates", dueDate: "2026-11-25", dueAt: "2026-11-25T15:00" },
  ],
  [
    "tomorrow 9 sales calls",
    "western",
    "2026-11-24T09:30",
    { kind: "task", title: "sales calls", dueDate: "2026-11-25", dueAt: "2026-11-25T09:00" },
  ],
  [
    "tomorrow 9 sales calls",
    "ethiopian",
    "2026-11-24T09:30",
    { kind: "task", title: "sales calls", dueDate: "2026-11-25", dueAt: "2026-11-25T15:00" },
  ],
  [
    "tomorrow 9 parents meeting",
    "western",
    "2026-11-24T09:30",
    { kind: "task", title: "parents meeting", dueDate: "2026-11-25", dueAt: "2026-11-25T09:00" },
  ],
  [
    "tomorrow 9 parents meeting",
    "ethiopian",
    "2026-11-24T09:30",
    { kind: "task", title: "parents meeting", dueDate: "2026-11-25", dueAt: "2026-11-25T15:00" },
  ],
  [
    "tomorrow 5 kids pickup",
    "western",
    "2026-11-24T09:30",
    { kind: "task", title: "kids pickup", dueDate: "2026-11-25", dueAt: "2026-11-25T17:00" },
  ],
  [
    "tomorrow 5 kids pickup",
    "ethiopian",
    "2026-11-24T09:30",
    { kind: "task", title: "kids pickup", dueDate: "2026-11-25", dueAt: "2026-11-25T11:00" },
  ],
  [
    "mon 8 kids to school",
    "western",
    "2026-11-24T09:30",
    { kind: "task", title: "kids to school", dueDate: "2026-11-30", dueAt: "2026-11-30T08:00" },
  ],
  [
    "mon 8 kids to school",
    "ethiopian",
    "2026-11-24T09:30",
    { kind: "task", title: "kids to school", dueDate: "2026-11-30", dueAt: "2026-11-30T14:00" },
  ],
  [
    "tomorrow 9 friends coming",
    "western",
    "2026-11-24T09:30",
    { kind: "task", title: "friends coming", dueDate: "2026-11-25", dueAt: "2026-11-25T09:00" },
  ],
  [
    "tomorrow 9 friends coming",
    "ethiopian",
    "2026-11-24T09:30",
    { kind: "task", title: "friends coming", dueDate: "2026-11-25", dueAt: "2026-11-25T15:00" },
  ],
  [
    "tomorrow 9 oil change",
    "western",
    "2026-11-24T09:30",
    { kind: "task", title: "oil change", dueDate: "2026-11-25", dueAt: "2026-11-25T09:00" },
  ],
  [
    "tomorrow 9 oil change",
    "ethiopian",
    "2026-11-24T09:30",
    { kind: "task", title: "oil change", dueDate: "2026-11-25", dueAt: "2026-11-25T15:00" },
  ],
  [
    "tomorrow 9 rice cooking",
    "western",
    "2026-11-24T09:30",
    { kind: "task", title: "rice cooking", dueDate: "2026-11-25", dueAt: "2026-11-25T09:00" },
  ],
  [
    "tomorrow 9 rice cooking",
    "ethiopian",
    "2026-11-24T09:30",
    { kind: "task", title: "rice cooking", dueDate: "2026-11-25", dueAt: "2026-11-25T15:00" },
  ],
  [
    "buy tomorrow 2 movie tickets",
    "western",
    "2026-11-24T09:30",
    { kind: "task", title: "buy 2 movie tickets", dueDate: "2026-11-25" },
  ],
  [
    "buy tomorrow 2 movie tickets",
    "ethiopian",
    "2026-11-24T09:30",
    { kind: "task", title: "buy 2 movie tickets", dueDate: "2026-11-25" },
  ],
  [
    "send abel tomorrow 3 test results",
    "western",
    "2026-11-24T09:30",
    { kind: "task", title: "send abel 3 test results", dueDate: "2026-11-25" },
  ],
  [
    "send abel tomorrow 3 test results",
    "ethiopian",
    "2026-11-24T09:30",
    { kind: "task", title: "send abel 3 test results", dueDate: "2026-11-25" },
  ],
  [
    "buy eggs tomorrow 12 pieces",
    "western",
    "2026-11-24T09:30",
    { kind: "task", title: "buy eggs 12 pieces", dueDate: "2026-11-25" },
  ],
  [
    "buy eggs tomorrow 12 pieces",
    "ethiopian",
    "2026-11-24T09:30",
    { kind: "task", title: "buy eggs 12 pieces", dueDate: "2026-11-25" },
  ],
  [
    "tomorrow pay rent 9000",
    "western",
    "2026-11-24T09:30",
    {
      kind: "expense",
      description: "pay rent",
      amount: 900000,
      categoryId: "cat_housing",
      date: "2026-11-25",
      account: "cash",
      accountName: "Cash",
    },
  ],
  [
    "tomorrow pay rent 9000",
    "ethiopian",
    "2026-11-24T09:30",
    {
      kind: "expense",
      description: "pay rent",
      amount: 900000,
      categoryId: "cat_housing",
      date: "2026-11-25",
      account: "cash",
      accountName: "Cash",
    },
  ],
  [
    "tomorrow 9 pay rent 9000",
    "western",
    "2026-11-24T09:30",
    {
      kind: "expense",
      description: "9 pay rent",
      amount: 900000,
      categoryId: "cat_housing",
      date: "2026-11-25",
      account: "cash",
      accountName: "Cash",
    },
  ],
  [
    "tomorrow 9 pay rent 9000",
    "ethiopian",
    "2026-11-24T09:30",
    {
      kind: "expense",
      description: "9 pay rent",
      amount: 900000,
      categoryId: "cat_housing",
      date: "2026-11-25",
      account: "cash",
      accountName: "Cash",
    },
  ],
  [
    "tomorrow 9 pay abel 500",
    "western",
    "2026-11-24T09:30",
    { kind: "task", title: "pay abel 500", dueDate: "2026-11-25", dueAt: "2026-11-25T09:00" },
  ],
  [
    "tomorrow 9 pay abel 500",
    "ethiopian",
    "2026-11-24T09:30",
    { kind: "task", title: "pay abel 500", dueDate: "2026-11-25", dueAt: "2026-11-25T15:00" },
  ],
  [
    "tomorrow 3 books",
    "western",
    "2026-11-24T09:30",
    {
      kind: "expense",
      description: "books",
      amount: 300,
      categoryId: "cat_learning",
      date: "2026-11-25",
      account: "cash",
      accountName: "Cash",
    },
  ],
  [
    "tomorrow 3 books",
    "ethiopian",
    "2026-11-24T09:30",
    {
      kind: "expense",
      description: "books",
      amount: 300,
      categoryId: "cat_learning",
      date: "2026-11-25",
      account: "cash",
      accountName: "Cash",
    },
  ],
  [
    "lunch 120",
    "western",
    "2026-11-24T09:30",
    {
      kind: "expense",
      description: "lunch",
      amount: 12000,
      categoryId: "cat_food",
      date: "2026-11-24",
      account: "cash",
      accountName: "Cash",
    },
  ],
  [
    "lunch 120",
    "ethiopian",
    "2026-11-24T09:30",
    {
      kind: "expense",
      description: "lunch",
      amount: 12000,
      categoryId: "cat_food",
      date: "2026-11-24",
      account: "cash",
      accountName: "Cash",
    },
  ],
  [
    "dinner 800 tonight",
    "western",
    "2026-11-24T09:30",
    {
      kind: "expense",
      description: "dinner",
      amount: 80000,
      categoryId: "cat_food",
      date: "2026-11-24",
      account: "cash",
      accountName: "Cash",
    },
  ],
  [
    "dinner 800 tonight",
    "western",
    "2026-11-24T23:30",
    {
      kind: "expense",
      description: "dinner",
      amount: 80000,
      categoryId: "cat_food",
      date: "2026-11-24",
      account: "cash",
      accountName: "Cash",
    },
  ],
  [
    "dinner 800 tonight",
    "western",
    "2026-11-25T01:30",
    {
      kind: "expense",
      description: "dinner",
      amount: 80000,
      categoryId: "cat_food",
      date: "2026-11-25",
      account: "cash",
      accountName: "Cash",
    },
  ],
  [
    "dinner 800 tonight",
    "western",
    "2026-11-24T01:30",
    {
      kind: "expense",
      description: "dinner",
      amount: 80000,
      categoryId: "cat_food",
      date: "2026-11-24",
      account: "cash",
      accountName: "Cash",
    },
  ],
  [
    "dinner 800 tonight",
    "ethiopian",
    "2026-11-24T09:30",
    {
      kind: "expense",
      description: "dinner",
      amount: 80000,
      categoryId: "cat_food",
      date: "2026-11-24",
      account: "cash",
      accountName: "Cash",
    },
  ],
  [
    "dinner 800 tonight",
    "ethiopian",
    "2026-11-24T23:30",
    {
      kind: "expense",
      description: "dinner",
      amount: 80000,
      categoryId: "cat_food",
      date: "2026-11-24",
      account: "cash",
      accountName: "Cash",
    },
  ],
  [
    "dinner 800 tonight",
    "ethiopian",
    "2026-11-25T01:30",
    {
      kind: "expense",
      description: "dinner",
      amount: 80000,
      categoryId: "cat_food",
      date: "2026-11-25",
      account: "cash",
      accountName: "Cash",
    },
  ],
  [
    "dinner 800 tonight",
    "ethiopian",
    "2026-11-24T01:30",
    {
      kind: "expense",
      description: "dinner",
      amount: 80000,
      categoryId: "cat_food",
      date: "2026-11-24",
      account: "cash",
      accountName: "Cash",
    },
  ],
  [
    "taxi tonight 150",
    "western",
    "2026-11-24T09:30",
    {
      kind: "expense",
      description: "taxi",
      amount: 15000,
      categoryId: "cat_transport",
      date: "2026-11-24",
      account: "cash",
      accountName: "Cash",
    },
  ],
  [
    "taxi tonight 150",
    "western",
    "2026-11-24T23:30",
    {
      kind: "expense",
      description: "taxi",
      amount: 15000,
      categoryId: "cat_transport",
      date: "2026-11-24",
      account: "cash",
      accountName: "Cash",
    },
  ],
  [
    "taxi tonight 150",
    "western",
    "2026-11-25T01:30",
    {
      kind: "expense",
      description: "taxi",
      amount: 15000,
      categoryId: "cat_transport",
      date: "2026-11-25",
      account: "cash",
      accountName: "Cash",
    },
  ],
  [
    "taxi tonight 150",
    "western",
    "2026-11-24T01:30",
    {
      kind: "expense",
      description: "taxi",
      amount: 15000,
      categoryId: "cat_transport",
      date: "2026-11-24",
      account: "cash",
      accountName: "Cash",
    },
  ],
  [
    "taxi tonight 150",
    "ethiopian",
    "2026-11-24T09:30",
    {
      kind: "expense",
      description: "taxi",
      amount: 15000,
      categoryId: "cat_transport",
      date: "2026-11-24",
      account: "cash",
      accountName: "Cash",
    },
  ],
  [
    "taxi tonight 150",
    "ethiopian",
    "2026-11-24T23:30",
    {
      kind: "expense",
      description: "taxi",
      amount: 15000,
      categoryId: "cat_transport",
      date: "2026-11-24",
      account: "cash",
      accountName: "Cash",
    },
  ],
  [
    "taxi tonight 150",
    "ethiopian",
    "2026-11-25T01:30",
    {
      kind: "expense",
      description: "taxi",
      amount: 15000,
      categoryId: "cat_transport",
      date: "2026-11-25",
      account: "cash",
      accountName: "Cash",
    },
  ],
  [
    "taxi tonight 150",
    "ethiopian",
    "2026-11-24T01:30",
    {
      kind: "expense",
      description: "taxi",
      amount: 15000,
      categoryId: "cat_transport",
      date: "2026-11-24",
      account: "cash",
      accountName: "Cash",
    },
  ],
  [
    "taxi tonight 8",
    "western",
    "2026-11-24T09:30",
    {
      kind: "expense",
      description: "taxi",
      amount: 800,
      categoryId: "cat_transport",
      date: "2026-11-24",
      account: "cash",
      accountName: "Cash",
    },
  ],
  [
    "taxi tonight 8",
    "western",
    "2026-11-24T23:30",
    {
      kind: "expense",
      description: "taxi",
      amount: 800,
      categoryId: "cat_transport",
      date: "2026-11-24",
      account: "cash",
      accountName: "Cash",
    },
  ],
  [
    "taxi tonight 8",
    "western",
    "2026-11-25T01:30",
    {
      kind: "expense",
      description: "taxi",
      amount: 800,
      categoryId: "cat_transport",
      date: "2026-11-25",
      account: "cash",
      accountName: "Cash",
    },
  ],
  [
    "taxi tonight 8",
    "western",
    "2026-11-24T01:30",
    {
      kind: "expense",
      description: "taxi",
      amount: 800,
      categoryId: "cat_transport",
      date: "2026-11-24",
      account: "cash",
      accountName: "Cash",
    },
  ],
  [
    "taxi tonight 8",
    "ethiopian",
    "2026-11-24T09:30",
    {
      kind: "expense",
      description: "taxi",
      amount: 800,
      categoryId: "cat_transport",
      date: "2026-11-24",
      account: "cash",
      accountName: "Cash",
    },
  ],
  [
    "taxi tonight 8",
    "ethiopian",
    "2026-11-24T23:30",
    {
      kind: "expense",
      description: "taxi",
      amount: 800,
      categoryId: "cat_transport",
      date: "2026-11-24",
      account: "cash",
      accountName: "Cash",
    },
  ],
  [
    "taxi tonight 8",
    "ethiopian",
    "2026-11-25T01:30",
    {
      kind: "expense",
      description: "taxi",
      amount: 800,
      categoryId: "cat_transport",
      date: "2026-11-25",
      account: "cash",
      accountName: "Cash",
    },
  ],
  [
    "taxi tonight 8",
    "ethiopian",
    "2026-11-24T01:30",
    {
      kind: "expense",
      description: "taxi",
      amount: 800,
      categoryId: "cat_transport",
      date: "2026-11-24",
      account: "cash",
      accountName: "Cash",
    },
  ],
  [
    "coffee tonight 5",
    "western",
    "2026-11-24T09:30",
    {
      kind: "expense",
      description: "coffee",
      amount: 500,
      categoryId: "cat_food",
      date: "2026-11-24",
      account: "cash",
      accountName: "Cash",
    },
  ],
  [
    "coffee tonight 5",
    "western",
    "2026-11-24T23:30",
    {
      kind: "expense",
      description: "coffee",
      amount: 500,
      categoryId: "cat_food",
      date: "2026-11-24",
      account: "cash",
      accountName: "Cash",
    },
  ],
  [
    "coffee tonight 5",
    "western",
    "2026-11-25T01:30",
    {
      kind: "expense",
      description: "coffee",
      amount: 500,
      categoryId: "cat_food",
      date: "2026-11-25",
      account: "cash",
      accountName: "Cash",
    },
  ],
  [
    "coffee tonight 5",
    "western",
    "2026-11-24T01:30",
    {
      kind: "expense",
      description: "coffee",
      amount: 500,
      categoryId: "cat_food",
      date: "2026-11-24",
      account: "cash",
      accountName: "Cash",
    },
  ],
  [
    "coffee tonight 5",
    "ethiopian",
    "2026-11-24T09:30",
    {
      kind: "expense",
      description: "coffee",
      amount: 500,
      categoryId: "cat_food",
      date: "2026-11-24",
      account: "cash",
      accountName: "Cash",
    },
  ],
  [
    "coffee tonight 5",
    "ethiopian",
    "2026-11-24T23:30",
    {
      kind: "expense",
      description: "coffee",
      amount: 500,
      categoryId: "cat_food",
      date: "2026-11-24",
      account: "cash",
      accountName: "Cash",
    },
  ],
  [
    "coffee tonight 5",
    "ethiopian",
    "2026-11-25T01:30",
    {
      kind: "expense",
      description: "coffee",
      amount: 500,
      categoryId: "cat_food",
      date: "2026-11-25",
      account: "cash",
      accountName: "Cash",
    },
  ],
  [
    "coffee tonight 5",
    "ethiopian",
    "2026-11-24T01:30",
    {
      kind: "expense",
      description: "coffee",
      amount: 500,
      categoryId: "cat_food",
      date: "2026-11-24",
      account: "cash",
      accountName: "Cash",
    },
  ],
  [
    "tip tonight 10 for waiter",
    "western",
    "2026-11-24T09:30",
    { kind: "task", title: "tip 10 for waiter", dueDate: "2026-11-24", plannedWindow: "evening" },
  ],
  [
    "tip tonight 10 for waiter",
    "western",
    "2026-11-24T23:30",
    { kind: "task", title: "tip 10 for waiter", dueDate: "2026-11-24", plannedWindow: "evening" },
  ],
  [
    "tip tonight 10 for waiter",
    "western",
    "2026-11-25T01:30",
    {
      kind: "task",
      title: "tip 10 for waiter",
      dueDate: "2026-11-25",
      plannedWindow: "evening",
      tonight: true,
    },
  ],
  [
    "tip tonight 10 for waiter",
    "western",
    "2026-11-24T01:30",
    {
      kind: "task",
      title: "tip 10 for waiter",
      dueDate: "2026-11-24",
      plannedWindow: "evening",
      tonight: true,
    },
  ],
  [
    "tip tonight 10 for waiter",
    "ethiopian",
    "2026-11-24T09:30",
    { kind: "task", title: "tip 10 for waiter", dueDate: "2026-11-24", plannedWindow: "evening" },
  ],
  [
    "tip tonight 10 for waiter",
    "ethiopian",
    "2026-11-24T23:30",
    { kind: "task", title: "tip 10 for waiter", dueDate: "2026-11-24", plannedWindow: "evening" },
  ],
  [
    "tip tonight 10 for waiter",
    "ethiopian",
    "2026-11-25T01:30",
    {
      kind: "task",
      title: "tip 10 for waiter",
      dueDate: "2026-11-25",
      plannedWindow: "evening",
      tonight: true,
    },
  ],
  [
    "tip tonight 10 for waiter",
    "ethiopian",
    "2026-11-24T01:30",
    {
      kind: "task",
      title: "tip 10 for waiter",
      dueDate: "2026-11-24",
      plannedWindow: "evening",
      tonight: true,
    },
  ],
  [
    "beer tonight 2",
    "western",
    "2026-11-24T09:30",
    {
      kind: "expense",
      description: "beer",
      amount: 200,
      categoryId: "cat_other",
      date: "2026-11-24",
      account: "cash",
      accountName: "Cash",
    },
  ],
  [
    "beer tonight 2",
    "western",
    "2026-11-24T23:30",
    {
      kind: "expense",
      description: "beer",
      amount: 200,
      categoryId: "cat_other",
      date: "2026-11-24",
      account: "cash",
      accountName: "Cash",
    },
  ],
  [
    "beer tonight 2",
    "western",
    "2026-11-25T01:30",
    {
      kind: "expense",
      description: "beer",
      amount: 200,
      categoryId: "cat_other",
      date: "2026-11-25",
      account: "cash",
      accountName: "Cash",
    },
  ],
  [
    "beer tonight 2",
    "western",
    "2026-11-24T01:30",
    {
      kind: "expense",
      description: "beer",
      amount: 200,
      categoryId: "cat_other",
      date: "2026-11-24",
      account: "cash",
      accountName: "Cash",
    },
  ],
  [
    "beer tonight 2",
    "ethiopian",
    "2026-11-24T09:30",
    {
      kind: "expense",
      description: "beer",
      amount: 200,
      categoryId: "cat_other",
      date: "2026-11-24",
      account: "cash",
      accountName: "Cash",
    },
  ],
  [
    "beer tonight 2",
    "ethiopian",
    "2026-11-24T23:30",
    {
      kind: "expense",
      description: "beer",
      amount: 200,
      categoryId: "cat_other",
      date: "2026-11-24",
      account: "cash",
      accountName: "Cash",
    },
  ],
  [
    "beer tonight 2",
    "ethiopian",
    "2026-11-25T01:30",
    {
      kind: "expense",
      description: "beer",
      amount: 200,
      categoryId: "cat_other",
      date: "2026-11-25",
      account: "cash",
      accountName: "Cash",
    },
  ],
  [
    "beer tonight 2",
    "ethiopian",
    "2026-11-24T01:30",
    {
      kind: "expense",
      description: "beer",
      amount: 200,
      categoryId: "cat_other",
      date: "2026-11-24",
      account: "cash",
      accountName: "Cash",
    },
  ],
  [
    "tonight 8",
    "western",
    "2026-11-24T09:30",
    { kind: "task", title: "8", dueDate: "2026-11-24", plannedWindow: "evening" },
  ],
  [
    "tonight 8",
    "western",
    "2026-11-24T23:30",
    { kind: "task", title: "8", dueDate: "2026-11-24", plannedWindow: "evening" },
  ],
  [
    "tonight 8",
    "western",
    "2026-11-25T01:30",
    { kind: "task", title: "8", dueDate: "2026-11-25", plannedWindow: "evening", tonight: true },
  ],
  [
    "tonight 8",
    "western",
    "2026-11-24T01:30",
    { kind: "task", title: "8", dueDate: "2026-11-24", plannedWindow: "evening", tonight: true },
  ],
  [
    "tonight 8",
    "ethiopian",
    "2026-11-24T09:30",
    { kind: "task", title: "8", dueDate: "2026-11-24", plannedWindow: "evening" },
  ],
  [
    "tonight 8",
    "ethiopian",
    "2026-11-24T23:30",
    { kind: "task", title: "8", dueDate: "2026-11-24", plannedWindow: "evening" },
  ],
  [
    "tonight 8",
    "ethiopian",
    "2026-11-25T01:30",
    { kind: "task", title: "8", dueDate: "2026-11-25", plannedWindow: "evening", tonight: true },
  ],
  [
    "tonight 8",
    "ethiopian",
    "2026-11-24T01:30",
    { kind: "task", title: "8", dueDate: "2026-11-24", plannedWindow: "evening", tonight: true },
  ],
  [
    "tonight 9 movie",
    "western",
    "2026-11-24T09:30",
    { kind: "task", title: "9 movie", dueDate: "2026-11-24", plannedWindow: "evening" },
  ],
  [
    "tonight 9 movie",
    "western",
    "2026-11-24T23:30",
    { kind: "task", title: "9 movie", dueDate: "2026-11-24", plannedWindow: "evening" },
  ],
  [
    "tonight 9 movie",
    "western",
    "2026-11-25T01:30",
    {
      kind: "task",
      title: "9 movie",
      dueDate: "2026-11-25",
      plannedWindow: "evening",
      tonight: true,
    },
  ],
  [
    "tonight 9 movie",
    "western",
    "2026-11-24T01:30",
    {
      kind: "task",
      title: "9 movie",
      dueDate: "2026-11-24",
      plannedWindow: "evening",
      tonight: true,
    },
  ],
  [
    "tonight 9 movie",
    "ethiopian",
    "2026-11-24T09:30",
    { kind: "task", title: "9 movie", dueDate: "2026-11-24", plannedWindow: "evening" },
  ],
  [
    "tonight 9 movie",
    "ethiopian",
    "2026-11-24T23:30",
    { kind: "task", title: "9 movie", dueDate: "2026-11-24", plannedWindow: "evening" },
  ],
  [
    "tonight 9 movie",
    "ethiopian",
    "2026-11-25T01:30",
    {
      kind: "task",
      title: "9 movie",
      dueDate: "2026-11-25",
      plannedWindow: "evening",
      tonight: true,
    },
  ],
  [
    "tonight 9 movie",
    "ethiopian",
    "2026-11-24T01:30",
    {
      kind: "task",
      title: "9 movie",
      dueDate: "2026-11-24",
      plannedWindow: "evening",
      tonight: true,
    },
  ],
  [
    "tonight 2 hours study",
    "western",
    "2026-11-24T09:30",
    { kind: "task", title: "2 hours study", dueDate: "2026-11-24", plannedWindow: "evening" },
  ],
  [
    "tonight 2 hours study",
    "western",
    "2026-11-24T23:30",
    { kind: "task", title: "2 hours study", dueDate: "2026-11-24", plannedWindow: "evening" },
  ],
  [
    "tonight 2 hours study",
    "western",
    "2026-11-25T01:30",
    {
      kind: "task",
      title: "2 hours study",
      dueDate: "2026-11-25",
      plannedWindow: "evening",
      tonight: true,
    },
  ],
  [
    "tonight 2 hours study",
    "western",
    "2026-11-24T01:30",
    {
      kind: "task",
      title: "2 hours study",
      dueDate: "2026-11-24",
      plannedWindow: "evening",
      tonight: true,
    },
  ],
  [
    "tonight 2 hours study",
    "ethiopian",
    "2026-11-24T09:30",
    { kind: "task", title: "2 hours study", dueDate: "2026-11-24", plannedWindow: "evening" },
  ],
  [
    "tonight 2 hours study",
    "ethiopian",
    "2026-11-24T23:30",
    { kind: "task", title: "2 hours study", dueDate: "2026-11-24", plannedWindow: "evening" },
  ],
  [
    "tonight 2 hours study",
    "ethiopian",
    "2026-11-25T01:30",
    {
      kind: "task",
      title: "2 hours study",
      dueDate: "2026-11-25",
      plannedWindow: "evening",
      tonight: true,
    },
  ],
  [
    "tonight 2 hours study",
    "ethiopian",
    "2026-11-24T01:30",
    {
      kind: "task",
      title: "2 hours study",
      dueDate: "2026-11-24",
      plannedWindow: "evening",
      tonight: true,
    },
  ],
  [
    "this evening 2 hours gym",
    "western",
    "2026-11-24T09:30",
    { kind: "task", title: "2 hours gym", dueDate: "2026-11-24", plannedWindow: "evening" },
  ],
  [
    "this evening 2 hours gym",
    "western",
    "2026-11-24T23:30",
    { kind: "task", title: "2 hours gym", dueDate: "2026-11-24", plannedWindow: "evening" },
  ],
  [
    "this evening 2 hours gym",
    "western",
    "2026-11-25T01:30",
    {
      kind: "task",
      title: "2 hours gym",
      dueDate: "2026-11-25",
      plannedWindow: "evening",
      tonight: true,
    },
  ],
  [
    "this evening 2 hours gym",
    "western",
    "2026-11-24T01:30",
    {
      kind: "task",
      title: "2 hours gym",
      dueDate: "2026-11-24",
      plannedWindow: "evening",
      tonight: true,
    },
  ],
  [
    "this evening 2 hours gym",
    "ethiopian",
    "2026-11-24T09:30",
    { kind: "task", title: "2 hours gym", dueDate: "2026-11-24", plannedWindow: "evening" },
  ],
  [
    "this evening 2 hours gym",
    "ethiopian",
    "2026-11-24T23:30",
    { kind: "task", title: "2 hours gym", dueDate: "2026-11-24", plannedWindow: "evening" },
  ],
  [
    "this evening 2 hours gym",
    "ethiopian",
    "2026-11-25T01:30",
    {
      kind: "task",
      title: "2 hours gym",
      dueDate: "2026-11-25",
      plannedWindow: "evening",
      tonight: true,
    },
  ],
  [
    "this evening 2 hours gym",
    "ethiopian",
    "2026-11-24T01:30",
    {
      kind: "task",
      title: "2 hours gym",
      dueDate: "2026-11-24",
      plannedWindow: "evening",
      tonight: true,
    },
  ],
  [
    "tonight 2 episodes then sleep",
    "western",
    "2026-11-24T09:30",
    {
      kind: "task",
      title: "2 episodes then sleep",
      dueDate: "2026-11-24",
      plannedWindow: "evening",
    },
  ],
  [
    "tonight 2 episodes then sleep",
    "western",
    "2026-11-24T23:30",
    {
      kind: "task",
      title: "2 episodes then sleep",
      dueDate: "2026-11-24",
      plannedWindow: "evening",
    },
  ],
  [
    "tonight 2 episodes then sleep",
    "western",
    "2026-11-25T01:30",
    {
      kind: "task",
      title: "2 episodes then sleep",
      dueDate: "2026-11-25",
      plannedWindow: "evening",
      tonight: true,
    },
  ],
  [
    "tonight 2 episodes then sleep",
    "western",
    "2026-11-24T01:30",
    {
      kind: "task",
      title: "2 episodes then sleep",
      dueDate: "2026-11-24",
      plannedWindow: "evening",
      tonight: true,
    },
  ],
  [
    "tonight 2 episodes then sleep",
    "ethiopian",
    "2026-11-24T09:30",
    {
      kind: "task",
      title: "2 episodes then sleep",
      dueDate: "2026-11-24",
      plannedWindow: "evening",
    },
  ],
  [
    "tonight 2 episodes then sleep",
    "ethiopian",
    "2026-11-24T23:30",
    {
      kind: "task",
      title: "2 episodes then sleep",
      dueDate: "2026-11-24",
      plannedWindow: "evening",
    },
  ],
  [
    "tonight 2 episodes then sleep",
    "ethiopian",
    "2026-11-25T01:30",
    {
      kind: "task",
      title: "2 episodes then sleep",
      dueDate: "2026-11-25",
      plannedWindow: "evening",
      tonight: true,
    },
  ],
  [
    "tonight 2 episodes then sleep",
    "ethiopian",
    "2026-11-24T01:30",
    {
      kind: "task",
      title: "2 episodes then sleep",
      dueDate: "2026-11-24",
      plannedWindow: "evening",
      tonight: true,
    },
  ],
  [
    "call mom tonight 1 hour",
    "western",
    "2026-11-24T09:30",
    { kind: "task", title: "call mom 1 hour", dueDate: "2026-11-24", plannedWindow: "evening" },
  ],
  [
    "call mom tonight 1 hour",
    "western",
    "2026-11-24T23:30",
    { kind: "task", title: "call mom 1 hour", dueDate: "2026-11-24", plannedWindow: "evening" },
  ],
  [
    "call mom tonight 1 hour",
    "western",
    "2026-11-25T01:30",
    {
      kind: "task",
      title: "call mom 1 hour",
      dueDate: "2026-11-25",
      plannedWindow: "evening",
      tonight: true,
    },
  ],
  [
    "call mom tonight 1 hour",
    "western",
    "2026-11-24T01:30",
    {
      kind: "task",
      title: "call mom 1 hour",
      dueDate: "2026-11-24",
      plannedWindow: "evening",
      tonight: true,
    },
  ],
  [
    "call mom tonight 1 hour",
    "ethiopian",
    "2026-11-24T09:30",
    { kind: "task", title: "call mom 1 hour", dueDate: "2026-11-24", plannedWindow: "evening" },
  ],
  [
    "call mom tonight 1 hour",
    "ethiopian",
    "2026-11-24T23:30",
    { kind: "task", title: "call mom 1 hour", dueDate: "2026-11-24", plannedWindow: "evening" },
  ],
  [
    "call mom tonight 1 hour",
    "ethiopian",
    "2026-11-25T01:30",
    {
      kind: "task",
      title: "call mom 1 hour",
      dueDate: "2026-11-25",
      plannedWindow: "evening",
      tonight: true,
    },
  ],
  [
    "call mom tonight 1 hour",
    "ethiopian",
    "2026-11-24T01:30",
    {
      kind: "task",
      title: "call mom 1 hour",
      dueDate: "2026-11-24",
      plannedWindow: "evening",
      tonight: true,
    },
  ],
  [
    "call mom tonight at 8",
    "western",
    "2026-11-24T09:30",
    { kind: "task", title: "call mom", dueDate: "2026-11-24", dueAt: "2026-11-24T20:00" },
  ],
  [
    "call mom tonight at 8",
    "western",
    "2026-11-24T23:30",
    { kind: "task", title: "call mom", dueDate: "2026-11-24", dueAt: "2026-11-24T20:00" },
  ],
  [
    "call mom tonight at 8",
    "western",
    "2026-11-25T01:30",
    {
      kind: "task",
      title: "call mom",
      dueDate: "2026-11-25",
      dueAt: "2026-11-25T20:00",
      tonight: true,
    },
  ],
  [
    "call mom tonight at 8",
    "western",
    "2026-11-24T01:30",
    {
      kind: "task",
      title: "call mom",
      dueDate: "2026-11-24",
      dueAt: "2026-11-24T20:00",
      tonight: true,
    },
  ],
  [
    "call mom tonight at 8",
    "ethiopian",
    "2026-11-24T09:30",
    { kind: "task", title: "call mom", dueDate: "2026-11-24", dueAt: "2026-11-24T14:00" },
  ],
  [
    "call mom tonight at 8",
    "ethiopian",
    "2026-11-24T23:30",
    { kind: "task", title: "call mom", dueDate: "2026-11-24", dueAt: "2026-11-24T14:00" },
  ],
  [
    "call mom tonight at 8",
    "ethiopian",
    "2026-11-25T01:30",
    {
      kind: "task",
      title: "call mom",
      dueDate: "2026-11-25",
      dueAt: "2026-11-25T14:00",
      tonight: true,
    },
  ],
  [
    "call mom tonight at 8",
    "ethiopian",
    "2026-11-24T01:30",
    {
      kind: "task",
      title: "call mom",
      dueDate: "2026-11-24",
      dueAt: "2026-11-24T14:00",
      tonight: true,
    },
  ],
  [
    "tonight at 8:30 call",
    "western",
    "2026-11-24T09:30",
    { kind: "task", title: "call", dueDate: "2026-11-24", dueAt: "2026-11-24T20:30" },
  ],
  [
    "tonight at 8:30 call",
    "western",
    "2026-11-24T23:30",
    { kind: "task", title: "call", dueDate: "2026-11-24", dueAt: "2026-11-24T20:30" },
  ],
  [
    "tonight at 8:30 call",
    "western",
    "2026-11-25T01:30",
    {
      kind: "task",
      title: "call",
      dueDate: "2026-11-25",
      dueAt: "2026-11-25T20:30",
      tonight: true,
    },
  ],
  [
    "tonight at 8:30 call",
    "western",
    "2026-11-24T01:30",
    {
      kind: "task",
      title: "call",
      dueDate: "2026-11-24",
      dueAt: "2026-11-24T20:30",
      tonight: true,
    },
  ],
  [
    "tonight at 8:30 call",
    "ethiopian",
    "2026-11-24T09:30",
    { kind: "task", title: "call", dueDate: "2026-11-24", dueAt: "2026-11-24T20:30" },
  ],
  [
    "tonight at 8:30 call",
    "ethiopian",
    "2026-11-24T23:30",
    { kind: "task", title: "call", dueDate: "2026-11-24", dueAt: "2026-11-24T20:30" },
  ],
  [
    "tonight at 8:30 call",
    "ethiopian",
    "2026-11-25T01:30",
    {
      kind: "task",
      title: "call",
      dueDate: "2026-11-25",
      dueAt: "2026-11-25T20:30",
      tonight: true,
    },
  ],
  [
    "tonight at 8:30 call",
    "ethiopian",
    "2026-11-24T01:30",
    {
      kind: "task",
      title: "call",
      dueDate: "2026-11-24",
      dueAt: "2026-11-24T20:30",
      tonight: true,
    },
  ],
  [
    "today at 12",
    "western",
    "2026-11-24T09:30",
    { kind: "inbox", body: "", why: "Type what to do" },
  ],
  [
    "today at 12",
    "ethiopian",
    "2026-11-24T09:30",
    { kind: "inbox", body: "", why: "Type what to do" },
  ],
  [
    "at 12 lunch with abel",
    "western",
    "2026-11-24T09:30",
    { kind: "task", title: "lunch with abel", dueDate: "2026-11-24", dueAt: "2026-11-24T12:00" },
  ],
  [
    "at 12 lunch with abel",
    "ethiopian",
    "2026-11-24T09:30",
    { kind: "task", title: "lunch with abel", dueDate: "2026-11-24", dueAt: "2026-11-24T18:00" },
  ],
  [
    "pay electricity 800 @cash tomorrow",
    "western",
    "2026-11-24T09:30",
    { kind: "task", title: "pay electricity 800", dueDate: "2026-11-25" },
  ],
  [
    "pay electricity 800 @cash tomorrow",
    "ethiopian",
    "2026-11-24T09:30",
    { kind: "task", title: "pay electricity 800", dueDate: "2026-11-25" },
  ],
  [
    "dec 25, 2027 renew passport",
    "western",
    "2026-11-24T09:30",
    { kind: "task", title: "renew passport", dueDate: "2027-12-25" },
  ],
  [
    "dec 25, 2027 renew passport",
    "ethiopian",
    "2026-11-24T09:30",
    { kind: "task", title: "renew passport", dueDate: "2027-12-25" },
  ],
];

describe("every other line reads as it did on main", () => {
  it.each(MAIN)("%j (%s, %s)", (text, clockStyle, now, expected) => {
    const out: Record<string, unknown> = { ...read(text, at(`${now}:00`), clockStyle) };
    if (typeof out.dueAt === "number")
      out.dueAt = new Date(out.dueAt + 3 * 60 * 60 * 1000).toISOString().slice(0, 16);
    expect(out).toEqual(expected);
  });
});
