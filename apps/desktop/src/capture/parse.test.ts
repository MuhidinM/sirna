import { describe, expect, it } from "vitest";

import fixtures from "./fixtures/capture.json";
import { echo, toOps } from "./ops";
import { parseCapture } from "./parse";
import { type ClockStyle } from "./when";

const nowMs = Date.parse(fixtures.now);

/** Fixture times are local (UTC+3); compare them as epoch ms. */
function expected(out: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...out };
  if (typeof copy.dueAt === "string") copy.dueAt = Date.parse(`${copy.dueAt}:00+03:00`);
  return copy;
}

describe("parseCapture fixtures", () => {
  it("has at least 60 cases", () => {
    expect(fixtures.cases.length).toBeGreaterThanOrEqual(60);
  });

  it.each(fixtures.cases.map((c) => [c.in, c] as const))("%j", (_, testCase) => {
    const clockStyle = ("clockStyle" in testCase ? testCase.clockStyle : "western") as ClockStyle;
    const parsed = parseCapture(testCase.in, { nowMs, clockStyle });
    expect(parsed).toMatchObject(expected(testCase.out));
  });
});

describe("toOps", () => {
  let counter = 0;
  const newId = () => `id${++counter}`;

  it("makes a someday task when there is no date", () => {
    const ops = toOps(parseCapture("buy charger", { nowMs }), { nowMs, newId });
    expect(ops).toMatchObject([
      { op: "insert", table: "task_items", values: { title: "buy charger", status: "someday" } },
    ]);
  });

  it("makes a dated task with a reminder at its time", () => {
    const parsed = parseCapture("call bank tomorrow 10am", { nowMs });
    const [op] = toOps(parsed, { nowMs, newId });
    expect(op).toMatchObject({
      table: "task_items",
      values: { status: "todo", due_date: "2026-11-12" },
    });
    expect(op && "values" in op ? op.values.remind_at : undefined).toBe(
      op && "values" in op ? op.values.due_at : null,
    );
  });

  it("stores spending as negative santim and income as positive", () => {
    const [spend] = toOps(parseCapture("lunch 120", { nowMs }), { nowMs, newId });
    const [earn] = toOps(parseCapture("+25000 salary", { nowMs }), { nowMs, newId });
    expect(spend).toMatchObject({
      table: "money_txns",
      values: { amount_minor: -12000, category_id: "cat_food" },
    });
    expect(earn).toMatchObject({ table: "money_txns", values: { amount_minor: 2500000 } });
  });

  it("files waiting-on items as waiting tasks with a follow-up date", () => {
    const [op] = toOps(parseCapture("wait: recruiter reply mon", { nowMs }), { nowMs, newId });
    expect(op).toMatchObject({
      values: { status: "waiting", waiting_on: "recruiter reply", follow_up_date: "2026-11-16" },
    });
  });

  it("puts unmatched lines in the inbox and cheat lines under their area", () => {
    const [inbox] = toOps(parseCapture("something about the car", { nowMs }), { nowMs, newId });
    const [cheat] = toOps(parseCapture("pin: git stash pop #coding", { nowMs }), { nowMs, newId });
    expect(inbox).toMatchObject({
      table: "note_items",
      values: { kind: "inbox", status: "inbox" },
    });
    expect(cheat).toMatchObject({
      table: "note_items",
      values: { kind: "cheat", area_id: "coding" },
    });
  });

  it("makes no rows for search, away and focus", () => {
    for (const text of ["? git", "away till mon", "focus"]) {
      expect(toOps(parseCapture(text, { nowMs }), { nowMs, newId })).toEqual([]);
    }
  });
});

describe("echo", () => {
  it.each([
    ["lunch 120", "120 ETB · Food"],
    ["call bank tomorrow 10am", "Task · Tomorrow 10:00"],
    ["submit report today", "Task · Today"],
    ["pay EEU 600 fri", "Task · Fri 13 Nov"],
    ["buy charger", "Task · Someday"],
    ["fix login bug #jobA", "Task · Someday · #joba"],
    ["wait: recruiter reply mon", "Waiting on recruiter reply · follow up Mon 16 Nov"],
    ["idea: sell old monitor", "Idea"],
    ["pin: git stash pop #coding", "Pinned to cheat sheet · #coding"],
    ["dentist maybe sometime", "Saved · will ask tonight"],
    ["+25000 salary", "Income 25,000 ETB"],
  ])("%j → %j", (text, line) => {
    expect(echo(parseCapture(text, { nowMs }), nowMs)).toBe(line);
  });
});

describe("after midnight, before 03:00 (still the evening before)", () => {
  // 01:00 on Thursday 12 Nov in Addis Ababa belongs to logical Wednesday 11 Nov.
  const late = Date.parse("2026-11-12T01:00:00+03:00");

  it("dates spending to the logical day", () => {
    expect(parseCapture("dinner 300", { nowMs: late })).toMatchObject({
      kind: "expense",
      date: "2026-11-11",
    });
  });

  it("reads tomorrow as the coming day, not the one after", () => {
    expect(parseCapture("call bank tomorrow", { nowMs: late })).toMatchObject({
      dueDate: "2026-11-12",
    });
  });

  it("reads a bare clock time against the real calendar", () => {
    expect(parseCapture("standup 9:30", { nowMs: late })).toMatchObject({
      dueDate: "2026-11-12",
      dueAt: Date.parse("2026-11-12T09:30:00+03:00"),
    });
  });
});
