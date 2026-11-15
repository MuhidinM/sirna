import { describe, expect, it } from "vitest";

import { openTestDb } from "../../test/sqlite";
import {
  freeGap,
  laterTodayOps,
  MISSED_SQL,
  type MissedBlock,
  skipOps,
  tomorrowOps,
} from "./missed";

const at = (hhmm: string) => Date.parse(`2026-11-16T${hhmm}:00+03:00`);

describe("missed blocks (T-070)", () => {
  it("finds focus blocks that ended with no session and no tick", () => {
    const db = openTestDb();
    const add = db.prepare(
      "INSERT INTO day_blocks (id, logical_date, start_at, end_at, kind, title, status, created_at, updated_at) VALUES (?, '2026-11-16', ?, ?, ?, ?, ?, 0, 0)",
    );
    add.run("missed", at("09:00"), at("10:00"), "area", "Coding", "planned");
    add.run("focused", at("10:00"), at("11:00"), "area", "Job hunt", "planned");
    add.run("ticked", at("11:00"), at("12:00"), "area", "Admin", "done");
    add.run("routine", at("07:00"), at("07:30"), "routine", "Quran", "planned");
    add.run("later", at("15:00"), at("16:00"), "area", "Coding", "planned");
    // Planned at 12:30 for a slot that had already passed: not missed.
    db.prepare(
      "INSERT INTO day_blocks (id, logical_date, start_at, end_at, kind, title, status, created_at, updated_at) VALUES ('late-plan', '2026-11-16', ?, ?, 'area', 'Coding', 'planned', ?, 0)",
    ).run(at("08:00"), at("09:00"), at("12:30"));
    // Its task was finished another way: not missed.
    db.prepare(
      "INSERT INTO task_items (id, title, status, created_at, updated_at) VALUES ('t-done', 'Done', 'done', 0, 0)",
    ).run();
    db.prepare(
      "INSERT INTO day_blocks (id, logical_date, start_at, end_at, kind, title, status, task_id, created_at, updated_at) VALUES ('finished', '2026-11-16', ?, ?, 'area', 'Coding', 'planned', 't-done', 0, 0)",
    ).run(at("12:00"), at("12:45"));
    db.prepare(
      "INSERT INTO focus_sessions (id, block_id, kind, planned_min, started_at) VALUES ('f', 'focused', 'focus', 50, ?)",
    ).run(at("10:00"));
    const ids = (db.prepare(MISSED_SQL).all("2026-11-16", at("13:00")) as { id: string }[]).map(
      (r) => r.id,
    );
    expect(ids).toEqual(["missed"]);
  });

  it("finds the next free gap today, from the next quarter hour", () => {
    const others = [
      { start_at: at("14:00"), end_at: at("15:00"), status: "planned" },
      { start_at: at("15:20"), end_at: at("16:00"), status: "planned" },
      { start_at: at("16:30"), end_at: at("17:00"), status: "skipped" },
    ];
    const hour = 60 * 60_000;
    // 13:05 → 13:15; 13:15–14:00 is too short; 15:00–15:20 too; free from 16:00.
    expect(freeGap(others, hour, at("13:05"), at("22:00"))).toBe(at("16:00"));
    expect(freeGap(others, 30 * 60_000, at("13:05"), at("22:00"))).toBe(at("13:15"));
    expect(freeGap(others, hour, at("21:30"), at("22:00"))).toBeNull();
  });

  it("moves it later, to tomorrow, or skips it", () => {
    const block: MissedBlock = {
      id: "b",
      start_at: at("09:00"),
      end_at: at("10:00"),
      title: "Coding",
      task_id: "t",
      task_title: "Portfolio",
    };
    expect(laterTodayOps(block, at("16:00"))).toEqual([
      {
        op: "update",
        table: "day_blocks",
        id: "b",
        values: { start_at: at("16:00"), end_at: at("17:00") },
      },
    ]);
    expect(tomorrowOps(block, "2026-11-17")).toEqual([
      { op: "update", table: "task_items", id: "t", values: { planned_date: "2026-11-17" } },
      { op: "update", table: "day_blocks", id: "b", values: { status: "moved" } },
    ]);
    expect(tomorrowOps({ ...block, task_id: null }, "2026-11-17")).toHaveLength(1);
    expect(skipOps(block)[0]).toMatchObject({ values: { status: "skipped" } });
  });
});
