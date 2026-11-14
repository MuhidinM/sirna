import { describe, expect, it } from "vitest";

import { localToEpoch } from "../capture/when";
import { type BlockRow } from "../features/plan/now";
import { openTestDb } from "../test/sqlite";
import { clock, CHEATS_SQL, NOTE_SQL, timerSummary, widgetView } from "./view";

const at = (hhmm: string) => {
  const [h = 0, m = 0] = hhmm.split(":").map(Number);
  return localToEpoch("2026-11-12", h * 60 + m);
};
const block = (id: string, from: string, to: string, extra: Partial<BlockRow> = {}): BlockRow => ({
  id,
  start_at: at(from),
  end_at: at(to),
  kind: "area",
  area_id: null,
  task_id: null,
  title: id,
  status: "planned",
  color: null,
  task_title: null,
  ...extra,
});
const base = { blocks: [], top: [], focus: null, note: null, nowMs: at("10:00") };

describe("the desktop widget", () => {
  it("shows the block now, with its task", () => {
    const view = widgetView({
      ...base,
      blocks: [block("Job hunt", "09:30", "11:00", { task_title: "Send CV" })],
    });
    expect(view.now).toBe("Now · Send CV");
  });

  it("shows the next block when nothing is on, and says when nothing is planned", () => {
    expect(widgetView({ ...base, blocks: [block("Gym", "14:00", "15:00")] }).now).toBe(
      "Next 14:00 · Gym",
    );
    expect(widgetView(base).now).toBe("Nothing planned right now");
    const skipped = block("Gym", "09:00", "11:00", { status: "skipped" });
    expect(widgetView({ ...base, blocks: [skipped] }).now).toBe("Nothing planned right now");
  });

  it("draws the timer ring from what is left", () => {
    const view = widgetView({
      ...base,
      focus: {
        kind: "focus",
        title: "Coding",
        remaining_ms: 10 * 60000,
        planned_min: 40,
        paused: false,
      },
    });
    expect(view.timer).toEqual({ label: "Coding", clock: "10:00", fraction: 0.25, paused: false });
    expect(timerSummary(view)).toBe("Coding, 10:00 left");
    const pause = widgetView({
      ...base,
      focus: { kind: "long_break", title: "", remaining_ms: 0, planned_min: 0, paused: true },
    });
    expect(pause.timer).toMatchObject({ label: "Long break", fraction: 0, paused: true });
    expect(
      widgetView({
        ...base,
        focus: { kind: null, title: "", remaining_ms: 0, planned_min: 0, paused: false },
      }).timer,
    ).toBeNull();
  });

  it("keeps the top 3 and marks done ones", () => {
    const view = widgetView({
      ...base,
      top: [
        { title: "a", status: "todo" },
        { title: "b", status: "done" },
        { title: "c", status: "todo" },
        { title: "d", status: "todo" },
      ],
    });
    expect(view.top).toEqual([
      { title: "a", done: false },
      { title: "b", done: true },
      { title: "c", done: false },
    ]);
  });

  it("shows the first lines of the pinned cheat sheet", () => {
    const body = ["", "one", "two  ", "three", "four", "five", "six", "seven"].join("\n");
    const view = widgetView({ ...base, note: { title: null, body } });
    expect(view.note).toEqual({
      title: "Cheat sheet",
      lines: ["one", "two", "three", "four", "five", "six"],
    });
  });

  it("formats the clock", () => {
    expect([clock(0), clock(61_000), clock(-5), clock(1)]).toEqual([
      "0:00",
      "1:01",
      "0:00",
      "0:01",
    ]);
  });

  it("finds the pinned cheat sheet, and nothing once it is deleted", () => {
    const db = openTestDb();
    db.prepare(
      "INSERT INTO note_items (id, kind, title, body, created_at, updated_at) VALUES ('n1', 'cheat', 'Git', 'git stash', 0, 0)",
    ).run();
    db.prepare(
      "INSERT INTO core_settings (key, value_json, updated_at) VALUES ('widget.note', '\"n1\"', 0)",
    ).run();
    expect(db.prepare(NOTE_SQL).all()).toEqual([{ title: "Git", body: "git stash" }]);
    expect(db.prepare(CHEATS_SQL).all()).toEqual([{ id: "n1", title: "Git" }]);
    db.prepare("UPDATE note_items SET deleted_at = 1").run();
    expect(db.prepare(NOTE_SQL).all()).toEqual([]);
  });
});
