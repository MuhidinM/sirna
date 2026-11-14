import { describe, expect, it } from "vitest";

import { type Op } from "../../kernel/db";
import { openTestDb } from "../../test/sqlite";
import {
  ALL_CATEGORIES_SQL,
  addCategoryOps,
  CATEGORY_TEMPLATES_SQL,
  CATEGORY_TXNS_SQL,
  type CategoryRow,
  checkCategoryName,
  hideCategoryOps,
  mergeCategoryOps,
  renameCategoryOps,
} from "./categories";
import { CATEGORIES_SQL, TXNS_SQL } from "./money";

/** Applies ops the way db_tx does for these tables (upsert revives). */
function apply(db: ReturnType<typeof openTestDb>, ops: Op[]) {
  for (const op of ops) {
    if (op.op === "delete") {
      db.prepare(`UPDATE ${op.table} SET deleted_at = 1 WHERE id = ?`).run(op.id);
      continue;
    }
    const cols = Object.keys(op.values);
    const vals = Object.values(op.values) as (string | number | null)[];
    const exists = db.prepare(`SELECT 1 FROM ${op.table} WHERE id = ?`).get(op.id);
    if (op.op === "insert" || (op.op === "upsert" && !exists))
      db.prepare(
        `INSERT INTO ${op.table} (id, ${cols.join(", ")}, created_at, updated_at) VALUES (?, ${cols.map(() => "?").join(", ")}, 0, 0)`,
      ).run(op.id, ...vals);
    else
      db.prepare(
        `UPDATE ${op.table} SET ${cols.map((c) => `${c} = ?`).join(", ")}${op.op === "upsert" ? ", deleted_at = NULL" : ""} WHERE id = ?`,
      ).run(...vals, op.id);
  }
}

const all = (db: ReturnType<typeof openTestDb>) =>
  db.prepare(ALL_CATEGORIES_SQL).all() as unknown as CategoryRow[];
const names = (db: ReturnType<typeof openTestDb>) =>
  (db.prepare(CATEGORIES_SQL).all() as { name: string }[]).map((row) => row.name);

describe("categories you manage (T-055)", () => {
  it("adds, renames and hides, refusing a name in use", () => {
    const db = openTestDb();
    expect(checkCategoryName("food", all(db))).toMatch(/already/);
    expect(checkCategoryName("  ", all(db))).toMatch(/A name/);
    expect(checkCategoryName("Fuel", all(db))).toBeNull();
    apply(db, addCategoryOps(" Fuel ", "expense", all(db), "cat_fuel"));
    expect(names(db)).toContain("Fuel");
    // Renaming to its own name is fine.
    expect(checkCategoryName("fuel", all(db), "cat_fuel")).toBeNull();
    apply(db, renameCategoryOps("cat_fuel", "Benzine"));
    apply(db, hideCategoryOps("cat_fuel"));
    expect(names(db)).not.toContain("Benzine");
  });

  it("brings a hidden category back instead of clashing with its name", () => {
    const db = openTestDb();
    apply(db, hideCategoryOps("cat_learning"));
    expect(checkCategoryName("Learning", all(db))).toBeNull();
    const ops = addCategoryOps("Learning", "expense", all(db), "new");
    expect(ops[0]).toMatchObject({ op: "upsert", id: "cat_learning" });
    apply(db, ops);
    expect(names(db)).toContain("Learning");
  });

  it("merges: every entry and chip moves, and the old one is hidden", () => {
    const db = openTestDb();
    const txn = db.prepare(
      "INSERT INTO money_txns (id, occurred_at, local_date, amount_minor, description, category_id, created_at, updated_at) VALUES (?, 0, '2026-11-10', -100, ?, ?, 0, 0)",
    );
    txn.run("t1", "bajaj", "cat_other");
    txn.run("t2", "bajaj", "cat_other");
    txn.run("t3", "lunch", "cat_food");
    db.prepare(
      "INSERT INTO money_templates (id, label, amount_minor, category_id, created_at, updated_at) VALUES ('chip', 'bajaj', 100, 'cat_other', 0, 0)",
    ).run();
    const ids = (sql: string) =>
      (db.prepare(sql).all("cat_other") as { id: string }[]).map((row) => row.id);
    apply(
      db,
      mergeCategoryOps(
        "cat_other",
        "cat_transport",
        ids(CATEGORY_TXNS_SQL),
        ids(CATEGORY_TEMPLATES_SQL),
      ),
    );
    const rows = db.prepare(TXNS_SQL).all("2026-11-01", "2026-11-30") as {
      id: string;
      category: string;
    }[];
    expect(rows.map((row) => [row.id, row.category]).sort()).toEqual([
      ["t1", "Transport"],
      ["t2", "Transport"],
      ["t3", "Food"],
    ]);
    expect(db.prepare("SELECT category_id FROM money_templates").get()).toEqual({
      category_id: "cat_transport",
    });
    expect(names(db)).not.toContain("Other");
    expect(mergeCategoryOps("cat_food", "cat_food", ["t3"], [])).toEqual([]);
  });

  it("counts how many entries use each category", () => {
    const db = openTestDb();
    db.prepare(
      "INSERT INTO money_txns (id, occurred_at, local_date, amount_minor, description, category_id, created_at, updated_at) VALUES ('t', 0, '2026-11-10', -100, 'tea', 'cat_food', 0, 0)",
    ).run();
    expect(all(db).find((row) => row.id === "cat_food")?.uses).toBe(1);
  });
});
