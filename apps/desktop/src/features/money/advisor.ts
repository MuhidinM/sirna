/**
 * The advisor (T-064; proposal 3.1). Findings are calculated, ranked, and at
 * most two are shown a day, each with at most two buttons that write
 * through db_tx (undoable). Gemini may add a one-sentence tip from ratios and
 * names only, never birr (see MONEY in features/ai/touchpoints.ts). Pure.
 */
import { type Op } from "../../kernel/db";
import { formatAmount, type Santim, SANTIM_PER_BIRR } from "../../kernel/money";
import { shiftDate } from "../plan/dayplan";
import { type AccountRow, balanceOf, transferOps } from "./accounts";
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

const roundUpBirr = (minor: Santim, step = 100) =>
  Math.ceil(minor / (step * SANTIM_PER_BIRR)) * step * SANTIM_PER_BIRR;

export function findings(input: {
  safe: SafeToSpend;
  due: DueItem[];
  accounts: AccountRow[];
  caps: { id: string; name: string; cap_minor: number }[];
  summary: MonthSummary;
  today: string;
  nowMs: number;
  newId: () => string;
}): Finding[] {
  const { safe, due, accounts, caps, summary, today, nowMs, newId } = input;
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
      text: `${item.regular.job ?? item.regular.name} pay is ${late} day${late === 1 ? "" : "s"} late: ${formatAmount(item.left)} still to come.`,
      facts: {
        finding: "pay late",
        job: item.regular.job ?? item.regular.name,
        daysLate: late,
        percentReceived: Math.round((item.done / item.regular.amount_minor) * 100),
      },
      actions: [{ label: "Received", ops: settleOps(item, today, nowMs, newId()) }],
    });
  }

  // 3. A bill coming soon from an account that can't cover it.
  for (const item of due.filter(
    (d) => d.regular.kind === "bill" && d.state !== "paid" && d.date <= shiftDate(today, SOON_DAYS),
  )) {
    const from = accounts.find((account) => account.id === item.regular.account);
    const balance = from ? balanceOf(from) : null;
    if (!from || balance === null || balance >= item.left) continue;
    const short = item.left - Math.max(0, balance);
    const move = roundUpBirr(short);
    const richest = accounts
      .filter((account) => account.id !== from.id)
      .map((account) => ({ account, balance: balanceOf(account) }))
      .filter((row): row is { account: AccountRow; balance: number } => row.balance !== null)
      .sort((a, b) => b.balance - a.balance)[0];
    out.push({
      key: `bill_short:${item.regular.id}:${item.date}`,
      kind: "bill_short",
      rank: 3,
      text: `${item.regular.name} ${formatAmount(item.left)} is due ${item.date === today ? "today" : `on ${item.date}`}; ${from.name} has ${formatAmount(Math.max(0, balance))}.`,
      facts: {
        finding: "bill due soon, account short",
        bill: item.regular.name,
        account: from.name,
        percentCovered: Math.max(0, Math.round((balance / item.left) * 100)),
        daysUntilDue: Math.max(0, days(today, item.date)),
      },
      actions:
        richest && richest.balance >= move
          ? [
              {
                label: `Move ${formatAmount(move)} from ${richest.account.name}`,
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
    if (status.over)
      out.push({
        key: `cap_over:${cap.id}`,
        kind: "cap_over",
        rank: 4,
        text: `${cap.name} is over its cap: ${formatAmount(used)} of ${formatAmount(cap.cap_minor)}, with ${summary.days - summary.day} days to go.`,
        facts: {
          finding: "over its cap",
          category: cap.name,
          percentOfCap: Math.round(status.share * 100),
          daysLeft: summary.days - summary.day,
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
          category: cap.name,
          percentOfCap: Math.round(status.share * 100),
          percentOfMonth: Math.round(status.pace * 100),
        },
        actions: [],
      });
  }
  // Uncapped categories well past their usual month at this point in it.
  for (const line of summary.categories) {
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
        category: line.name,
        percentOfUsual: Math.round(share * 100),
        percentOfMonth: Math.round(pace * 100),
      },
      actions: cap
        ? [{ label: `Cap ${line.name} at ${formatAmount(cap)}`, ops: capOps(line.id, cap) }]
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
