import { describe, expect, it } from "vitest";

import { openTestDb } from "../../test/sqlite";
import {
  insightRange,
  insights,
  localHour,
  weekdayCounts,
  type SessionRow,
  SESSIONS_SQL,
  weekSummary,
} from "./insights";

/** A session at an Addis local time on a date. */
const at = (date: string, hour: number, change: Partial<SessionRow> = {}): SessionRow => ({
  started_at: Date.parse(`${date}T${String((hour + 21) % 24).padStart(2, "0")}:00:00Z`),
  minutes: 50,
  planned_min: 50,
  outcome: "completed",
  distractions: 0,
  ...change,
});

describe("insights from seeded sessions", () => {
  it("knows the Addis hour", () => {
    expect(localHour(Date.parse("2026-11-10T06:00:00Z"))).toBe(9);
    expect(localHour(Date.parse("2026-11-10T22:00:00Z"))).toBe(1);
  });

  it("finds the best focus window when the gap is clear", () => {
    const sessions = [
      ...["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"].map((d) =>
        at(d, 9),
      ),
      at("2026-11-02", 19, { outcome: "stopped" }),
      at("2026-11-03", 19, { outcome: "stopped" }),
      at("2026-11-04", 19),
      at("2026-11-05", 19, { outcome: "interrupted" }),
    ];
    expect(insights(sessions).find((i) => i.key === "window")?.text).toBe(
      "Your best focus window: mornings (5 of 5 sessions finished).",
    );
  });

  it("says nothing about windows without enough sessions or a gap", () => {
    const even = [9, 9, 9, 9, 19, 19, 19, 19].map((h, i) => at(`2026-11-0${(i % 5) + 2}`, h));
    expect(insights(even).some((i) => i.key === "window")).toBe(false);
    expect(insights([at("2026-11-02", 9)])).toEqual([]);
  });

  it("names the strongest weekday once there are two of each", () => {
    // Tuesdays 3 and 4 Nov… 10 Nov: 150 min each; Mondays 2 and 9 Nov: 50 min.
    const sessions = [
      at("2026-11-03", 9),
      at("2026-11-03", 11),
      at("2026-11-03", 14),
      at("2026-11-10", 9),
      at("2026-11-10", 11),
      at("2026-11-10", 14),
      at("2026-11-02", 9),
      at("2026-11-09", 9),
    ];
    expect(insights(sessions).find((i) => i.key === "weekday")?.text).toBe(
      "Tuesdays are your strongest day (2 h 30 of focus on average).",
    );
  });

  it("notices fewer distractions in short sessions and many early stops", () => {
    const sessions = [
      ...[2, 3, 4, 5].map((d) => at(`2026-11-0${d}`, 9, { planned_min: 25, distractions: 0 })),
      ...[2, 3, 4, 5].map((d) =>
        at(`2026-11-0${d}`, 15, {
          planned_min: 50,
          distractions: 2,
          outcome: d < 5 ? "stopped" : "completed",
        }),
      ),
    ];
    const found = insights(sessions);
    expect(found.find((i) => i.key === "length")?.text).toBe(
      "You note fewer distractions in short sessions (0 vs 2 a session). Try 25 minutes when it's hard to settle.",
    );
    expect(found.find((i) => i.key === "early")?.text).toBe(
      "3 of 8 sessions ended early. A smaller first step may help them stick.",
    );
  });

  it("reads finished focus sessions, pauses left out", () => {
    const db = openTestDb();
    db.exec(`INSERT INTO focus_sessions (id, kind, started_at, planned_min, ended_at, paused_ms, outcome, distractions) VALUES
      ('a', 'focus', 1000, 50, 1000 + 3600000, 600000, 'completed', 1),
      ('b', 'break', 1000, 5, 1000 + 300000, 0, 'completed', 0),
      ('c', 'focus', 2000, 50, NULL, 0, NULL, 0)`);
    expect(db.prepare(SESSIONS_SQL).all(0)).toEqual([
      { started_at: 1000, minutes: 50, planned_min: 50, outcome: "completed", distractions: 1 },
    ]);
  });
});

describe("the week in plain words", () => {
  it("says what was met, what is furthest behind, and next week's load", () => {
    expect(
      weekSummary({
        areas: [
          { name: "Quran", done_min: 140, target_min: 140 },
          { name: "Job hunt", done_min: 50, target_min: 240 },
          { name: "Coding skills", done_min: 200, target_min: 240 },
        ],
        sessions: 9,
        overrunDays: 1,
        nextWeekPercent: 22,
      }),
    ).toBe(
      "9 focus sessions this week. On target: Quran. Furthest behind: Job hunt (50 min of 4 h). 1 day past the focus cap. Next week is at 22% of your free time.",
    );
  });
});

describe("review fixes", () => {
  it("averages a weekday over every such day in the window, empty ones included", () => {
    const range = insightRange("2026-11-29");
    expect(range.from).toBe("2026-11-02");
    expect(weekdayCounts(range.from, range.to)[2]).toBe(4); // four Tuesdays
    // Two Tuesdays of 150 min and two empty ones: 75 a Tuesday, not 150.
    const sessions = [
      at("2026-11-03", 9, { minutes: 150 }),
      at("2026-11-10", 9, { minutes: 150 }),
      ...["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23"].map((d) =>
        at(d, 9, { minutes: 90 }),
      ),
    ];
    expect(insights(sessions, range).some((i) => i.key === "weekday")).toBe(false);
  });
});
