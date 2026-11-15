/**
 * Spending caps (T-063; your answer 5): a cap on each category to build the
 * habit, suggested from your usual month. Pure and tested, integer santim.
 */
import { type Op } from "../../kernel/db";
import { type Santim, SANTIM_PER_BIRR } from "../../kernel/money";

const HUNDRED_BIRR = 100 * SANTIM_PER_BIRR;

/** Your usual month for that category, rounded up to 100 birr; null without history. */
export function suggestCap(usual: Santim | null | undefined): Santim | null {
  if (usual === null || usual === undefined || usual <= 0) return null;
  return Math.ceil(usual / HUNDRED_BIRR) * HUNDRED_BIRR;
}

export interface CapStatus {
  /** Spent as a share of the cap (can pass 1). */
  share: number;
  /** How far through the month: day ÷ days. */
  pace: number;
  over: boolean;
  /** Spending faster than the month: more than 10 points past the pace. */
  ahead: boolean;
  /** Left under the cap (0 when over). */
  left: Santim;
}

export function capStatus(spent: Santim, cap: Santim, day: number, days: number): CapStatus {
  const share = cap > 0 ? spent / cap : 0;
  const pace = days > 0 ? Math.min(1, day / days) : 1;
  return {
    share,
    pace,
    over: spent > cap,
    ahead: spent <= cap && share > pace + 0.1,
    left: Math.max(0, cap - spent),
  };
}

export function capOps(categoryId: string, cap: Santim | null): Op[] {
  return [{ op: "update", table: "money_categories", id: categoryId, values: { cap_minor: cap } }];
}

/** Every suggestion at once, for categories without a cap that have one. */
export function acceptAllOps(
  categories: { id: string; kind: string; cap_minor: number | null }[],
  usual: Map<string, number | null>,
): Op[] {
  return categories
    .filter((category) => category.kind === "expense" && category.cap_minor === null)
    .flatMap((category) => {
      const cap = suggestCap(usual.get(category.id));
      return cap === null ? [] : capOps(category.id, cap);
    });
}

export const CAPS_SQL = `SELECT id, name, cap_minor FROM money_categories
  WHERE deleted_at IS NULL AND kind = 'expense' AND cap_minor IS NOT NULL`;
