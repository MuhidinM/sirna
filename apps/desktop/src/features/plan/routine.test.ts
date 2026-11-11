import { describe, expect, it } from "vitest";

import {
  DEFAULT_ANSWERS,
  defaultRoutine,
  parseTimes,
  toHhmm,
  toMinutes,
  type Weekday,
} from "./routine";

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

describe("email check times", () => {
  const checks = (emailChecks: string[]) =>
    defaultRoutine({ ...DEFAULT_ANSWERS, emailChecks })
      .filter((block) => block.weekday === 1 && block.title === "Check email")
      .map((block) => toHhmm(block.startMin));

  it("uses the times you set", () => {
    expect(checks(["09:30"])).toEqual(["09:30"]);
    expect(checks(["11:00", "16:45"])).toEqual(["11:00", "16:45"]);
  });

  it("has none when the list is empty", () => {
    expect(checks([])).toEqual([]);
  });

  it("keeps the defaults for answers saved before the setting existed", () => {
    const old = { ...DEFAULT_ANSWERS } as Partial<typeof DEFAULT_ANSWERS>;
    delete old.emailChecks;
    const blocks = defaultRoutine(old as typeof DEFAULT_ANSWERS).filter(
      (block) => block.weekday === 1 && block.title === "Check email",
    );
    expect(blocks.map((block) => toHhmm(block.startMin))).toEqual(["10:00", "15:00"]);
  });
});

describe("parseTimes", () => {
  it("reads, sorts and dedupes times", () => {
    expect(parseTimes("15:00, 9:30 15:00")).toEqual(["09:30", "15:00"]);
  });

  it("reads empty text as no times", () => {
    expect(parseTimes("  ")).toEqual([]);
  });

  it("rejects anything that is not a time", () => {
    expect(parseTimes("10:00, lunch")).toBeNull();
    expect(parseTimes("25:00")).toBeNull();
  });
});

describe("email checks outside work hours", () => {
  it("never share time with a focus block", () => {
    const monday = defaultRoutine({ ...DEFAULT_ANSWERS, emailChecks: ["18:30"] }).filter(
      (block) => block.weekday === 1,
    );
    const check = monday.find((block) => block.title === "Check email");
    expect(check && toHhmm(check.startMin)).toBe("18:30");
    for (const block of monday.filter((other) => other.kind === "area")) {
      const end = block.startMin + block.durationMin;
      const overlaps = block.startMin < 18 * 60 + 40 && 18 * 60 + 30 < end;
      expect(overlaps, `${toHhmm(block.startMin)} focus overlaps the 18:30 check`).toBe(false);
    }
  });
});
