import { describe, expect, it } from "vitest";

import { openTestDb } from "../../test/sqlite";
import { CHANGED_SQL, type ChangedCounts, changedText } from "./changed";

const at = (iso: string) => Date.parse(iso);
const yesterdayStart = at("2026-11-10T03:00:00+03:00");

describe("changedText", () => {
  it("joins what changed and hides zeros", () => {
    expect(changedText({ captured: 3, done: 2, moved: 0, follow_ups: 1 })).toBe(
      "3 captured · 2 done · 1 follow-up due",
    );
    expect(changedText({ captured: 0, done: 0, moved: 2, follow_ups: 2 })).toBe(
      "2 moved · 2 follow-ups due",
    );
  });

  it("is nothing when nothing changed", () => {
    expect(changedText({ captured: 0, done: 0, moved: 0, follow_ups: 0 })).toBeUndefined();
    expect(changedText(undefined)).toBeUndefined();
  });
});

describe("CHANGED_SQL", () => {
  it("counts since the start of yesterday", () => {
    const db = openTestDb();
    const raw = db.prepare(
      "INSERT INTO core_raw_items (source, received_at, body, parse_status) VALUES ('capture', ?, ?, ?)",
    );
    raw.run(at("2026-11-10T09:00:00+03:00"), "lunch 120", "parsed");
    raw.run(at("2026-11-11T08:00:00+03:00"), "call bank", "parsed");
    raw.run(at("2026-11-11T08:01:00+03:00"), "oops", "ignored"); // undone
    raw.run(at("2026-11-09T09:00:00+03:00"), "old", "parsed");

    const task = db.prepare(
      `INSERT INTO task_items (id, title, status, completed_at, follow_up_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, 0)`,
    );
    task.run("d1", "sent report", "done", at("2026-11-10T17:00:00+03:00"), null);
    task.run("d0", "old done", "done", at("2026-11-09T17:00:00+03:00"), null);
    task.run("w1", "recruiter", "waiting", null, "2026-11-11");
    task.run("w2", "landlord", "waiting", null, "2026-11-14");

    const activity = db.prepare(
      `INSERT INTO core_activity (at, actor, entity_type, entity_id, action, before_json, after_json)
       VALUES (?, 'user', 'task_items', ?, 'update', ?, ?)`,
    );
    const due = (date: string | null) => JSON.stringify({ due_date: date });
    // Carried twice: counts once. A title-only edit and an old move don't count.
    activity.run(at("2026-11-10T21:30:00+03:00"), "t1", due("2026-11-10"), due("2026-11-11"));
    activity.run(at("2026-11-11T07:00:00+03:00"), "t1", due("2026-11-11"), due("2026-11-12"));
    activity.run(at("2026-11-11T07:00:00+03:00"), "t2", due("2026-11-11"), due("2026-11-11"));
    activity.run(at("2026-11-09T21:30:00+03:00"), "t3", due("2026-11-09"), due("2026-11-10"));

    const counts = db
      .prepare(CHANGED_SQL)
      .get(yesterdayStart, "2026-11-11") as unknown as ChangedCounts;
    expect(counts).toEqual({ captured: 2, done: 1, moved: 1, follow_ups: 1 });
  });
});
