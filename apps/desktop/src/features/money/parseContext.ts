/**
 * What the capture parser needs from your money data: categories, the ones
 * you corrected, jobs, accounts, open loans, areas and rates. Any screen that
 * reads money lines (the night review's spending step) passes the same as the
 * capture bar, so `@telebirr` and `$3` land the same way everywhere (F3).
 */
import { type ParseOptions } from "../../capture/parse";
import { type Query } from "../projects/capacity";
import { RATES_SQL, readRates } from "./currency";
import { balances, type LoanEvent, loanPeople, LOANS_SQL } from "./loans";
import { CATEGORIES_SQL, LEARNED_SQL } from "./money";

export type MoneyContext = Pick<
  ParseOptions,
  "categories" | "learned" | "jobs" | "accounts" | "loanPeople" | "areas" | "rates"
>;

export const PARSE_ACCOUNTS_SQL =
  "SELECT id, name, kind, pays_in, currency, is_savings FROM money_accounts WHERE deleted_at IS NULL ORDER BY sort_order";
const JOBS_SQL =
  "SELECT id, name FROM area_items WHERE kind = 'work' AND active = 1 AND deleted_at IS NULL";
const AREAS_SQL = "SELECT id, name FROM area_items WHERE active = 1 AND deleted_at IS NULL";

/** Reads it all; one failed read leaves that part empty, never the rest. */
export async function loadMoneyContext(query: Query): Promise<MoneyContext> {
  const results = await Promise.allSettled([
    query<{ id: string; name: string; kind: "expense" | "income" }>(CATEGORIES_SQL),
    query<{ id: string; category_id: string }>(LEARNED_SQL),
    query<{ id: string; name: string }>(JOBS_SQL),
    query<{
      id: string;
      name: string;
      kind: string;
      pays_in: number;
      currency: string;
      is_savings: number;
    }>(PARSE_ACCOUNTS_SQL),
    query<LoanEvent & Record<string, string | number | null>>(LOANS_SQL),
    query<{ id: string; name: string }>(AREAS_SQL),
    query<{ value_json: string }>(RATES_SQL),
  ]);
  const [categories, learned, jobs, accounts, loans, areas, rates] = results.map((result) =>
    result.status === "fulfilled" ? result.value : [],
  ) as [
    { id: string; name: string; kind: "expense" | "income" }[],
    { id: string; category_id: string }[],
    { id: string; name: string }[],
    {
      id: string;
      name: string;
      kind: string;
      pays_in: number;
      currency: string;
      is_savings: number;
    }[],
    (LoanEvent & Record<string, string | number | null>)[],
    { id: string; name: string }[],
    { value_json: string }[],
  ];
  return {
    areas,
    categories,
    learned: Object.fromEntries(learned.map((row) => [row.id, row.category_id])),
    jobs,
    accounts,
    loanPeople: loanPeople(balances(loans)),
    rates: readRates(rates[0]?.value_json),
  };
}
