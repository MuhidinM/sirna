/**
 * Regulars (T-059, T-060; proposal 2.2-2.4): bills you pay (rent, internet,
 * iddir) and pay you expect from each job, on one repeat rule. Nothing posts
 * by itself: Paid or Received records the entry, marked with the regular and
 * the date it was due. Pure and tested, integer santim, logical dates.
 */
import { type Op } from "../../kernel/db";
import { logicalDate } from "../../kernel/dates";
import { formatAmount, type Santim } from "../../kernel/money";
import { shiftDate } from "../plan/dayplan";
import { monthOf } from "./money";

// --- The repeat rule ------------------------------------------------------------

/** Monthly on a day (31 means the last day in short months), or weekly on ISO weekdays. */
export type Rule = { every: "month"; day: number } | { every: "week"; days: number[] };

const DAY_NAMES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/**
 * `monthly 10`, `monthly 1st`, `monthly last`, `every mon`, `every mon, thu`,
 * `every weekday`. Null when it isn't one of those.
 */
export function parseRule(text: string): Rule | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, " ");
  const monthly = /^(?:monthly|every month)(?: on)?(?: the)? (\d{1,2})(?:st|nd|rd|th)?$/.exec(t);
  if (monthly) {
    const day = Number(monthly[1]);
    return day >= 1 && day <= 31 ? { every: "month", day } : null;
  }
  if (/^(?:monthly|every month)(?: on)?(?: the)? last(?: day)?$/.test(t))
    return { every: "month", day: 31 };
  if (/^every (?:weekday|work ?day)s?$/.test(t)) return { every: "week", days: [1, 2, 3, 4, 5] };
  const weekly = /^(?:every|weekly)(?: on)? (.+)$/.exec(t);
  if (weekly?.[1]) {
    const days = weekly[1]
      .split(/\s*(?:,|and)\s*|\s+/)
      .filter(Boolean)
      .map((word) => DAY_NAMES.findIndex((name) => word.startsWith(name)) + 1);
    if (days.length > 0 && days.every((day) => day > 0))
      return { every: "week", days: [...new Set(days)].sort((a, b) => a - b) };
  }
  return null;
}

export function ruleText(rule: Rule): string {
  if (rule.every === "month") {
    if (rule.day >= 31) return "monthly, last day";
    const suffix =
      rule.day % 10 === 1 && rule.day !== 11
        ? "st"
        : rule.day % 10 === 2 && rule.day !== 12
          ? "nd"
          : rule.day % 10 === 3 && rule.day !== 13
            ? "rd"
            : "th";
    return `monthly on the ${rule.day}${suffix}`;
  }
  if (rule.days.join() === "1,2,3,4,5") return "every weekday";
  return `every ${rule.days.map((day) => DAY_NAMES[day - 1] ?? "?").join(", ")}`;
}

export function readRule(json: string): Rule | null {
  try {
    const value = JSON.parse(json) as Partial<Rule> & { day?: unknown; days?: unknown };
    if (value.every === "month" && typeof value.day === "number")
      return { every: "month", day: value.day };
    if (value.every === "week" && Array.isArray(value.days))
      return { every: "week", days: value.days.filter((d): d is number => typeof d === "number") };
  } catch {
    return null;
  }
  return null;
}

const isoWeekday = (date: string) => {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
};

/** Every date the rule falls on, from `from` to `to` (inclusive). */
export function occurrences(rule: Rule, from: string, to: string): string[] {
  const dates: string[] = [];
  if (rule.every === "month") {
    let month = monthOf(from).from;
    while (month <= to) {
      const { days, key } = monthOf(month);
      const date = `${key}-${String(Math.min(rule.day, days)).padStart(2, "0")}`;
      if (date >= from && date <= to) dates.push(date);
      month = shiftDate(monthOf(month).to, 1);
    }
    return dates;
  }
  for (let date = from; date <= to; date = shiftDate(date, 1))
    if (rule.days.includes(isoWeekday(date))) dates.push(date);
  return dates;
}

// --- Regulars and what is due -----------------------------------------------------

export interface RegularRow {
  id: string;
  kind: "bill" | "pay";
  name: string;
  amount_minor: number;
  rule_json: string;
  category_id: string | null;
  account: string;
  area_id: string | null;
  active: number;
  /** The job's name, for pay. */
  job: string | null;
  /** When you added it: earlier occurrences aren't asked about. */
  created_at: number;
}

export const REGULARS_SQL = `
  SELECT r.id, r.kind, r.name, r.amount_minor, r.rule_json, r.category_id, r.account,
         r.area_id, r.active, a.name AS job, r.created_at
  FROM money_regulars r
  LEFT JOIN area_items a ON a.id = r.area_id
  WHERE r.deleted_at IS NULL
  ORDER BY r.kind DESC, r.name`;

/** Entries recorded against regulars between ?1 and ?2 (due dates), plus income per job. */
export const REGULAR_TXNS_SQL = `
  SELECT regular_id, due_date, area_id, amount_minor, local_date FROM money_txns
  WHERE deleted_at IS NULL
    AND ((regular_id IS NOT NULL AND due_date >= ?1 AND due_date <= ?2)
      OR (area_id IS NOT NULL AND amount_minor > 0 AND local_date >= ?1 AND local_date <= ?2))`;

export interface RegularTxn {
  regular_id: string | null;
  due_date: string | null;
  area_id: string | null;
  amount_minor: number;
  local_date: string;
}

export type DueState = "paid" | "due" | "late" | "upcoming";

export interface DueItem {
  regular: RegularRow;
  date: string;
  state: DueState;
  /** Paid or received so far against this occurrence. */
  done: Santim;
  /** Still to pay, or still to come. */
  left: Santim;
}

/** Pay counts as late this many days after its day. */
export const PAY_GRACE_DAYS = 3;

/**
 * Each occurrence from `from` to `to` and where it stands. A bill is paid by
 * an entry marked with it. Pay is received by an entry marked with it or by
 * any income from that job in the same month (`got 18k job a`), up to the
 * expected amount.
 */
export function dueItems(
  regulars: RegularRow[],
  txns: RegularTxn[],
  from: string,
  to: string,
  today: string,
): DueItem[] {
  const items: DueItem[] = [];
  const usedIncome = new Map<string, Santim>(); // job+month → income already matched
  for (const regular of regulars) {
    if (regular.active !== 1) continue;
    const rule = readRule(regular.rule_json);
    if (!rule) continue;
    // Occurrences before you added it are not yours to settle now.
    const since = regular.created_at > 0 ? logicalDate(regular.created_at) : from;
    for (const date of occurrences(rule, from > since ? from : since, to)) {
      let done = txns
        .filter((txn) => txn.regular_id === regular.id && txn.due_date === date)
        .reduce((sum, txn) => sum + Math.abs(txn.amount_minor), 0);
      if (regular.kind === "pay" && regular.area_id && done < regular.amount_minor) {
        const month = date.slice(0, 7);
        const key = `${regular.area_id}|${month}`;
        const income = txns
          .filter(
            (txn) =>
              txn.regular_id === null &&
              txn.area_id === regular.area_id &&
              txn.amount_minor > 0 &&
              txn.local_date.slice(0, 7) === month,
          )
          .reduce((sum, txn) => sum + txn.amount_minor, 0);
        const free = income - (usedIncome.get(key) ?? 0);
        const take = Math.max(0, Math.min(free, regular.amount_minor - done));
        usedIncome.set(key, (usedIncome.get(key) ?? 0) + take);
        done += take;
      }
      const left = Math.max(0, regular.amount_minor - done);
      const grace = regular.kind === "pay" ? PAY_GRACE_DAYS : 0;
      const state: DueState =
        left === 0
          ? "paid"
          : today > shiftDate(date, grace)
            ? "late"
            : today >= date
              ? "due"
              : "upcoming";
      items.push({ regular, date, state, done, left });
    }
  }
  return items.sort(
    (a, b) => a.date.localeCompare(b.date) || a.regular.name.localeCompare(b.regular.name),
  );
}

/** The entry Paid or Received records: the full amount left, today, marked with the regular. */
export function settleOps(item: DueItem, today: string, nowMs: number, id: string): Op[] {
  const out = item.regular.kind === "bill";
  return [
    {
      op: "insert",
      table: "money_txns",
      id,
      values: {
        account: item.regular.account,
        occurred_at: nowMs,
        local_date: today,
        amount_minor: out ? -item.left : item.left,
        description: item.regular.name,
        category_id: item.regular.category_id ?? (out ? null : "cat_salary"),
        area_id: item.regular.area_id,
        origin: "regular",
        regular_id: item.regular.id,
        due_date: item.date,
      },
    },
  ];
}

/** Lines for the brief and Today: bills due or late, pay late. */
export function dueLines(items: DueItem[]): string[] {
  return items
    .filter((item) =>
      item.regular.kind === "bill"
        ? item.state === "due" || item.state === "late"
        : item.state === "late",
    )
    .map((item) =>
      item.regular.kind === "bill"
        ? `${item.regular.name} ${formatAmount(item.left)} ${item.state === "late" ? `was due ${item.date}` : "due today"}`
        : `${item.regular.job ?? item.regular.name} pay is late: ${formatAmount(item.left)} expected on ${item.date}`,
    );
}

// --- Adding and changing ----------------------------------------------------------

export interface RegularDraft {
  kind: "bill" | "pay";
  name: string;
  amount: Santim;
  ruleText: string;
  categoryId: string;
  account: string;
  areaId: string;
}

export function checkRegular(draft: RegularDraft): string | null {
  if (!draft.name.trim())
    return draft.kind === "pay" ? "Name it, like Job A pay." : "Name it, like Rent.";
  if (!Number.isSafeInteger(draft.amount) || draft.amount <= 0) return "An amount above zero.";
  if (!parseRule(draft.ruleText))
    return "When: monthly 10, monthly last, every mon, every weekday.";
  if (draft.kind === "pay" && !draft.areaId) return "Which job pays it.";
  return null;
}

export function regularOps(draft: RegularDraft, id: string, existing = false): Op[] {
  const rule = parseRule(draft.ruleText);
  return [
    {
      op: existing ? "update" : "insert",
      table: "money_regulars",
      id,
      values: {
        kind: draft.kind,
        name: draft.name.trim(),
        amount_minor: draft.amount,
        rule_json: JSON.stringify(rule),
        category_id: draft.kind === "bill" ? draft.categoryId || null : "cat_salary",
        account: draft.account,
        area_id: draft.kind === "pay" ? draft.areaId || null : null,
      },
    },
  ];
}

export function removeRegularOps(id: string): Op[] {
  return [{ op: "delete", table: "money_regulars", id }];
}

/** "Rent 6,000 · monthly on the 1st". */
export function regularText(regular: RegularRow): string {
  const rule = readRule(regular.rule_json);
  return `${formatAmount(regular.amount_minor)} · ${rule ? ruleText(rule) : "no rule"}`;
}
