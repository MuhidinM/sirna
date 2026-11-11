import { describe, expect, it } from "vitest";

import { parseCapture } from "../../capture/parse";
import { echo, ideaInput, toOps } from "../../capture/ops";
import { type PlannedProject } from "./capacity";
import { ideaActionValues, placeIdea, shortDay } from "./idea";

const TODAY = "2026-11-11";
const NOW = Date.parse("2026-11-11T09:00:00Z");
const PLAN = { week: { capacity: 1000, areaCommitted: 500 }, projects: [], today: TODAY };
const active = (id: string): PlannedProject => ({
  id,
  status: "active",
  weekly_min: 100,
  start_date: null,
  forecast_finish: null,
});

const idea = (text: string) => {
  const parsed = parseCapture(text, { nowMs: NOW });
  if (parsed.kind !== "idea") throw new Error(`not an idea: ${parsed.kind}`);
  return parsed;
};

describe("reading an idea", () => {
  it("reads an estimate and a date and keeps the name", () => {
    expect(idea("idea: build a CLI budget tool ~18h by 20 dec")).toEqual({
      kind: "idea",
      body: "build a CLI budget tool ~18h by 20 dec",
      title: "build a CLI budget tool",
      estimateMin: 1080,
      deadline: "2026-12-20",
    });
    expect(idea("idea: learn Go 20 hours #coding")).toMatchObject({
      title: "learn Go",
      estimateMin: 1200,
      area: "coding",
    });
    expect(idea("idea: sell old monitor")).toEqual({ kind: "idea", body: "sell old monitor" });
  });
});

describe("placing an idea", () => {
  it("places an undated idea with an estimate by itself", () => {
    const placed = placeIdea(ideaInput(idea("idea: learn Go ~10h")), PLAN);
    expect(placed.values).toMatchObject({
      title: "learn Go",
      status: "active",
      estimate_min: 600,
      estimate_by: "user",
      start_date: "2026-11-16",
      forecast_finish: "2026-11-29",
      weekly_min: 350,
    });
    expect(placed.echo).toBe(
      "learn Go · starts Mon 16 Nov · 5 h 50/week · ~2 weeks · Ctrl+Z undoes",
    );
  });

  it("puts it in Next up when two projects already run", () => {
    const projects = [active("a"), { ...active("b"), forecast_finish: "2026-11-29" }];
    const placed = placeIdea(ideaInput(idea("idea: learn Go ~4h")), { ...PLAN, projects });
    expect(placed.values).toMatchObject({ status: "next_up", start_date: "2026-11-30" });
  });

  it("gives a dated idea its verdict and keeps it an idea", () => {
    const placed = placeIdea(ideaInput(idea("idea: CLI tool ~30h by 20 dec")), PLAN);
    expect(placed.values.status).toBe("idea");
    expect(placed.values.deadline).toBe("2026-12-20");
    expect(JSON.parse(String(placed.values.last_check_json))).toMatchObject({
      verdict: "good",
      weeklyNeeded: 315,
    });
    expect(placed.echo).toBe("Good · 5 h 15/week · load 50% → 82% · see Projects");
  });

  it("waits for an estimate", () => {
    expect(placeIdea(ideaInput(idea("idea: sell old monitor")), PLAN)).toEqual({
      values: {
        title: "sell old monitor",
        area_id: null,
        estimate_min: null,
        estimate_by: null,
        deadline: null,
        status: "idea",
        origin: "capture",
      },
      echo: 'Idea · add hours to place it, e.g. "~10h"',
    });
  });

  it("keeps it an idea when nothing fits", () => {
    const full = { ...PLAN, week: { capacity: 1000, areaCommitted: 900 } };
    const placed = placeIdea(ideaInput(idea("idea: learn Go ~10h")), full);
    expect(placed.values.status).toBe("idea");
    expect(placed.echo).toBe("Idea · no room in the next year at 85% load");
  });

  it("still saves when the week can't be read", () => {
    expect(placeIdea(ideaInput(idea("idea: learn Go ~10h")), null).values.status).toBe("idea");
  });
});

describe("the capture writes one project", () => {
  it("inserts the placed project in the capture's transaction", () => {
    const parsed = idea("idea: learn Go ~10h");
    const placed = placeIdea(ideaInput(parsed), PLAN);
    const ops = toOps(parsed, { nowMs: NOW, newId: () => "p1", idea: placed });
    expect(ops).toEqual([
      { op: "insert", table: "project_items", id: "p1", values: placed.values },
    ]);
    expect(echo(parsed, NOW, placed)).toBe(placed.echo);
  });

  it("writes an unplaced idea without a week", () => {
    const ops = toOps(idea("idea: sell old monitor"), { nowMs: NOW, newId: () => "p1" });
    expect(ops[0]).toMatchObject({ table: "project_items", values: { status: "idea" } });
  });

  it("labels days", () => {
    expect(shortDay("2026-11-16")).toBe("Mon 16 Nov");
  });
});

describe("acting on an idea's card", () => {
  const dated = { id: "me", estimate_min: 1800, deadline: "2026-12-20" };

  it("keeps the date: starts now, finishes by it", () => {
    expect(ideaActionValues(dated, { kind: "keep" }, PLAN)).toMatchObject({
      status: "active",
      start_date: TODAY,
      forecast_finish: "2026-12-20",
      weekly_min: 315,
    });
  });

  it("uses the suggested dates, moving the deadline", () => {
    expect(ideaActionValues(dated, { kind: "suggested" }, PLAN)).toMatchObject({
      status: "active",
      start_date: "2026-11-16",
      deadline: "2026-12-27",
      forecast_finish: "2026-12-27",
    });
  });

  it("places an undated idea, waiting when two projects run", () => {
    const projects = [active("a"), active("b")];
    const undated = { id: "me", estimate_min: 600, deadline: null };
    expect(ideaActionValues(undated, { kind: "place" }, { ...PLAN, projects })).toBeNull();
    const ends = [active("a"), { ...active("b"), forecast_finish: "2026-11-22" }];
    expect(ideaActionValues(undated, { kind: "place" }, { ...PLAN, projects: ends })).toMatchObject(
      {
        status: "next_up",
        start_date: "2026-11-23",
      },
    );
  });

  it("sets an estimate, drops, and refuses what can't apply", () => {
    const bare = { id: "me", estimate_min: null, deadline: null };
    expect(ideaActionValues(bare, { kind: "estimate", minutes: 600 }, PLAN)).toEqual({
      estimate_min: 600,
      estimate_by: "user",
    });
    expect(ideaActionValues(bare, { kind: "drop" }, PLAN)).toEqual({ status: "dropped" });
    expect(ideaActionValues(bare, { kind: "place" }, PLAN)).toBeNull();
    expect(
      ideaActionValues({ ...dated, deadline: "2026-11-01" }, { kind: "keep" }, PLAN),
    ).toBeNull();
  });
});

describe("review fixes", () => {
  it("keeps an unknown #tag in the name instead of failing the save", () => {
    const parsed = idea("idea: podcast ~10h #side");
    const known = placeIdea(ideaInput(idea("idea: learn Go ~10h #coding")), {
      ...PLAN,
      areaIds: ["coding"],
    });
    expect(known.values).toMatchObject({ title: "learn Go", area_id: "coding" });
    expect(placeIdea(ideaInput(parsed), { ...PLAN, areaIds: ["coding"] }).values).toMatchObject({
      title: "podcast #side",
      area_id: null,
    });
    expect(placeIdea(ideaInput(parsed), null).values.area_id).toBeNull();
  });

  it("only reads a bare number of hours at the end or before by", () => {
    expect(idea("idea: 3h podcast")).toEqual({ kind: "idea", body: "3h podcast" });
    expect(idea("idea: 24h fitness challenge app")).not.toHaveProperty("estimateMin");
    expect(idea("idea: podcast 3h")).toMatchObject({ title: "podcast", estimateMin: 180 });
    expect(idea("idea: podcast 3 hours by fri")).toMatchObject({
      title: "podcast",
      estimateMin: 180,
    });
    expect(idea("idea: ~3h podcast")).toMatchObject({ title: "podcast", estimateMin: 180 });
  });

  it("won't keep a date by starting a third running project", () => {
    const projects = [active("a"), active("b")];
    const dated = { id: "me", estimate_min: 600, deadline: "2026-12-20" };
    expect(ideaActionValues(dated, { kind: "keep" }, { ...PLAN, projects })).toBeNull();
  });

  it("finds the projects a capture made", async () => {
    const { openTestDb } = await import("../../test/sqlite");
    const { REPLACED_PROJECTS_SQL } = await import("./idea");
    const db = openTestDb();
    db.exec(`INSERT INTO core_activity (at, actor, context, entity_type, entity_id, action)
      VALUES (0, 'user', 'capture:7', 'project_items', 'p1', 'insert'),
             (0, 'user', 'capture:7', 'task_items', 't1', 'insert'),
             (0, 'user', 'capture:8', 'project_items', 'p2', 'insert')`);
    expect(db.prepare(REPLACED_PROJECTS_SQL).all("capture:7")).toEqual([{ entity_id: "p1" }]);
  });
});
