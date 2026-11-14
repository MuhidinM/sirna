/**
 * The Money page (proposal 1.1-1.2; R-MON-01): the month at a glance and the
 * ledger. Pure: SQL text plus functions over rows, all in integer santim.
 * Spending is negative in money_txns, income positive (0005_money.sql).
 */
import { type Op } from "../../kernel/db";
import { formatAmount, type Santim, SANTIM_PER_BIRR } from "../../kernel/money";
import { shiftDate } from "../plan/dayplan";

/** The calendar month a logical date is in, as inclusive dates. */
export function monthOf(date: string): { from: string; to: string; days: number; key: string } {
  const [y = 0, m = 1] = date.split("-").map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const key = `${y}-${String(m).padStart(2, "0")}`;
  return { from: `${key}-01`, to: `${key}-${String(days).padStart(2, "0")}`, days, key };
}

/** The month before, as "YYYY-MM-01". */
export function previousMonthStart(date: string): string {
  return monthOf(shiftDate(monthOf(date).from, -1)).from;
}

export function monthLabel(key: string): string {
  const [y = 0, m = 1] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(Date.UTC(y, m - 1, 1));
}

// --- The month ------------------------------------------------------------------

export interface TxnRow {
  id: string;
  local_date: string;
  occurred_at: number;
  amount_minor: number;
  description: string;
  category_id: string | null;
  category: string | null;
  account: string;
  origin: string | null;
  /** The job income came from, when named. */
  source?: string | null;
}

/** Entries between ?1 and ?2 (inclusive dates), newest first. */
export const TXNS_SQL = `
  SELECT m.id, m.local_date, m.occurred_at, m.amount_minor, m.description, m.category_id,
         c.name AS category, m.account, m.origin, a.name AS source
  FROM money_txns m
  LEFT JOIN money_categories c ON c.id = m.category_id
  LEFT JOIN area_items a ON a.id = m.area_id
  WHERE m.deleted_at IS NULL AND m.local_date >= ?1 AND m.local_date <= ?2
  ORDER BY m.local_date DESC, m.occurred_at DESC`;

/** Money put aside (+) or taken out (−) of goals between ?1 and ?2. */
export const SAVED_SQL = `SELECT COALESCE(sum(amount_minor), 0) AS minor FROM savings_entries
  WHERE deleted_at IS NULL AND local_date >= ?1 AND local_date <= ?2`;

/**
 * Spending per category per month for the 3 months before this one, and
 * which of those months have any entry at all. ?1 = first day 3 months back,
 * ?2 = first day of this month.
 */
export const HISTORY_SQL = `
  SELECT substr(m.local_date, 1, 7) AS month, m.category_id,
         COALESCE(sum(CASE WHEN m.amount_minor < 0 THEN -m.amount_minor END), 0) AS out_minor
  FROM money_txns m
  WHERE m.deleted_at IS NULL AND m.local_date >= ?1 AND m.local_date < ?2
  GROUP BY month, m.category_id`;

export interface HistoryRow {
  month: string;
  category_id: string | null;
  out_minor: number;
}

export function historyParams(today: string): [string, string] {
  const start = monthOf(today).from;
  let from = start;
  for (let i = 0; i < 3; i++) from = previousMonthStart(from);
  return [from, start];
}

/** The middle value (lower middle for an even count), or null for none. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? null;
}

/**
 * Your usual monthly spending per category: the median over the earlier
 * months that have any entry (a month you spent nothing in a category counts
 * as 0 there). Null when there is no earlier month yet.
 */
export function usualByCategory(history: HistoryRow[]): Map<string, number | null> {
  const months = [...new Set(history.map((row) => row.month))];
  const categories = new Set(history.map((row) => row.category_id ?? ""));
  const usual = new Map<string, number | null>();
  for (const category of categories) {
    const values = months.map(
      (month) =>
        history.find((row) => row.month === month && (row.category_id ?? "") === category)
          ?.out_minor ?? 0,
    );
    usual.set(category, median(values));
  }
  return usual;
}

export interface CategoryLine {
  id: string;
  name: string;
  spent: Santim;
  usual: Santim | null;
}

export interface SourceLine {
  name: string;
  amount: Santim;
}

export interface MonthSummary {
  in: Santim;
  out: Santim;
  /** Put into goals this month, net of what was taken out. */
  saved: Santim;
  /** In − Out − Saved: what is left of this month's money. */
  left: Santim;
  sources: SourceLine[];
  categories: CategoryLine[];
  /** Day of the month (1-based) and how many days it has. */
  day: number;
  days: number;
  /** About how much a day is left to spend, rounded down; null when nothing is left. */
  perDay: Santim | null;
}

export function monthSummary(input: {
  txns: TxnRow[];
  saved: Santim;
  history: HistoryRow[];
  today: string;
}): MonthSummary {
  const { days } = monthOf(input.today);
  const day = Number(input.today.slice(8, 10));
  let income = 0;
  let out = 0;
  const sources = new Map<string, Santim>();
  const spent = new Map<string, { name: string; amount: Santim }>();
  for (const txn of input.txns) {
    if (txn.amount_minor > 0) {
      income += txn.amount_minor;
      // By job when the capture named one (`got 18k job a`), else by category.
      const name = txn.source ?? txn.category ?? "Other income";
      sources.set(name, (sources.get(name) ?? 0) + txn.amount_minor);
    } else {
      out += -txn.amount_minor;
      const id = txn.category_id ?? "";
      const line = spent.get(id) ?? { name: txn.category ?? "Other", amount: 0 };
      line.amount += -txn.amount_minor;
      spent.set(id, line);
    }
  }
  const usual = usualByCategory(input.history);
  const categories: CategoryLine[] = [...spent.entries()].map(([id, line]) => ({
    id,
    name: line.name,
    spent: line.amount,
    usual: usual.get(id) ?? (usual.size > 0 ? 0 : null),
  }));
  categories.sort((a, b) => b.spent - a.spent || a.name.localeCompare(b.name));
  const left = income - out - input.saved;
  const daysLeft = days - day + 1;
  return {
    in: income,
    out,
    saved: input.saved,
    left,
    sources: [...sources.entries()]
      .map(([name, amount]) => ({ name, amount }))
      .sort((a, b) => b.amount - a.amount),
    categories,
    day,
    days,
    // Rounded down to whole birr: never more than there is.
    perDay: left > 0 ? Math.floor(left / daysLeft / SANTIM_PER_BIRR) * SANTIM_PER_BIRR : null,
  };
}

/** "Spent 340 today · 12,400 left this month · about 740 a day". */
export function moneyLine(summary: MonthSummary, spentToday: Santim): string {
  const short = (minor: Santim) => formatAmount(minor).replace(/ ETB$/, "");
  const parts = [`Spent ${short(spentToday)} today`];
  if (summary.in > 0 || summary.out > 0)
    parts.push(
      summary.left >= 0
        ? `${short(summary.left)} left this month`
        : `${short(-summary.left)} over this month`,
    );
  if (summary.perDay !== null) parts.push(`about ${short(summary.perDay)} a day`);
  return parts.join(" · ");
}

// --- The ledger -----------------------------------------------------------------

export interface LedgerFilter {
  text: string;
  categoryId: string;
  kind: "" | "in" | "out";
}

export function filterLedger(rows: TxnRow[], filter: LedgerFilter): TxnRow[] {
  const words = filter.text.toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((row) => {
    if (filter.kind === "in" && row.amount_minor <= 0) return false;
    if (filter.kind === "out" && row.amount_minor >= 0) return false;
    if (filter.categoryId && (row.category_id ?? "") !== filter.categoryId) return false;
    const hay = `${row.description} ${row.category ?? ""}`.toLowerCase();
    return words.every((word) => hay.includes(word));
  });
}

/** Rows grouped by date, newest day first, keeping the rows' order inside a day. */
export function byDay(rows: TxnRow[]): { date: string; rows: TxnRow[]; net: Santim }[] {
  const days: { date: string; rows: TxnRow[]; net: Santim }[] = [];
  for (const row of rows) {
    let day = days.find((d) => d.date === row.local_date);
    if (!day) {
      day = { date: row.local_date, rows: [], net: 0 };
      days.push(day);
    }
    day.rows.push(row);
    day.net += row.amount_minor;
  }
  return days.sort((a, b) => b.date.localeCompare(a.date));
}

export interface TxnDraft {
  kind: "in" | "out";
  /** Positive santim. */
  amount: Santim;
  description: string;
  categoryId: string;
  date: string;
}

export function checkTxn(draft: TxnDraft): string | null {
  if (!Number.isSafeInteger(draft.amount) || draft.amount <= 0) return "An amount above zero.";
  if (!draft.description.trim()) return "A short description.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date)) return "A date like 2026-11-14.";
  return null;
}

/** Learned categories for the capture box: description (lowercase) → category. */
export const LEARNED_SQL = "SELECT id, category_id FROM money_learned WHERE deleted_at IS NULL";

export const learnKey = (description: string) => description.trim().toLowerCase();

/**
 * The update for an edited entry: the sign follows in or out. A new category
 * is remembered for that description, so the next capture gets it right.
 */
export function txnEditOps(row: TxnRow, draft: TxnDraft): Op[] {
  const learned: Op[] =
    draft.categoryId && draft.categoryId !== (row.category_id ?? "")
      ? [
          {
            op: "upsert",
            table: "money_learned",
            id: learnKey(draft.description),
            values: { category_id: draft.categoryId },
          },
        ]
      : [];
  return [
    ...learned,
    {
      op: "update",
      table: "money_txns",
      id: row.id,
      values: {
        amount_minor: draft.kind === "out" ? -draft.amount : draft.amount,
        description: draft.description.trim(),
        category_id: draft.categoryId || null,
        local_date: draft.date,
      },
    },
  ];
}

export function txnDeleteOps(row: TxnRow): Op[] {
  return [{ op: "delete", table: "money_txns", id: row.id }];
}

/** Puts a deleted entry back as it was (an upsert revives a soft-deleted row). */
export function txnRestoreOps(row: TxnRow): Op[] {
  return [
    {
      op: "upsert",
      table: "money_txns",
      id: row.id,
      values: {
        amount_minor: row.amount_minor,
        description: row.description,
        category_id: row.category_id,
        local_date: row.local_date,
        occurred_at: row.occurred_at,
        account: row.account,
        origin: row.origin,
      },
    },
  ];
}

const csvCell = (value: string) =>
  /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

/** The ledger as CSV, oldest first: amounts in birr with two decimals. */
export function toCsv(rows: TxnRow[]): string {
  const lines = ["date,kind,amount_etb,category,description,account"];
  for (const row of [...rows].sort(
    (a, b) => a.local_date.localeCompare(b.local_date) || a.occurred_at - b.occurred_at,
  )) {
    const abs = Math.abs(row.amount_minor);
    const birr = `${Math.floor(abs / SANTIM_PER_BIRR)}.${String(abs % SANTIM_PER_BIRR).padStart(2, "0")}`;
    lines.push(
      [
        row.local_date,
        row.amount_minor > 0 ? "in" : "out",
        birr,
        csvCell(row.category ?? ""),
        csvCell(row.description),
        csvCell(row.account),
      ].join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

export const CATEGORIES_SQL = `SELECT id, name, kind FROM money_categories
  WHERE deleted_at IS NULL ORDER BY kind DESC, name`;

/** A new entry typed on the Money page (not the capture box). */
export function txnAddOps(draft: TxnDraft, nowMs: number, id: string): Op[] {
  return [
    {
      op: "insert",
      table: "money_txns",
      id,
      values: {
        occurred_at: nowMs,
        local_date: draft.date,
        amount_minor: draft.kind === "out" ? -draft.amount : draft.amount,
        description: draft.description.trim(),
        category_id: draft.categoryId || null,
        origin: "money",
      },
    },
  ];
}
