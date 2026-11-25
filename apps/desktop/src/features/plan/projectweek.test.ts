/**
 * A project's week (start dates, mid-week ends): what Next 7 days plans for
 * each project on each day, and what the Projects header counts, for a set
 * of fixture projects. MAIN holds what the planner gave before this change;
 * every row must still match it except the ones listed as intended.
 */
import { describe, expect, it } from "vitest";

import { type Row, type SqlValue } from "../../kernel/db";
import { openTestDb } from "../../test/sqlite";
import { loadWeek, weekLoad } from "../projects/capacity";
import { loadPreview } from "./preview";
import { DEFAULT_ANSWERS } from "./routine";
import { setupOps } from "./setup";

const AREAS = ["joba", "jobb", "jobhunt", "coding", "experiments", "gym", "quran", "admin"];

interface Fixture {
  id: string;
  status?: string;
  area?: string;
  weekly: number | null;
  start: string | null;
  finish: string | null;
  deadline?: string | null;
}

interface Case {
  name: string;
  /** Logical date the forecast starts on (03:00 day start, Addis time). */
  today: string;
  projects: Fixture[];
}

/** Week of Monday 9 Nov 2026 to Sunday 15 Nov. */
const CASES: Case[] = [
  {
    name: "whole week",
    today: "2026-11-09",
    projects: [{ id: "p", weekly: 600, start: "2026-11-02", finish: "2026-11-29" }],
  },
  {
    name: "starts Monday",
    today: "2026-11-09",
    projects: [{ id: "p", weekly: 600, start: "2026-11-09", finish: "2026-11-29" }],
  },
  {
    name: "starts Thursday",
    today: "2026-11-09",
    projects: [{ id: "p", weekly: 600, start: "2026-11-12", finish: "2026-11-29" }],
  },
  {
    name: "ends Wednesday",
    today: "2026-11-09",
    projects: [{ id: "p", weekly: 600, start: "2026-11-02", finish: "2026-11-11" }],
  },
  {
    name: "ends Sunday",
    today: "2026-11-09",
    projects: [{ id: "p", weekly: 600, start: "2026-11-02", finish: "2026-11-15" }],
  },
  {
    name: "starts Tuesday, ends Friday",
    today: "2026-11-09",
    projects: [{ id: "p", weekly: 300, start: "2026-11-10", finish: "2026-11-13" }],
  },
  {
    name: "Wednesday to Friday, planned on Wednesday",
    today: "2026-11-11",
    projects: [{ id: "p", weekly: 600, start: "2026-11-11", finish: "2026-11-13" }],
  },
  {
    name: "overdue, finish before the week",
    today: "2026-11-09",
    projects: [
      { id: "p", weekly: 600, start: "2026-10-01", finish: "2026-11-01", deadline: "2026-11-01" },
    ],
  },
  {
    name: "overdue, deadline only",
    today: "2026-11-09",
    projects: [{ id: "p", weekly: 600, start: "2026-10-01", finish: null, deadline: "2026-11-01" }],
  },
  {
    name: "overdue inside the week",
    today: "2026-11-11",
    projects: [{ id: "p", weekly: 600, start: "2026-10-01", finish: "2026-11-10" }],
  },
  {
    name: "next up from next Monday",
    today: "2026-11-09",
    projects: [
      { id: "p", status: "next_up", weekly: 600, start: "2026-11-16", finish: "2026-11-29" },
    ],
  },
  {
    name: "next up without a start",
    today: "2026-11-09",
    projects: [{ id: "p", status: "next_up", weekly: 600, start: null, finish: null }],
  },
  {
    name: "paused",
    today: "2026-11-09",
    projects: [
      { id: "p", status: "paused", weekly: 600, start: "2026-11-02", finish: "2026-11-29" },
    ],
  },
  {
    name: "no weekly hours",
    today: "2026-11-09",
    projects: [{ id: "p", weekly: null, start: "2026-11-02", finish: "2026-11-29" }],
  },
  {
    name: "tiny weekly 10",
    today: "2026-11-09",
    projects: [{ id: "p", weekly: 10, start: "2026-11-02", finish: "2026-11-29" }],
  },
  {
    name: "tiny weekly 20 from Saturday",
    today: "2026-11-09",
    projects: [{ id: "p", weekly: 20, start: "2026-11-14", finish: "2026-11-29" }],
  },
  {
    name: "starts after it ends",
    today: "2026-11-09",
    projects: [{ id: "p", weekly: 600, start: "2026-11-12", finish: "2026-11-11" }],
  },
  {
    name: "two projects",
    today: "2026-11-09",
    projects: [
      { id: "p", weekly: 300, start: "2026-11-02", finish: "2026-11-29" },
      { id: "q", area: "experiments", weekly: 240, start: "2026-11-02", finish: "2026-11-29" },
    ],
  },
  {
    name: "two projects, one from Thursday",
    today: "2026-11-09",
    projects: [
      { id: "p", weekly: 300, start: "2026-11-02", finish: "2026-11-29" },
      { id: "q", area: "experiments", weekly: 420, start: "2026-11-12", finish: "2026-11-29" },
    ],
  },
];

interface Result {
  /** Per day, minutes planned per area or project (project:<id>). */
  days: Record<string, Record<string, number>>;
  header: { committed: number; running: number };
}

async function run(c: Case): Promise<Result> {
  const db = openTestDb();
  const query = <T extends Row>(sql: string, params: SqlValue[] = []) =>
    Promise.resolve(db.prepare(sql).all(...(params as never[])) as T[]);
  let n = 0;
  for (const op of setupOps(
    { ...DEFAULT_ANSWERS, clockStyle: "western", targetsHours: {} },
    [],
    AREAS,
    () => `id${++n}`,
  )) {
    if (op.op === "delete") continue;
    const idColumn = op.table === "core_settings" ? "key" : "id";
    const exists = db.prepare(`SELECT 1 FROM ${op.table} WHERE ${idColumn} = ?`).get(op.id);
    if (exists) {
      const sets = Object.keys(op.values)
        .map((key) => `${key} = ?`)
        .join(", ");
      db.prepare(`UPDATE ${op.table} SET ${sets} WHERE ${idColumn} = ?`).run(
        ...(Object.values(op.values) as never[]),
        op.id,
      );
      continue;
    }
    const stamps =
      op.table === "core_settings" ? { updated_at: 0 } : { created_at: 0, updated_at: 0 };
    const all = { [idColumn]: op.id, ...op.values, ...stamps };
    const keys = Object.keys(all);
    db.prepare(
      `INSERT INTO ${op.table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
    ).run(...(Object.values(all) as never[]));
  }
  const insert = db.prepare(
    `INSERT INTO project_items (id, title, area_id, weekly_min, start_date, forecast_finish, deadline, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
  );
  for (const p of c.projects)
    insert.run(
      p.id,
      `Project ${p.id}`,
      p.area ?? "coding",
      p.weekly,
      p.start,
      p.finish,
      p.deadline ?? null,
      p.status ?? "active",
    );
  // 06:00 on the day: the whole day is ahead.
  const nowMs = Date.parse(`${c.today}T06:00:00+03:00`);
  const preview = await loadPreview(query, c.today, nowMs);
  const days: Result["days"] = {};
  for (const day of preview.days) {
    const sums: Record<string, number> = {};
    for (const block of day.blocks) {
      const key = block.projectId ? `project:${block.projectId}` : (block.areaId ?? "-");
      sums[key] = (sums[key] ?? 0) + block.durationMin;
    }
    days[day.date] = sums;
  }
  const plan = await loadWeek(query, c.today);
  const load = weekLoad(plan.week, plan.projects, "2026-11-09");
  return { days, header: { committed: load.committed, running: load.activeProjects } };
}

/** What main planned for each case (run on main, then copied here). */
const MAIN: Record<string, Result> = {
  "whole week": {
    days: {
      "2026-11-09": { "project:p": 100 },
      "2026-11-10": { "project:p": 100 },
      "2026-11-11": { "project:p": 100 },
      "2026-11-12": { "project:p": 75, jobhunt: 45 },
      "2026-11-13": { "project:p": 75, coding: 45 },
      "2026-11-14": { "project:p": 75, experiments: 90, admin: 45 },
      "2026-11-15": {},
    },
    header: { committed: 1300, running: 1 },
  },
  "starts Monday": {
    days: {
      "2026-11-09": { "project:p": 100 },
      "2026-11-10": { "project:p": 100 },
      "2026-11-11": { "project:p": 100 },
      "2026-11-12": { "project:p": 75, jobhunt: 45 },
      "2026-11-13": { "project:p": 75, coding: 45 },
      "2026-11-14": { "project:p": 75, experiments: 90, admin: 45 },
      "2026-11-15": {},
    },
    header: { committed: 1300, running: 1 },
  },
  "starts Thursday": {
    days: {
      "2026-11-09": { "project:p": 100 },
      "2026-11-10": { "project:p": 100 },
      "2026-11-11": { "project:p": 100 },
      "2026-11-12": { "project:p": 75, jobhunt: 45 },
      "2026-11-13": { "project:p": 75, coding: 45 },
      "2026-11-14": { "project:p": 75, experiments: 90, admin: 45 },
      "2026-11-15": {},
    },
    header: { committed: 1300, running: 1 },
  },
  "ends Wednesday": {
    days: {
      "2026-11-09": { "project:p": 100 },
      "2026-11-10": { "project:p": 100 },
      "2026-11-11": { "project:p": 100 },
      "2026-11-12": { "project:p": 75, jobhunt: 45 },
      "2026-11-13": { "project:p": 75, coding: 45 },
      "2026-11-14": { "project:p": 75, experiments: 90, admin: 45 },
      "2026-11-15": {},
    },
    header: { committed: 1300, running: 1 },
  },
  "ends Sunday": {
    days: {
      "2026-11-09": { "project:p": 100 },
      "2026-11-10": { "project:p": 100 },
      "2026-11-11": { "project:p": 100 },
      "2026-11-12": { "project:p": 75, jobhunt: 45 },
      "2026-11-13": { "project:p": 75, coding: 45 },
      "2026-11-14": { "project:p": 75, experiments: 90, admin: 45 },
      "2026-11-15": {},
    },
    header: { committed: 1300, running: 1 },
  },
  "starts Tuesday, ends Friday": {
    days: {
      "2026-11-09": { "project:p": 45, jobhunt: 75 },
      "2026-11-10": { "project:p": 45, coding: 75 },
      "2026-11-11": { "project:p": 45, experiments: 75 },
      "2026-11-12": { "project:p": 45, admin: 75 },
      "2026-11-13": { "project:p": 45, jobhunt: 75 },
      "2026-11-14": { "project:p": 45, coding: 90, experiments: 75 },
      "2026-11-15": {},
    },
    header: { committed: 1000, running: 1 },
  },
  "Wednesday to Friday, planned on Wednesday": {
    days: {
      "2026-11-11": { "project:p": 120 },
      "2026-11-12": { "project:p": 120 },
      "2026-11-13": { "project:p": 120 },
      "2026-11-14": { "project:p": 120, jobhunt: 90 },
      "2026-11-15": {},
      "2026-11-16": { jobhunt: 75, coding: 45 },
      "2026-11-17": { experiments: 75, admin: 45 },
    },
    header: { committed: 1300, running: 1 },
  },
  "overdue, finish before the week": {
    days: {
      "2026-11-09": { jobhunt: 75, coding: 45 },
      "2026-11-10": { experiments: 75, admin: 45 },
      "2026-11-11": { coding: 75, jobhunt: 45 },
      "2026-11-12": { admin: 75, experiments: 45 },
      "2026-11-13": { jobhunt: 75, coding: 45 },
      "2026-11-14": { experiments: 60, coding: 90, jobhunt: 60 },
      "2026-11-15": {},
    },
    header: { committed: 700, running: 0 },
  },
  "overdue, deadline only": {
    days: {
      "2026-11-09": { "project:p": 100 },
      "2026-11-10": { "project:p": 100 },
      "2026-11-11": { "project:p": 100 },
      "2026-11-12": { "project:p": 75, jobhunt: 45 },
      "2026-11-13": { "project:p": 75, coding: 45 },
      "2026-11-14": { "project:p": 75, experiments: 90, admin: 45 },
      "2026-11-15": {},
    },
    header: { committed: 1300, running: 1 },
  },
  "overdue inside the week": {
    days: {
      "2026-11-11": { "project:p": 120 },
      "2026-11-12": { "project:p": 120 },
      "2026-11-13": { "project:p": 120 },
      "2026-11-14": { "project:p": 120, jobhunt: 90 },
      "2026-11-15": {},
      "2026-11-16": { jobhunt: 75, coding: 45 },
      "2026-11-17": { experiments: 75, admin: 45 },
    },
    header: { committed: 1300, running: 1 },
  },
  "next up from next Monday": {
    days: {
      "2026-11-09": { jobhunt: 75, coding: 45 },
      "2026-11-10": { experiments: 75, admin: 45 },
      "2026-11-11": { coding: 75, jobhunt: 45 },
      "2026-11-12": { admin: 75, experiments: 45 },
      "2026-11-13": { jobhunt: 75, coding: 45 },
      "2026-11-14": { experiments: 60, coding: 90, jobhunt: 60 },
      "2026-11-15": {},
    },
    header: { committed: 700, running: 0 },
  },
  "next up without a start": {
    days: {
      "2026-11-09": { jobhunt: 75, coding: 45 },
      "2026-11-10": { experiments: 75, admin: 45 },
      "2026-11-11": { coding: 75, jobhunt: 45 },
      "2026-11-12": { admin: 75, experiments: 45 },
      "2026-11-13": { jobhunt: 75, coding: 45 },
      "2026-11-14": { experiments: 60, coding: 90, jobhunt: 60 },
      "2026-11-15": {},
    },
    header: { committed: 700, running: 0 },
  },
  paused: {
    days: {
      "2026-11-09": { jobhunt: 75, coding: 45 },
      "2026-11-10": { experiments: 75, admin: 45 },
      "2026-11-11": { coding: 75, jobhunt: 45 },
      "2026-11-12": { admin: 75, experiments: 45 },
      "2026-11-13": { jobhunt: 75, coding: 45 },
      "2026-11-14": { experiments: 60, coding: 90, jobhunt: 60 },
      "2026-11-15": {},
    },
    header: { committed: 700, running: 0 },
  },
  "no weekly hours": {
    days: {
      "2026-11-09": { jobhunt: 75, coding: 45 },
      "2026-11-10": { experiments: 75, admin: 45 },
      "2026-11-11": { coding: 75, jobhunt: 45 },
      "2026-11-12": { admin: 75, experiments: 45 },
      "2026-11-13": { jobhunt: 75, coding: 45 },
      "2026-11-14": { experiments: 60, coding: 90, jobhunt: 60 },
      "2026-11-15": {},
    },
    header: { committed: 700, running: 1 },
  },
  "tiny weekly 10": {
    days: {
      "2026-11-09": {},
      "2026-11-10": {},
      "2026-11-11": {},
      "2026-11-12": {},
      "2026-11-13": {},
      "2026-11-14": {},
      "2026-11-15": {},
    },
    header: { committed: 710, running: 1 },
  },
  "tiny weekly 20 from Saturday": {
    days: {
      "2026-11-09": {},
      "2026-11-10": {},
      "2026-11-11": {},
      "2026-11-12": {},
      "2026-11-13": {},
      "2026-11-14": {},
      "2026-11-15": {},
    },
    header: { committed: 720, running: 1 },
  },
  "starts after it ends": {
    days: {
      "2026-11-09": { "project:p": 100 },
      "2026-11-10": { "project:p": 100 },
      "2026-11-11": { "project:p": 100 },
      "2026-11-12": { "project:p": 75, jobhunt: 45 },
      "2026-11-13": { "project:p": 75, coding: 45 },
      "2026-11-14": { "project:p": 75, experiments: 90, admin: 45 },
      "2026-11-15": {},
    },
    header: { committed: 1300, running: 1 },
  },
  "two projects": {
    days: {
      "2026-11-09": { "project:p": 45, jobhunt: 30, "project:q": 45 },
      "2026-11-10": { "project:p": 45, coding: 30, "project:q": 45 },
      "2026-11-11": { "project:p": 45, experiments: 30, "project:q": 30 },
      "2026-11-12": { "project:p": 45, admin: 30, "project:q": 30 },
      "2026-11-13": { "project:p": 45, jobhunt: 30, "project:q": 30 },
      "2026-11-14": { "project:p": 45, experiments: 45, "project:q": 30, coding: 90 },
      "2026-11-15": {},
    },
    header: { committed: 1240, running: 2 },
  },
  "two projects, one from Thursday": {
    days: {
      "2026-11-09": { "project:p": 45, "project:q": 60 },
      "2026-11-10": { "project:q": 60, "project:p": 45 },
      "2026-11-11": { "project:q": 60, "project:p": 45 },
      "2026-11-12": { "project:q": 60, "project:p": 45 },
      "2026-11-13": { "project:q": 60, "project:p": 45 },
      "2026-11-14": { "project:q": 60, "project:p": 45, jobhunt: 90 },
      "2026-11-15": {},
    },
    header: { committed: 1420, running: 2 },
  },
};

/** Rows this change means to move; every other row must equal MAIN. */
const INTENDED = new Set([
  "starts Thursday",
  "ends Wednesday",
  "starts Tuesday, ends Friday",
  "tiny weekly 20 from Saturday",
  "starts after it ends",
  "two projects, one from Thursday",
]);

const byName = (name: string) => CASES.find((c) => c.name === name) as Case;
const projectMin = (result: Result, id: string, date: string) =>
  result.days[date]?.[`project:${id}`] ?? 0;
const before = (result: Result, id: string, date: string) =>
  Object.keys(result.days)
    .filter((day) => day < date)
    .reduce((sum, day) => sum + projectMin(result, id, day), 0);

describe("project week regression table", () => {
  it.each(CASES.filter((c) => !INTENDED.has(c.name)).map((c) => [c.name, c] as const))(
    "%s: the same as main",
    async (_name, c) => {
      expect(await run(c)).toEqual(MAIN[c.name]);
    },
  );

  it("starts Thursday: nothing Monday to Wednesday, 345 min counted for the week", async () => {
    const result = await run(byName("starts Thursday"));
    expect(before(result, "p", "2026-11-12")).toBe(0);
    expect(projectMin(result, "p", "2026-11-12")).toBeGreaterThan(0);
    expect(result.header).toEqual({ committed: 700 + 345, running: 1 });
  });

  it("ends Wednesday: paced to Wednesday, more by then than main gave", async () => {
    const result = await run(byName("ends Wednesday"));
    const main = MAIN["ends Wednesday"] as Result;
    expect(before(result, "p", "2026-11-12")).toBeGreaterThan(before(main, "p", "2026-11-12"));
    expect(result.header).toEqual(main.header);
  });

  it("starts Tuesday, ends Friday: nothing on Monday, its whole weekly hours count", async () => {
    const result = await run(byName("starts Tuesday, ends Friday"));
    expect(projectMin(result, "p", "2026-11-09")).toBe(0);
    expect(projectMin(result, "p", "2026-11-10")).toBeGreaterThan(0);
    expect(result.header).toEqual({ committed: 700 + 300, running: 1 });
  });

  it("tiny weekly 20 from Saturday: no project time before Saturday", async () => {
    const result = await run(byName("tiny weekly 20 from Saturday"));
    expect(before(result, "p", "2026-11-14")).toBe(0);
    expect(result.header).toEqual({ committed: 720, running: 1 });
  });

  it("starts after it ends: no time and not running", async () => {
    const result = await run(byName("starts after it ends"));
    expect(before(result, "p", "2026-11-16")).toBe(0);
    expect(result.header).toEqual({ committed: 700, running: 0 });
  });

  it("two projects, one from Thursday: the other is as main, the late one waits", async () => {
    const result = await run(byName("two projects, one from Thursday"));
    const main = MAIN["two projects, one from Thursday"] as Result;
    for (const day of Object.keys(main.days))
      expect(projectMin(result, "p", day)).toBe(projectMin(main, "p", day));
    expect(before(result, "q", "2026-11-12")).toBe(0);
    expect(projectMin(result, "q", "2026-11-12")).toBeGreaterThan(0);
    // 420 × 4/7 = 240.
    expect(result.header).toEqual({ committed: 700 + 300 + 240, running: 2 });
  });
});
