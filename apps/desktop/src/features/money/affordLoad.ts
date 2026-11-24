/**
 * `afford 4500 shoes` in the capture box (T-074): the same numbers as Money →
 * Can I afford it?, loaded without the main window. Safe to spend once an
 * account has a balance; before that, this month's in − out − saved.
 */
import { logicalDate } from "../../kernel/dates";
import { formatAmount, type Santim } from "../../kernel/money";
import { GOALS_SQL, type GoalRow, UNASSIGNED_SQL } from "../savings/savings";
import { type Query } from "../plan/dayplan";
import { type AccountRow, ACCOUNTS_SQL } from "./accounts";
import { afford } from "./afford";
import { RATES_SQL, readRates, toEtb } from "./currency";
import { type LoanEvent, LOANS_SQL } from "./loans";
import { monthOf, monthSummary, SAVED_SQL, type TxnRow, TXNS_SQL } from "./money";
import {
  dueItems,
  dueWindow,
  type RegularRow,
  REGULARS_SQL,
  REGULAR_TXNS_SQL,
  type RegularTxn,
} from "./regulars";
import { GOAL_MONTH_SQL, safeToSpend } from "./safe";

type Rows<T> = T & Record<string, string | number | null>;

export async function affordAnswer(
  query: Query,
  nowMs: number,
  amount: Santim,
  what?: string,
  /** `afford $200`: the amount's currency; the answer is in birr at the saved rate. */
  currency?: string,
): Promise<string> {
  const today = logicalDate(nowMs);
  const { from, to, days } = monthOf(today);
  const window = dueWindow(today);
  const [
    accounts,
    goals,
    saved,
    waiting,
    regulars,
    regularTxns,
    txns,
    savedMonth,
    rateRows,
    loans,
  ] = await Promise.all([
    query<Rows<AccountRow>>(ACCOUNTS_SQL),
    query<Rows<GoalRow>>(GOALS_SQL),
    query<{ goal_id: string; minor: number }>(GOAL_MONTH_SQL, [from, to]),
    query<{ minor: number; n: number; held: number }>(UNASSIGNED_SQL),
    query<Rows<RegularRow>>(REGULARS_SQL),
    query<Rows<RegularTxn>>(REGULAR_TXNS_SQL, [window.txnFrom, window.to]),
    query<Rows<TxnRow>>(TXNS_SQL, [from, to]),
    query<{ minor: number }>(SAVED_SQL, [from, to]),
    query<{ value_json: string }>(RATES_SQL),
    query<Rows<LoanEvent>>(LOANS_SQL),
  ]);
  const rates = readRates(rateRows[0]?.value_json);
  const foreign = currency && currency !== "ETB" ? currency : undefined;
  const etb = toEtb(amount, foreign, rates);
  if (etb === null) return `Set a ${foreign ?? ""} rate in Money → Accounts first, then ask again.`;
  // "$200 ≈ 26,500 ETB at 132.50": what the question is in birr.
  const inBirr = foreign
    ? ` · ${formatAmount(amount, foreign)} ≈ ${formatAmount(etb)} at ${rates[foreign]?.rate ?? ""}`
    : "";
  const safe = safeToSpend({
    accounts,
    goals,
    savedThisMonth: Object.fromEntries(saved.map((row) => [row.goal_id, row.minor])),
    due: dueItems(regulars, regularTxns, window.from, window.to, today, window.shownFrom),
    today,
    daysInMonth: days,
    unassigned: waiting[0]?.minor ?? 0,
    unassignedHeld: waiting[0]?.held ?? 0,
    rates,
    loans,
  });
  const month = monthSummary({
    txns,
    saved: savedMonth[0]?.minor ?? 0,
    history: [],
    today,
    rates,
  });
  const answer = afford({
    amount: etb,
    available: safe.known ? safe.total : month.left,
    daysLeft: days - Number(today.slice(8, 10)) + 1,
    basis: safe.known ? "safe" : "month",
  });
  const notes = safe.known ? safe.notes : month.notes;
  const rate = notes?.rate ? ` (≈, ${notes.rate})` : "";
  const missing = notes?.missing ? ` · ${notes.missing}` : "";
  return `${answer.verdict}${what ? ` for ${what}` : ""}${inBirr} · ${answer.reasons[0] ?? ""}${rate}${missing}`;
}
