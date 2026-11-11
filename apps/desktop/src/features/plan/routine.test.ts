import { describe, expect, it } from "vitest";

import { DEFAULT_ANSWERS, defaultRoutine, toHhmm, toMinutes, type Weekday } from "./routine";

const day = (weekday: Weekday) =>
  defaultRoutine(DEFAULT_ANSWERS)
    .filter((block) => block.weekday === weekday)
    .map((block) => `${toHhmm(block.startMin)} ${block.durationMin} ${block.kind} ${block.title}`);

describe("times", () => {
  it("converts both ways", () => {
    expect(toMinutes("06:00")).toBe(360);
    expect(toMinutes("22:30")).toBe(1350);
    expect(toHhmm(1350)).toBe("22:30");
    expect(() => toMinutes("25:00")).toThrow(RangeError);
    expect(() => toMinutes("6pm")).toThrow(RangeError);
  });
});

describe("defaultRoutine", () => {
  it("builds a workday from jobs, routines and free focus blocks", () => {
    expect(day(1)).toEqual([
      "06:00 20 routine Quran",
      "06:30 75 area Focus block",
      "08:00 240 fixed Job A",
      "10:00 10 routine Check email",
      "13:00 240 fixed Job B",
      "15:00 10 routine Check email",
      "17:30 45 routine Gym",
      "18:30 90 area Focus block",
      "21:00 15 routine Night review",
    ]);
  });

  it("keeps lunch free and at most 2 focus blocks on a workday", () => {
    expect(day(1).some((line) => line.startsWith("12:"))).toBe(false);
    expect(day(2).filter((line) => line.includes("Focus block"))).toHaveLength(2);
    expect(day(2).some((line) => line.includes("Gym"))).toBe(false);
  });

  it("gives a free day up to 3 focus blocks", () => {
    expect(day(6).filter((line) => line.includes("Focus block"))).toHaveLength(3);
  });

  it("makes the rest day a rest block with Quran and the review", () => {
    expect(day(7)).toEqual([
      "06:00 20 routine Quran",
      "06:30 840 rest Rest day",
      "21:00 15 routine Night review",
    ]);
  });

  it("never overlaps blocks on any day", () => {
    const blocks = defaultRoutine(DEFAULT_ANSWERS);
    for (const weekday of [1, 2, 3, 4, 5, 6, 7] as Weekday[]) {
      // Email checks (10 minutes) may sit inside work hours; everything else is apart.
      const today = blocks
        .filter((block) => block.weekday === weekday)
        .filter((block) => block.kind !== "rest" && block.durationMin > 15);
      for (let i = 1; i < today.length; i++) {
        const previous = today[i - 1];
        const current = today[i];
        if (!previous || !current) continue;
        expect(current.startMin).toBeGreaterThanOrEqual(previous.startMin + previous.durationMin);
      }
    }
  });

  it("leaves out areas the user unticked", () => {
    const blocks = defaultRoutine({ ...DEFAULT_ANSWERS, activeAreas: ["joba", "jobb", "coding"] });
    expect(blocks.some((block) => block.areaId === "gym" || block.areaId === "quran")).toBe(false);
  });

  it("follows the user's job hours", () => {
    const blocks = defaultRoutine({
      ...DEFAULT_ANSWERS,
      jobs: [{ areaId: "joba", name: "Kifiya", days: [2, 4], start: "09:30", end: "18:00" }],
    });
    const tuesday = blocks.filter((block) => block.weekday === 2);
    expect(tuesday).toContainEqual(
      expect.objectContaining({ startMin: 570, durationMin: 510, kind: "fixed", title: "Kifiya" }),
    );
    // No email checks on a day without a job.
    expect(
      blocks.filter((block) => block.weekday === 1).some((block) => block.title === "Check email"),
    ).toBe(false);
  });
});
