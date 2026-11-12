/**
 * The dashboard's card layout (plan §3.14; R-PRG-05): order, hidden cards
 * and sizes, saved in settings so it survives a restart. Pure and tested.
 */
import { type Op } from "../../kernel/db";

export type CardId = "tiles" | "streak" | "insights" | "year" | "savings" | "areas";
export type CardSize = "S" | "M" | "L";

export const CARDS: { id: CardId; label: string; size: CardSize }[] = [
  { id: "tiles", label: "This week's numbers", size: "L" },
  { id: "streak", label: "Focus streak", size: "M" },
  { id: "insights", label: "Insights", size: "M" },
  { id: "year", label: "The year", size: "L" },
  { id: "savings", label: "Savings", size: "L" },
  { id: "areas", label: "Areas this week", size: "L" },
];

export interface CardPlace {
  id: CardId;
  hidden: boolean;
  size: CardSize;
}

export const LAYOUT_KEY = "dashboard.layout";
export const LAYOUT_SQL = `SELECT value_json FROM core_settings WHERE key = '${LAYOUT_KEY}'`;

export function defaultLayout(): CardPlace[] {
  return CARDS.map((card) => ({ id: card.id, hidden: false, size: card.size }));
}

const isCard = (id: unknown): id is CardId => CARDS.some((card) => card.id === id);
const isSize = (size: unknown): size is CardSize => size === "S" || size === "M" || size === "L";

/** The saved layout; unknown cards are dropped and new ones join at the end. */
export function readLayout(valueJson: string | null | undefined): CardPlace[] {
  let saved: unknown;
  try {
    saved = JSON.parse(valueJson ?? "null");
  } catch {
    saved = null;
  }
  const places: CardPlace[] = [];
  if (Array.isArray(saved))
    for (const item of saved as unknown[]) {
      if (typeof item !== "object" || item === null) continue;
      const { id, hidden, size } = item as Record<string, unknown>;
      if (!isCard(id) || places.some((p) => p.id === id)) continue;
      const fallback = CARDS.find((card) => card.id === id)?.size ?? "M";
      places.push({ id, hidden: hidden === true, size: isSize(size) ? size : fallback });
    }
  for (const card of defaultLayout()) if (!places.some((p) => p.id === card.id)) places.push(card);
  return places;
}

/** One step earlier or later among the visible cards (hidden ones are stepped over). */
export function move(layout: CardPlace[], id: CardId, by: -1 | 1): CardPlace[] {
  const from = layout.findIndex((p) => p.id === id);
  if (from < 0) return layout;
  for (let i = from + by; i >= 0 && i < layout.length; i += by) {
    const other = layout[i];
    if (other && !other.hidden) return moveTo(layout, id, other.id);
  }
  return layout;
}

/** Moves a card to where another one is (drag and drop). */
export function moveTo(layout: CardPlace[], id: CardId, onto: CardId): CardPlace[] {
  if (id === onto) return layout;
  const card = layout.find((p) => p.id === id);
  if (!card) return layout;
  const rest = layout.filter((p) => p.id !== id);
  const at = rest.findIndex((p) => p.id === onto);
  if (at < 0) return layout;
  const from = layout.findIndex((p) => p.id === id);
  const target = layout.findIndex((p) => p.id === onto);
  rest.splice(from < target ? at + 1 : at, 0, card);
  return rest;
}

export function toggleHidden(layout: CardPlace[], id: CardId): CardPlace[] {
  return layout.map((p) => (p.id === id ? { ...p, hidden: !p.hidden } : p));
}

export function setSize(layout: CardPlace[], id: CardId, size: CardSize): CardPlace[] {
  return layout.map((p) => (p.id === id ? { ...p, size } : p));
}

export function layoutOps(layout: CardPlace[]): Op[] {
  return [
    {
      op: "upsert",
      table: "core_settings",
      id: LAYOUT_KEY,
      values: { value_json: JSON.stringify(layout) },
    },
  ];
}

/** Grid columns a size takes in the 6-column dashboard. */
export function span(size: CardSize): number {
  return size === "S" ? 2 : size === "M" ? 3 : 6;
}
