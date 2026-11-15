/**
 * The month review (T-066; proposal 3.5): on the first Sunday of a month, the
 * month that just ended. Pure and tested, integer santim.
 */
import { type Santim } from "../../kernel/money";
import { type AccountRow, totalBalance } from "./accounts";
import { type PersonBalance } from "./loans";
import { type MonthSummary } from "./money";

export interface MonthReview {
  in: Santim;
  out: Santim;
  /** Saved as a share of what came in, in whole percent; null with no income. */
  savingsRate: number | null;
  /** The 3 biggest changes against your usual month, biggest first. */
  changes: { name: string; spent: Santim; usual: Santim; diff: Santim }[];
  capsOver: { name: string; spent: Santim; cap: Santim }[];
  /** Accounts with a balance + owed to you − what you owe. Null with no balance yet. */
  netWorth: Santim | null;
}

/** The first Sunday of a month is a Sunday (ISO 7) on day 1 to 7. */
export function isFirstSunday(date: string): boolean {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 && Number(date.slice(8, 10)) <= 7;
}

export function monthReview(input: {
  summary: MonthSummary;
  caps: { id: string; name: string; cap_minor: number }[];
  accounts: AccountRow[];
  people: PersonBalance[];
}): MonthReview {
  const { summary, caps, accounts, people } = input;
  const changes = summary.categories
    .filter((line) => line.usual !== null)
    .map((line) => ({
      name: line.name,
      spent: line.spent,
      usual: line.usual ?? 0,
      diff: line.spent - (line.usual ?? 0),
    }))
    .filter((line) => line.diff !== 0)
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff) || a.name.localeCompare(b.name))
    .slice(0, 3);
  const spent = new Map(summary.categories.map((line) => [line.id, line.spent]));
  const capsOver = caps
    .map((cap) => ({ name: cap.name, spent: spent.get(cap.id) ?? 0, cap: cap.cap_minor }))
    .filter((cap) => cap.spent > cap.cap);
  const { total, unknown } = totalBalance(accounts);
  const known = accounts.length > unknown;
  const owed = people.reduce((sum, person) => sum + person.owedToMe - person.iOwe, 0);
  return {
    in: summary.in,
    out: summary.out,
    savingsRate: summary.in > 0 ? Math.floor((summary.saved / summary.in) * 100) : null,
    changes,
    capsOver,
    netWorth: known ? total + owed : null,
  };
}
