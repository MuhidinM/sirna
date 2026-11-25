import { describe, expect, it } from "vitest";

import { openTestDb } from "../../test/sqlite";
import { JOB_MINUTES_SQL, JOB_PAY_SQL, jobRates } from "./rate";

const at = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00+03:00`);

describe("birr per hour for each job (T-073)", () => {
  it("divides pay by the hours of the job's blocks, rounded down", () => {
    expect(
      jobRates(
        [
          { area_id: "joba", name: "Job A", minutes: 160 * 60 },
          { area_id: "jobb", name: "Job B", minutes: 80 * 60 },
          { area_id: "jobc", name: "Job C", minutes: 10 * 60 },
        ],
        [
          { area_id: "joba", minor: 1_800_000, currency: "ETB" },
          { area_id: "jobb", minor: 2_100_000 },
        ],
      ),
    ).toEqual([
      // 21,000 ÷ 80 h = 262.5 → 262; 18,000 ÷ 160 h = 112.5 → 112.
      { areaId: "jobb", name: "Job B", pay: 2_100_000, minutes: 4800, perHour: 26_200 },
      { areaId: "joba", name: "Job A", pay: 1_800_000, minutes: 9600, perHour: 11_200 },
      { areaId: "jobc", name: "Job C", pay: 0, minutes: 600, perHour: null },
    ]);
  });

  it("counts blocks up to now, not skipped or moved ones, and pay by job", () => {
    const db = openTestDb();
    const block = db.prepare(
      "INSERT INTO day_blocks (id, logical_date, start_at, end_at, kind, area_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'fixed', ?, 'Job', ?, 0, 0)",
    );
    block.run(
      "a1",
      "2026-11-16",
      at("2026-11-16", "08:00"),
      at("2026-11-16", "12:00"),
      "joba",
      "planned",
    );
    block.run(
      "a2",
      "2026-11-17",
      at("2026-11-17", "08:00"),
      at("2026-11-17", "12:00"),
      "joba",
      "skipped",
    );
    // Only the part up to now (10:00) counts today.
    block.run(
      "a3",
      "2026-11-18",
      at("2026-11-18", "08:00"),
      at("2026-11-18", "12:00"),
      "joba",
      "planned",
    );
    block.run(
      "g",
      "2026-11-16",
      at("2026-11-16", "17:00"),
      at("2026-11-16", "18:00"),
      "gym",
      "planned",
    );
    expect(
      db.prepare(JOB_MINUTES_SQL).all("2026-11-01", "2026-11-30", at("2026-11-18", "10:00")),
    ).toEqual([{ area_id: "joba", name: "Job A", minutes: 360 }]);
    db.prepare(
      "INSERT INTO money_txns (id, occurred_at, local_date, amount_minor, description, area_id, created_at, updated_at) VALUES ('p', 0, '2026-11-10', 1800000, 'salary', 'joba', 0, 0)",
    ).run();
    expect(db.prepare(JOB_PAY_SQL).all("2026-11-01", "2026-11-30")).toEqual([
      { area_id: "joba", minor: 1_800_000, currency: "ETB" },
    ]);
  });

  it("adds up both parts of a split job day (T-079)", () => {
    const db = openTestDb();
    const block = db.prepare(
      "INSERT INTO day_blocks (id, logical_date, start_at, end_at, kind, area_id, title, status, created_at, updated_at) VALUES (?, '2026-11-16', ?, ?, 'fixed', 'joba', 'Job A', 'planned', 0, 0)",
    );
    block.run("am", at("2026-11-16", "08:00"), at("2026-11-16", "10:00"));
    block.run("pm", at("2026-11-16", "13:00"), at("2026-11-16", "15:00"));
    expect(
      db.prepare(JOB_MINUTES_SQL).all("2026-11-01", "2026-11-30", at("2026-11-20", "12:00")),
    ).toEqual([{ area_id: "joba", name: "Job A", minutes: 240 }]);
  });
});
