import { describe, expect, it } from "vitest";

import { type PlannedProject } from "./capacity";
import { EMPTY_DRAFT } from "./projects";
import { savePlan, timingOf } from "./timing";

const TODAY = "2026-11-11";
const WEEK = { capacity: 1000, areaCommitted: 500 };
const active = (id: string): PlannedProject => ({
  id,
  status: "active",
  weekly_min: 100,
  start_date: null,
  forecast_finish: null,
});

describe("timingOf", () => {
  it("waits for an estimate", () => {
    expect(timingOf({ ...EMPTY_DRAFT, title: "P" }, null, WEEK, [], TODAY)).toBeNull();
  });

  it("checks against the date when there is one", () => {
    const timing = timingOf(
      { ...EMPTY_DRAFT, title: "P", estimateHours: "10", deadline: "2026-12-20" },
      null,
      WEEK,
      [],
      TODAY,
    );
    expect(timing).toMatchObject({ kind: "date", check: { verdict: "good", weeklyNeeded: 105 } });
  });

  it("finds a slot without a date, at the hours asked for", () => {
    const timing = timingOf(
      { ...EMPTY_DRAFT, title: "P", estimateHours: "10", weeklyHours: "2" },
      null,
      WEEK,
      [],
      TODAY,
    );
    expect(timing).toMatchObject({
      kind: "slot",
      slot: { start: "2026-11-16", weeks: [120, 120, 120, 120, 120] },
    });
  });

  it("doesn't count the project against itself when editing", () => {
    const self = { ...active("me"), weekly_min: 350 };
    const timing = timingOf(
      { ...EMPTY_DRAFT, title: "P", estimateHours: "5" },
      "me",
      WEEK,
      [self],
      TODAY,
    );
    expect(timing).toMatchObject({ kind: "slot", slot: { weeks: [300] } });
  });
});

describe("savePlan", () => {
  it("saves the slot's dates and weekly time", () => {
    const draft = { ...EMPTY_DRAFT, title: "P", estimateHours: "10" };
    const timing = timingOf(draft, null, WEEK, [], TODAY);
    expect(savePlan(draft, null, null, timing, [], TODAY)).toEqual({
      values: {
        status: "active",
        start_date: "2026-11-16",
        forecast_finish: "2026-11-29",
        weekly_min: 350,
      },
      held: false,
    });
  });

  it("keeps the weekly hours you typed", () => {
    const draft = {
      ...EMPTY_DRAFT,
      title: "P",
      estimateHours: "10",
      deadline: "2026-12-20",
      weeklyHours: "3",
    };
    const timing = timingOf(draft, null, WEEK, [], TODAY);
    expect(savePlan(draft, null, null, timing, [], TODAY).values).toEqual({
      status: "active",
      start_date: TODAY,
      forecast_finish: "2026-12-20",
    });
  });

  it("puts a third active project in Next up", () => {
    const draft = { ...EMPTY_DRAFT, title: "P" };
    expect(savePlan(draft, null, null, null, [active("a"), active("b")], TODAY)).toEqual({
      values: { status: "next_up" },
      held: true,
    });
  });

  it("leaves ideas and paused projects undated", () => {
    const draft = { ...EMPTY_DRAFT, title: "P", estimateHours: "10", status: "idea" as const };
    const timing = timingOf(draft, null, WEEK, [], TODAY);
    expect(savePlan(draft, null, null, timing, [], TODAY).values).toEqual({ status: "idea" });
  });
});

describe("review fixes", () => {
  it("gives a held third project no dates", () => {
    const draft = { ...EMPTY_DRAFT, title: "P", estimateHours: "10", deadline: "2026-12-20" };
    const projects = [active("a"), active("b")];
    const timing = timingOf(draft, null, WEEK, projects, TODAY);
    expect(savePlan(draft, null, null, timing, projects, TODAY)).toEqual({
      values: { status: "next_up" },
      held: true,
    });
  });

  it("keeps the dates when an edit doesn't touch the plan", () => {
    const draft = { ...EMPTY_DRAFT, title: "Renamed", estimateHours: "20", weeklyHours: "2" };
    const saved = { draft: { ...draft, title: "Old" }, start_date: "2026-11-02" };
    const timing = timingOf(draft, "me", WEEK, [], TODAY);
    expect(savePlan(draft, saved, "me", timing, [], TODAY).values).toEqual({ status: "active" });
  });

  it("keeps the start of a project under way when its plan changes", () => {
    const draft = { ...EMPTY_DRAFT, title: "P", estimateHours: "10", weeklyHours: "2" };
    const saved = { draft: { ...draft, estimateHours: "20" }, start_date: "2026-11-02" };
    const timing = timingOf(draft, "me", WEEK, [], TODAY);
    const { values } = savePlan(draft, saved, "me", timing, [], TODAY);
    expect(values).not.toHaveProperty("start_date");
    expect(values.forecast_finish).toBe("2026-12-20");
  });

  it("caps the weekly hours it fills in, and sets no dates for a passed deadline", () => {
    const soon = { ...EMPTY_DRAFT, title: "P", estimateHours: "100", deadline: "2026-11-16" };
    const big = { capacity: 100_000, areaCommitted: 0 };
    const values = savePlan(
      soon,
      null,
      null,
      timingOf(soon, null, big, [], TODAY),
      [],
      TODAY,
    ).values;
    expect(values.weekly_min).toBe(40 * 60);
    const passed = { ...soon, deadline: "2026-11-01" };
    expect(
      savePlan(passed, null, null, timingOf(passed, null, big, [], TODAY), [], TODAY).values,
    ).toEqual({ status: "active" });
  });
});
