/**
 * Payments that look regular (T-072; proposal 2.4): the same description and
 * amount about once a month, in at least 2 of the last 3 months, and not yet a
 * bill. Pay and bills offers "Track it" or "No". Pure and tested.
 */
import { type Op } from "../../kernel/db";
import { formatAmount, type Santim } from "../../kernel/money";
import { monthOf, previousMonthStart } from "./money";
import { type RegularRow, regularOps } from "./regulars";

/** Spending from ?1 on, grouped by description and amount (transfers, loans and bills left out). */
export const SUGGEST_SQL = `
  SELECT lower(trim(description)) AS key, max(description) AS description,
         -amount_minor AS amount, max(category_id) AS category_id, max(account) AS account,
         count(DISTINCT substr(local_date, 1, 7)) AS months, count(*) AS times,
         max(local_date) AS last_date
  FROM money_txns
  WHERE deleted_at IS NULL AND transfer_id IS NULL AND regular_id IS NULL
    AND amount_minor < 0 AND local_date >= ?1
  GROUP BY key, amount_minor`;

export interface SuggestRow {
  key: string;
  description: string;
  amount: Santim;
  category_id: string | null;
  account: string;
  months: number;
  times: number;
  last_date: string;
}

export interface Suggestion {
  key: string;
  name: string;
  amount: Santim;
  day: number;
  categoryId: string | null;
  account: string;
  text: string;
}

export const DISMISSED_SUGGESTIONS_KEY = "money.regular_dismissed";

/** The first day of the month two months back: three months of history with this one. */
export function suggestSince(today: string): string {
  return previousMonthStart(previousMonthStart(monthOf(today).from));
}

const suggestionKey = (row: { key: string; amount: Santim }) => `${row.key}|${row.amount}`;

export function suggestRegulars(
  rows: SuggestRow[],
  regulars: Pick<RegularRow, "name" | "amount_minor" | "kind">[],
  dismissed: string[],
): Suggestion[] {
  const tracked = (row: SuggestRow) =>
    regulars.some(
      (regular) =>
        regular.kind === "bill" &&
        (regular.name.trim().toLowerCase() === row.key || regular.amount_minor === row.amount) &&
        (regular.name.trim().toLowerCase() === row.key ||
          row.key.includes(regular.name.trim().toLowerCase())),
    );
  return rows
    .filter((row) => row.months >= 2 && row.times <= row.months + 1) // about once a month
    .filter((row) => !tracked(row) && !dismissed.includes(suggestionKey(row)))
    .sort((a, b) => b.amount - a.amount)
    .map((row) => {
      const day = Number(row.last_date.slice(8, 10));
      const trimmed = row.description.trim();
      // Typed in different cases over the months: show it with a capital.
      const name = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
      return {
        key: suggestionKey(row),
        name,
        amount: row.amount,
        day,
        categoryId: row.category_id,
        account: row.account,
        text: `${name} ${formatAmount(row.amount)} around the ${day}${
          day % 10 === 1 && day !== 11
            ? "st"
            : day % 10 === 2 && day !== 12
              ? "nd"
              : day % 10 === 3 && day !== 13
                ? "rd"
                : "th"
        } looks regular.`,
      };
    });
}

export function trackOps(suggestion: Suggestion, id: string): Op[] {
  return regularOps(
    {
      kind: "bill",
      name: suggestion.name,
      amount: suggestion.amount,
      ruleText: `monthly ${suggestion.day}`,
      categoryId: suggestion.categoryId ?? "",
      account: suggestion.account,
      areaId: "",
    },
    id,
  );
}

export function readDismissed(valueJson: string | null | undefined): string[] {
  try {
    const value: unknown = JSON.parse(valueJson ?? "[]");
    return Array.isArray(value)
      ? value.filter((key): key is string => typeof key === "string")
      : [];
  } catch {
    return [];
  }
}

export function notAgainOps(valueJson: string | null | undefined, key: string): Op[] {
  return [
    {
      op: "upsert",
      table: "core_settings",
      id: DISMISSED_SUGGESTIONS_KEY,
      values: { value_json: JSON.stringify([...new Set([...readDismissed(valueJson), key])]) },
    },
  ];
}
