import { describe, expect, it } from "vitest";

import {
  DEFAULT_ANSWERS,
  defaultRoutine,
  type JobAnswer,
  jobFromBlocks,
  jobParts,
  jobProblems,
  type SavedJob,
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
      jobs: [
        { areaId: "joba", name: "Kifiya", days: [2, 4], parts: [{ start: "09:30", end: "18:00" }] },
      ],
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

describe("jobs made in My week", () => {
  it("read back their days and hours from fixed blocks", () => {
    const rows = [3, 1, 5].map((weekday) => ({ weekday, start_min: 540, duration_min: 300 }));
    expect(jobFromBlocks("job-c", "Shop", rows)).toEqual({
      areaId: "job-c",
      name: "Shop",
      days: [1, 3, 5],
      parts: [{ start: "09:00", end: "14:00" }],
    });
  });

  it("read back a split day as its parts", () => {
    const rows = [
      { weekday: 2, start_min: 780, duration_min: 120 },
      { weekday: 2, start_min: 480, duration_min: 120 },
      { weekday: 4, start_min: 480, duration_min: 120 },
    ];
    expect(jobFromBlocks("joba", "Job A", rows)).toMatchObject({
      days: [2, 4],
      parts: [
        { start: "08:00", end: "10:00" },
        { start: "13:00", end: "15:00" },
      ],
    });
  });

  it("have no days when they have no blocks yet", () => {
    expect(jobFromBlocks("job-c", "Shop", []).days).toEqual([]);
  });
});

describe("jobProblems", () => {
  const job: JobAnswer = {
    areaId: "joba",
    name: "Job A",
    days: [1, 2],
    parts: [{ start: "08:00", end: "12:00" }],
  };
  const jobB: JobAnswer = {
    areaId: "jobb",
    name: "Job B",
    days: [2, 3],
    parts: [{ start: "13:00", end: "17:00" }],
  };
  const parts = (...ranges: [string, string][]) => ranges.map(([start, end]) => ({ start, end }));

  it("passes the default jobs", () => {
    expect(jobProblems(DEFAULT_ANSWERS.jobs)).toBeNull();
  });

  it("needs a name, a different one for each job", () => {
    expect(jobProblems([{ ...job, name: "  " }])).toBe("Every job needs a name.");
    expect(jobProblems([job, { ...job, areaId: "job-c", name: "job a " }])).toMatch(
      /Two jobs are called/,
    );
  });

  it("needs a day for a job that is on, not for one ticked off", () => {
    expect(jobProblems([{ ...job, days: [] }])).toBe("Job A: pick its days, or untick it.");
    expect(jobProblems([{ ...job, days: [], enabled: false }])).toBeNull();
  });

  it("needs each part to end after it starts, on the same day", () => {
    expect(jobProblems([{ ...job, parts: parts(["12:00", "08:00"]) }])).toBe(
      "Job A: 12:00–08:00 must end after it starts, on the same day.",
    );
    expect(jobProblems([{ ...job, parts: parts(["22:00", "02:00"]) }])).toMatch(/same day/);
    expect(jobProblems([{ ...job, parts: parts(["08:00", "08:00"]) }])).toMatch(/end after/);
    expect(jobProblems([{ ...job, parts: parts(["08:00", ""]) }])).toBe(
      "Job A: fill in each From and To time.",
    );
  });

  it("allows up to 3 parts that don't overlap", () => {
    const three = parts(["06:00", "08:00"], ["09:00", "11:00"], ["13:00", "15:00"]);
    expect(jobProblems([{ ...job, parts: three }])).toBeNull();
    expect(jobProblems([{ ...job, parts: [...three, { start: "16:00", end: "17:00" }] }])).toBe(
      "Job A: at most 3 parts a day.",
    );
    expect(jobProblems([{ ...job, parts: parts(["08:00", "11:00"], ["10:30", "12:00"]) }])).toBe(
      "Job A: two parts overlap.",
    );
    // Touching parts are fine.
    expect(jobProblems([{ ...job, parts: parts(["08:00", "10:00"], ["10:00", "12:00"]) }])).toBe(
      null,
    );
  });

  it("stops two jobs overlapping on a day they share, not on other days", () => {
    const clash = { ...jobB, parts: parts(["11:00", "14:00"]) };
    expect(jobProblems([job, clash])).toBe("Job A and Job B overlap on the same day.");
    expect(jobProblems([job, { ...clash, days: [3, 4] as Weekday[] }])).toBeNull();
    expect(jobProblems([job, { ...clash, enabled: false }])).toBeNull();
  });

  it("keeps lunch out of job hours", () => {
    expect(jobProblems([job, jobB], "12:00")).toBeNull();
    expect(jobProblems([job, jobB], "11:30")).toBe(
      "Lunch overlaps Job A. Leave lunch out of job hours: end a part before it.",
    );
    expect(jobProblems([job, jobB], "")).toBeNull();
  });
});

describe("a job day in parts (split shift)", () => {
  const split: JobAnswer = {
    areaId: "joba",
    name: "Job A",
    days: [1, 2, 3, 4, 5],
    parts: [
      { start: "08:00", end: "10:00" },
      { start: "13:00", end: "15:00" },
    ],
  };
  const monday = (answers: Partial<typeof DEFAULT_ANSWERS>) =>
    defaultRoutine({
      ...DEFAULT_ANSWERS,
      jobs: [split],
      activeAreas: ["joba", "admin"],
      ...answers,
    })
      .filter((block) => block.weekday === 1)
      .map(
        (block) => `${toHhmm(block.startMin)} ${block.durationMin} ${block.kind} ${block.title}`,
      );

  it("makes one fixed block per part, both named after the job", () => {
    expect(monday({}).filter((line) => line.includes("fixed"))).toEqual([
      "08:00 120 fixed Job A",
      "13:00 120 fixed Job A",
    ]);
  });

  it("plans a focus block in a long gap between parts when there is no lunch", () => {
    // 10:00–13:00 is free: with the 15-minute buffers a 90-minute block fits.
    expect(monday({})).toContain("10:15 90 area Focus block");
  });

  it("keeps lunch free of focus blocks", () => {
    const day = monday({ lunch: "11:30" });
    expect(day).toContain("11:30 60 routine Lunch");
    const focus = day.filter((line) => line.includes("Focus block"));
    for (const line of focus) {
      const [time = "", minutes = "0"] = line.split(" ");
      const start = toMinutes(time);
      const end = start + Number(minutes);
      expect(start < 12 * 60 + 30 && 11 * 60 + 30 < end, line).toBe(false);
    }
  });

  it("puts lunch on workdays only", () => {
    const blocks = defaultRoutine({
      ...DEFAULT_ANSWERS,
      jobs: [split],
      activeAreas: ["joba"],
      lunch: "11:30",
    });
    expect(blocks.filter((block) => block.title === "Lunch").map((block) => block.weekday)).toEqual(
      [1, 2, 3, 4, 5],
    );
    expect(blocks.find((block) => block.title === "Lunch")?.areaId).toBeNull();
  });

  it("treats an email check at a part's end as part of it, not a free-time anchor", () => {
    // Checks at 10:00 and 15:00, the ends of the two parts: the gap after each
    // still starts at the part's end, so the focus block keeps its place.
    const day = monday({ emailChecks: ["10:00", "15:00"] });
    expect(day).toContain("10:00 10 routine Check email");
    expect(day).toContain("10:15 90 area Focus block");
  });

  it("still reads an answer saved before parts as one part", () => {
    const old: SavedJob = {
      areaId: "joba",
      name: "Kifiya",
      days: [2],
      start: "09:30",
      end: "18:00",
    };
    expect(jobParts(old)).toEqual([{ start: "09:30", end: "18:00" }]);
    const blocks = defaultRoutine({
      ...DEFAULT_ANSWERS,
      // Old saves reach defaultRoutine as they were stored.
      jobs: [old as JobAnswer],
    });
    expect(blocks).toContainEqual(
      expect.objectContaining({ weekday: 2, startMin: 570, durationMin: 510, title: "Kifiya" }),
    );
  });
});
