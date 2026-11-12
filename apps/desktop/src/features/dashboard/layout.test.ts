import { describe, expect, it } from "vitest";

import { openTestDb } from "../../test/sqlite";
import {
  defaultLayout,
  LAYOUT_SQL,
  layoutOps,
  move,
  moveTo,
  readLayout,
  setSize,
  span,
  toggleHidden,
} from "./layout";

const ids = (layout: { id: string }[]) => layout.map((p) => p.id);

describe("the dashboard layout", () => {
  it("steps over hidden cards with the arrows", () => {
    const layout = toggleHidden(defaultLayout(), "streak");
    expect(ids(move(layout, "tiles", 1)).slice(0, 3)).toEqual(["streak", "insights", "tiles"]);
    expect(ids(move(layout, "insights", -1)).slice(0, 3)).toEqual(["insights", "tiles", "streak"]);
  });

  it("starts with every card in its place", () => {
    expect(ids(readLayout(null))).toEqual([
      "tiles",
      "streak",
      "insights",
      "year",
      "savings",
      "areas",
    ]);
    expect(readLayout("not json")).toEqual(defaultLayout());
  });

  it("moves, hides and resizes cards", () => {
    let layout = defaultLayout();
    layout = move(layout, "savings", -1);
    expect(ids(layout).slice(3, 5)).toEqual(["savings", "year"]);
    expect(move(layout, "tiles", -1)).toBe(layout);
    layout = moveTo(layout, "areas", "streak");
    expect(ids(layout).slice(0, 3)).toEqual(["tiles", "areas", "streak"]);
    layout = moveTo(layout, "tiles", "insights");
    expect(ids(layout).indexOf("tiles")).toBe(ids(layout).indexOf("insights") + 1);
    layout = toggleHidden(layout, "year");
    layout = setSize(layout, "savings", "S");
    expect(layout.find((p) => p.id === "year")?.hidden).toBe(true);
    expect(layout.find((p) => p.id === "savings")?.size).toBe("S");
    expect([span("S"), span("M"), span("L")]).toEqual([2, 3, 6]);
  });

  it("survives a restart: saved in settings and read back the same", () => {
    const db = openTestDb();
    const layout = setSize(
      toggleHidden(move(defaultLayout(), "year", -1), "insights"),
      "streak",
      "S",
    );
    const [op] = layoutOps(layout);
    if (!op || op.op !== "upsert") throw new Error("no upsert");
    db.prepare("INSERT INTO core_settings (key, value_json, updated_at) VALUES (?, ?, 0)").run(
      op.id,
      String(op.values.value_json),
    );
    const [row] = db.prepare(LAYOUT_SQL).all() as { value_json: string }[];
    expect(readLayout(row?.value_json)).toEqual(layout);
  });

  it("drops unknown cards and adds new ones at the end", () => {
    const saved = JSON.stringify([
      { id: "areas", hidden: true, size: "S" },
      { id: "retired-card", hidden: false, size: "M" },
      { id: "areas", hidden: false, size: "L" },
      { id: "tiles", size: "XL" },
    ]);
    const layout = readLayout(saved);
    expect(layout[0]).toEqual({ id: "areas", hidden: true, size: "S" });
    expect(layout[1]).toEqual({ id: "tiles", hidden: false, size: "L" });
    expect(ids(layout)).toHaveLength(6);
    expect(ids(layout).slice(2)).toEqual(["streak", "insights", "year", "savings"]);
  });
});
