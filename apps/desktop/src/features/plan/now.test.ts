import { describe, expect, it } from "vitest";

import { type BlockRow, firstStep, formatMinutes, nowAndNext } from "./now";

const at = (hhmm: string) => Date.parse(`2026-11-11T${hhmm}:00+03:00`);
const block = (
  id: string,
  from: string,
  to: string,
  kind: BlockRow["kind"] = "area",
  task: string | null = null,
): BlockRow => ({
  id,
  start_at: at(from),
  end_at: at(to),
  kind,
  area_id: null,
  task_id: task ? `t-${id}` : null,
  title: id,
  status: "planned",
  color: null,
  task_title: task,
});

const day = [
  block("quran", "06:00", "06:20", "routine"),
  block("jobA", "08:00", "12:00", "fixed"),
  block("email", "10:00", "10:10", "routine"),
  block("gym", "17:30", "18:15", "routine"),
];

describe("nowAndNext", () => {
  it("finds the current block and the next one", () => {
    const result = nowAndNext(day, at("09:00"));
    expect(result.now?.id).toBe("jobA");
    expect(result.next?.id).toBe("email");
    expect(result.minutesToNext).toBe(60);
  });

  it("prefers the shorter block when two overlap", () => {
    expect(nowAndNext(day, at("10:05")).now?.id).toBe("email");
  });

  it("has no current block in a gap", () => {
    const result = nowAndNext(day, at("13:00"));
    expect(result.now).toBeUndefined();
    expect(result.next?.id).toBe("gym");
    expect(result.minutesToNext).toBe(270);
  });

  it("has nothing next after the last block", () => {
    expect(nowAndNext(day, at("20:00"))).toEqual({
      now: undefined,
      next: undefined,
      minutesToNext: undefined,
    });
  });

  it("ignores the rest-day block", () => {
    expect(nowAndNext([block("rest", "06:30", "20:30", "rest")], at("09:00")).now).toBeUndefined();
  });
});

describe("helpers", () => {
  it("formats minutes", () => {
    expect(formatMinutes(48)).toBe("48 min");
    expect(formatMinutes(120)).toBe("2 h");
    expect(formatMinutes(125)).toBe("2 h 5 min");
  });

  it("uses the block's task as the first step", () => {
    expect(firstStep(block("coding", "18:30", "19:30", "area", "Finish login form"))).toBe(
      "Finish login form",
    );
    expect(firstStep(block("Gym", "17:30", "18:15", "routine"))).toBe("Gym");
  });
});
