/**
 * Focus kits (plan §3.6a): per area, what opens, what gets minimized and the
 * checklist. Edited as one entry per line; stored as JSON arrays.
 */
import { type Op } from "../../kernel/db";

export interface KitRow {
  area_id: string;
  name: string;
  open_json: string | null;
  minimize_json: string | null;
  checklist_json: string | null;
}

export interface KitText {
  open: string;
  minimize: string;
  checklist: string;
}

/** Every active area with its kit (empty when it has none yet). */
export const KITS_SQL = `
  SELECT a.id AS area_id, a.name, k.open_json, k.minimize_json, k.checklist_json
  FROM area_items AS a
  LEFT JOIN focus_kits AS k ON k.area_id = a.id
  WHERE a.deleted_at IS NULL AND a.active = 1
  ORDER BY a.priority_rank, a.name`;

/** A stored JSON list as editable lines; anything unreadable is empty. */
export function toLines(json: string | null): string {
  if (!json) return "";
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string").join("\n")
      : "";
  } catch {
    return "";
  }
}

/** Lines back to a JSON list: trimmed, blanks and repeats dropped. */
export function toJson(lines: string): string {
  const items = lines
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return JSON.stringify([...new Set(items)]);
}

export function kitText(row: KitRow): KitText {
  return {
    open: toLines(row.open_json),
    minimize: toLines(row.minimize_json),
    checklist: toLines(row.checklist_json),
  };
}

export function kitOps(areaId: string, text: KitText): Op[] {
  return [
    {
      op: "upsert",
      table: "focus_kits",
      id: areaId,
      values: {
        open_json: toJson(text.open),
        minimize_json: toJson(text.minimize),
        checklist_json: toJson(text.checklist),
      },
    },
  ];
}
