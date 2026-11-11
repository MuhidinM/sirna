import { describe, expect, it } from "vitest";

import { openTestDb } from "../../test/sqlite";
import { AT_RISK_SQL, riskLine, riskOf, type RiskRow, risks } from "./risk";

const TODAY = "2026-11-11";
const row = (change: Partial<RiskRow> = {}): RiskRow => ({
  id: "p",
  title: "Portfolio site",
  deadline: "2026-11-24", // 14 days left, today included
  estimate_min: 600,
  weekly_min: 120,
  start_date: null,
  done_min: 0,
  ...change,
});

describe("at risk", () => {
  it("flags a plan that falls short of the estimate", () => {
    // 2 weeks × 2 h = 4 h planned, 10 h left: 6 h short.
    expect(riskOf(row(), TODAY)).toMatchObject({ shortMin: 360, overdue: false });
  });

  it("counts focus time already done", () => {
    expect(riskOf(row({ done_min: 360 }), TODAY)).toBeNull();
    expect(riskOf(row({ done_min: 300 }), TODAY)).toMatchObject({ shortMin: 60 });
  });

  it("is fine when the weekly hours cover it", () => {
    expect(riskOf(row({ weekly_min: 300 }), TODAY)).toBeNull();
  });

  it("only plans from the start date when it is later", () => {
    // Starts 18 Nov: 7 days × 300/7 = 300 planned, 600 left.
    expect(riskOf(row({ weekly_min: 300, start_date: "2026-11-18" }), TODAY)).toMatchObject({
      shortMin: 300,
    });
  });

  it("marks a passed deadline with work left", () => {
    expect(riskOf(row({ deadline: "2026-11-01" }), TODAY)).toMatchObject({
      shortMin: 600,
      overdue: true,
    });
  });

  it("writes one brief line", () => {
    const list = risks([row(), row({ id: "q", title: "CV", deadline: "2026-12-01" })], TODAY);
    expect(riskLine(list)).toBe("Portfolio site · 6 h short before Tue 24 Nov · +1 more");
    expect(riskLine(risks([row({ deadline: "2026-11-01" })], TODAY))).toBe(
      "Portfolio site · past Sun 1 Nov, 10 h left",
    );
    expect(riskLine([])).toBeNull();
  });

  it("reads open projects with deadlines and their focus time", () => {
    const db = openTestDb();
    db.exec(`
      INSERT INTO project_items (id, title, deadline, estimate_min, weekly_min, status, created_at, updated_at)
      VALUES ('p1', 'Portfolio', '2026-11-24', 600, 120, 'active', 0, 0),
             ('p2', 'Paused', '2026-11-24', 600, 0, 'paused', 0, 0),
             ('p3', 'No date', NULL, 600, 0, 'active', 0, 0);
      INSERT INTO task_items (id, title, project_id, created_at, updated_at)
      VALUES ('t1', 'Card', 'p1', 0, 0);
      INSERT INTO focus_sessions (id, task_id, kind, started_at, planned_min, ended_at)
      VALUES ('f1', 't1', 'focus', 0, 50, 3000000),
             ('f2', 't1', 'break', 0, 5, 300000);
    `);
    const rows = db.prepare(AT_RISK_SQL).all() as unknown as RiskRow[];
    expect(rows.map((r) => [r.id, r.done_min])).toEqual([["p1", 50]]);
  });
});

describe("paused time", () => {
  it("doesn't count as work done", () => {
    const db = openTestDb();
    db.exec(`
      INSERT INTO project_items (id, title, deadline, estimate_min, weekly_min, status, created_at, updated_at)
      VALUES ('p1', 'Portfolio', '2026-11-24', 600, 120, 'active', 0, 0);
      INSERT INTO task_items (id, title, project_id, created_at, updated_at) VALUES ('t1', 'Card', 'p1', 0, 0);
      INSERT INTO focus_sessions (id, task_id, kind, started_at, planned_min, ended_at, paused_ms)
      VALUES ('f1', 't1', 'focus', 0, 50, 5400000, 2400000);
    `);
    const [first] = db.prepare(AT_RISK_SQL).all() as unknown as RiskRow[];
    expect(first?.done_min).toBe(50);
  });
});
