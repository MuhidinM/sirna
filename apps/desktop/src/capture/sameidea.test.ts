// F91: the same idea captured twice doesn't make a second project.
import { describe, expect, it } from "vitest";

import { placeIdea } from "../features/projects/idea";
import { openTestDb } from "../test/sqlite";
import { echo, SAME_PROJECT_SQL, sameProject, toOps } from "./ops";
import { parseCapture } from "./parse";

const nowMs = Date.parse("2026-11-24T10:00:00+03:00");

describe("an idea you already have (F91)", () => {
  it("finds an open project by title, whatever the case", () => {
    const db = openTestDb();
    db.exec(`INSERT INTO project_items (id, title, status, origin, created_at, updated_at)
      VALUES ('p1', 'learn Go', 'idea', 'capture', 1, 1),
             ('p2', 'old thing', 'done', 'capture', 1, 1),
             ('p3', 'gone one', 'active', 'capture', 1, 1)`);
    db.exec("UPDATE project_items SET deleted_at = 2 WHERE id = 'p3'");
    const find = (title: string) => db.prepare(SAME_PROJECT_SQL).all(title);
    expect(find("Learn go ")).toMatchObject([{ id: "p1", status: "idea" }]);
    expect(find("old thing")).toEqual([]);
    expect(find("gone one")).toEqual([]);
  });

  it("saves nothing and says where it is", () => {
    const parsed = parseCapture("idea: learn Go", { nowMs });
    const placement = sameProject(placeIdea({ title: "learn Go" }, null), {
      id: "p1",
      status: "idea",
    });
    expect(toOps(parsed, { nowMs, newId: () => "x", idea: placement })).toEqual([]);
    expect(echo(parsed, nowMs, placement)).toBe("Already an idea · see Projects");
    const active = sameProject(placement, { id: "p1", status: "active" });
    expect(echo(parsed, nowMs, active)).toBe("Already a project (Active) · see Projects");
  });
});
