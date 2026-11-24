/**
 * Safe to spend and the emergency fund (T-062; proposal 2.5, 2.6). One honest
 * number: what you can spend a day until the month ends, after what is
 * already promised. Shown only once at least one account has a real balance
 * (before that the month's in − out − saved is all there is). Every line of
 * the sum is returned, so the page can show it. Pure and tested.
 */
import { formatAmount, type Santim, SANTIM_PER_BIRR } from "../../kernel/money";
import { type GoalRow, goalPace, SAVING_FLOW } from "../savings/savings";
import { type AccountRow, balanceOf, inEtb, spending, totalBalance } from "./accounts";
import {
  convert,
  conversionNotes,
  type ConversionNotes,
  newConversion,
  type Rates,
} from "./currency";
import { type LoanEvent, owedThrough } from "./loans";
import { type DueItem, readRule, type RegularRow } from "./regulars";

/**
 * Saved into goals this month per goal (?1 first day, ?2 last day). A claim
 * of money already in the account is not this month's saving (F31).
 */
export const GOAL_MONTH_SQL = `SELECT goal_id, COALESCE(sum(amount_minor), 0) AS minor
  FROM savings_entries
  WHERE deleted_at IS NULL AND goal_id IS NOT NULL AND local_date >= ?1 AND local_date <= ?2
    AND ${SAVING_FLOW}
  GROUP BY goal_id`;

export interface SafeLine {
  label: string;
  /** Signed: what it adds to (or takes from) what you can spend. */
  amount: Santim;
}

export interface SafeToSpend {
  /** False until at least one account has a balance: then nothing is shown. */
  known: boolean;
  total: Santim;
  /** Rounded down to whole birr; null when nothing is left. */
  perDay: Santim | null;
  daysLeft: number;
  lines: SafeLine[];
  /** Accounts still without a balance: their money isn't counted. */
  unknownAccounts: number;
  /** Foreign money converted ("≈ at 132.50 (23 Nov)") or left out for want of a rate. */
  notes?: ConversionNotes;
}

/**
 * (money in spending accounts − money put aside in goals but still in them
 *  − what you still owe people
 *  + pay still to come this month − bills still to pay this month − what
 *  goals with a date still need this month) ÷ days left, rounded down.
 * Savings accounts never count: what sits there is already put aside.
 * Foreign money counts at its rate, or not at all without one.
 */
export function safeToSpend(input: {
  accounts: AccountRow[];
  goals: GoalRow[];
  /** This month's saving per goal id. */
  savedThisMonth: Record<string, Santim>;
  due: DueItem[];
  today: string;
  daysInMonth: number;
  /** Saved before any goal existed: put aside all the same. */
  unassigned?: Santim;
  /** The part of `unassigned` already in a savings account. */
  unassignedHeld?: Santim;
  rates?: Rates;
  /** Money lent and owed: what you still owe is not yours to spend. */
  loans?: LoanEvent[];
}): SafeToSpend {
  const rates = input.rates ?? {};
  const conversion = newConversion();
  const accounts = inEtb(spending(input.accounts), rates, conversion);
  const { total, unknown } = totalBalance(accounts);
  const daysLeft = input.daysInMonth - Number(input.today.slice(8, 10)) + 1;
  const known = accounts.length > unknown;
  const active = input.goals.filter((goal) => goal.status === "active");
  // Money put aside stays put aside while a goal is paused, and before it has
  // a goal; what already sits in a savings account is out of the sum anyway.
  const earmarked =
    input.goals
      .filter((goal) => goal.status !== "done")
      .reduce((sum, goal) => sum + Math.max(0, goal.saved_minor - (goal.held_minor ?? 0)), 0) +
    Math.max(0, (input.unassigned ?? 0) - (input.unassignedHeld ?? 0));
  // Pay and bills count only through accounts whose balance is known: pay
  // landing in an uncounted account would vanish from the sum once it came.
  const counted = new Set(
    accounts.filter((account) => balanceOf(account) !== null).map((account) => account.id),
  );
  const inCounted = input.due.filter((item) => counted.has(item.regular.account));
  const leftOf = (kind: "pay" | "bill") =>
    inCounted
      .filter((item) => item.regular.kind === kind)
      .reduce(
        (sum, item) => sum + (convert(conversion, rates, item.left, item.regular.currency) ?? 0),
        0,
      );
  const payLeft = leftOf("pay");
  const billsLeft = leftOf("bill");
  const goalsLeft = active.reduce((sum, goal) => {
    const need = goalPace(goal, input.today).needPerMonth;
    if (need === null) return sum;
    return sum + Math.max(0, need - (input.savedThisMonth[goal.id] ?? 0));
  }, 0);
  // Borrowed money sits in your accounts but is not yours (F30). Like pay and
  // bills, only loans through counted accounts: money borrowed into an
  // account with no balance was never added, so it isn't taken off either.
  // What is open is worked out from every event, so a repayment through
  // another account still clears the debt.
  const owed = owedThrough(input.loans ?? [], counted).reduce(
    (sum, debt) => sum + (convert(conversion, rates, debt.amount, debt.currency) ?? 0),
    0,
  );
  const lines: SafeLine[] = [{ label: "In your accounts", amount: total }];
  if (earmarked > 0) lines.push({ label: "Put aside in goals", amount: -earmarked });
  if (owed > 0) lines.push({ label: "You owe people", amount: -owed });
  if (payLeft > 0) lines.push({ label: "Pay still to come this month", amount: payLeft });
  if (billsLeft > 0) lines.push({ label: "Bills still to pay this month", amount: -billsLeft });
  if (goalsLeft > 0) lines.push({ label: "Goals still to fund this month", amount: -goalsLeft });
  const sum = lines.reduce((acc, line) => acc + line.amount, 0);
  return {
    known,
    total: sum,
    perDay:
      sum > 0 && daysLeft > 0
        ? Math.floor(sum / daysLeft / SANTIM_PER_BIRR) * SANTIM_PER_BIRR
        : null,
    daysLeft,
    lines,
    unknownAccounts: unknown,
    notes: conversionNotes(conversion, rates),
  };
}

export function safeLine(safe: SafeToSpend): string {
  const short = (minor: Santim) => formatAmount(minor).replace(/ ETB$/, "");
  if (safe.total <= 0) return `Nothing safe to spend: ${short(-safe.total)} short this month`;
  return `${short(safe.total)} safe to spend · about ${short(safe.perDay ?? 0)} a day`;
}

// --- The emergency fund ----------------------------------------------------------

/** Categories that keep life running: what an emergency fund must cover. */
export const ESSENTIAL_CATEGORIES = [
  "cat_housing",
  "cat_utilities",
  "cat_food",
  "cat_transport",
  "cat_phone",
  "cat_health",
];

export const EMERGENCY_TITLE = "Emergency fund";
export const EMERGENCY_MONTHS = 3;

export const isEmergency = (goal: Pick<GoalRow, "title">) =>
  goal.title.trim().toLowerCase() === EMERGENCY_TITLE.toLowerCase();

/** A bill's cost in a month, in its own currency: weekly ones × 52 ÷ 12. */
function billPerMonth(bill: Pick<RegularRow, "amount_minor" | "rule_json">): Santim {
  const rule = readRule(bill.rule_json);
  if (rule?.every === "week") return Math.round((bill.amount_minor * rule.days.length * 52) / 12);
  return bill.amount_minor;
}

/**
 * A month of essentials: your usual spending in the essential categories,
 * and your regular bills (F100). In an essential category the larger of the
 * two counts, so rent already in Housing's usual isn't counted twice; a bill
 * outside them is added. Null with no history and no bills yet.
 */
export function essentialMonth(
  usual: Map<string, number | null>,
  bills: Pick<
    RegularRow,
    "kind" | "active" | "amount_minor" | "rule_json" | "category_id" | "currency"
  >[] = [],
  rates: Rates = {},
): Santim | null {
  const billed = new Map<string, Santim>();
  const conversion = newConversion();
  for (const bill of bills) {
    if (bill.kind !== "bill" || bill.active !== 1) continue;
    const etb = convert(conversion, rates, billPerMonth(bill), bill.currency);
    if (etb === null) continue;
    const key = bill.category_id ?? "";
    billed.set(key, (billed.get(key) ?? 0) + etb);
  }
  let total = 0;
  let any = false;
  for (const id of ESSENTIAL_CATEGORIES) {
    const value = usual.get(id);
    const fromBills = billed.get(id);
    if ((value === undefined || value === null) && fromBills === undefined) continue;
    total += Math.max(value ?? 0, fromBills ?? 0);
    any = true;
  }
  for (const [id, minor] of billed) {
    if (ESSENTIAL_CATEGORIES.includes(id)) continue;
    total += minor;
    any = true;
  }
  return any ? total : null;
}

/** "Covers 1.4 months" (one decimal, rounded down so it never overstates). */
export function monthsCovered(saved: Santim, month: Santim | null): number | null {
  if (month === null || month <= 0) return null;
  return Math.floor((Math.max(0, saved) / month) * 10) / 10;
}

/** A target of 3 months of essentials, rounded up to a whole thousand birr. */
export function emergencyTarget(month: Santim): Santim {
  const raw = month * EMERGENCY_MONTHS;
  const thousand = 1000 * SANTIM_PER_BIRR;
  return Math.ceil(raw / thousand) * thousand;
}
