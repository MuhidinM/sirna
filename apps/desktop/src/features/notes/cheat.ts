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
  /** Its place once a card edit set one; null for a pin not yet moved. */
  sort_order?: number | null;
}

export interface Card {
  /** The area id or tag; "" for General. */
  key: string;
  title: string;
  lines: { id: string; body: string; sort_order?: number | null }[];
}

/**
 * Every kept cheat line. Areas first in their priority order, then tags,
 * General last. Within a card: edited order first, then pins as they came.
 */
export const CHEAT_SQL = `
  SELECT n.id, n.body, n.area_id, a.name AS area_name, n.sort_order
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
    card.lines.push(
      row.sort_order === undefined
        ? { id: row.id, body: row.body }
        : { id: row.id, body: row.body, sort_order: row.sort_order },
    );
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

// --- Notes and search (plan §3.5: `n:` notes, `? kifiya`) ----------------------

/** Notes kept from `n:`, `fb:` or a loose end sorted as Note: newest first. */
export const NOTES_SQL = `
  SELECT n.id, n.body, n.area_id, a.name AS area_name, n.kind
  FROM note_items AS n
  LEFT JOIN area_items AS a ON a.id = n.area_id AND a.deleted_at IS NULL
  WHERE n.kind IN ('note', 'feedback') AND n.status = 'kept' AND n.deleted_at IS NULL
  ORDER BY n.created_at DESC, n.id DESC`;

export type FoundKind = "cheat" | "note" | "task";

export interface FoundRow extends CheatRow {
  kind: FoundKind;
}

/** What `?` searches: kept cheat lines and notes, and open tasks. */
export const FIND_SQL = `
  SELECT id, body, area_id, area_name, kind FROM (
    SELECT n.id, n.body, n.area_id, a.name AS area_name,
           CASE WHEN n.kind = 'cheat' THEN 'cheat' ELSE 'note' END AS kind,
           a.priority_rank AS rank, n.sort_order AS sort_order, n.created_at AS created_at
    FROM note_items AS n
    LEFT JOIN area_items AS a ON a.id = n.area_id AND a.deleted_at IS NULL
    WHERE n.kind IN ('cheat', 'note', 'feedback') AND n.status = 'kept' AND n.deleted_at IS NULL
    UNION ALL
    SELECT t.id, t.title, t.area_id, a.name, 'task', a.priority_rank, NULL, t.created_at
    FROM task_items AS t
    LEFT JOIN area_items AS a ON a.id = t.area_id AND a.deleted_at IS NULL
    WHERE t.deleted_at IS NULL AND t.status IN ('todo', 'waiting', 'someday'))
  -- The cards' order (CHEAT_SQL): by area priority, General last, then as kept.
  ORDER BY area_id IS NULL, rank IS NULL, rank, area_id,
           sort_order IS NULL, sort_order, created_at, id`;

export interface Found {
  id: string;
  body: string;
  kind: FoundKind;
  /** "Cheat · Coding", "Note", "Task · Job hunt". */
  label: string;
  /** The area id, or "" (for its colour). */
  key: string;
}

const KIND_WORD: Record<FoundKind, string> = { cheat: "Cheat", note: "Note", task: "Task" };

/** Rows matching every word of the query (any order, any case): cheat lines, then notes, then tasks. */
export function find(rows: FoundRow[], query: string): Found[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const order: FoundKind[] = ["cheat", "note", "task"];
  return rows
    .map((row) => {
      // An area-less cheat line is on the General card, so "general" finds it.
      const area = row.area_id || row.kind === "cheat" ? cardTitle(row) : "";
      return { row, area };
    })
    .filter(({ row, area }) => {
      const haystack = `${row.body} ${area}`.toLowerCase();
      return words.every((word) => haystack.includes(word));
    })
    .sort((a, b) => order.indexOf(a.row.kind) - order.indexOf(b.row.kind))
    .map(({ row, area }) => ({
      id: row.id,
      body: row.body,
      kind: row.kind,
      label: area ? `${KIND_WORD[row.kind]} · ${area}` : KIND_WORD[row.kind],
      key: row.area_id ?? "",
    }));
}

/** The card as editable text, one line per row. */
export function cardText(card: Card): string {
  return card.lines.map((line) => line.body).join("\n");
}

/**
 * The writes that turn a card into `text`: line i updates row i, new lines are
 * inserted, missing lines deleted (soft, so undo can bring them back). A kept
 * line gets its position, so the order sticks. A line you didn't change isn't
 * written when it already sits in its place (reg2-7): a pinned line with no
 * position stays as the capture made it, so the pin can still be undone.
 */
export function editOps(card: Card, text: string, newId: () => string): Op[] {
  const next = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const ops: Op[] = [];
  // Nothing before the new lines changes: they go on the end. After lines
  // with no position (pins, in the order they came) a new one needs none
  // either; it is the newest.
  const kept = card.lines.slice(0, next.length);
  const untouched = kept.every((line, index) => line.body === next[index]);
  const lastOrder = card.lines[card.lines.length - 1]?.sort_order;
  // Unchanged pins with no position at the end of the card stay last without
  // one (lines with a position come first), and so do new lines after them.
  let tail = next.length;
  let tailHasPin = false;
  while (tail > 0) {
    const existing = card.lines[tail - 1];
    if (existing && (existing.body !== next[tail - 1] || existing.sort_order !== null)) break;
    if (existing) tailHasPin = true;
    tail -= 1;
  }
  if (!tailHasPin) tail = next.length;
  next.forEach((body, index) => {
    const existing = card.lines[index];
    if (existing) {
      if (untouched || index >= tail) return;
      if (existing.body === body && existing.sort_order === index) return;
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
          sort_order:
            (untouched && lastOrder === null) || index >= tail
              ? null
              : Math.max(index, untouched && typeof lastOrder === "number" ? lastOrder + 1 : 0),
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

/** The tail of an undo message when undo kept fields edited since (tx::Undone.kept). */
export function keptNote(kept: number): string {
  if (kept <= 0) return "";
  return kept === 1 ? "; kept 1 newer change" : `; kept ${kept} newer changes`;
}
