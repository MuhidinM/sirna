import { type DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { type Op } from "../../kernel/db";
import { openTestDb } from "../../test/sqlite";
import {
  addAreaOps,
  addBlockOps,
  areaDraftOf,
  areaId,
  type AreaRow,
  AREAS_SQL,
  checkArea,
  checkBlock,
  clashes,
  draftOf,
  duplicateOf,
  EMPTY_AREA,
  removeBlockOps,
  ROUTINE_SQL,
  type RoutineRow,
  seriesOf,
  setAreaActiveOps,
  updateAreaOps,
  updateBlockOps,
} from "./editor";

type Input = string | number | null;

/** Applies ops the way tx.rs does, enough to check them against the schema. */
function apply(db: DatabaseSync, ops: Op[]) {
  for (const op of ops) {
    if (op.op === "insert") {
      const values = { id: op.id, ...op.values, created_at: 0, updated_at: 0 };
      const names = Object.keys(values);
      db.prepare(
        `INSERT INTO ${op.table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
      ).run(...(Object.values(values) as Input[]));
    } else if (op.op === "update") {
      const names = Object.keys(op.values);
      db.prepare(
        `UPDATE ${op.table} SET ${names.map((n) => `${n} = ?`).join(", ")} WHERE id = ?`,
      ).run(...(Object.values(op.values) as Input[]), op.id);
    } else if (op.op === "delete") {
      db.prepare(`UPDATE ${op.table} SET deleted_at = 1 WHERE id = ?`).run(op.id);
    }
  }
}

const routine = (db: DatabaseSync) => db.prepare(ROUTINE_SQL).all() as unknown as RoutineRow[];
const areas = (db: DatabaseSync) => db.prepare(AREAS_SQL).all() as unknown as AreaRow[];

function ids() {
  let n = 0;
  return () => `b${String(++n).padStart(3, "0")}`;
}

const GYM = {
  title: "Gym",
  kind: "routine" as const,
  areaId: "gym",
  start: "17:30",
  end: "18:15",
  days: [1, 3, 5] as (1 | 3 | 5)[],
};

describe("routine blocks", () => {
  it("adds a block on several days", () => {
    const db = openTestDb();
    apply(db, addBlockOps(GYM, ids()));
    expect(routine(db).map((r) => [r.weekday, r.start_min, r.duration_min, r.title])).toEqual([
      [1, 1050, 45, "Gym"],
      [3, 1050, 45, "Gym"],
      [5, 1050, 45, "Gym"],
    ]);
  });

  it("moves the gym to the morning on every day it happens", () => {
    const db = openTestDb();
    const newId = ids();
    apply(db, addBlockOps(GYM, newId));
    const [monday] = routine(db);
    if (!monday) throw new Error("no block");
    const series = seriesOf(routine(db), monday);
    expect(series).toHaveLength(3);
    apply(
      db,
      updateBlockOps(
        routine(db),
        monday,
        { ...draftOf(monday, [1, 3, 5, 6]), start: "06:30", end: "07:15" },
        "series",
        newId,
      ),
    );
    expect(routine(db).map((r) => [r.weekday, r.start_min])).toEqual([
      [1, 390],
      [3, 390],
      [5, 390],
      [6, 390],
    ]);
  });

  it("drops a day from a series, or changes just one day", () => {
    const db = openTestDb();
    const newId = ids();
    apply(db, addBlockOps(GYM, newId));
    const [monday] = routine(db);
    if (!monday) throw new Error("no block");
    apply(db, updateBlockOps(routine(db), monday, draftOf(monday, [1, 5]), "series", newId));
    expect(routine(db).map((r) => r.weekday)).toEqual([1, 5]);
    const [first] = routine(db);
    if (!first) throw new Error("no block");
    apply(
      db,
      updateBlockOps(
        routine(db),
        first,
        { ...draftOf(first), start: "16:00", end: "16:45" },
        "day",
        newId,
      ),
    );
    expect(routine(db).map((r) => [r.weekday, r.start_min])).toEqual([
      [1, 960],
      [5, 1050],
    ]);
  });

  it("removes one day or the whole series", () => {
    const db = openTestDb();
    apply(db, addBlockOps(GYM, ids()));
    const [monday] = routine(db);
    if (!monday) throw new Error("no block");
    apply(db, removeBlockOps(routine(db), monday, "day"));
    expect(routine(db)).toHaveLength(2);
    const [wednesday] = routine(db);
    if (!wednesday) throw new Error("no block");
    apply(db, removeBlockOps(routine(db), wednesday, "series"));
    expect(routine(db)).toHaveLength(0);
  });

  it("checks a block", () => {
    expect(checkBlock(GYM)).toBeNull();
    expect(checkBlock({ ...GYM, title: " " })).toMatch(/name/);
    expect(checkBlock({ ...GYM, days: [] })).toMatch(/day/);
    expect(checkBlock({ ...GYM, end: "17:00" })).toMatch(/after/);
    expect(checkBlock({ ...GYM, start: "7.30" })).toMatch(/07:30/);
    expect(checkBlock({ ...GYM, areaId: "" })).toMatch(/area/);
    expect(checkBlock({ ...GYM, kind: "area", title: "", areaId: "" })).toBeNull();
    expect(checkBlock({ ...GYM, start: "22:00", end: "24:00" })).toBeNull();
  });

  it("warns about blocks sharing time", () => {
    const db = openTestDb();
    apply(db, addBlockOps(GYM, ids()));
    const rows = routine(db);
    const walk = { ...GYM, title: "Walk", start: "18:00", end: "18:30", days: [1] as 1[] };
    expect(clashes(rows, walk, 1).map((r) => r.title)).toEqual(["Gym"]);
    expect(clashes(rows, { ...walk, start: "18:15" }, 1)).toEqual([]);
    expect(clashes(rows, walk, 2)).toEqual([]);
  });
});

describe("areas", () => {
  it("adds a third job and a new area", () => {
    const db = openTestDb();
    const taken = areas(db).map((a) => a.id);
    const job = addAreaOps(
      { ...EMPTY_AREA, name: "Job C", kind: "work", color: "work", weeklyHours: "0" },
      taken,
    );
    apply(db, job.ops);
    const music = addAreaOps({ ...EMPTY_AREA, name: "Music", weeklyHours: "2.5" }, [
      ...taken,
      job.id,
    ]);
    apply(db, music.ops);
    expect(job.id).toBe("job-c");
    expect(areas(db).find((a) => a.id === "music")).toMatchObject({
      name: "Music",
      kind: "growth",
      weekly_target_min: 150,
      active: 1,
    });
    apply(
      db,
      addBlockOps(
        {
          ...GYM,
          title: "Job C",
          kind: "fixed",
          areaId: job.id,
          start: "18:00",
          end: "20:00",
          days: [2, 4],
        },
        ids(),
      ),
    );
    expect(routine(db).map((r) => r.area_id)).toEqual(["job-c", "job-c"]);
  });

  it("makes ids from names that are unique", () => {
    expect(areaId("Job C", ["joba"])).toBe("job-c");
    expect(areaId("Coding", ["coding"])).toBe("coding-2");
    expect(areaId("!!!", [])).toBe("area");
  });

  it("renames and retargets an area", () => {
    const db = openTestDb();
    const coding = areas(db).find((a) => a.id === "coding");
    if (!coding) throw new Error("no coding area");
    apply(db, updateAreaOps("coding", { ...areaDraftOf(coding), name: "Rust", weeklyHours: "6" }));
    expect(areas(db).find((a) => a.id === "coding")).toMatchObject({
      name: "Rust",
      weekly_target_min: 360,
    });
  });

  it("turning an area off takes its blocks out of the routine", () => {
    const db = openTestDb();
    apply(db, addBlockOps(GYM, ids()));
    apply(db, setAreaActiveOps("gym", false, routine(db)));
    expect(routine(db)).toHaveLength(0);
    expect(areas(db).find((a) => a.id === "gym")?.active).toBe(0);
  });

  it("checks an area", () => {
    const rows = [{ id: "coding", name: "Coding skills" } as AreaRow];
    expect(checkArea({ ...EMPTY_AREA, name: "Music" }, rows, null)).toBeNull();
    expect(checkArea({ ...EMPTY_AREA, name: "coding SKILLS" }, rows, null)).toMatch(/name/);
    expect(checkArea({ ...EMPTY_AREA, name: "coding skills" }, rows, "coding")).toBeNull();
    expect(checkArea({ ...EMPTY_AREA, name: "X", weeklyHours: "99" }, rows, null)).toMatch(
      /0 to 80/,
    );
    expect(checkArea({ ...EMPTY_AREA, name: "X", priority: "0" }, rows, null)).toMatch(/Priority/);
  });
});

describe("duplicates", () => {
  it("refuses a second block with the same name and start on a day", () => {
    const db = openTestDb();
    apply(db, addBlockOps(GYM, ids()));
    const rows = routine(db);
    expect(duplicateOf(rows, { ...GYM, end: "18:00" }, [1])?.weekday).toBe(1);
    expect(duplicateOf(rows, { ...GYM, title: "gym " }, [3])?.weekday).toBe(3);
    expect(duplicateOf(rows, { ...GYM, start: "17:45", end: "18:15" }, [1])).toBeNull();
    expect(duplicateOf(rows, GYM, [2])).toBeNull();
    const monday = rows[0];
    expect(monday && duplicateOf(rows, GYM, [1], new Set([monday.id]))).toBeNull();
  });
});
