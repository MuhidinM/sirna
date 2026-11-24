import { describe, expect, it } from "vitest";

import { openTestDb } from "../test/sqlite";
import { CAPTURE_MADE_SQL, fixBlocked, fixReading, madeKind, type MadeRow } from "./fix";
import { readings } from "./alternatives";
import { parseCapture } from "./parse";

const nowMs = Date.parse("2026-11-24T09:00:00+03:00");

function log(
  db: ReturnType<typeof openTestDb>,
  context: string | null,
  table: string,
  id: string,
  action: string,
  after: object = {},
) {
  db.prepare(
    "INSERT INTO core_activity (at, actor, context, entity_type, entity_id, action, after_json) VALUES (1, 'user', ?, ?, ?, ?, ?)",
  ).run(context, table, id, action, JSON.stringify(after));
}

describe("fixing a capture with Up arrow (r2-7)", () => {
  it("starts on the reading of the kind the capture made", () => {
    const text = "weekly money summary";
    const options = readings(parseCapture(text, { nowMs }), text, nowMs);
    const idea = fixReading(options, "idea");
    expect(idea).toBeGreaterThan(0);
    expect(options[idea]?.kind).toBe("idea");
    expect(fixReading(options, undefined)).toBe(0);
  });

  it("reads the kind from what the capture inserted", () => {
    const db = openTestDb();
    log(db, "capture:1", "project_items", "p1", "insert");
    log(db, "capture:2", "note_items", "n1", "insert", { kind: "cheat" });
    log(db, "capture:3", "task_items", "t1", "insert");
    const made = (context: string) =>
      db.prepare(CAPTURE_MADE_SQL).all(context) as unknown as MadeRow[];
    expect(madeKind(made("capture:1"))).toBe("idea");
    expect(madeKind(made("capture:2"))).toBe("cheat");
    expect(madeKind(made("capture:3"))).toBe("task");
    expect(madeKind(made("capture:9"))).toBeUndefined();
  });

  it("won't replace a project you changed since", () => {
    const db = openTestDb();
    log(db, "capture:1", "project_items", "p1", "insert");
    const made = () => db.prepare(CAPTURE_MADE_SQL).all("capture:1") as unknown as MadeRow[];
    expect(fixBlocked(made())).toBeNull();
    log(db, null, "project_items", "p1", "update");
    expect(fixBlocked(made())).toMatch(/Edit it on Projects/);
  });
});
