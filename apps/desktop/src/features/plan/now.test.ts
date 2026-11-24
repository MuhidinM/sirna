import { describe, expect, it } from "vitest";

import { openTestDb } from "../../test/sqlite";
import {
  type BlockRow,
  blockProgress,
  doneToggle,
  firstStep,
  skipToggle,
  focusOffer,
  formatMinutes,
  nowAndNext,
  TODAY_BLOCKS_SQL,
} from "./now";

const at = (hhmm: string) => Date.parse(`2026-11-11T${hhmm}:00+03:00`);
const block = (
  id: string,
  from: string,
  to: string,
  kind: BlockRow["kind"] = "area",
  task: string | null = null,
): BlockRow => ({
  id,
  start_at: at(from),
  end_at: at(to),
  kind,
  area_id: null,
  task_id: task ? `t-${id}` : null,
  title: id,
  status: "planned",
  color: null,
  task_title: task,
});

const day = [
  block("quran", "06:00", "06:20", "routine"),
  block("jobA", "08:00", "12:00", "fixed"),
  block("email", "10:00", "10:10", "routine"),
  block("gym", "17:30", "18:15", "routine"),
];

describe("nowAndNext", () => {
  it("finds the current block and the next one", () => {
    const result = nowAndNext(day, at("09:00"));
    expect(result.now?.id).toBe("jobA");
    expect(result.next?.id).toBe("email");
    expect(result.minutesToNext).toBe(60);
  });

  it("prefers the shorter block when two overlap", () => {
    expect(nowAndNext(day, at("10:05")).now?.id).toBe("email");
  });

  it("has no current block in a gap", () => {
    const result = nowAndNext(day, at("13:00"));
    expect(result.now).toBeUndefined();
    expect(result.next?.id).toBe("gym");
    expect(result.minutesToNext).toBe(270);
  });

  it("has nothing next after the last block", () => {
    expect(nowAndNext(day, at("20:00"))).toEqual({
      now: undefined,
      next: undefined,
      minutesToNext: undefined,
    });
  });

  it("ignores the rest-day block", () => {
    expect(nowAndNext([block("rest", "06:30", "20:30", "rest")], at("09:00")).now).toBeUndefined();
  });
});

describe("helpers", () => {
  it("formats minutes", () => {
    expect(formatMinutes(48)).toBe("48 min");
    expect(formatMinutes(120)).toBe("2 h");
    expect(formatMinutes(125)).toBe("2 h 5 min");
  });

  it("uses the block's task as the first step", () => {
    expect(firstStep(block("coding", "18:30", "19:30", "area", "Finish login form"))).toBe(
      "Finish login form",
    );
    expect(firstStep(block("Gym", "17:30", "18:15", "routine"))).toBe("Gym");
  });
});

describe("Start focus on the Now card (rule 7)", () => {
  it("is always offered while no session runs: on the block now, or on nothing", () => {
    const now = block("Gym", "09:00", "10:00", "routine");
    expect(focusOffer(now, null)).toEqual({ blockId: "Gym" });
    expect(focusOffer(undefined, null)).toEqual({ blockId: null });
    expect(focusOffer(undefined, undefined)).toEqual({ blockId: null });
    expect(focusOffer(now, "focus")).toBeNull();
  });
});

describe("when a block counts as done (focus)", () => {
  const hour = { start_at: 0, end_at: 60 * 60_000, status: "planned" };
  it("is done when marked, or after 80% of its length in focus", () => {
    expect(blockProgress({ ...hour, focused_min: 35 })).toEqual({
      focusedMin: 35,
      lengthMin: 60,
      done: false,
    });
    expect(blockProgress({ ...hour, focused_min: 48 }).done).toBe(true);
    expect(blockProgress({ ...hour, status: "done", focused_min: null }).done).toBe(true);
  });

  it("is not done once skipped, whatever the focus says (Not done on a focused block)", () => {
    expect(blockProgress({ ...hour, status: "skipped", focused_min: 55 }).done).toBe(false);
  });
});

describe("ticking a block (review, block editor)", () => {
  const hour = { start_at: 0, end_at: 60 * 60_000, status: "planned", focused_min: 0 };
  it("marks an open block done, and a marked one back to planned", () => {
    expect(doneToggle(hour)).toBe("done");
    expect(doneToggle({ ...hour, status: "done" })).toBe("planned");
  });

  it("un-ticks a block done by focus as skipped, so the 80% rule can't tick it again", () => {
    const focused = { ...hour, focused_min: 55 };
    expect(doneToggle(focused)).toBe("skipped");
    expect(blockProgress({ ...focused, status: doneToggle(focused) }).done).toBe(false);
    expect(doneToggle({ ...focused, status: "skipped" })).toBe("done");
  });

  it("skips and unskips", () => {
    expect(skipToggle(hour)).toBe("skipped");
    expect(skipToggle({ ...hour, status: "skipped" })).toBe("planned");
  });
});

describe("a block finished or skipped is not Now", () => {
  it("moves on from a block marked done or skipped", () => {
    const review = { ...block("review", "21:00", "21:15", "routine"), status: "done" };
    expect(nowAndNext([review], at("21:05")).now).toBeUndefined();
    const gym = { ...block("gym", "17:30", "18:15", "routine"), status: "skipped" };
    expect(nowAndNext([gym], at("17:00")).next).toBeUndefined();
  });
});

describe("the focus time on a block (TODAY_BLOCKS_SQL)", () => {
  it("adds finished focus sessions, paused time left out", () => {
    const db = openTestDb();
    db.exec(`INSERT INTO day_blocks (id, logical_date, start_at, end_at, kind, title, source, created_at, updated_at)
      VALUES ('b', '2026-11-24', 0, 3600000, 'area', 'Coding', 'generator', 0, 0)`);
    db.exec(`INSERT INTO focus_sessions (id, block_id, kind, started_at, planned_min, paused_ms, ended_at)
      VALUES ('f1', 'b', 'focus', 0, 25, 300000, 1800000), ('f2', 'b', 'focus', 0, 25, 0, NULL)`);
    const [row] = db.prepare(TODAY_BLOCKS_SQL).all("2026-11-24") as { focused_min: number }[];
    expect(row?.focused_min).toBe(25);
  });
});
