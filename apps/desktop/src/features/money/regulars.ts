/**
 * Regulars (T-059, T-060; proposal 2.2-2.4): bills you pay (rent, internet,
 * iddir) and pay you expect from each job, on one repeat rule. Nothing posts
 * by itself: Paid or Received records the entry, marked with the regular and
 * the date it was due. Pure and tested, integer santim, logical dates.
 */
import { type Op } from "../../kernel/db";
import { logicalDate, showDate } from "../../kernel/dates";
import { formatAmount, type Santim } from "../../kernel/money";
import { shiftDate } from "../plan/dayplan";
import { monthOf, previousMonthStart } from "./money";
import { rowCurrencySql } from "./currency";

// --- The repeat rule ------------------------------------------------------------

/** Monthly on a day (31 means the last day in short months), or weekly on ISO weekdays. */
export type Rule = { every: "month"; day: number } | { every: "week"; days: number[] };

const DAY_NAMES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_WORD =
  /^(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)s?$/;

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
  if (/^(?:daily|every ?day)$/.test(t)) return { every: "week", days: [1, 2, 3, 4, 5, 6, 7] };
  const weekly = /^(?:every|weekly)(?: on)? (.+)$/.exec(t);
  if (weekly?.[1]) {
    const days = weekly[1]
      .split(/\s*(?:,|and)\s*|\s+/)
      .filter(Boolean)
      // A day name or its short form only: "every month" is not Monday.
      .map((word) =>
        DAY_WORD.test(word) ? DAY_NAMES.findIndex((name) => word.startsWith(name)) + 1 : 0,
      );
    if (days.length > 0 && days.every((day) => day > 0))
      return { every: "week", days: [...new Set(days)].sort((a, b) => a - b) };
  }
  return null;
}

export function ruleText(rule: Rule): string {
  if (rule.every === "month") {
    // Reads back with parseRule, so a form can show it and save it again.
    if (rule.day >= 31) return "monthly last";
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

/**
 * Dates you skipped (F29): kept in rule_json next to the rule, as
 * `{"every":"month","day":24,"skip":["2026-10-24"]}`. readRule ignores them.
 */
export function readSkips(json: string): string[] {
  try {
    const value = JSON.parse(json) as { skip?: unknown };
    return Array.isArray(value.skip)
      ? value.skip.filter((date): date is string => typeof date === "string")
      : [];
  } catch {
    return [];
  }
}

/** The rule with its skipped dates, as rule_json stores it; none older than `keepFrom`. */
function ruleJson(rule: Rule | null, skips: string[], keepFrom: string): string {
  const kept = [...new Set(skips.filter((date) => date >= keepFrom))].sort();
  return JSON.stringify(rule && kept.length > 0 ? { ...rule, skip: kept } : rule);
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
  /** Its account's currency; ETB when not given. */
  currency?: string | null;
}

export const REGULARS_SQL = `
  SELECT r.id, r.kind, r.name, r.amount_minor, r.rule_json, r.category_id, r.account,
         r.area_id, r.active, a.name AS job, r.created_at,
         ${rowCurrencySql("r")} AS currency
  FROM money_regulars r
  LEFT JOIN area_items a ON a.id = r.area_id
  LEFT JOIN money_accounts acc ON acc.id = r.account
  WHERE r.deleted_at IS NULL
  ORDER BY r.kind DESC, r.name`;

/**
 * Entries that can settle a regular between ?1 and ?2: the ones marked with
 * it, and the rest of your income and spending (pay you captured as
 * `got 18k job a`, rent you captured as `paid rent 6000`). Transfers and
 * loans never settle anything.
 */
export const REGULAR_TXNS_SQL = `
  SELECT t.regular_id, t.due_date, t.area_id, t.amount_minor, t.local_date, t.description,
         t.category_id, ${rowCurrencySql("t")} AS currency
  FROM money_txns t
  LEFT JOIN money_accounts acc ON acc.id = t.account
  WHERE t.deleted_at IS NULL AND t.transfer_id IS NULL
    AND ((t.regular_id IS NOT NULL AND t.due_date >= ?1 AND t.due_date <= ?2)
      OR (t.regular_id IS NULL AND t.local_date >= ?1 AND t.local_date <= ?2))
  ORDER BY t.local_date, t.rowid`;

export interface RegularTxn {
  regular_id: string | null;
  due_date: string | null;
  area_id: string | null;
  amount_minor: number;
  local_date: string;
  description?: string | null;
  category_id?: string | null;
  /** The entry's currency; ETB when not given. */
  currency?: string | null;
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
/** Money that comes or goes up to this many days early still counts for the date. */
export const EARLY_DAYS = 7;
/**
 * An unpaid bill or pay stays on the list until you pay it or skip it,
 * whatever its day of the month (F84): dates are worked out this far back,
 * a year, and never before you added the regular. A month was too short:
 * an unpaid bill went with no notice.
 */
export const LATE_KEEP_DAYS = 366;
/**
 * Late pay stays this many days, as before: pay that never came is not money
 * to count on, and Safe to spend adds every late item's `left`, so a year of
 * missed pay would count as coming this month.
 */
export const LATE_PAY_KEEP_DAYS = 31;

/**
 * The dates to work out a month: occurrences from the start of last month
 * (so a late payment settles last month's date, not this month's), or
 * LATE_KEEP_DAYS back if that is earlier; entries from a week before that
 * (so an early payment for the first one counts), to the month's end. Only
 * items from `shownFrom`, or still open within LATE_KEEP_DAYS of today
 * (LATE_PAY_KEEP_DAYS for pay), are shown.
 */
export function dueWindow(today: string): {
  from: string;
  txnFrom: string;
  to: string;
  shownFrom: string;
} {
  const { from, to } = monthOf(today);
  const lastMonth = previousMonthStart(from);
  const keep = shiftDate(today, -LATE_KEEP_DAYS);
  const occurrencesFrom = keep < lastMonth ? keep : lastMonth;
  // On a month's last day, tomorrow too: the evening bill toast names it and opens this page.
  const tomorrow = shiftDate(today, 1);
  return {
    from: occurrencesFrom,
    txnFrom: shiftDate(occurrencesFrom, -EARLY_DAYS),
    to: tomorrow > to ? tomorrow : to,
    shownFrom: from,
  };
}

/** An expense you typed that is this bill: its name in the words, or its category and amount. */
export function paysBill(
  regular: Pick<RegularRow, "name" | "category_id" | "amount_minor">,
  txn: Pick<RegularTxn, "amount_minor" | "description" | "category_id">,
): boolean {
  if (txn.amount_minor >= 0) return false;
  const name = regular.name.trim().toLowerCase();
  const words = (txn.description ?? "").trim().toLowerCase();
  if (name && words && (words.includes(name) || name.includes(words))) return true;
  return (
    regular.category_id !== null &&
    txn.category_id === regular.category_id &&
    -txn.amount_minor === regular.amount_minor
  );
}

/** Compares by Unicode code points, as Rust compares strings (not UTF-16 units, not locale). */
export function compareCodePoints(x: string, y: string): number {
  const a = Array.from(x, (c) => c.codePointAt(0) ?? 0);
  const b = Array.from(y, (c) => c.codePointAt(0) ?? 0);
  for (let i = 0; i < Math.min(a.length, b.length); i++)
    if (a[i] !== b[i]) return (a[i] ?? 0) - (b[i] ?? 0);
  return a.length - b.length;
}

/** Same-day order, shared with bills.rs: name ignoring case, then exactly, then id. */
function compareRegulars(a: RegularRow, b: RegularRow): number {
  return (
    compareCodePoints(a.name.toLowerCase(), b.name.toLowerCase()) ||
    compareCodePoints(a.name, b.name) ||
    compareCodePoints(a.id, b.id)
  );
}

const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/**
 * Each occurrence from `from` to `to` and where it stands. Entries marked
 * with a regular settle that occurrence. Any other entry that fits (pay:
 * income from that job; bills: spending that names the bill or matches its
 * category and amount) counts for each regular's due date nearest to it, from
 * EARLY_DAYS before it until that regular's next date; between regulars, a
 * bill named exactly goes first, then the oldest date. What is left over
 * (catching up) goes to the oldest open date it could pay. So pay that comes late settles last
 * month's date, rent paid a few days early counts for the coming date, and
 * a month you never recorded doesn't take the next month's payment. Dates
 * up to EARLY_DAYS after `to` are worked out too, so an early payment at the
 * end of a month counts the same on every day. Items before `shownFrom` are
 * kept only while still open and within LATE_KEEP_DAYS of today (pay:
 * LATE_PAY_KEEP_DAYS). Dates you
 * skipped are left out: they neither show nor take a payment.
 */
export function dueItems(
  regulars: RegularRow[],
  txns: RegularTxn[],
  from: string,
  to: string,
  today: string,
  shownFrom: string = from,
): DueItem[] {
  type Work = DueItem & { next: string | null };
  const items: Work[] = [];
  const until = shiftDate(to, EARLY_DAYS);
  for (const regular of regulars) {
    if (regular.active !== 1) continue;
    const rule = readRule(regular.rule_json);
    if (!rule) continue;
    // Occurrences before you added it are not yours to settle now.
    const since = regular.created_at > 0 ? logicalDate(regular.created_at) : from;
    const skipped = new Set(readSkips(regular.rule_json));
    const dates = occurrences(rule, from > since ? from : since, until).filter(
      (date) => !skipped.has(date),
    );
    dates.forEach((date, index) => {
      const done = txns
        .filter((txn) => txn.regular_id === regular.id && txn.due_date === date)
        .reduce((sum, txn) => sum + Math.abs(txn.amount_minor), 0);
      items.push({
        regular,
        date,
        state: "upcoming",
        done,
        left: 0,
        next: dates[index + 1] ?? null,
      });
    });
  }
  items.sort((a, b) => compareCodePoints(a.date, b.date) || compareRegulars(a.regular, b.regular));
  const open = (item: DueItem) => Math.max(0, item.regular.amount_minor - item.done);

  const free = txns
    .filter((txn) => txn.regular_id === null)
    .sort((a, b) => compareCodePoints(a.local_date, b.local_date));
  for (const txn of free) {
    const day = txn.local_date;
    // Only money in the regular's own currency settles it: 15 birr is not $15.
    const fits = (item: Work) =>
      (txn.currency ?? "ETB") === (item.regular.currency ?? "ETB") &&
      shiftDate(item.date, -EARLY_DAYS) <= day &&
      (item.regular.kind === "pay"
        ? txn.amount_minor > 0 &&
          item.regular.area_id !== null &&
          txn.area_id === item.regular.area_id
        : paysBill(item.regular, txn));
    const candidates = items.filter(fits);
    // Each regular's own date for it: the nearest one, up to that regular's next date.
    const distance = (item: Work) => Math.abs(daysBetween(day, item.date));
    const own = new Map<string, Work>();
    for (const item of candidates) {
      if (item.next !== null && day >= item.next) continue;
      const best = own.get(item.regular.id);
      if (!best || distance(item) < distance(best)) own.set(item.regular.id, item);
    }
    // Between regulars: a bill named exactly, then the oldest date (so the 10th's
    // late pay isn't taken by the 21st). Anything left catches up the oldest open dates.
    const words = (txn.description ?? "").trim().toLowerCase();
    const named = (item: Work) =>
      item.regular.kind === "bill" &&
      words !== "" &&
      item.regular.name.trim().toLowerCase() === words;
    const first = [...own.values()].sort(
      (x, y) =>
        Number(named(y)) - Number(named(x)) ||
        compareCodePoints(x.date, y.date) ||
        compareRegulars(x.regular, y.regular),
    );
    const order = [...first, ...candidates.filter((item) => !first.includes(item))];
    let amount = Math.abs(txn.amount_minor);
    for (const item of order) {
      if (amount === 0) break;
      const take = Math.min(open(item), amount);
      item.done += take;
      amount -= take;
    }
  }

  return items
    .filter((item) => item.date <= to)
    .map(({ next: _next, ...item }) => {
      const left = open(item);
      const grace = item.regular.kind === "pay" ? PAY_GRACE_DAYS : 0;
      const state: DueState =
        left === 0
          ? "paid"
          : today > shiftDate(item.date, grace)
            ? "late"
            : today >= item.date
              ? "due"
              : "upcoming";
      return { ...item, left, state };
    })
    .filter(
      (item) =>
        item.date >= shownFrom ||
        (item.state !== "paid" &&
          item.date >=
            shiftDate(today, -(item.regular.kind === "pay" ? LATE_PAY_KEEP_DAYS : LATE_KEEP_DAYS))),
    );
}

/**
 * The entry Paid or Received records: the full amount left, marked with the
 * regular. Dated today, or its own date when that was in an earlier month,
 * so October's bill paid late counts in October, not in November's spending
 * (but not before the account's opening date).
 */
export function settleOps(
  item: DueItem,
  today: string,
  nowMs: number,
  id: string,
  /** The account's opening date: a balance counts only entries from then on. */
  openingDate?: string | null,
): Op[] {
  const out = item.regular.kind === "bill";
  // A date from an earlier month is booked on that date, so it stays in its
  // month, but never before the account's opening date: a balance typed since
  // would leave it out, and money that really moved would not show.
  const date =
    item.date.slice(0, 7) >= today.slice(0, 7)
      ? today
      : openingDate && openingDate > item.date
        ? openingDate < today
          ? openingDate
          : today
        : item.date;
  return [
    {
      op: "insert",
      table: "money_txns",
      id,
      values: {
        account: item.regular.account,
        occurred_at: nowMs,
        local_date: date,
        amount_minor: out ? -item.left : item.left,
        description: item.regular.name,
        category_id: item.regular.category_id ?? (out ? null : "cat_salary"),
        area_id: item.regular.area_id,
        origin: "regular",
        regular_id: item.regular.id,
        due_date: item.date,
        ...(item.regular.currency ? { currency: item.regular.currency } : {}),
      },
    },
  ];
}

/** Lines for the brief and Today: bills due or late, pay late. */
export function dueLines(items: DueItem[], today?: string): string[] {
  return items
    .filter((item) =>
      item.regular.kind === "bill"
        ? item.state === "due" || item.state === "late"
        : item.state === "late",
    )
    .map((item) => {
      const left = formatAmount(item.left, item.regular.currency ?? "ETB");
      return item.regular.kind === "bill"
        ? `${item.regular.name} ${left} ${item.state === "late" ? `was due ${showDate(item.date, today)}` : "due today"}`
        : `${item.regular.job ?? item.regular.name} pay is late: ${left} expected on ${showDate(item.date, today)}`;
    });
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
  /** The account's currency, kept with the regular. */
  currency?: string;
  /** Dates already skipped, kept when you change it. */
  skip?: string[];
}

/** A form's draft for a regular you have, to change it. */
export function regularDraftOf(regular: RegularRow): RegularDraft {
  const rule = readRule(regular.rule_json);
  return {
    kind: regular.kind,
    name: regular.name,
    amount: regular.amount_minor,
    ruleText: rule ? ruleText(rule) : "",
    categoryId: regular.category_id ?? "",
    account: regular.account,
    areaId: regular.area_id ?? "",
    ...(regular.currency ? { currency: regular.currency } : {}),
    skip: readSkips(regular.rule_json),
  };
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
        rule_json: ruleJson(rule, draft.skip ?? [], ""),
        category_id: draft.kind === "bill" ? draft.categoryId || null : "cat_salary",
        account: draft.account,
        area_id: draft.kind === "pay" ? draft.areaId || null : null,
        ...(draft.currency ? { currency: draft.currency } : {}),
      },
    },
  ];
}

export function removeRegularOps(id: string): Op[] {
  return [{ op: "delete", table: "money_regulars", id }];
}

/**
 * Skip one date (F29): it stops showing and asking, and nothing is recorded.
 * Skips older than the list ever shows are dropped, so the rule stays small.
 */
export function skipOps(item: DueItem, today: string): Op[] {
  const rule = readRule(item.regular.rule_json);
  const skips = [...readSkips(item.regular.rule_json), item.date];
  return [
    {
      op: "update",
      table: "money_regulars",
      id: item.regular.id,
      values: { rule_json: ruleJson(rule, skips, shiftDate(today, -2 * LATE_KEEP_DAYS)) },
    },
  ];
}

/** Pause a regular (it stops showing) or start it again. */
export function pauseOps(regular: Pick<RegularRow, "id" | "active">): Op[] {
  return [
    {
      op: "update",
      table: "money_regulars",
      id: regular.id,
      values: { active: regular.active === 1 ? 0 : 1 },
    },
  ];
}

/** "Rent 6,000 · monthly on the 1st". */
export function regularText(regular: RegularRow): string {
  const rule = readRule(regular.rule_json);
  return `${formatAmount(regular.amount_minor, regular.currency ?? "ETB")} · ${rule ? ruleText(rule) : "no rule"}`;
}
