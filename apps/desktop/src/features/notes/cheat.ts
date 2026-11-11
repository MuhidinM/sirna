/**
 * Cheat sheets (plan §3.15): short cards you keep coming back to. Each pinned
 * line is one `note_items` row (kind 'cheat'); a card is all the lines of one
 * area (or `#tag`, or General). Pure helpers; the screen is shell/Notes.tsx.
 */
import { type Op } from "../../kernel/db";

/** Past this many lines the card suggests splitting (plan §3.15: ~25). */
export const LONG_CARD = 25;

export interface CheatRow {
  id: string;
  body: string;
  area_id: string | null;
  area_name: string | null;
}

export interface Card {
  /** The area id or tag; "" for General. */
  key: string;
  title: string;
  lines: { id: string; body: string }[];
}

/**
 * Every kept cheat line. Areas first in their priority order, then tags,
 * General last. Within a card: edited order first, then pins as they came.
 */
export const CHEAT_SQL = `
  SELECT n.id, n.body, n.area_id, a.name AS area_name
  FROM note_items AS n
  LEFT JOIN area_items AS a ON a.id = n.area_id AND a.deleted_at IS NULL
  WHERE n.kind = 'cheat' AND n.status = 'kept' AND n.deleted_at IS NULL
  ORDER BY n.area_id IS NULL, a.priority_rank IS NULL, a.priority_rank, n.area_id,
           n.sort_order IS NULL, n.sort_order, n.created_at, n.id`;

function cardTitle(row: CheatRow): string {
  if (row.area_name) return row.area_name;
  if (row.area_id) return row.area_id.charAt(0).toUpperCase() + row.area_id.slice(1);
  return "General";
}

/** Rows (already ordered by CHEAT_SQL) grouped into cards. */
export function groupCards(rows: CheatRow[]): Card[] {
  const cards = new Map<string, Card>();
  for (const row of rows) {
    const key = row.area_id ?? "";
    let card = cards.get(key);
    if (!card) {
      card = { key, title: cardTitle(row), lines: [] };
      cards.set(key, card);
    }
    card.lines.push({ id: row.id, body: row.body });
  }
  return [...cards.values()];
}

/** Lines matching every word of the query (any order, any case). */
export function search(
  cards: Card[],
  query: string,
): { card: Card; line: Card["lines"][number] }[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const hits: { card: Card; line: Card["lines"][number] }[] = [];
  for (const card of cards) {
    for (const line of card.lines) {
      const haystack = `${line.body} ${card.title}`.toLowerCase();
      if (words.every((word) => haystack.includes(word))) hits.push({ card, line });
    }
  }
  return hits;
}

/** The card as editable text, one line per row. */
export function cardText(card: Card): string {
  return card.lines.map((line) => line.body).join("\n");
}

/**
 * The writes that turn a card into `text`: line i updates row i, new lines are
 * inserted, missing lines deleted (soft, so undo can bring them back). Every
 * kept line gets its position, so the order sticks.
 */
export function editOps(card: Card, text: string, newId: () => string): Op[] {
  const next = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const ops: Op[] = [];
  next.forEach((body, index) => {
    const existing = card.lines[index];
    if (existing) {
      ops.push({
        op: "update",
        table: "note_items",
        id: existing.id,
        values: { body, sort_order: index },
      });
    } else {
      ops.push({
        op: "insert",
        table: "note_items",
        id: newId(),
        values: {
          kind: "cheat",
          status: "kept",
          body,
          area_id: card.key === "" ? null : card.key,
          sort_order: index,
          origin: "notes",
        },
      });
    }
  });
  for (const removed of card.lines.slice(next.length)) {
    ops.push({ op: "delete", table: "note_items", id: removed.id });
  }
  return ops;
}

export type Token = { kind: "text" | "code" | "bold"; text: string };

/** The little Markdown a cheat line needs: `code` and **bold**. */
export function tokens(line: string): Token[] {
  const out: Token[] = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  for (const match of line.matchAll(pattern)) {
    const at = match.index;
    if (at > last) out.push({ kind: "text", text: line.slice(last, at) });
    if (match[1] !== undefined) out.push({ kind: "code", text: match[1] });
    else if (match[2] !== undefined) out.push({ kind: "bold", text: match[2] });
    last = at + match[0].length;
  }
  if (last < line.length) out.push({ kind: "text", text: line.slice(last) });
  return out;
}
