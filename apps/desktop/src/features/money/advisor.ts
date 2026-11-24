/**
 * The advisor (T-064; proposal 3.1). Findings are calculated, ranked, and at
 * most two are shown a day, each with at most two buttons that write
 * through db_tx (undoable). Gemini may add a one-sentence tip from ratios and
 * names only, never birr (see MONEY in features/ai/touchpoints.ts). Pure.
 */
import { type Op } from "../../kernel/db";
import { showDate } from "../../kernel/dates";
import { formatAmount, type Santim, SANTIM_PER_BIRR } from "../../kernel/money";
import { shiftDate } from "../plan/dayplan";
import { type AccountRow, balanceOf, currencyOf, isSavings, transferOps } from "./accounts";
import { capOps, capStatus, suggestCap } from "./caps";
import { type MonthSummary } from "./money";
import { type DueItem, settleOps } from "./regulars";
import { type SafeToSpend } from "./safe";

export type FindingKind = "short" | "pay_late" | "bill_short" | "cap_over" | "pace";

export interface FindingAction {
  label: string;
  ops: Op[];
}

export interface Finding {
  /** Stable for the day, so "Not now" can hide it. */
  key: string;
  kind: FindingKind;
  /** Lower comes first. */
  rank: number;
  text: string;
  /** What the AI may see: names and ratios, never amounts of money. */
  facts: Record<string, string | number>;
  actions: FindingAction[];
}

export const SHOWN_PER_DAY = 2;
/** A bill counts as coming soon within this many days. */
export const SOON_DAYS = 3;
/** Past this share of your usual month ahead of the calendar, spending is fast. */
export const PACE_LIMIT = 1.3;

const days = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** A name for the AI, with any digits taken out so no amount can slip through. */
export const safeName = (name: string) =>
  name
    .replace(/\d+([.,]\d+)*/g, "")
    .replace(/\s+/g, " ")
    .trim() || "it";

const roundUpBirr = (minor: Santim, step = 100) =>
  Math.ceil(minor / (step * SANTIM_PER_BIRR)) * step * SANTIM_PER_BIRR;

export function findings(input: {
  safe: SafeToSpend;
  due: DueItem[];
  accounts: AccountRow[];
  caps: { id: string; name: string; cap_minor: number }[];
  /** Hidden categories: no cap buttons for them. */
  hidden?: string[];
  summary: MonthSummary;
  today: string;
  nowMs: number;
  newId: () => string;
}): Finding[] {
  const { safe, due, accounts, caps, summary, today, nowMs, newId } = input;
  const hidden = new Set(input.hidden ?? []);
  const out: Finding[] = [];

  // 1. Short this month.
  if (safe.known && safe.total < 0)
    out.push({
      key: "short",
      kind: "short",
      rank: 1,
      text: `You're ${formatAmount(-safe.total)} short this month once bills, goals and pay still to come are counted.`,
      facts: { finding: "short this month", daysLeft: safe.daysLeft },
      actions: [],
    });

  // 2. Pay that is late.
  for (const item of due.filter((d) => d.regular.kind === "pay" && d.state === "late")) {
    const late = days(item.date, today);
    out.push({
      key: `pay_late:${item.regular.id}:${item.date}`,
      kind: "pay_late",
      rank: 2,
      text: `${item.regular.job ?? item.regular.name} pay is ${late} day${late === 1 ? "" : "s"} late: ${formatAmount(item.left, item.regular.currency ?? "ETB")} still to come.`,
      facts: {
        finding: "pay late",
        job: safeName(item.regular.job ?? item.regular.name),
        daysLate: late,
        percentReceived: Math.round((item.done / item.regular.amount_minor) * 100),
      },
      actions: [{ label: "Received", ops: settleOps(item, today, nowMs, newId()) }],
    });
  }

  // 3. Bills coming soon from an account that can't cover them all.
  const soon = due.filter(
    (d) => d.regular.kind === "bill" && d.state !== "paid" && d.date <= shiftDate(today, SOON_DAYS),
  );
  for (const accountId of [...new Set(soon.map((item) => item.regular.account))]) {
    const bills = soon.filter((item) => item.regular.account === accountId);
    const from = accounts.find((account) => account.id === accountId);
    const balance = from ? balanceOf(from) : null;
    const owed = bills.reduce((sum, item) => sum + item.left, 0);
    if (!from || balance === null || balance >= owed) continue;
    const move = roundUpBirr(owed - Math.max(0, balance));
    const first = bills[0];
    if (!first) continue;
    // Amounts compare only within one currency; money comes from spending accounts.
    const currency = currencyOf(from);
    if (bills.some((item) => (item.regular.currency ?? "ETB") !== currency)) continue;
    const show = (minor: Santim) => formatAmount(minor, currency);
    const richest = accounts
      .filter(
        (account) =>
          account.id !== from.id && !isSavings(account) && currencyOf(account) === currency,
      )
      .map((account) => ({ account, balance: balanceOf(account) }))
      .filter((row): row is { account: AccountRow; balance: number } => row.balance !== null)
      .sort((a, b) => b.balance - a.balance)[0];
    const names =
      bills.length === 1
        ? `${first.regular.name} ${show(first.left)} is due ${first.date === today ? "today" : `on ${showDate(first.date, today)}`}`
        : `${bills.map((item) => item.regular.name).join(" and ")} (${show(owed)}) are due by ${showDate(bills[bills.length - 1]?.date ?? first.date, today)}`;
    out.push({
      key: `bill_short:${from.id}:${first.date}`,
      kind: "bill_short",
      rank: 3,
      text: `${names}; ${from.name} has ${show(Math.max(0, balance))}.`,
      facts: {
        finding: "bills due soon, account short",
        bills: bills.map((item) => safeName(item.regular.name)).join(", "),
        account: safeName(from.name),
        percentCovered: Math.max(0, Math.round((balance / owed) * 100)),
        daysUntilDue: Math.max(0, days(today, first.date)),
      },
      actions:
        richest && richest.balance >= move
          ? [
              {
                label: `Move ${show(move)} from ${richest.account.name}`,
                ops: transferOps({
                  from: richest.account,
                  to: from,
                  amount: move,
                  date: today,
                  nowMs,
                  ids: [newId(), newId()],
                  transferId: newId(),
                }),
              },
            ]
          : [],
    });
  }

  // 4. Over a cap, or spending fast.
  const spent = new Map(summary.categories.map((line) => [line.id, line]));
  const capped = new Set(caps.map((cap) => cap.id));
  for (const cap of caps) {
    const used = spent.get(cap.id)?.spent ?? 0;
    const status = capStatus(used, cap.cap_minor, summary.day, summary.days);
    // Today counts, as in Safe to spend: the last day has 1 day to go, not 0 (F108).
    const daysLeft = summary.days - summary.day + 1;
    if (status.over)
      out.push({
        key: `cap_over:${cap.id}`,
        kind: "cap_over",
        rank: 4,
        text: `${cap.name} is over its cap: ${formatAmount(used)} of ${formatAmount(cap.cap_minor)}, with ${daysLeft} ${daysLeft === 1 ? "day" : "days"} to go.`,
        facts: {
          finding: "over its cap",
          category: safeName(cap.name),
          percentOfCap: Math.round(status.share * 100),
          daysLeft,
        },
        actions: [
          {
            label: `Raise cap to ${formatAmount(roundUpBirr(used))}`,
            ops: capOps(cap.id, roundUpBirr(used)),
          },
        ],
      });
    else if (status.ahead)
      out.push({
        key: `pace:${cap.id}`,
        kind: "pace",
        rank: 5,
        text: `${cap.name}: ${Math.round(status.share * 100)}% of its cap with ${Math.round(status.pace * 100)}% of the month gone.`,
        facts: {
          finding: "spending fast against its cap",
          category: safeName(cap.name),
          percentOfCap: Math.round(status.share * 100),
          percentOfMonth: Math.round(status.pace * 100),
        },
        actions: [],
      });
  }
  // Uncapped categories well past their usual month at this point in it.
  for (const line of summary.categories) {
    // Uncategorized spending ("") and hidden categories can't take a cap.
    if (line.id === "" || hidden.has(line.id)) continue;
    if (capped.has(line.id) || line.usual === null || line.usual <= 0) continue;
    const share = line.spent / line.usual;
    const pace = summary.day / summary.days;
    if (share <= pace * PACE_LIMIT || line.spent - line.usual * pace < 200 * SANTIM_PER_BIRR)
      continue;
    const cap = suggestCap(line.usual);
    out.push({
      key: `pace:${line.id}`,
      kind: "pace",
      rank: 5,
      text: `${line.name}: ${formatAmount(line.spent)} so far, ${Math.round(share * 100)}% of a usual month with ${Math.round(pace * 100)}% of it gone.`,
      facts: {
        finding: "spending fast against the usual month",
        category: safeName(line.name),
        percentOfUsual: Math.round(share * 100),
        percentOfMonth: Math.round(pace * 100),
      },
      // A cap at your usual only helps while you are still under it.
      actions:
        cap && line.spent < cap
          ? [
              {
                label: `Cap ${line.name} at ${formatAmount(cap)}`,
                ops: capOps(line.id, cap, today),
              },
            ]
          : [],
    });
  }

  return out.sort((a, b) => a.rank - b.rank || a.key.localeCompare(b.key));
}

// --- What is shown today -----------------------------------------------------------

export const DISMISSED_KEY = "advisor.dismissed";

/** Keys hidden with "Not now" today (the setting holds one day). */
export function dismissedToday(valueJson: string | null | undefined, today: string): string[] {
  try {
    const value = JSON.parse(valueJson ?? "null") as { date?: unknown; keys?: unknown } | null;
    if (value?.date === today && Array.isArray(value.keys))
      return value.keys.filter((key): key is string => typeof key === "string");
  } catch {
    return [];
  }
  return [];
}

export function dismissOps(valueJson: string | null | undefined, today: string, key: string): Op[] {
  const keys = [...new Set([...dismissedToday(valueJson, today), key])];
  return [
    {
      op: "upsert",
      table: "core_settings",
      id: DISMISSED_KEY,
      values: { value_json: JSON.stringify({ date: today, keys }) },
    },
  ];
}

/** The top findings not hidden today, at most two. */
export function shownToday(all: Finding[], hidden: string[]): Finding[] {
  return all.filter((finding) => !hidden.includes(finding.key)).slice(0, SHOWN_PER_DAY);
}

// --- AI tips, asked once a day per finding ---------------------------------------------

export const TIPS_KEY = "advisor.tips";
const NAME_FACTS = ["job", "bill", "bills", "account", "category"];

/** In strict mode the AI sees what kind of finding it is and the ratios, never names. */
export function tipFacts(facts: Record<string, string | number>, strict: boolean) {
  return strict
    ? Object.fromEntries(Object.entries(facts).filter(([key]) => !NAME_FACTS.includes(key)))
    : facts;
}

/** Today's tips by finding key ("" = asked, no usable tip: don't ask again today). */
export function tipsToday(
  valueJson: string | null | undefined,
  today: string,
): Record<string, string> {
  try {
    const value = JSON.parse(valueJson ?? "null") as { date?: unknown; byKey?: unknown } | null;
    if (value?.date === today && value.byKey && typeof value.byKey === "object")
      return Object.fromEntries(
        Object.entries(value.byKey as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
  } catch {
    return {};
  }
  return {};
}

export function tipOps(
  valueJson: string | null | undefined,
  today: string,
  key: string,
  tip: string,
): Op[] {
  const byKey = { ...tipsToday(valueJson, today), [key]: tip };
  return [
    {
      op: "upsert",
      table: "core_settings",
      id: TIPS_KEY,
      values: { value_json: JSON.stringify({ date: today, byKey }) },
    },
  ];
}
