/**
 * Can I afford it? (T-065; proposal 3.2). One answer from your real numbers:
 * Fine, Tight or Not now. The verdict is calculated here; nothing guesses.
 */
import { formatAmount, type Santim, SANTIM_PER_BIRR } from "../../kernel/money";

export type AffordVerdict = "Fine" | "Tight" | "Not now";

export interface Afford {
  verdict: AffordVerdict;
  /** What is left to spend this month afterwards. */
  after: Santim;
  /** About a day afterwards (rounded down), or null when nothing is left. */
  perDayAfter: Santim | null;
  perDayBefore: Santim | null;
  reasons: string[];
}

/** A big share of what is left, or halving the daily figure, makes it tight. */
export const TIGHT_SHARE = 0.25;

const perDay = (minor: Santim, days: number) =>
  minor > 0 && days > 0 ? Math.floor(minor / days / SANTIM_PER_BIRR) * SANTIM_PER_BIRR : null;

/**
 * `available` is safe to spend once an account has a balance, else this
 * month's in − out − saved; `basis` says which, for the words.
 */
export function afford(input: {
  amount: Santim;
  available: Santim;
  daysLeft: number;
  basis: "safe" | "month";
}): Afford {
  const { amount, available, daysLeft, basis } = input;
  const after = available - amount;
  const before = perDay(available, daysLeft);
  const perDayAfter = perDay(after, daysLeft);
  const what = basis === "safe" ? "safe to spend" : "left this month";
  let verdict: AffordVerdict;
  if (after < 0) verdict = "Not now";
  else if (amount > available * TIGHT_SHARE || (before !== null && (perDayAfter ?? 0) < before / 2))
    verdict = "Tight";
  else verdict = "Fine";
  const reasons: string[] = [];
  if (after < 0)
    reasons.push(`It is ${formatAmount(-after)} more than you have ${what} this month.`);
  else
    reasons.push(
      `It leaves ${formatAmount(after)} ${what} for ${daysLeft} day${daysLeft === 1 ? "" : "s"}${
        perDayAfter !== null ? `, about ${formatAmount(perDayAfter)} a day` : ""
      }${before !== null ? ` (now ${formatAmount(before)})` : ""}.`,
    );
  if (verdict === "Tight" && amount > available * TIGHT_SHARE)
    reasons.push(
      `That is ${Math.round((amount / Math.max(1, available)) * 100)}% of what you have ${what}.`,
    );
  if (verdict === "Not now") reasons.push("Wait for next month's pay, or save for it as a goal.");
  if (basis === "month")
    reasons.push(
      "Set your account balances for a sharper answer: then bills and pay to come count too.",
    );
  return { verdict, after, perDayAfter, perDayBefore: before, reasons };
}
