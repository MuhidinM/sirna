/**
 * Categories you manage (proposal 1.3; R-MON-02): add, rename, hide and
 * merge. Hiding is a soft delete: old entries keep their category's name.
 * Merging moves every entry and chip to the other category in one write.
 */
import { type Op } from "../../kernel/db";

export interface CategoryRow {
  id: string;
  name: string;
  kind: "expense" | "income";
  deleted_at: number | null;
  uses: number;
}

/** Every category, hidden ones too, with how many entries use it. */
export const ALL_CATEGORIES_SQL = `
  SELECT c.id, c.name, c.kind, c.deleted_at,
         (SELECT count(*) FROM money_txns m
          WHERE m.category_id = c.id AND m.deleted_at IS NULL) AS uses
  FROM money_categories c
  ORDER BY c.kind DESC, c.name`;

export const CATEGORY_TXNS_SQL = `SELECT id FROM money_txns
  WHERE category_id = ? AND deleted_at IS NULL`;
export const CATEGORY_TEMPLATES_SQL = `SELECT id FROM money_templates
  WHERE category_id = ? AND deleted_at IS NULL`;

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Null when the name can be used; `selfId` is the category being renamed. */
export function checkCategoryName(
  name: string,
  all: CategoryRow[],
  selfId?: string,
): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "A name, like Fuel or Rent.";
  if (trimmed.length > 40) return "Keep it under 40 characters.";
  if (all.some((row) => row.id !== selfId && row.deleted_at === null && same(row.name, trimmed)))
    return `There is already a category called ${trimmed}.`;
  return null;
}

/**
 * A new category. A hidden one with the same name comes back instead, since
 * names are unique (0005_money.sql).
 */
export function addCategoryOps(
  name: string,
  kind: CategoryRow["kind"],
  all: CategoryRow[],
  newId: string,
): Op[] {
  const hidden = all.find((row) => row.deleted_at !== null && same(row.name, name));
  return [
    {
      op: "upsert",
      table: "money_categories",
      id: hidden?.id ?? newId,
      values: { name: name.trim(), kind },
    },
  ];
}

export function renameCategoryOps(id: string, name: string): Op[] {
  return [{ op: "update", table: "money_categories", id, values: { name: name.trim() } }];
}

export function hideCategoryOps(id: string): Op[] {
  return [{ op: "delete", table: "money_categories", id }];
}

/** Moves every entry and chip from one category to another, then hides the first. */
export function mergeCategoryOps(
  fromId: string,
  toId: string,
  txnIds: string[],
  templateIds: string[],
): Op[] {
  if (fromId === toId) return [];
  return [
    ...txnIds.map((id): Op => ({
      op: "update",
      table: "money_txns",
      id,
      values: { category_id: toId },
    })),
    ...templateIds.map((id): Op => ({
      op: "update",
      table: "money_templates",
      id,
      values: { category_id: toId },
    })),
    { op: "delete", table: "money_categories", id: fromId },
  ];
}
