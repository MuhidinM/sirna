import { describe, expect, it } from "vitest";

import { openTestDb } from "../../test/sqlite";
import { type BlockRow } from "../plan/now";
import {
  type BriefInput,
  buildBrief,
  loadLabel,
  MAX_LINES,
  moneyLines,
  WEEK_SQL,
  weekStart,
} from "./brief";

const at = (hhmm: string, date = "2026-11-11") => Date.parse(`${date}T${hhmm}:00+03:00`);

function block(
  id: string,
  kind: BlockRow["kind"],
  from: string,
  to: string,
  title: string,
  status = "planned",
): BlockRow {
  return {
    id,
    kind,
    start_at: at(from),
    end_at: at(to),
    area_id: null,
    task_id: null,
    title,
    status,
    color: null,
    task_title: null,
  };
}

const day: BlockRow[] = [
  block("q", "routine", "06:00", "06:20", "Quran"),
  block("a", "fixed", "08:00", "12:00", "Job A"),
  block("b", "fixed", "13:00", "17:00", "Job B"),
  block("g", "routine", "17:30", "18:15", "Gym"),
  block("c", "area", "19:00", "19:50", "Coding"),
  block("r", "routine", "21:00", "21:15", "Night review"),
];

const input: BriefInput = {
  nowMs: at("06:05"),
  today: "2026-11-11",
  blocks: day,
  top: [
    { title: "Send weekly report", due_date: "2026-11-11" },
    { title: "Apply: Backend dev", due_date: "2026-11-09" },
    { title: "Portfolio site: About page", due_date: null },
    { title: "A fourth task", due_date: null },
  ],
  week: [
    { id: "jobhunt", name: "Job hunt", target_min: 240, done_min: 90 },
    { id: "coding", name: "Coding", target_min: 240, done_min: 120 },
    { id: "gym", name: "Gym", target_min: 135, done_min: 0 },
    { id: "quran", name: "Quran", target_min: 140, done_min: 140 },
  ],
  checks: { notificationsMuted: false, autostartOff: false },
  wakeMin: 6 * 60,
  hardStopMin: 22 * 60,
};

const render = (lines: ReturnType<typeof buildBrief>) =>
  lines.map((l) => [l.label, l.text, l.meta].filter(Boolean).join(" | "));

describe("buildBrief", () => {
  it("matches the golden brief", () => {
    expect(render(buildBrief(input))).toEqual([
      "Wed 11 Nov | 06:05",
      "NOW | Quran · 06:00–06:20",
      "TOP 3 | Send weekly report | due today",
      "Apply: Backend dev | since 9 Nov",
      "Portfolio site: About page",
      "TODAY | 06:00 Quran · 08–12 Job A · 13–17 Job B · 17:30 Gym · 19:00 Coding · +1",
      "LOAD | 2 h 10 min planned of 8 h free · light",
      "THIS WEEK | Gym 0 / 2 h 15 min · Job hunt 1 h 30 min / 4 h · Coding 2 h / 4 h",
    ]);
  });

  it("shows the week's outcomes after the load (T-076)", () => {
    const lines = render(buildBrief({ ...input, outcomes: ["Ship the invoice", "Gym 3 times"] }));
    expect(lines.slice(7, 9)).toEqual([
      "OUTCOMES | Ship the invoice · Gym 3 times",
      "THIS WEEK | Gym 0 / 2 h 15 min · Job hunt 1 h 30 min / 4 h · Coding 2 h / 4 h",
    ]);
    expect(render(buildBrief({ ...input, outcomes: [] }))).toHaveLength(8);
  });

  it("puts the checks first and stays within 12 lines", () => {
    const lines = buildBrief({
      ...input,
      checks: { notificationsMuted: true, autostartOff: true },
    });
    expect(lines.length).toBeLessThanOrEqual(MAX_LINES);
    expect(lines.slice(1, 3).map((l) => [l.label, l.tone])).toEqual([
      ["CHECK", "warn"],
      ["CHECK", "warn"],
    ]);
  });

  it("hides empty sections and shows the next block between blocks", () => {
    const lines = buildBrief({ ...input, nowMs: at("07:00"), top: [], week: [] });
    expect(lines.map((l) => l.label)).toEqual(["", "NEXT", "TODAY", "LOAD"]);
    expect(lines[1]?.text).toBe("Job A · 08:00–12:00");
  });

  it("shows up to two money lines: bills due and late pay (T-059, T-060)", () => {
    const lines = buildBrief({
      ...input,
      due: [
        "Rent 6,000 ETB due today",
        "Job A pay is late: 18,000 ETB expected on 10 Nov",
        "Third",
      ],
    });
    expect(render(lines).filter((line) => /Rent|Job A pay|Third/.test(line))).toEqual([
      "MONEY | Rent 6,000 ETB due today",
      "Job A pay is late: 18,000 ETB expected on 10 Nov | +1 more",
    ]);
    expect(lines.length).toBeLessThanOrEqual(MAX_LINES);
  });

  it("says how many money lines didn't fit", () => {
    const lines = buildBrief({ ...input, due: ["A", "B", "C", "D"] });
    expect(render(lines).filter((line) => /^(MONEY \| )?[ABCD]\b/.test(line))).toEqual([
      "MONEY | A",
      "B | +2 more",
    ]);
  });

  it("dates the day it is, not the calendar: 00:30 is still the evening before", () => {
    const late = Date.parse("2026-11-25T00:30:00+03:00");
    const [first] = buildBrief({ ...input, nowMs: late, today: "2026-11-24" });
    expect(first).toEqual({ label: "", text: "Tue 24 Nov", meta: "00:30" });
  });

  it("leaves skipped blocks out", () => {
    const blocks = day.map((b) => (b.id === "q" ? { ...b, status: "skipped" } : b));
    const lines = buildBrief({ ...input, blocks });
    expect(lines[1]?.label).toBe("NEXT");
  });

  it("ends with what changed since yesterday and stays within 12 lines when full", () => {
    const lines = buildBrief({
      ...input,
      checks: { notificationsMuted: true, autostartOff: true },
      changed: { captured: 3, done: 2, moved: 1, follow_ups: 1 },
    });
    // Every section filled is 11 lines, so CHANGED is never cut by the cap.
    expect(lines).toHaveLength(11);
    expect(lines.length).toBeLessThanOrEqual(MAX_LINES);
    expect(lines.at(-1)).toEqual({
      label: "CHANGED",
      text: "3 captured · 2 done · 1 moved · 1 follow-up due",
    });
  });

  it("is just the date on an empty day", () => {
    expect(buildBrief({ ...input, blocks: [], top: [], week: [] })).toHaveLength(1);
  });
});

describe("moneyLines", () => {
  it("gives a loan follow-up a slot beside the bills", () => {
    expect(moneyLines(["Iddir 1", "Iddir 2"], ["Ask Hana", "Ask Dawit"])).toEqual([
      "Iddir 1",
      "Ask Hana",
      "Iddir 2",
      "Ask Dawit",
    ]);
    expect(moneyLines(["Iddir 1", "Iddir 2"], [])).toEqual(["Iddir 1", "Iddir 2"]);
    expect(moneyLines([], ["Ask Hana", "Ask Dawit"])).toEqual(["Ask Hana", "Ask Dawit"]);
  });
});

describe("loadLabel", () => {
  it.each([
    [100, 400, "light"],
    [300, 400, "steady"],
    [400, 400, "full"],
    [401, 400, "over"],
    [0, 0, "free"],
    [10, 0, "over"],
  ])("%i of %i is %s", (planned, free, label) => {
    expect(loadLabel(planned, free)).toBe(label);
  });
});

describe("weekStart", () => {
  it("is Monday 03:00", () => {
    expect(weekStart(at("12:00"))).toBe(at("03:00", "2026-11-09"));
  });
  it("counts Monday before 03:00 as the week before", () => {
    expect(weekStart(at("02:00", "2026-11-09"))).toBe(at("03:00", "2026-11-02"));
  });
  it("keeps Sunday in the same week", () => {
    expect(weekStart(at("23:00", "2026-11-15"))).toBe(at("03:00", "2026-11-09"));
  });
});

describe("WEEK_SQL", () => {
  it("adds focused minutes and done routines, and skips work areas", () => {
    const db = openTestDb();
    const insertBlock = db.prepare(
      `INSERT INTO day_blocks (id, logical_date, start_at, end_at, kind, area_id, title, status, created_at, updated_at)
       VALUES (?, '2026-11-10', ?, ?, ?, ?, ?, ?, 0, 0)`,
    );
    insertBlock.run(
      "cb",
      at("19:00", "2026-11-10"),
      at("20:00", "2026-11-10"),
      "area",
      "coding",
      "Coding",
      "planned",
    );
    insertBlock.run(
      "gb",
      at("17:30", "2026-11-10"),
      at("18:15", "2026-11-10"),
      "routine",
      "gym",
      "Gym",
      "done",
    );
    insertBlock.run(
      "qb",
      at("06:00", "2026-11-10"),
      at("06:20", "2026-11-10"),
      "routine",
      "quran",
      "Quran",
      "skipped",
    );
    const insertSession = db.prepare(
      `INSERT INTO focus_sessions (id, block_id, area_id, kind, started_at, planned_min, paused_ms, ended_at)
       VALUES (?, ?, ?, ?, ?, 25, ?, ?)`,
    );
    // 25 min through the block, 20 min with a 5-minute pause, a break, and last week's session.
    insertSession.run(
      "s1",
      "cb",
      null,
      "focus",
      at("19:00", "2026-11-10"),
      0,
      at("19:25", "2026-11-10"),
    );
    insertSession.run(
      "s2",
      null,
      "coding",
      "focus",
      at("10:00", "2026-11-11"),
      300000,
      at("10:25", "2026-11-11"),
    );
    insertSession.run(
      "s3",
      null,
      "coding",
      "break",
      at("10:25", "2026-11-11"),
      0,
      at("10:30", "2026-11-11"),
    );
    insertSession.run(
      "s4",
      null,
      "coding",
      "focus",
      at("10:00", "2026-11-08"),
      0,
      at("10:25", "2026-11-08"),
    );

    const rows = db.prepare(WEEK_SQL).all(weekStart(at("12:00")), at("12:00"));
    const done = Object.fromEntries(rows.map((r) => [r.id, r.done_min]));
    expect(done).toMatchObject({ coding: 45, gym: 45, quran: 0, jobhunt: 0 });
    expect(done).not.toHaveProperty("joba");
  });

  it("counts a habit block focused and marked done once", () => {
    const db = openTestDb();
    db.prepare(
      `INSERT INTO day_blocks (id, logical_date, start_at, end_at, kind, area_id, title, status, created_at, updated_at)
       VALUES ('qb', '2026-11-10', ?, ?, 'routine', 'quran', 'Quran', 'done', 0, 0)`,
    ).run(at("06:00", "2026-11-10"), at("06:20", "2026-11-10"));
    db.prepare(
      `INSERT INTO focus_sessions (id, block_id, kind, started_at, planned_min, paused_ms, ended_at)
       VALUES ('s', 'qb', 'focus', ?, 20, 0, ?)`,
    ).run(at("06:00", "2026-11-10"), at("06:20", "2026-11-10"));
    const rows = db.prepare(WEEK_SQL).all(weekStart(at("12:00")), at("12:00"));
    expect(rows.find((r) => r.id === "quran")?.done_min).toBe(20);
  });
});
