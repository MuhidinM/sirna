/**
 * The month review (T-066; proposal 3.5): on the first Sunday of a month, the
 * month that just ended. Pure and tested, integer santim.
 */
import { type Santim } from "../../kernel/money";
import { type AccountRow, inEtb, totalBalance } from "./accounts";
import { conversionNotes, type ConversionNotes, newConversion, type Rates } from "./currency";
import { owedInEtb, type PersonBalance } from "./loans";
import { type MonthSummary } from "./money";

export interface MonthReview {
  in: Santim;
  out: Santim;
  /** Saved as a share of what came in, in whole percent; null with no income. */
  savingsRate: number | null;
  /** The 3 biggest changes against your usual month, biggest first. */
  changes: { name: string; spent: Santim; usual: Santim; diff: Santim }[];
  capsOver: { name: string; spent: Santim; cap: Santim }[];
  /**
   * Every account with a balance (savings accounts too) + owed to you − what
   * you owe, in ETB. Null with no balance yet.
   */
  netWorth: Santim | null;
  /** Net worth's foreign money: converted, or left out. */
  notes: ConversionNotes;
}

/** The first Sunday of a month is a Sunday (ISO 7) on day 1 to 7. */
export function isFirstSunday(date: string): boolean {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 && Number(date.slice(8, 10)) <= 7;
}

export function monthReview(input: {
  summary: MonthSummary;
  caps: { id: string; name: string; cap_minor: number; cap_since?: string | null }[];
  accounts: AccountRow[];
  people: PersonBalance[];
  /** Your usual month per category, so one you stopped spending on shows too. */
  usual?: Map<string, number | null>;
  /** Category names, for the ones with no spending this month. */
  names?: Map<string, string>;
  /** The month's last day: a cap that started later doesn't judge it. */
  monthEnd?: string;
  rates?: Rates;
}): MonthReview {
  const rates = input.rates ?? {};
  const conversion = newConversion();
  const { summary, caps, accounts, people } = input;
  const lines = new Map(
    summary.categories.map((line) => [
      line.id,
      { name: line.name, spent: line.spent, usual: line.usual },
    ]),
  );
  for (const [id, usual] of input.usual ?? new Map<string, number | null>()) {
    if (lines.has(id) || id === "" || usual === null || usual <= 0) continue;
    const name = input.names?.get(id);
    if (name) lines.set(id, { name, spent: 0, usual });
  }
  const changes = [...lines.values()]
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
    .filter((cap) => !input.monthEnd || !cap.cap_since || cap.cap_since <= input.monthEnd)
    .map((cap) => ({ name: cap.name, spent: spent.get(cap.id) ?? 0, cap: cap.cap_minor }))
    .filter((cap) => cap.spent > cap.cap);
  const inHome = inEtb(accounts, rates, conversion);
  const { total, unknown } = totalBalance(inHome);
  const known = inHome.length > unknown;
  const owed = owedInEtb(people, rates, conversion);
  return {
    in: summary.in,
    out: summary.out,
    savingsRate: summary.in > 0 ? Math.floor((summary.saved / summary.in) * 100) : null,
    changes,
    capsOver,
    netWorth: known ? total + owed : null,
    notes: conversionNotes(conversion, rates),
  };
}
