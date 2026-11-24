import "../theme/pages/money.css";

import { type ReactNode, useEffect, useRef, useState } from "react";

import { systemClock } from "../kernel/clock";
import { logicalDate, showDate } from "../kernel/dates";
import { type Op, query, transact } from "../kernel/db";
import { CURRENCIES, formatAmount, formatNumber, parseAmount } from "../kernel/money";
import { ulid } from "../kernel/ulid";
import {
  byDay,
  CATEGORIES_SQL,
  checkTxn,
  csvName,
  filterLedger,
  HISTORY_SQL,
  historyInEtb,
  type HistoryRow,
  historyParams,
  type LedgerFilter,
  monthLabel,
  monthOf,
  moneyLine,
  type MonthSummary,
  monthSummary,
  previousMonthStart,
  SAVED_SQL,
  toCsv,
  txnAddOps,
  txnDeleteOps,
  type TxnDraft,
  txnEditOps,
  txnRestoreOps,
  type TxnRow,
  TXNS_SQL,
  usualByCategory,
} from "../features/money/money";
import { shiftDate } from "../features/plan/dayplan";
import {
  ACCOUNT_TXN_COUNT_SQL,
  type AccountRow,
  ACCOUNTS_SQL,
  addAccountOps,
  balanceOf,
  checkAccountName,
  checkCurrency,
  checkHide,
  checkPayAccount,
  checkSavings,
  checkTransfer,
  currencyOf,
  currencyOps,
  DAY_MOVED_SQL,
  hideAccountOps,
  inEtb,
  isSavings,
  payAccount,
  reconcileOps,
  reconcileText,
  renameAccountOps,
  SAVINGS_SINCE_SQL,
  savingsOps,
  setPayAccountOps,
  spendAccount,
  spending,
  totalBalance,
  transferAmounts,
  transferOps,
} from "../features/money/accounts";
import {
  approxMark,
  checkRate,
  conversionNotes,
  type ConversionNotes,
  newConversion,
  type Rates,
  RATES_SQL,
  rateOps,
  readRates,
  sumInEtb,
  switchCurrency,
  syncRateBox,
} from "../features/money/currency";
import {
  checkRegular,
  regularDraftOf,
  type DueItem,
  dueItems,
  dueLines,
  dueWindow,
  pauseOps,
  type RegularDraft,
  regularOps,
  type RegularRow,
  REGULARS_SQL,
  regularText,
  REGULAR_TXNS_SQL,
  type RegularTxn,
  removeRegularOps,
  settleOps,
  skipOps,
} from "../features/money/regulars";
import {
  balances,
  checkLoan,
  checkRepayment,
  LOAN_SQL,
  loanIdOf,
  loanRestoreOps,
  personFollowUpOps,
  type LoanEvent,
  loanEchoText,
  loanOps,
  LOANS_SQL,
  type PersonBalance,
} from "../features/money/loans";
import {
  EMERGENCY_MONTHS,
  EMERGENCY_TITLE,
  emergencyTarget,
  essentialMonth,
  GOAL_MONTH_SQL,
  isEmergency,
  monthsCovered,
  safeLine,
  safeToSpend,
} from "../features/money/safe";
import {
  addGoalOps,
  GOAL_HELD_SQL,
  type GoalHeld,
  type GoalRow,
  GOALS_SQL,
  transferGoal,
  transferSaving,
  transferSavingOps,
  UNASSIGNED_SQL,
  UNHELD,
} from "../features/savings/savings";
import {
  addCategoryOps,
  ALL_CATEGORIES_SQL,
  CATEGORY_TEMPLATES_SQL,
  CATEGORY_TXNS_SQL,
  type CategoryRow,
  checkCategoryName,
  hideCategoryOps,
  mergeCategoryOps,
  renameCategoryOps,
} from "../features/money/categories";
import { acceptAllOps, CAPS_SQL, capOps, capStatus, suggestCap } from "../features/money/caps";
import {
  DISMISSED_KEY,
  dismissedToday,
  dismissOps,
  type Finding,
  findings,
  shownToday,
  tipFacts,
  tipOps,
  TIPS_KEY,
  tipsToday,
} from "../features/money/advisor";
import { type Afford, afford } from "../features/money/afford";
import { monthReview } from "../features/money/review";
import { JOB_MINUTES_SQL, JOB_PAY_SQL, jobRates } from "../features/money/rate";
import {
  DISMISSED_SUGGESTIONS_KEY,
  notAgainOps,
  readDismissed,
  suggestRegulars,
  suggestSince,
  SUGGEST_SQL,
  type SuggestRow,
  trackOps,
} from "../features/money/suggest";
import { ask } from "../features/ai/ask";
import { STRICT_SQL, strictOrNull } from "../features/ai/strict";
import { MONEY } from "../features/ai/touchpoints";
import {
  IconArrowLeft,
  IconArrowRight,
  IconArrowUpRight,
  IconBolt,
  IconChart,
  IconDownload,
  IconMoney,
  IconPlus,
  IconSearch,
} from "./icons";
import { cancelOnEscape, returnsFocus, useEscapeToCancel } from "./keys";
import { type Bar as ChartBar, BarChart, PanelHead } from "./kit";
import { Segmented } from "./Nav";
import { Savings, useSavingsSync } from "./Savings";
import { Bar, Button } from "./ui";
import { useLiveQuery } from "./useLiveQuery";

interface Category extends Record<string, string> {
  id: string;
  name: string;
  kind: "expense" | "income";
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** An amount without its unit, for placeholders people type over ("e.g. 4,000"). */
const birr = (minor: number) => formatNumber(minor);

/**
 * "12,400 ETB" with the unit set small, both from formatAmount(); "$1,200"
 * keeps its symbol. `approx` puts "≈" before a total holding converted money.
 */
function Amount({
  minor,
  currency = "ETB",
  approx = false,
}: {
  minor: number;
  currency?: string;
  approx?: boolean | undefined;
}) {
  const text = formatAmount(minor, currency);
  const cut = text.lastIndexOf(" ");
  const mark = approx ? "≈ " : "";
  if (cut < 0) return <>{`${mark}${text}`}</>;
  return (
    <>
      {mark}
      {text.slice(0, cut)} <small>{text.slice(cut + 1)}</small>
    </>
  );
}

/** The exchange rates you set (Money → Accounts). */
function useRates() {
  const rows = useLiveQuery<{ value_json: string }>(RATES_SQL);
  return { rates: readRates(rows.rows[0]?.value_json), loading: rows.loading };
}

/**
 * Under a total with foreign money: the rate it was converted at, and what
 * was left out for want of one (time-first §3).
 */
function RateNotes({ notes }: { notes: ConversionNotes | undefined }) {
  if (!notes || (!notes.rate && !notes.missing)) return null;
  return (
    <>
      {notes.rate && <p className="meta money-rate-note">≈ converted {notes.rate}</p>}
      {notes.missing && <p className="warn-text money-rate-note">{notes.missing}</p>}
    </>
  );
}

/** "18,000 ETB + $500": sums kept apart by currency, ETB first. */
function perCurrency(items: { minor: number; currency?: string | null | undefined }[]): string {
  const sums = new Map<string, number>();
  for (const item of items) {
    const code = item.currency ?? "ETB";
    sums.set(code, (sums.get(code) ?? 0) + item.minor);
  }
  if (sums.size === 0) return formatAmount(0);
  return [...sums.entries()]
    .sort(([a], [b]) => (a === "ETB" ? -1 : b === "ETB" ? 1 : a.localeCompare(b)))
    .map(([code, minor]) => formatAmount(minor, code))
    .join(" + ");
}

/** Money moved between accounts: two arrows passing (drawn like icons.tsx). */
function IconMove() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 8h15M15 4l4 4-4 4M20 16H5M9 12l-4 4 4 4" />
    </svg>
  );
}

function useMonth(month: string, today: string) {
  const { from, to } = monthOf(month);
  const txns = useLiveQuery<TxnRow & Record<string, string | number | null>>(TXNS_SQL, [from, to]);
  const saved = useLiveQuery<{ minor: number }>(SAVED_SQL, [from, to]);
  const history = useLiveQuery<HistoryRow & Record<string, string | number | null>>(
    HISTORY_SQL,
    historyParams(month),
  );
  const { rates, loading: ratesLoading } = useRates();
  // A past month is seen from its last day; this month from today.
  const asOf = to < today ? to : today;
  const summary = monthSummary({
    txns: txns.rows,
    saved: saved.rows[0]?.minor ?? 0,
    history: history.rows,
    today: asOf,
    rates,
  });
  return {
    txns,
    summary,
    history: historyInEtb(history.rows, rates),
    usual: usualByCategory(history.rows, rates),
    rates,
    current: to >= today,
    loading: txns.loading || history.loading || ratesLoading,
  };
}

/** Safe to spend for the month `today` is in (T-062). */
export function useSafe(today: string) {
  const { from, to, days } = monthOf(today);
  const accounts = useLiveQuery<AccountRow & Record<string, string | number | null>>(ACCOUNTS_SQL);
  const goals = useLiveQuery<GoalRow & Record<string, string | number | null>>(GOALS_SQL);
  const saved = useLiveQuery<{ goal_id: string; minor: number }>(GOAL_MONTH_SQL, [from, to]);
  const waiting = useLiveQuery<{ minor: number; n: number; held: number }>(UNASSIGNED_SQL);
  const { items, loading } = useDue(today);
  const { rates, loading: ratesLoading } = useRates();
  const loans = useLiveQuery<LoanEvent & Record<string, string | number | null>>(LOANS_SQL);
  const safe = safeToSpend({
    accounts: accounts.rows,
    goals: goals.rows,
    savedThisMonth: Object.fromEntries(saved.rows.map((row) => [row.goal_id, row.minor])),
    due: items,
    today,
    daysInMonth: days,
    unassigned: waiting.rows[0]?.minor ?? 0,
    unassignedHeld: waiting.rows[0]?.held ?? 0,
    rates,
    loans: loans.rows,
  });
  return {
    safe,
    goals: goals.rows,
    loading:
      loading ||
      loans.loading ||
      accounts.loading ||
      goals.loading ||
      saved.loading ||
      waiting.loading ||
      ratesLoading,
  };
}

/** Safe to spend, as the side column's yellow card (docs/design.md → Now card). */
function SafeCard({ today, onAccounts }: { today: string; onAccounts: () => void }) {
  const { safe, loading } = useSafe(today);
  const [open, setOpen] = useState(false);
  if (loading) return null;
  if (!safe.known)
    return (
      <section className="now-card money-safe" aria-labelledby="safe">
        <div className="now-card-top">
          <h2 id="safe" className="now-when">
            Safe to spend
          </h2>
        </div>
        <p className="money-safe-note">
          Set what one of your accounts shows (Accounts tab) and Sirna can tell you what is safe to
          spend each day, after bills, pay still to come and your goals.
        </p>
        <div className="now-card-actions">
          <Button className="btn-orange" onClick={onAccounts}>
            Open accounts
          </Button>
        </div>
      </section>
    );
  const short = safe.total <= 0;
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Escape hides the sum; keydown bubbles from its buttons
    <section
      className={short ? "now-card money-safe short" : "now-card money-safe"}
      aria-labelledby="safe"
      onKeyDown={open ? cancelOnEscape(() => setOpen(false)) : undefined}
    >
      <div className="now-card-top">
        <h2 id="safe" className="now-when">
          Safe to spend
        </h2>
        <span className="time-pill">
          {safe.daysLeft} {safe.daysLeft === 1 ? "day" : "days"} left
        </span>
      </div>
      {short ? (
        <p className="money-safe-total">Nothing safe</p>
      ) : (
        <p className="money-safe-total">
          <Amount minor={safe.total} approx={safe.notes?.approx} />
        </p>
      )}
      <p className="money-safe-sub">
        {short ? safeLine(safe) : `about ${formatAmount(safe.perDay ?? 0)} a day`}
      </p>
      <RateNotes notes={safe.notes} />
      {open && (
        <ul className="money-safe-sum">
          {safe.lines.map((line) => (
            <li key={line.label}>
              <span>{line.label}</span>
              <span className="money-num">
                {line.amount < 0 ? "−" : "+"}
                {formatAmount(Math.abs(line.amount))}
              </span>
            </li>
          ))}
          <li className="total">
            <strong>Safe to spend</strong>
            <strong className="money-num">
              {approxMark(safe.notes ?? { approx: false })}
              {formatAmount(safe.total)}
            </strong>
          </li>
          <li className="meta">Savings accounts aren&apos;t counted: that money is put aside.</li>
        </ul>
      )}
      {safe.unknownAccounts > 0 && (
        <p className="money-safe-note">
          {safe.unknownAccounts} account{safe.unknownAccounts === 1 ? "" : "s"} without a balance
          yet aren&apos;t counted.
        </p>
      )}
      <div className="now-card-actions">
        <Button className="btn-orange" onClick={() => setOpen((shown) => !shown)}>
          {open ? "Hide the sum" : "How?"}
        </Button>
        <Button onClick={onAccounts}>Accounts</Button>
      </div>
      {!open && <CoinArt />}
    </section>
  );
}

/** A small stack of coins, the Money page's sticker. */
function CoinArt() {
  return (
    <svg className="money-art" viewBox="0 0 110 90" aria-hidden="true" focusable="false">
      <g stroke="#2a1a12" strokeWidth="2.4" strokeLinejoin="round">
        <path d="M14 62v12c0 5 13 9 30 9s30-4 30-9V62" fill="#f78fb3" />
        <ellipse cx="44" cy="62" rx="30" ry="9" fill="#fdf1da" />
        <path d="M14 50v12c0 5 13 9 30 9s30-4 30-9V50" fill="#fdf1da" />
        <ellipse cx="44" cy="50" rx="30" ry="9" fill="#ee6300" />
        <circle cx="84" cy="30" r="18" fill="#fdf1da" />
        <path
          d="M84 20v20M89 25h-7a3 3 0 0 0 0 6h4a3 3 0 0 1 0 6h-7"
          fill="none"
          strokeLinecap="round"
        />
      </g>
    </svg>
  );
}

/** Every account and what it holds, as list rows in the side column. */
function AccountsPanel({ onOpen }: { onOpen: () => void }) {
  const accounts = useLiveQuery<AccountRow & Record<string, string | number | null>>(ACCOUNTS_SQL);
  const { rates, loading } = useRates();
  if (accounts.loading || loading) return null;
  const conversion = newConversion();
  const { total, unknown } = totalBalance(inEtb(accounts.rows, rates, conversion));
  const notes = conversionNotes(conversion, rates);
  return (
    <section className="panel money-accounts" aria-labelledby="money-accounts">
      <PanelHead
        id="money-accounts"
        icon={<IconMoney size={18} />}
        title="Accounts"
        sub={`${approxMark(notes)}${formatAmount(total)} in all${unknown > 0 ? ` · ${unknown} not set` : ""}`}
        action={
          <button
            type="button"
            className="icon-btn plain"
            aria-label="Open accounts"
            onClick={onOpen}
          >
            <IconArrowUpRight />
          </button>
        }
      />
      {accounts.rows.length === 0 ? (
        <p className="empty">No accounts yet. Add one under Accounts.</p>
      ) : (
        <ul className="list-rows">
          {accounts.rows.map((account) => {
            const balance = balanceOf(account);
            return (
              <li key={account.id}>
                <span className={balance === null ? "dot-pink" : "dot-cream"} aria-hidden="true" />
                <span className="grow">
                  {account.name}
                  {account.pays_in === 1 && <span className="meta"> · pay lands here</span>}
                  {isSavings(account) && <span className="meta"> · savings</span>}
                </span>
                <span className={balance === null ? "meta" : "money-num"}>
                  {balance === null ? "not set" : formatAmount(balance, currencyOf(account))}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <RateNotes notes={notes} />
    </section>
  );
}

function EmergencyCard({ today }: { today: string }) {
  const { goals, loading } = useSafe(today);
  const history = useLiveQuery<HistoryRow & Record<string, string | number | null>>(
    HISTORY_SQL,
    historyParams(today),
  );
  const { rates } = useRates();
  const regulars = useLiveQuery<RegularRow & Record<string, string | number | null>>(REGULARS_SQL);
  const [note, setNote] = useState<string | null>(null);
  if (loading || history.loading || regulars.loading) return null;
  // Rent and other regular bills count even before a month of history (F100).
  const month = essentialMonth(usualByCategory(history.rows, rates), regulars.rows, rates);
  const fund = goals.find((goal) => isEmergency(goal) && goal.status !== "done");
  const head = (
    <PanelHead
      id="emergency"
      icon={<IconBolt size={18} />}
      title="Emergency fund"
      sub={`Aim for ${EMERGENCY_MONTHS} months of essentials`}
    />
  );
  if (fund) {
    const covered = monthsCovered(fund.saved_minor, month);
    return (
      <section className="panel money-emergency" aria-labelledby="emergency">
        {head}
        <p className="money-big">
          {covered === null
            ? formatAmount(Math.max(0, fund.saved_minor))
            : `covers ${covered} months`}
        </p>
        {covered !== null && (
          <Bar
            value={covered / EMERGENCY_MONTHS}
            label={`Emergency fund covers ${covered} of ${EMERGENCY_MONTHS} months`}
          />
        )}
        <p className="meta">
          of essentials · aim for {EMERGENCY_MONTHS}
          {month !== null ? ` (${formatAmount(month)} a month)` : ""}
        </p>
      </section>
    );
  }
  return (
    <section className="panel money-emergency" aria-labelledby="emergency">
      {head}
      <p className="meta">
        No emergency fund yet. {EMERGENCY_MONTHS} months of essentials
        {month !== null
          ? ` is about ${formatAmount(emergencyTarget(month))}`
          : " (known after a month of entries)"}
        .
      </p>
      {month !== null && (
        <Button
          onClick={() =>
            void transact(
              "user",
              addGoalOps(
                { title: EMERGENCY_TITLE, target: String(emergencyTarget(month) / 100) },
                today,
                ulid(),
              ),
              "savings",
            )
              .then(() => setNote("Started. Put money aside in it under Savings."))
              .catch((failure: unknown) => setNote(`Couldn't start it: ${message(failure)}`))
          }
        >
          Start one
        </Button>
      )}
      {note && (
        <p className="meta" role="status">
          {note}
        </p>
      )}
    </section>
  );
}

/** One of the month's four numbers, as a loud card on the canvas. */
function Stat({
  tone,
  label,
  value,
  sub,
  approx = false,
}: {
  tone: "purple" | "orange" | "leaf" | "cream" | "pink";
  label: string;
  /** Santim. */
  value: number;
  sub?: string | undefined;
  approx?: boolean | undefined;
}) {
  return (
    <div className={`money-stat tone-${tone}`}>
      <span className="money-stat-label">{label}</span>
      <strong className="money-stat-value">
        <Amount minor={value} approx={approx} />
      </strong>
      {sub && <span className="money-stat-sub">{sub}</span>}
    </div>
  );
}

const SHORT_MONTH = new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" });
const shortMonth = (key: string) => {
  const [y = 0, m = 1] = key.split("-").map(Number);
  return SHORT_MONTH.format(Date.UTC(y, m - 1, 1));
};

/** Money out in the three months before and this one: the same sums as "usual". */
function OutByMonth({
  month,
  history,
  out,
}: {
  month: string;
  history: HistoryRow[];
  out: number;
}) {
  const keys: string[] = [];
  let start = month;
  for (let i = 0; i < 3; i++) {
    start = previousMonthStart(start);
    keys.unshift(monthOf(start).key);
  }
  const totals = keys.map((key) =>
    history.filter((row) => row.month === key).reduce((sum, row) => sum + row.out_minor, 0),
  );
  if (out === 0 && totals.every((total) => total === 0)) return null;
  const thousands = (minor: number) => minor / 100_000;
  const bars: ChartBar[] = [
    ...keys.map((key, i) => ({
      label: shortMonth(key),
      total: thousands(totals[i] ?? 0),
      done: thousands(totals[i] ?? 0),
      tipTitle: monthLabel(key),
      tip: [{ label: "Out", value: formatAmount(totals[i] ?? 0), tone: "cream" as const }],
    })),
    {
      label: shortMonth(monthOf(month).key),
      total: thousands(out),
      done: thousands(out),
      highlight: true,
      tipTitle: monthLabel(monthOf(month).key),
      tip: [{ label: "Out", value: formatAmount(out), tone: "yellow" as const }],
    },
  ];
  return (
    <section className="card money-trend" aria-labelledby="money-trend">
      <PanelHead
        id="money-trend"
        icon={<IconChart size={18} />}
        title="Out by month"
        sub="This month against the three before"
      />
      <BarChart
        bars={bars}
        unit="k"
        ariaLabel={`Money out: ${bars
          .map((bar, i) => `${bar.tipTitle} ${formatAmount(i < 3 ? (totals[i] ?? 0) : out)}`)
          .join(", ")}`}
      />
    </section>
  );
}

function MonthView({ month, today }: { month: string; today: string }) {
  const { summary, history, current, loading } = useMonth(month, today);
  const { safe, loading: safeLoading } = useSafe(today);
  if (loading || safeLoading) return null;
  const biggest = Math.max(
    1,
    ...summary.categories.map((line) => Math.max(line.spent, line.usual ?? 0)),
  );
  const empty = summary.in === 0 && summary.out === 0 && summary.saved === 0;
  const approx = summary.notes?.approx;
  return (
    <>
      {!current && <MonthReviewCard month={month} today={today} />}
      <div className="money-stats">
        <Stat tone="purple" label="In" value={summary.in} approx={approx} />
        <Stat tone="orange" label="Out" value={summary.out} approx={approx} />
        <Stat tone="leaf" label="Saved" value={summary.saved} />
        <Stat
          tone={summary.left < 0 ? "pink" : "cream"}
          label={summary.left >= 0 ? "Left" : "Over"}
          value={Math.abs(summary.left)}
          approx={approx}
          sub={
            // One "a day" answer per page: once an account has a balance, Safe to
            // spend gives it, and this month's flow is only the fallback (R-MON-07, F56).
            current && !safe.known && summary.perDay !== null
              ? `about ${formatAmount(summary.perDay)} a day`
              : undefined
          }
        />
      </div>
      <RateNotes notes={summary.notes} />
      {empty && (
        <p className="meta money-note">
          Nothing recorded {current ? "yet this month" : "that month"}. Type money in the capture
          box (<code>lunch 120</code>, <code>+18000 salary</code>) or add it in Ledger.
        </p>
      )}
      {current && (
        <p className="meta money-note">
          Day {summary.day} of {summary.days}. Left = in − out − saved this month.
        </p>
      )}

      <div className="money-grid">
        <OutByMonth month={month} history={history} out={summary.out} />

        {summary.categories.length > 0 && (
          <section className="card" aria-labelledby="money-out">
            <h2 id="money-out">Where it went</h2>
            <ul className="money-spend">
              {summary.categories.map((line, index) => (
                <li key={line.id} className={index === 0 ? "hi" : undefined}>
                  <span className="money-spend-head">
                    <span className="money-spend-name">{line.name}</span>
                    <span className="meta money-num">
                      {formatAmount(line.spent)}
                      {line.usual !== null ? ` · usually ${formatAmount(line.usual)}` : ""}
                    </span>
                  </span>
                  <span className="money-track">
                    {line.usual !== null && (
                      <span
                        className="money-usual"
                        style={{ width: `${(line.usual / biggest) * 100}%` }}
                        aria-label={`${line.name} usually ${formatAmount(line.usual)}`}
                      />
                    )}
                    <span
                      className="money-spent"
                      style={{ width: `${(line.spent / biggest) * 100}%` }}
                      aria-label={`${line.name} ${formatAmount(line.spent)}`}
                    />
                  </span>
                </li>
              ))}
            </ul>
            {summary.categories.some((line) => line.usual !== null) && (
              <p className="hint">The light bar is your usual month (the middle of the last 3).</p>
            )}
          </section>
        )}

        {summary.sources.length > 0 && (
          <section className="card" aria-labelledby="money-in">
            <h2 id="money-in">Money in</h2>
            <ul className="money-lines">
              {summary.sources.map((source) => (
                <li key={source.name}>
                  <span>{source.name}</span>
                  <span className="money-num money-in">+{formatAmount(source.amount)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {current && <CapsCard summary={summary} />}
        <JobRatesCard month={month} today={today} />
      </div>

      <div className="money-wide">
        <Savings />
      </div>
    </>
  );
}

/** Caps this month (T-063): spent against each cap, with where the month is. */
function CapsCard({ summary }: { summary: ReturnType<typeof monthSummary> }) {
  const caps = useLiveQuery<{ id: string; name: string; cap_minor: number }>(CAPS_SQL);
  if (caps.loading) return null;
  if (caps.rows.length === 0)
    return (
      <p className="empty money-note money-full">
        No caps yet. Set one per category under Categories; Sirna suggests amounts from your usual
        month.
      </p>
    );
  const spent = new Map(summary.categories.map((line) => [line.id, line.spent]));
  return (
    <section className="card" aria-labelledby="money-caps">
      <h2 id="money-caps">Caps this month</h2>
      <ul className="money-caps">
        {caps.rows.map((cap) => {
          const used = spent.get(cap.id) ?? 0;
          const status = capStatus(used, cap.cap_minor, summary.day, summary.days);
          return (
            <li
              key={cap.id}
              className={status.over || status.ahead ? "money-cap warn" : "money-cap"}
            >
              <span className="money-spend-head">
                <span className="money-spend-name">{cap.name}</span>
                <span
                  className={status.over || status.ahead ? "warn-text money-num" : "meta money-num"}
                >
                  {formatAmount(used)} of {formatAmount(cap.cap_minor)}
                  {status.over
                    ? ` · over by ${formatAmount(used - cap.cap_minor)}`
                    : ` · ${formatAmount(status.left)} left${status.ahead ? ", spending fast" : ""}`}
                </span>
              </span>
              <span className="money-cap-bar">
                <Bar
                  value={status.share}
                  label={`${cap.name} ${Math.round(status.share * 100)}% of its cap`}
                />
                <span
                  className="money-pace"
                  style={{ left: `${status.pace * 100}%` }}
                  title={`Day ${summary.day} of ${summary.days}`}
                />
              </span>
            </li>
          );
        })}
      </ul>
      <p className="hint">The mark is how far through the month you are.</p>
      <RateNotes notes={summary.notes} />
    </section>
  );
}

/** Today's findings (T-064): calculated, ranked, at most two. */
export function useAdvisor(today: string) {
  const { summary, loading: monthLoading } = useMonth(monthOf(today).from, today);
  const { safe, loading: safeLoading } = useSafe(today);
  const { items, loading: dueLoading } = useDue(today);
  const accounts = useLiveQuery<AccountRow & Record<string, string | number | null>>(ACCOUNTS_SQL);
  const caps = useLiveQuery<{ id: string; name: string; cap_minor: number }>(CAPS_SQL);
  const hidden = useLiveQuery<{ value_json: string }>(
    "SELECT value_json FROM core_settings WHERE key = ?",
    [DISMISSED_KEY],
  );
  const hiddenCategories = useLiveQuery<{ id: string }>(
    "SELECT id FROM money_categories WHERE deleted_at IS NOT NULL",
  );
  const loading =
    monthLoading ||
    safeLoading ||
    dueLoading ||
    accounts.loading ||
    caps.loading ||
    hidden.loading ||
    hiddenCategories.loading;
  const all = loading
    ? []
    : findings({
        safe,
        due: items,
        accounts: accounts.rows,
        caps: caps.rows,
        hidden: hiddenCategories.rows.map((row) => row.id),
        summary,
        today,
        nowMs: systemClock.now(),
        newId: () => ulid(),
      });
  const hiddenJson = hidden.rows[0]?.value_json;
  return {
    shown: shownToday(all, dismissedToday(hiddenJson, today)),
    hiddenJson,
    loading,
  };
}

function FindingCard({
  finding,
  today,
  hiddenJson,
  tipsJson,
  strict,
}: {
  finding: Finding;
  today: string;
  hiddenJson: string | undefined;
  tipsJson: string | undefined;
  /** Null until the setting has loaded: nothing is asked before. */
  strict: boolean | null;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const stored = tipsToday(tipsJson, today)[finding.key];
  const asked = useRef(false);
  // One question to Gemini per finding per day; the answer (or that there
  // was none) is kept, so reopening the window asks nothing.
  useEffect(() => {
    if (stored !== undefined || strict === null || asked.current) return;
    asked.current = true;
    void ask(MONEY, tipFacts(finding.facts, strict))
      // Read the saved tips again: another card may have saved one meanwhile.
      .then((result) =>
        query<{ value_json: string }>("SELECT value_json FROM core_settings WHERE key = ?", [
          TIPS_KEY,
        ]).then(([row]) =>
          transact(
            "system",
            tipOps(row?.value_json, today, finding.key, result.ok ? result.value.tip : ""),
            "advisor",
          ),
        ),
      );
  }, [stored, strict, finding, today]);
  const write = (ops: Op[], context: string) => {
    // One write at a time: a double click can't move money twice.
    setBusy(true);
    void transact("user", ops, context)
      .catch((failure: unknown) => setError(`Couldn't do it: ${message(failure)}`))
      .finally(() => setBusy(false));
  };
  return (
    <li className={finding.rank <= 2 ? "finding urgent" : "finding"}>
      <span className={finding.rank <= 2 ? "dot-pink" : "dot-cream"} aria-hidden="true" />
      <p className="finding-text">{finding.text}</p>
      {stored && <p className="meta finding-tip">{stored}</p>}
      <span className="finding-actions">
        {finding.actions.map((action) => (
          <Button
            key={action.label}
            className="finding-act"
            disabled={busy}
            onClick={() => write(action.ops, `advisor:${finding.key}`)}
          >
            {action.label}
          </Button>
        ))}
        <Button
          disabled={busy}
          onClick={() => write(dismissOps(hiddenJson, today, finding.key), "advisor")}
        >
          Not now
        </Button>
      </span>
      {error && (
        <span role="alert" className="error finding-error">
          {error}
        </span>
      )}
    </li>
  );
}

/**
 * The advisor: what needs you about money today, if anything. `framed` gives
 * it its own panel (the Money side column); without, it sits in a panel
 * that is already there (Money today, on Today).
 */
export function Advisor({ today, framed = false }: { today: string; framed?: boolean }) {
  const { shown, hiddenJson, loading } = useAdvisor(today);
  const tips = useLiveQuery<{ value_json: string }>(
    "SELECT value_json FROM core_settings WHERE key = ?",
    [TIPS_KEY],
  );
  const strict = strictOrNull(useLiveQuery<{ value_json: string | null }>(STRICT_SQL));
  if (loading || tips.loading || shown.length === 0) return null;
  return (
    <section className={framed ? "panel advisor" : "advisor flat"} aria-labelledby="advisor">
      {framed ? (
        <PanelHead
          id="advisor"
          title="Worth a look"
          sub="Worked out from your numbers"
          action={<span className="badge">{shown.length}</span>}
        />
      ) : (
        <h3 id="advisor">Worth a look</h3>
      )}
      <ul className="findings">
        {shown.map((finding) => (
          <FindingCard
            key={finding.key}
            finding={finding}
            today={today}
            hiddenJson={hiddenJson}
            tipsJson={tips.rows[0]?.value_json}
            strict={strict}
          />
        ))}
      </ul>
    </section>
  );
}

/** Can I afford it? (T-065): Fine, Tight or Not now, from your real numbers. */
function AffordBox({ today, summary }: { today: string; summary: MonthSummary }) {
  const { safe, loading } = useSafe(today);
  const [amount, setAmount] = useState("");
  const [what, setWhat] = useState("");
  const [answer, setAnswer] = useState<Afford | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (loading) return null;
  return (
    <section className="panel money-afford" aria-labelledby="afford">
      <PanelHead id="afford" title="Can I afford it?" sub="Fine, Tight or Not now" />
      <form
        className="money-afford-form"
        onSubmit={(event) => {
          event.preventDefault();
          const minor = parseAmount(amount);
          if (minor === null || minor <= 0) {
            setError("An amount, like 4,500.");
            setAnswer(null);
            return;
          }
          setError(null);
          setAnswer(
            afford({
              amount: minor,
              available: safe.known ? safe.total : summary.left,
              daysLeft: summary.days - summary.day + 1,
              basis: safe.known ? "safe" : "month",
            }),
          );
        }}
      >
        <input
          inputMode="decimal"
          aria-label="How much"
          placeholder="4,500"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <input
          aria-label="What it is"
          placeholder="shoes (optional)"
          value={what}
          onChange={(e) => setWhat(e.target.value)}
        />
        <Button type="submit">Check</Button>
      </form>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {answer && (
        <div
          className={
            answer.verdict === "Fine"
              ? "money-verdict fine"
              : answer.verdict === "Tight"
                ? "money-verdict warn"
                : "money-verdict no"
          }
        >
          <p>
            <strong>{answer.verdict}</strong>
            {what.trim() ? ` for ${what.trim()}` : ""}
          </p>
          <ul className="plain-list">
            {answer.reasons.map((reason) => (
              <li key={reason} className="meta">
                {reason}
              </li>
            ))}
          </ul>
          <RateNotes notes={safe.known ? safe.notes : summary.notes} />
        </div>
      )}
    </section>
  );
}

/** Can I afford it? in the side column, always against this month. */
function SideAfford({ today }: { today: string }) {
  const { summary, loading } = useMonth(monthOf(today).from, today);
  if (loading) return null;
  return <AffordBox today={today} summary={summary} />;
}

/** The month review (T-066): the month that `month` starts, seen from `today`. */
export function MonthReviewCard({ month, today }: { month: string; today: string }) {
  const { summary, usual, rates, loading } = useMonth(month, today);
  const caps = useLiveQuery<{
    id: string;
    name: string;
    cap_minor: number;
    cap_since: string | null;
  }>(CAPS_SQL);
  const accounts = useLiveQuery<AccountRow & Record<string, string | number | null>>(ACCOUNTS_SQL);
  const categories = useLiveQuery<{ id: string; name: string }>(
    "SELECT id, name FROM money_categories",
  );
  const { people, loading: loansLoading } = useLoans();
  if (loading || caps.loading || accounts.loading || loansLoading || categories.loading)
    return null;
  const review = monthReview({
    summary,
    caps: caps.rows,
    accounts: accounts.rows,
    people,
    usual,
    names: new Map(categories.rows.map((row) => [row.id, row.name])),
    monthEnd: monthOf(month).to,
    rates,
  });
  if (review.in === 0 && review.out === 0) return null;
  return (
    <section className="card money-review" aria-labelledby="month-review">
      <h2 id="month-review">{monthLabel(monthOf(month).key)} in review</h2>
      <p>
        {formatAmount(review.in)} in · {formatAmount(review.out)} out
        {review.savingsRate !== null && (
          <span className="meta"> · saved {review.savingsRate}% of what came in</span>
        )}
      </p>
      {review.changes.length > 0 && (
        <ul className="plain-list">
          {review.changes.map((change) => (
            <li key={change.name} className="row money-line">
              <span>{change.name}</span>
              <span className={change.diff > 0 ? "warn-text" : "money-in"}>
                {change.diff > 0 ? "+" : "−"}
                {formatAmount(Math.abs(change.diff))} against your usual{" "}
                {formatAmount(change.usual)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {review.capsOver.length > 0 && (
        <p className="meta">
          Over cap:{" "}
          {review.capsOver
            .map((cap) => `${cap.name} (${formatAmount(cap.spent)} of ${formatAmount(cap.cap)})`)
            .join(", ")}
        </p>
      )}
      {review.netWorth !== null && (
        <p className="meta">
          Net worth now: {approxMark(review.notes)}
          {formatAmount(review.netWorth)} (accounts and savings, plus owed to you, less what you
          owe)
        </p>
      )}
      <RateNotes notes={summary.notes} />
      {review.netWorth !== null && <RateNotes notes={review.notes} />}
    </section>
  );
}

/**
 * Birr per hour for each job (T-073): a whole month's pay over its blocks'
 * hours. While a month is running, the last full one is shown, so a job paid
 * on the 21st isn't missing and one paid on the 10th isn't counted early.
 */
function JobRatesCard({ month, today }: { month: string; today: string }) {
  const running = monthOf(month).to >= today;
  const shown = running ? monthOf(previousMonthStart(month)) : monthOf(month);
  const { from, to } = shown;
  const [nowMs] = useState(() => systemClock.now());
  const minutes = useLiveQuery<{ area_id: string; name: string; minutes: number }>(
    JOB_MINUTES_SQL,
    [from, to, nowMs],
  );
  const pay = useLiveQuery<{ area_id: string; minor: number; currency: string | null }>(
    JOB_PAY_SQL,
    [from, to],
  );
  const { rates } = useRates();
  // This month's hours, only to say why there is nothing yet in your first month.
  const thisMonth = monthOf(month);
  const current = useLiveQuery<{ area_id: string }>(JOB_MINUTES_SQL, [
    thisMonth.from,
    thisMonth.to,
    nowMs,
  ]);
  if (minutes.loading || pay.loading || current.loading) return null;
  if (minutes.rows.length === 0) {
    if (!running || current.rows.length === 0) return null;
    return (
      <section className="card" aria-labelledby="job-rates">
        <h2 id="job-rates">Your jobs</h2>
        <p className="meta">
          Birr per hour shows once {monthLabel(thisMonth.key)} is over, so both pay days are in.
        </p>
      </section>
    );
  }
  const perJob = jobRates(minutes.rows, pay.rows, rates);
  return (
    <section className="card" aria-labelledby="job-rates">
      <h2 id="job-rates">Your jobs in {monthLabel(shown.key)}</h2>
      <ul className="money-lines">
        {perJob.map((rate) => (
          <li key={rate.areaId}>
            <span>{rate.name}</span>
            <span className="meta money-num">
              {formatAmount(rate.pay)} for {Math.round(rate.minutes / 60)} h
              {rate.perHour !== null ? ` · about ${formatAmount(rate.perHour)} an hour` : ""}
            </span>
          </li>
        ))}
      </ul>
      <p className="hint">
        Hours are the job&apos;s blocks that month (skipped or moved ones left out); pay is income
        you recorded for that job.{running ? " This month shows once it is over." : ""}
      </p>
    </section>
  );
}

const emptyDraft = (today: string): TxnDraft => ({
  kind: "out",
  amount: 0,
  description: "",
  categoryId: "",
  date: today,
});

function TxnForm({
  initial,
  categories,
  accounts,
  submitLabel,
  onSave,
  onCancel,
}: {
  initial: TxnDraft;
  categories: Category[];
  accounts: AccountRow[];
  submitLabel: string;
  onSave: (draft: TxnDraft) => Promise<unknown>;
  onCancel?: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [amountText, setAmountText] = useState(
    initial.amount > 0 ? String(initial.amount / 100) : "",
  );
  const [error, setError] = useState<string | null>(null);
  const [converted, setConverted] = useState<string | null>(null);
  const { rates } = useRates();
  const set = (part: Partial<TxnDraft>) => setDraft((old) => ({ ...old, ...part }));
  const shown = categories.filter(
    (category) => category.kind === (draft.kind === "in" ? "income" : "expense"),
  );
  const accountId =
    draft.account ||
    (draft.kind === "in" ? payAccount(spending(accounts)) : spendAccount(accounts));
  // An entry is in its account's currency.
  const currency = currencyOf(accounts.find((account) => account.id === accountId));
  const onEscape = useEscapeToCancel(() => onCancel?.());
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Escape cancels; keydown bubbles from its fields
    <form
      className="money-form"
      onKeyDown={onCancel ? onEscape : undefined}
      onSubmit={(event) => {
        event.preventDefault();
        const full = {
          ...draft,
          amount: parseAmount(amountText) ?? 0,
          account: accountId,
          currency,
        };
        const problem = checkTxn(full);
        if (problem) {
          setError(problem);
          return;
        }
        void onSave(full)
          .then(() => {
            setError(null);
            if (!onCancel) {
              setDraft(emptyDraft(draft.date));
              setAmountText("");
            }
          })
          .catch((failure: unknown) => setError(`Couldn't save: ${message(failure)}`));
      }}
    >
      <div className="money-fields">
        <label className="money-field">
          <span>In or out</span>
          <select
            value={draft.kind}
            onChange={(e) => set({ kind: e.target.value as TxnDraft["kind"], categoryId: "" })}
          >
            <option value="out">Out (spent)</option>
            <option value="in">In (received)</option>
          </select>
        </label>
        <label className="money-field">
          <span>Amount ({currency})</span>
          <input
            inputMode="decimal"
            value={amountText}
            placeholder="e.g. 120 or 2k"
            onChange={(e) => setAmountText(e.target.value)}
          />
        </label>
        <label className="money-field">
          <span>What</span>
          <input value={draft.description} onChange={(e) => set({ description: e.target.value })} />
        </label>
        <label className="money-field">
          <span>Category</span>
          <select value={draft.categoryId} onChange={(e) => set({ categoryId: e.target.value })}>
            <option value="">None</option>
            {shown.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </label>
        <label className="money-field">
          <span>Account</span>
          <select
            value={accountId}
            onChange={(e) => {
              // $4 moved to birr Cash stays worth $4, not 4 birr (F71).
              const next = currencyOf(accounts.find((account) => account.id === e.target.value));
              const typed = parseAmount(amountText);
              const switched = switchCurrency(typed, currency, next, rates);
              if (switched.minor !== null && switched.minor !== typed)
                setAmountText(String(switched.minor / 100));
              if (next !== currency) setConverted(switched.note);
              set({ account: e.target.value });
            }}
          >
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
                {currencyOf(account) !== "ETB" ? ` (${currencyOf(account)})` : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="money-field">
          <span>Date</span>
          <input type="date" value={draft.date} onChange={(e) => set({ date: e.target.value })} />
        </label>
      </div>
      {converted && (
        <p className="meta" role="status">
          {converted}
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="money-actions">
        <Button type="submit">{submitLabel}</Button>
        {onCancel && <Button onClick={onCancel}>Cancel</Button>}
      </div>
    </form>
  );
}

const draftOf = (row: TxnRow): TxnDraft => ({
  kind: row.amount_minor > 0 ? "in" : "out",
  amount: Math.abs(row.amount_minor),
  description: row.description,
  categoryId: row.category_id ?? "",
  date: row.local_date,
  account: row.account,
});

function LedgerRow({
  row,
  categories,
  accounts,
  halves,
  onDeleted,
}: {
  row: TxnRow;
  categories: Category[];
  accounts: AccountRow[];
  /** Both halves when this is a transfer; deleting one deletes both. */
  halves: TxnRow[];
  onDeleted: (deleted: { label: TxnRow; restore: Op[] }) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (editing)
    return (
      <li className="ledger-edit">
        <TxnForm
          initial={draftOf(row)}
          categories={categories}
          accounts={accounts}
          submitLabel="Save"
          onSave={(draft) =>
            transact("user", txnEditOps(row, draft), `money:${row.id}`).then(() =>
              setEditing(false),
            )
          }
          onCancel={() => setEditing(false)}
        />
      </li>
    );
  const income = row.amount_minor > 0;
  return (
    <li className="ledger-row">
      <span
        className={income ? "ledger-mark in" : row.transfer_id ? "ledger-mark move" : "ledger-mark"}
        aria-hidden="true"
      >
        {income ? "+" : row.transfer_id ? <IconMove /> : "−"}
      </span>
      <span className="ledger-what">
        <span className="ledger-desc">{row.description}</span>
        {(row.category || row.account_name) && (
          <span className="meta">
            {[row.category, row.account_name].filter(Boolean).join(" · ")}
          </span>
        )}
      </span>
      <span className={income ? "ledger-amount money-in" : "ledger-amount"}>
        {income ? "+" : "−"}
        {formatAmount(Math.abs(row.amount_minor), row.currency ?? "ETB")}
      </span>
      <span className="ledger-actions">
        {!row.transfer_id && (
          <Button
            className="btn-ghost"
            {...returnsFocus(`txn-edit:${row.id}`)}
            onClick={() => setEditing(true)}
          >
            Edit
          </Button>
        )}
        <Button
          className="btn-ghost btn-danger"
          onClick={() => {
            // A loan's entry goes with its loan event, or the loan would stay open.
            const loanId = loanIdOf(row.transfer_id);
            void (
              loanId
                ? query<LoanEvent & Record<string, string | number | null>>(LOAN_SQL, [loanId])
                : Promise.resolve([])
            )
              .then(([loan]) =>
                transact(
                  "user",
                  [
                    ...halves.flatMap(txnDeleteOps),
                    ...(loan
                      ? [{ op: "delete" as const, table: "money_loans" as const, id: loan.id }]
                      : []),
                  ],
                  `money:${row.id}`,
                ).then(() =>
                  onDeleted({
                    label: row,
                    restore: [
                      ...halves.flatMap(txnRestoreOps),
                      ...(loan ? loanRestoreOps(loan) : []),
                    ],
                  }),
                ),
              )
              .catch((failure: unknown) => setError(`Couldn't delete: ${message(failure)}`));
          }}
        >
          Delete
        </Button>
      </span>
      {error && (
        <p role="alert" className="error ledger-error">
          {error}
        </p>
      )}
    </li>
  );
}

/** The ledger's add form: Escape closes it and gives focus back to Add entry. */
function AddEntry({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const onEscape = useEscapeToCancel(onClose);
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Escape closes it; keydown bubbles from its fields
    <section className="card money-add" aria-label="Add entry" onKeyDown={onEscape}>
      {children}
    </section>
  );
}

function LedgerView({
  month,
  today,
  adding,
  onCloseAdd,
}: {
  month: string;
  today: string;
  /** The add form, opened by the page's Add entry button. */
  adding: boolean;
  /** Closes the add form (Escape in it). */
  onCloseAdd: () => void;
}) {
  const { txns } = useMonth(month, today);
  const categories = useLiveQuery<Category>(CATEGORIES_SQL);
  const accounts = useLiveQuery<AccountRow & Record<string, string | number | null>>(ACCOUNTS_SQL);
  const [filter, setFilter] = useState<LedgerFilter>({ text: "", categoryId: "", kind: "" });
  const [deleted, setDeleted] = useState<{ label: TxnRow; restore: Op[] } | null>(null);
  const halvesOf = (row: TxnRow) =>
    row.transfer_id ? txns.rows.filter((other) => other.transfer_id === row.transfer_id) : [row];
  const [note, setNote] = useState("");
  const [toast, setToast] = useState<{ file: string; count: number } | null>(null);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 8000);
    return () => window.clearTimeout(timer);
  }, [toast]);
  const shown = filterLedger(txns.rows, filter);
  const set = (part: Partial<LedgerFilter>) => setFilter((old) => ({ ...old, ...part }));
  const exportCsv = () => {
    const file = csvName(month);
    const url = URL.createObjectURL(new Blob([toCsv(shown)], { type: "text/csv" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = file;
    link.click();
    URL.revokeObjectURL(url);
    // The window saves downloads to your Downloads folder.
    setToast({ file, count: shown.length });
  };
  return (
    <>
      <div className="money-toolbar">
        <label className="search money-search">
          <IconSearch size={16} />
          <input
            type="search"
            placeholder="Search"
            aria-label="Search entries"
            value={filter.text}
            onChange={(e) => set({ text: e.target.value })}
          />
        </label>
        <select
          aria-label="Category"
          value={filter.categoryId}
          onChange={(e) => set({ categoryId: e.target.value })}
        >
          <option value="">All categories</option>
          {categories.rows.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
        <select
          aria-label="In or out"
          value={filter.kind}
          onChange={(e) => set({ kind: e.target.value as LedgerFilter["kind"] })}
        >
          <option value="">In and out</option>
          <option value="in">Money in</option>
          <option value="out">Money out</option>
        </select>
        <Button onClick={exportCsv} disabled={shown.length === 0}>
          <IconDownload size={16} /> Export CSV
        </Button>
      </div>
      {adding && (
        <AddEntry onClose={onCloseAdd}>
          <TxnForm
            initial={emptyDraft(month === monthOf(today).from ? today : monthOf(month).to)}
            categories={categories.rows}
            accounts={accounts.rows}
            submitLabel="Add"
            onSave={(draft) =>
              transact("user", txnAddOps(draft, systemClock.now(), ulid()), "money").then(() =>
                setNote(`Added ${draft.description.trim()}.`),
              )
            }
          />
        </AddEntry>
      )}
      {toast && (
        <div className="money-toast" role="status">
          <span>
            Exported {toast.count} {toast.count === 1 ? "entry" : "entries"}. Saved as{" "}
            <strong>{toast.file}</strong> (or a numbered copy) in Downloads.
          </span>
          <Button className="btn-ghost" onClick={() => setToast(null)}>
            OK
          </Button>
        </div>
      )}
      {deleted && (
        <p className="notice money-notice" role="status">
          Deleted {deleted.label.description} (
          {formatAmount(Math.abs(deleted.label.amount_minor), deleted.label.currency ?? "ETB")}
          ).
          <Button
            onClick={() =>
              void transact("user", deleted.restore, `money:${deleted.label.id}`).then(() =>
                setDeleted(null),
              )
            }
          >
            Undo
          </Button>
        </p>
      )}
      {note && (
        <p className="meta money-note" role="status">
          {note}
        </p>
      )}
      {txns.error && (
        <p role="alert" className="error">
          Couldn&apos;t load entries: {txns.error}
        </p>
      )}
      {!txns.loading && shown.length === 0 && (
        <p className="empty">
          {txns.rows.length === 0
            ? "No entries this month. Add one with Add entry or type it in the capture box."
            : "Nothing matches. Clear the search or pick another category."}
        </p>
      )}
      <div className="ledger">
        {byDay(shown).map((day) => {
          // A day's net is shown only when its entries share one currency.
          const codes = new Set(day.rows.map((row) => row.currency ?? "ETB"));
          const [code = "ETB"] = [...codes];
          return (
            <section
              key={day.date}
              className="ledger-day"
              aria-label={showDate(day.date, today, { weekday: true })}
            >
              <h3 className="ledger-day-head">
                <span className={day.date === today ? "ledger-date today" : "ledger-date"}>
                  {showDate(day.date, today, { weekday: true })}
                </span>
                {codes.size === 1 && (
                  <span className="ledger-net">
                    {day.net >= 0 ? "+" : "−"}
                    {formatAmount(Math.abs(day.net), code)}
                  </span>
                )}
              </h3>
              <ul className="ledger-rows">
                {day.rows.map((row) => (
                  <LedgerRow
                    key={row.id}
                    row={row}
                    categories={categories.rows}
                    accounts={accounts.rows}
                    halves={halvesOf(row)}
                    onDeleted={setDeleted}
                  />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </>
  );
}

/** A first cap starts today; changing one keeps its start. */
const capStart = (row: CategoryRow) =>
  row.cap_minor === null ? logicalDate(systemClock.now()) : undefined;

function CategoryItem({
  row,
  all,
  usual,
}: {
  row: CategoryRow;
  all: CategoryRow[];
  usual: number | null;
}) {
  const [name, setName] = useState(row.name);
  const [capText, setCapText] = useState("");
  const suggested = suggestCap(usual);
  const [into, setInto] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** True when saved; an error stays on screen until the next save works. */
  const write = (ops: Op[]) =>
    transact("user", ops, `category:${row.id}`)
      .then(() => {
        setError(null);
        return true;
      })
      .catch((failure: unknown) => {
        setError(`Couldn't change it: ${message(failure)}`);
        return false;
      });
  const others = all.filter(
    (other) => other.id !== row.id && other.kind === row.kind && other.deleted_at === null,
  );
  return (
    <li className="money-row">
      <span className="money-row-line">
        <input
          className="money-input"
          aria-label={`Name of ${row.name}`}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        {name.trim() !== row.name && (
          <Button
            onClick={() => {
              const problem = checkCategoryName(name, all, row.id);
              if (problem) setError(problem);
              else void write(renameCategoryOps(row.id, name));
            }}
          >
            Rename
          </Button>
        )}
        <span className="meta">
          {row.uses} {row.uses === 1 ? "entry" : "entries"}
        </span>
      </span>
      <span className="money-row-line">
        <select
          aria-label={`Merge ${row.name} into`}
          value={into}
          onChange={(e) => setInto(e.target.value)}
        >
          <option value="">Merge into…</option>
          {others.map((other) => (
            <option key={other.id} value={other.id}>
              {other.name}
            </option>
          ))}
        </select>
        {into && (
          <Button
            onClick={() =>
              void Promise.all([
                query<{ id: string }>(CATEGORY_TXNS_SQL, [row.id]),
                query<{ id: string }>(CATEGORY_TEMPLATES_SQL, [row.id]),
              ]).then(([txns, chips]) =>
                write(
                  mergeCategoryOps(
                    row.id,
                    into,
                    txns.map((t) => t.id),
                    chips.map((c) => c.id),
                  ),
                ),
              )
            }
          >
            Merge
          </Button>
        )}
        <Button onClick={() => void write(hideCategoryOps(row.id))}>Hide</Button>
      </span>
      {row.kind === "expense" && (
        <span className="money-row-line">
          <span className="meta">
            {row.cap_minor !== null ? `Cap ${formatAmount(row.cap_minor)} a month` : "No cap"}
          </span>
          <input
            className="money-input"
            inputMode="decimal"
            aria-label={`Monthly cap for ${row.name}`}
            placeholder={suggested !== null ? `e.g. ${birr(suggested)}` : "Monthly cap"}
            value={capText}
            onChange={(e) => setCapText(e.target.value)}
          />
          {capText.trim() && (
            <Button
              onClick={() => {
                const minor = parseAmount(capText);
                if (minor === null || minor <= 0) setError("A cap like 4,000.");
                else
                  void write(capOps(row.id, minor, capStart(row))).then((saved) => {
                    if (saved) setCapText("");
                  });
              }}
            >
              Set cap
            </Button>
          )}
          {!capText.trim() && suggested !== null && suggested !== row.cap_minor && (
            <Button onClick={() => void write(capOps(row.id, suggested, capStart(row)))}>
              Use {formatAmount(suggested)} (your usual)
            </Button>
          )}
          {row.cap_minor !== null && (
            <Button onClick={() => void write(capOps(row.id, null))}>No cap</Button>
          )}
        </span>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </li>
  );
}

function CategoriesView({ today }: { today: string }) {
  const all = useLiveQuery<CategoryRow & Record<string, string | number | null>>(
    ALL_CATEGORIES_SQL,
  );
  const history = useLiveQuery<HistoryRow & Record<string, string | number | null>>(
    HISTORY_SQL,
    historyParams(today),
  );
  const usual = usualByCategory(history.rows);
  const suggestions = acceptAllOps(
    all.rows.filter((row) => row.deleted_at === null),
    usual,
    today,
  );
  const [name, setName] = useState("");
  const [kind, setKind] = useState<CategoryRow["kind"]>("expense");
  const [note, setNote] = useState<string | null>(null);
  const shown = all.rows.filter((row) => row.deleted_at === null);
  const hidden = all.rows.filter((row) => row.deleted_at !== null);
  return (
    <>
      <form
        className="money-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          const problem = checkCategoryName(name, all.rows);
          if (problem) {
            setNote(problem);
            return;
          }
          void transact("user", addCategoryOps(name, kind, all.rows, ulid()), "category")
            .then(() => {
              setNote(`Added ${name.trim()}.`);
              setName("");
            })
            .catch((failure: unknown) => setNote(`Couldn't add it: ${message(failure)}`));
        }}
      >
        <input
          aria-label="New category"
          placeholder="New category, e.g. Fuel"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <select
          aria-label="Kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as CategoryRow["kind"])}
        >
          <option value="expense">Spending</option>
          <option value="income">Income</option>
        </select>
        <Button type="submit">Add</Button>
        {note && (
          <span className="meta" role="status">
            {note}
          </span>
        )}
      </form>
      {suggestions.length > 0 && (
        <p className="notice money-notice">
          <span className="meta">
            {suggestions.length} categor{suggestions.length === 1 ? "y has" : "ies have"} no cap
            yet. Start with your usual month for each:
          </span>
          <Button
            onClick={() =>
              void transact("user", suggestions, "caps")
                .then(() => setNote("Caps set from your usual month. Change any of them below."))
                .catch((failure: unknown) => setNote(`Couldn't set them: ${message(failure)}`))
            }
          >
            Use all suggestions
          </Button>
        </p>
      )}
      <div className="money-grid">
        {(["expense", "income"] as const).map((group) => (
          <section
            key={group}
            className="card"
            aria-label={group === "expense" ? "Spending" : "Income"}
          >
            <h2>{group === "expense" ? "Spending" : "Income"}</h2>
            <ul className="money-rows">
              {shown
                .filter((row) => row.kind === group)
                .map((row) => (
                  <CategoryItem
                    key={row.id}
                    row={row}
                    all={all.rows}
                    usual={usual.get(row.id) ?? null}
                  />
                ))}
            </ul>
          </section>
        ))}
      </div>
      {hidden.length > 0 && (
        <p className="hint money-note">
          Hidden: {hidden.map((row) => row.name).join(", ")}. Old entries keep their name; add a
          category with the same name to bring it back.
        </p>
      )}
    </>
  );
}

/**
 * Today's money in one line (proposal 1.6): spent today, left this month and
 * about how much a day. The same numbers as the Money page.
 */
export function TodayMoney({
  today,
  spentToday,
  onOpen,
}: {
  today: string;
  /** Today's spending per currency (SPENT_TODAY_SQL). */
  spentToday: { currency: string; spent: number }[];
  onOpen?: (() => void) | undefined;
}) {
  const { summary, loading } = useMonth(monthOf(today).from, today);
  const { safe, loading: safeLoading } = useSafe(today);
  const { rates, loading: ratesLoading } = useRates();
  if (loading || safeLoading || ratesLoading) return null;
  const short = (minor: number) => formatAmount(minor).replace(/ ETB$/, "");
  // Dollars spent today count at the saved rate, not as birr (F4).
  const spent = sumInEtb(
    spentToday.map((row) => ({ minor: row.spent, currency: row.currency })),
    rates,
  );
  const spentNotes = conversionNotes(spent.conversion, rates);
  const approx =
    (safe.known ? safe.notes : summary.notes)?.approx || spentNotes.approx ? " (≈)" : "";
  const line = safe.known
    ? `Spent ${short(spent.total)} today · ${safeLine(safe)}${approx}`
    : `${moneyLine(summary, spent.total)}${approx}`;
  const [lead = "", ...rest] = line.split(" · ");
  return (
    <div className="money-today-block">
      <div className="money-today">
        <p className="money-today-line">
          <strong>{lead}</strong>
          {rest.length > 0 && <span className="meta"> · {rest.join(" · ")}</span>}
        </p>
        {onOpen && (
          <Button onClick={onOpen}>
            Money <IconArrowUpRight size={14} />
          </Button>
        )}
      </div>
      {spentNotes.missing && <p className="warn-text money-rate-note">{spentNotes.missing}</p>}
      <TodayDue today={today} />
      <Advisor today={today} />
    </div>
  );
}

const TAB_NAMES = {
  month: "Month",
  ledger: "Ledger",
  regulars: "Pay and bills",
  loans: "Lent and owed",
  accounts: "Accounts",
  categories: "Categories",
} as const;

/** Lent and owed, per person (T-061). */
export function useLoans() {
  const events = useLiveQuery<LoanEvent & Record<string, string | number | null>>(LOANS_SQL);
  return { people: balances(events.rows), loading: events.loading };
}

function PersonRow({
  person,
  accounts,
  today,
}: {
  person: PersonBalance;
  accounts: AccountRow[];
  today: string;
}) {
  const [amount, setAmount] = useState("");
  const [account, setAccount] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const theyOwe = person.owedToMe > 0;
  const open = theyOwe ? person.owedToMe : person.iOwe;
  const last = person.events[person.events.length - 1];
  const currency = person.currency ?? "ETB";
  // Paid back in the loan's currency, into (or from) an account in it.
  const choices = accounts.filter((row) => currencyOf(row) === currency);
  const chosen =
    account ||
    (currency === "ETB" ? spendAccount(accounts) : (choices[0]?.id ?? spendAccount(accounts)));
  const settle = () => {
    const minor = amount.trim() ? (parseAmount(amount) ?? 0) : open;
    const problem = checkLoan(person.person, minor) ?? checkRepayment(person, minor);
    if (problem) {
      setNote(problem);
      return;
    }
    const kind = theyOwe ? "paid_me" : "i_paid";
    void transact(
      "user",
      loanOps({
        person: person.person,
        kind,
        amount: minor,
        date: today,
        account: chosen,
        nowMs: systemClock.now(),
        id: ulid(),
        txnId: ulid(),
        currency,
      }),
      "loan",
    )
      .then(() => {
        setNote(loanEchoText(kind, person.person, minor, Math.max(0, open - minor), currency));
        setAmount("");
      })
      .catch((failure: unknown) => setNote(`Couldn't save: ${message(failure)}`));
  };
  return (
    <li className="money-row">
      <span className="money-row-head">
        <span className="money-avatar" aria-hidden="true">
          {person.person.trim().charAt(0).toUpperCase()}
        </span>
        <span className="money-row-title">
          {person.person}
          <span className="meta">
            {" "}
            · {formatAmount(open, currency)}
            {person.since ? ` since ${showDate(person.since, today)}` : ""}
            {person.followUp ? ` · ask on ${showDate(person.followUp, today)}` : ""}
          </span>
        </span>
      </span>
      <span className="money-row-line">
        <input
          className="money-input"
          inputMode="decimal"
          aria-label={`Amount paid back, ${person.person}`}
          placeholder={`all ${formatAmount(open, currency)}`}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <select aria-label="Account" value={chosen} onChange={(e) => setAccount(e.target.value)}>
          {(choices.length > 0 ? choices : accounts).map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
            </option>
          ))}
        </select>
        <Button onClick={settle}>{theyOwe ? "Paid me back" : "I paid back"}</Button>
        {last && (
          <input
            type="date"
            aria-label={`Ask about it on, ${person.person}`}
            title="Ask about it on"
            value={person.followUp ?? ""}
            onChange={(e) =>
              void transact(
                "user",
                personFollowUpOps(person, e.target.value || null),
                "loan",
              ).catch((failure: unknown) => setNote(`Couldn't save: ${message(failure)}`))
            }
          />
        )}
      </span>
      {note && (
        <p className="meta" role="status">
          {note}
        </p>
      )}
    </li>
  );
}

function LoanForm({ accounts, today }: { accounts: AccountRow[]; today: string }) {
  const [kind, setKind] = useState<"lent" | "borrowed">("lent");
  const [person, setPerson] = useState("");
  const [amount, setAmount] = useState("");
  const [account, setAccount] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [note, setNote] = useState<string | null>(null);
  return (
    <form
      className="money-toolbar"
      onSubmit={(event) => {
        event.preventDefault();
        const minor = parseAmount(amount) ?? 0;
        const problem = checkLoan(person, minor);
        if (problem) {
          setNote(problem);
          return;
        }
        const from = account || spendAccount(accounts);
        const currency = currencyOf(accounts.find((row) => row.id === from));
        void transact(
          "user",
          loanOps({
            person,
            kind,
            amount: minor,
            date: today,
            account: from,
            nowMs: systemClock.now(),
            id: ulid(),
            txnId: ulid(),
            followUp: followUp || null,
            currency,
          }),
          "loan",
        )
          .then(() => {
            setNote(loanEchoText(kind, person.trim(), minor, null, currency));
            setPerson("");
            setAmount("");
            setFollowUp("");
          })
          .catch((failure: unknown) => setNote(`Couldn't save: ${message(failure)}`));
      }}
    >
      <select
        aria-label="Lent or borrowed"
        value={kind}
        onChange={(e) => setKind(e.target.value as "lent" | "borrowed")}
      >
        <option value="lent">I lent</option>
        <option value="borrowed">I borrowed</option>
      </select>
      <input
        inputMode="decimal"
        aria-label="Amount"
        placeholder="1,000"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      <input
        aria-label={kind === "lent" ? "To whom" : "From whom"}
        placeholder={kind === "lent" ? "to Abel" : "from Sara"}
        value={person}
        onChange={(e) => setPerson(e.target.value)}
      />
      <select
        aria-label="Account"
        value={account || spendAccount(accounts)}
        onChange={(e) => setAccount(e.target.value)}
      >
        {accounts.map((row) => (
          <option key={row.id} value={row.id}>
            {row.name}
            {currencyOf(row) !== "ETB" ? ` (${currencyOf(row)})` : ""}
          </option>
        ))}
      </select>
      <label className="money-inline">
        <span className="meta">Ask on</span>
        <input type="date" value={followUp} onChange={(e) => setFollowUp(e.target.value)} />
      </label>
      <Button type="submit">Save</Button>
      {note && (
        <span className="meta" role="status">
          {note}
        </span>
      )}
    </form>
  );
}

/** Money → Lent and owed (T-061). */
function LoansView({ today }: { today: string }) {
  const { people, loading } = useLoans();
  const accounts = useLiveQuery<AccountRow & Record<string, string | number | null>>(ACCOUNTS_SQL);
  if (loading) return null;
  const owedToMe = people.filter((person) => person.owedToMe > 0);
  const iOwe = people.filter((person) => person.iOwe > 0);
  // Kept per currency: dollars lent and birr lent are two sums.
  const total = (list: PersonBalance[], key: "owedToMe" | "iOwe") =>
    perCurrency(list.map((person) => ({ minor: person[key], currency: person.currency })));
  return (
    <>
      <LoanForm accounts={accounts.rows} today={today} />
      <div className="money-grid">
        <section className="card" aria-labelledby="owed-to-me">
          <h2 id="owed-to-me">Owed to you · {total(owedToMe, "owedToMe")}</h2>
          {owedToMe.length === 0 ? (
            <p className="empty">Nobody owes you anything. Add what you lend above.</p>
          ) : (
            <ul className="money-rows">
              {owedToMe.map((person) => (
                <PersonRow
                  key={`${person.person}|${person.currency ?? "ETB"}`}
                  person={person}
                  accounts={accounts.rows}
                  today={today}
                />
              ))}
            </ul>
          )}
        </section>
        <section className="card" aria-labelledby="i-owe">
          <h2 id="i-owe">You owe · {total(iOwe, "iOwe")}</h2>
          {iOwe.length === 0 ? (
            <p className="empty">You don&apos;t owe anyone. Add what you borrow above.</p>
          ) : (
            <ul className="money-rows">
              {iOwe.map((person) => (
                <PersonRow
                  key={`${person.person}|${person.currency ?? "ETB"}`}
                  person={person}
                  accounts={accounts.rows}
                  today={today}
                />
              ))}
            </ul>
          )}
        </section>
      </div>
      <p className="hint money-note">
        In the capture box: <code>lent 1000 abel</code>, <code>borrowed 500 from sara</code>,{" "}
        <code>abel paid back 400</code>, <code>paid back sara 500</code>. Lending moves money out of
        an account but isn&apos;t spending; being paid back isn&apos;t income.
      </p>
    </>
  );
}

const JOBS_SQL =
  "SELECT id, name FROM area_items WHERE kind = 'work' AND active = 1 AND deleted_at IS NULL ORDER BY name";

/** This month's regulars and where each stands (T-059, T-060). */
export function useDue(today: string) {
  // From a little before the month, so pay due at the end of last month that
  // is still open (or arrives now) is settled against the right date.
  const { from, txnFrom, to, shownFrom } = dueWindow(today);
  const regulars = useLiveQuery<RegularRow & Record<string, string | number | null>>(REGULARS_SQL);
  const txns = useLiveQuery<RegularTxn & Record<string, string | number | null>>(REGULAR_TXNS_SQL, [
    txnFrom,
    to,
  ]);
  return {
    items: dueItems(regulars.rows, txns.rows, from, to, today, shownFrom),
    regulars: regulars.rows,
    loading: regulars.loading || txns.loading,
  };
}

/** One tap records the payment (or the pay that came), for what is left. */
export function SettleButton({ item, today }: { item: DueItem; today: string }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Button
        onClick={() =>
          void query<{ opening_date: string | null }>(
            "SELECT opening_date FROM money_accounts WHERE id = ?",
            [item.regular.account],
          )
            .then((rows) =>
              transact(
                "user",
                settleOps(item, today, systemClock.now(), ulid(), rows[0]?.opening_date),
                `regular:${item.regular.id}`,
              ),
            )
            .catch((failure: unknown) => setError(`Couldn't record it: ${message(failure)}`))
        }
      >
        {item.regular.kind === "bill" ? "Paid" : "Received"}
      </Button>
      {error && (
        <span role="alert" className="error">
          {error}
        </span>
      )}
    </>
  );
}

const STATE_TEXT: Record<DueItem["state"], string> = {
  paid: "done",
  due: "due",
  late: "late",
  upcoming: "coming",
};

function DueRow({ item, today }: { item: DueItem; today: string }) {
  const pay = item.regular.kind === "pay";
  return (
    <li className="money-row">
      <span className="money-row-head">
        <span className={`money-day ${item.state}`} aria-hidden="true">
          {Number(item.date.slice(8, 10))}
        </span>
        <span className="money-row-title">
          {pay ? (item.regular.job ?? item.regular.name) : item.regular.name}
          <span className="meta">
            {" "}
            · {showDate(item.date, today)} ·{" "}
            {formatAmount(item.regular.amount_minor, item.regular.currency ?? "ETB")}
            {item.done > 0 && item.left > 0
              ? ` · ${formatAmount(item.left, item.regular.currency ?? "ETB")} still to ${pay ? "come" : "pay"}`
              : ""}
          </span>
        </span>
      </span>
      <span className="money-row-line">
        <span className={`money-state ${item.state}`}>{STATE_TEXT[item.state]}</span>
        {item.state !== "paid" && <SettleButton item={item} today={today} />}
        {item.state !== "paid" && item.done === 0 && <SkipButton item={item} today={today} />}
      </span>
    </li>
  );
}

/** Skip this one date (F29): it stops asking, and nothing is recorded. Undo brings it back. */
function SkipButton({ item, today }: { item: DueItem; today: string }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Button
        className="btn-ghost"
        title="Not this time: nothing is recorded"
        onClick={() =>
          void transact("user", skipOps(item, today), `regular:${item.regular.id}`).catch(
            (failure: unknown) => setError(`Couldn't skip it: ${message(failure)}`),
          )
        }
      >
        Skip
      </Button>
      {error && (
        <span role="alert" className="error">
          {error}
        </span>
      )}
    </>
  );
}

const emptyRegular = (kind: RegularDraft["kind"], account: string): RegularDraft => ({
  kind,
  name: "",
  amount: 0,
  ruleText: "monthly 1",
  categoryId: "",
  account,
  areaId: "",
});

/** Adds a regular, or changes one you have (`editing`, F29). */
function RegularForm({
  editing = null,
  onDone,
}: {
  editing?: RegularRow | null;
  onDone?: () => void;
}) {
  const accounts = useLiveQuery<AccountRow & Record<string, string | number | null>>(ACCOUNTS_SQL);
  const categories = useLiveQuery<Category>(CATEGORIES_SQL);
  const jobs = useLiveQuery<{ id: string; name: string }>(JOBS_SQL);
  const [draft, setDraft] = useState<RegularDraft>(() =>
    editing ? regularDraftOf(editing) : emptyRegular("bill", ""),
  );
  const [amountText, setAmountText] = useState(() =>
    editing ? formatNumber(editing.amount_minor) : "",
  );
  const [note, setNote] = useState<string | null>(null);
  const set = (part: Partial<RegularDraft>) => setDraft((old) => ({ ...old, ...part }));
  const account =
    draft.account ||
    (draft.kind === "pay" ? payAccount(spending(accounts.rows)) : spendAccount(accounts.rows));
  const currency = currencyOf(accounts.rows.find((row) => row.id === account));
  return (
    <section className="card money-full" aria-labelledby="regular-add">
      <h2 id="regular-add">{editing ? `Change ${editing.name}` : "Add pay or a bill"}</h2>
      <form
        className="money-form"
        onSubmit={(event) => {
          event.preventDefault();
          const full = { ...draft, account, currency, amount: parseAmount(amountText) ?? 0 };
          const problem = checkRegular(full);
          if (problem) {
            setNote(problem);
            return;
          }
          if (editing) {
            void transact("user", regularOps(full, editing.id, true), `regular:${editing.id}`)
              .then(() => onDone?.())
              .catch((failure: unknown) => setNote(`Couldn't save it: ${message(failure)}`));
            return;
          }
          void transact("user", regularOps(full, ulid()), "regular")
            .then(() => {
              setNote(`Added ${full.name.trim()}. It shows above when it falls due.`);
              setDraft(emptyRegular(draft.kind, ""));
              setAmountText("");
            })
            .catch((failure: unknown) => setNote(`Couldn't add it: ${message(failure)}`));
        }}
      >
        <div className="money-fields">
          <label className="money-field">
            <span>Kind</span>
            <select
              value={draft.kind}
              disabled={editing !== null}
              onChange={(e) => setDraft(emptyRegular(e.target.value as RegularDraft["kind"], ""))}
            >
              <option value="bill">A bill I pay</option>
              <option value="pay">Pay I receive</option>
            </select>
          </label>
          {draft.kind === "pay" ? (
            <label className="money-field">
              <span>Job</span>
              <select
                value={draft.areaId}
                onChange={(e) => {
                  const job = jobs.rows.find((row) => row.id === e.target.value);
                  set({ areaId: e.target.value, name: job ? `${job.name} pay` : draft.name });
                }}
              >
                <option value="">Pick a job…</option>
                {jobs.rows.map((job) => (
                  <option key={job.id} value={job.id}>
                    {job.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="money-field">
              <span>Name</span>
              <input
                value={draft.name}
                placeholder="Rent"
                onChange={(e) => set({ name: e.target.value })}
              />
            </label>
          )}
          <label className="money-field">
            <span>Amount ({currency})</span>
            <input
              inputMode="decimal"
              value={amountText}
              placeholder={draft.kind === "pay" ? "18,000" : "6,000"}
              onChange={(e) => setAmountText(e.target.value)}
            />
          </label>
          <label className="money-field">
            <span>When</span>
            <input
              value={draft.ruleText}
              placeholder="monthly 10"
              onChange={(e) => set({ ruleText: e.target.value })}
            />
          </label>
          {draft.kind === "bill" && (
            <label className="money-field">
              <span>Category</span>
              <select
                value={draft.categoryId}
                onChange={(e) => set({ categoryId: e.target.value })}
              >
                <option value="">None</option>
                {categories.rows
                  .filter((category) => category.kind === "expense")
                  .map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <label className="money-field">
            <span>{draft.kind === "pay" ? "Lands in" : "Paid from"}</span>
            <select value={account} onChange={(e) => set({ account: e.target.value })}>
              {accounts.rows.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                  {currencyOf(row) !== "ETB" ? ` (${currencyOf(row)})` : ""}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="money-actions">
          <Button type="submit">{editing ? "Save" : "Add"}</Button>
          {editing && (
            <Button className="btn-ghost" onClick={() => onDone?.()}>
              Cancel
            </Button>
          )}
          <span className="meta">
            When: <code>monthly 10</code>, <code>monthly last</code>, <code>every mon</code>,{" "}
            <code>every weekday</code>.
          </span>
        </div>
        {note && (
          <p className="meta" role="status">
            {note}
          </p>
        )}
      </form>
    </section>
  );
}

/** Payments that look regular (T-072): Track it adds the bill; No stops asking. */
function SuggestedRegulars({ today, regulars }: { today: string; regulars: RegularRow[] }) {
  const rows = useLiveQuery<SuggestRow & Record<string, string | number | null>>(SUGGEST_SQL, [
    suggestSince(today),
  ]);
  const dismissed = useLiveQuery<{ value_json: string }>(
    "SELECT value_json FROM core_settings WHERE key = ?",
    [DISMISSED_SUGGESTIONS_KEY],
  );
  const [error, setError] = useState<string | null>(null);
  if (rows.loading || dismissed.loading) return null;
  const json = dismissed.rows[0]?.value_json;
  const suggestions = suggestRegulars(rows.rows, regulars, readDismissed(json));
  if (suggestions.length === 0) return null;
  const write = (ops: Op[]) =>
    void transact("user", ops, "regular").catch((failure: unknown) =>
      setError(`Couldn't save: ${message(failure)}`),
    );
  return (
    <section className="card" aria-labelledby="regular-suggest">
      <h2 id="regular-suggest">Track these?</h2>
      <ul className="money-rows">
        {suggestions.slice(0, 3).map((suggestion) => (
          <li key={suggestion.key} className="money-row">
            <span>{suggestion.text}</span>
            <span className="money-row-line">
              <Button onClick={() => write(trackOps(suggestion, ulid()))}>Track it</Button>
              <Button onClick={() => write(notAgainOps(json, suggestion.key))}>No</Button>
            </span>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}

/** Regulars (T-059, T-060): pay you expect and bills you pay, this month. */
function RegularsView({ today }: { today: string }) {
  const { items, regulars, loading } = useDue(today);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = regulars.find((row) => row.id === editingId) ?? null;
  if (loading) return null;
  const pay = items.filter((item) => item.regular.kind === "pay");
  const bills = items.filter((item) => item.regular.kind === "bill");
  // The bar compares like with like: one currency's pay at a time, the first one's.
  const payCurrency = pay[0]?.regular.currency ?? "ETB";
  const sameCurrency = pay.filter((item) => (item.regular.currency ?? "ETB") === payCurrency);
  const expected = sameCurrency.reduce((sum, item) => sum + item.regular.amount_minor, 0);
  const received = sameCurrency.reduce((sum, item) => sum + item.done, 0);
  const allExpected = perCurrency(
    pay.map((item) => ({ minor: item.regular.amount_minor, currency: item.regular.currency })),
  );
  const allReceived = perCurrency(
    pay.map((item) => ({ minor: item.done, currency: item.regular.currency })),
  );
  return (
    <div className="money-grid">
      <section className="card" aria-labelledby="regular-pay">
        <h2 id="regular-pay">Pay this month</h2>
        {pay.length === 0 ? (
          <p className="empty">
            Add each job&apos;s pay below (yours: the 10th and the 21st, into CBO). Income you
            capture as <code>got 18k job a</code> counts toward it.
          </p>
        ) : (
          <>
            <p className="money-progress-line">
              <strong className="money-num">{allReceived}</strong> of {allExpected} received
            </p>
            {expected > 0 && <Bar value={received / expected} label="Pay received this month" />}
            <ul className="money-rows">
              {pay.map((item) => (
                <DueRow key={`${item.regular.id}${item.date}`} item={item} today={today} />
              ))}
            </ul>
          </>
        )}
      </section>
      <section className="card" aria-labelledby="regular-bills">
        <h2 id="regular-bills">Bills this month</h2>
        {bills.length === 0 ? (
          <p className="empty">No bills yet. Add rent and the others below.</p>
        ) : (
          <ul className="money-rows">
            {bills.map((item) => (
              <DueRow key={`${item.regular.id}${item.date}`} item={item} today={today} />
            ))}
          </ul>
        )}
      </section>
      <SuggestedRegulars today={today} regulars={regulars} />
      {editing ? (
        <RegularForm key={editing.id} editing={editing} onDone={() => setEditingId(null)} />
      ) : (
        <RegularForm key="new" />
      )}
      {regulars.length > 0 && (
        <section className="card" aria-labelledby="regular-all">
          <h2 id="regular-all">All regulars</h2>
          <ul className="money-rows">
            {regulars.map((row) => (
              <li key={row.id} className="money-row">
                <span>
                  {row.kind === "pay" ? (row.job ?? row.name) : row.name}
                  <span className="meta">
                    {" "}
                    · {regularText(row)}
                    {row.active !== 1 ? " · paused" : ""}
                  </span>
                </span>
                <span className="money-row-line">
                  <Button className="btn-ghost" onClick={() => setEditingId(row.id)}>
                    Edit
                  </Button>
                  <Button
                    className="btn-ghost"
                    onClick={() =>
                      void transact("user", pauseOps(row), `regular:${row.id}`).catch(
                        (failure: unknown) => setError(`Couldn't change it: ${message(failure)}`),
                      )
                    }
                  >
                    {row.active === 1 ? "Pause" : "Resume"}
                  </Button>
                  <Button
                    className="btn-ghost btn-danger"
                    onClick={() =>
                      void transact("user", removeRegularOps(row.id), `regular:${row.id}`).catch(
                        (failure: unknown) => setError(`Couldn't remove it: ${message(failure)}`),
                      )
                    }
                  >
                    Remove
                  </Button>
                </span>
              </li>
            ))}
          </ul>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
        </section>
      )}
    </div>
  );
}

/** Today: bills due or late, and pay that is late, each with its button. */
export function TodayDue({ today }: { today: string }) {
  const { items, loading } = useDue(today);
  if (loading) return null;
  const open = items.filter((item) =>
    item.regular.kind === "bill"
      ? item.state === "due" || item.state === "late"
      : item.state === "late",
  );
  if (open.length === 0) return null;
  const lines = dueLines(open, today);
  return (
    <ul className="list-rows money-due">
      {open.map((item, index) => (
        <li key={`${item.regular.id}${item.date}`}>
          <span className={item.state === "late" ? "dot-pink" : "dot-cream"} aria-hidden="true" />
          <span className={item.state === "late" ? "grow warn-text" : "grow"}>{lines[index]}</span>
          <SettleButton item={item} today={today} />
        </li>
      ))}
    </ul>
  );
}

function AccountItem({
  account,
  all,
  regulars,
  today,
  sinceJson,
}: {
  account: AccountRow;
  all: AccountRow[];
  regulars: RegularRow[];
  today: string;
  /** When accounts became savings accounts (money.savings_since). */
  sinceJson: string | undefined;
}) {
  const [name, setName] = useState(account.name);
  const [typed, setTyped] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const balance = balanceOf(account);
  const currency = currencyOf(account);
  const savings = isSavings(account);
  const write = (ops: Op[], done?: string) =>
    transact("user", ops, `account:${account.id}`)
      .then(() => {
        if (done) setNote(done);
      })
      .catch((failure: unknown) => setNote(`Couldn't change it: ${message(failure)}`));
  const reconcile = () => {
    const minor = parseAmount(typed.replace(/^\s*-/, ""));
    if (minor === null) {
      setNote("The balance your bank or app shows, like 12,400.");
      return;
    }
    const signed = typed.trim().startsWith("-") ? -minor : minor;
    void query<{ minor: number }>(DAY_MOVED_SQL, [account.id, today]).then(([moved]) => {
      const text = reconcileText(account, signed);
      const ops = reconcileOps(
        account,
        signed,
        today,
        moved?.minor ?? 0,
        systemClock.now(),
        ulid(),
      );
      setTyped("");
      if (ops.length === 0) setNote(text);
      else void write(ops, text);
    });
  };
  return (
    <li className="money-row">
      <span className="money-row-line">
        <input
          className="money-input"
          aria-label={`Name of ${account.name}`}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        {name.trim() !== account.name && (
          <Button
            onClick={() => {
              const problem = checkAccountName(name, all, account.id);
              if (problem) setNote(problem);
              else void write(renameAccountOps(account.id, name));
            }}
          >
            Rename
          </Button>
        )}
        <strong className="money-balance money-num">
          {balance === null ? "Balance not set" : formatAmount(balance, currency)}
        </strong>
        {account.pays_in === 1 && <span className="chip">pay lands here</span>}
        {savings && <span className="chip">savings</span>}
        <select
          aria-label={`Currency of ${account.name}`}
          value={currency}
          onChange={(e) => {
            const next = e.target.value;
            void query<{ n: number }>(ACCOUNT_TXN_COUNT_SQL, [account.id]).then(([count]) => {
              const problem = checkCurrency(account, count?.n ?? 0);
              if (problem) setNote(problem);
              else void write(currencyOps(account.id, next), `${account.name} is in ${next} now.`);
            });
          }}
        >
          {[...new Set([...CURRENCIES, currency])].map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>
      </span>
      <span className="money-row-line">
        <input
          className="money-input"
          inputMode="decimal"
          aria-label={`Balance of ${account.name} now`}
          placeholder={balance === null ? "Balance now" : "Bank shows…"}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
        <Button onClick={reconcile} disabled={!typed.trim()}>
          {balance === null ? "Set" : "Check"}
        </Button>
        {account.pays_in !== 1 && !savings && (
          <Button
            onClick={() => {
              const problem = checkPayAccount(account);
              if (problem) setNote(problem);
              else void write(setPayAccountOps(account.id, all), "Pay will land here.");
            }}
          >
            Pay lands here
          </Button>
        )}
        <Button
          onClick={() => {
            const problem = checkSavings(account, !savings);
            if (problem) setNote(problem);
            else
              void write(
                savingsOps(account, !savings, sinceJson, systemClock.now()),
                savings
                  ? `${account.name} is a spending account again.`
                  : `${account.name} is a savings account: money moved in counts as saving, and safe to spend leaves it out.`,
              );
          }}
        >
          {savings ? "Back to spending" : "Make it savings"}
        </Button>
        <Button
          onClick={() => {
            const problem = checkHide(account, regulars);
            if (problem) setNote(problem);
            else void write(hideAccountOps(account.id));
          }}
        >
          Hide
        </Button>
      </span>
      {note && (
        <p className="meta" role="status">
          {note}
        </p>
      )}
    </li>
  );
}

function TransferForm({ accounts, today }: { accounts: AccountRow[]; today: string }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const { rates } = useRates();
  const goals = useLiveQuery<GoalRow & Record<string, string | number | null>>(GOALS_SQL);
  const goalHeld = useLiveQuery<GoalHeld & Record<string, string | number>>(GOAL_HELD_SQL);
  const source = accounts.find((account) => account.id === from);
  const target = accounts.find((account) => account.id === to);
  // Between two currencies, the other half is worked out at the saved rate (time-first §3).
  const exchange = source && target && currencyOf(source) !== currencyOf(target);
  return (
    <form
      className="money-toolbar"
      onSubmit={(event) => {
        event.preventDefault();
        const minor = parseAmount(amount) ?? 0;
        const problem = checkTransfer(from, to, minor);
        if (problem || !source || !target) {
          setNote(problem ?? "Pick both accounts.");
          return;
        }
        const halves = transferAmounts({ from: source, to: target, amount: minor, rates });
        if ("problem" in halves) {
          setNote(`${halves.problem}.`);
          return;
        }
        const transferId = ulid();
        const nowMs = systemClock.now();
        // Into or out of a savings account it is saving, counted in the same write.
        const saving = transferSaving({
          from: source,
          to: target,
          sent: halves.sent,
          received: halves.received,
          rates,
        });
        // Out of savings, only a goal holding it there pays, a finished one first (F32, F33).
        const pays = saving && transferGoal(goals.rows, saving, goalHeld.rows);
        void transact(
          "user",
          [
            ...transferOps({
              from: source,
              to: target,
              amount: halves.sent,
              ...(exchange ? { received: halves.received } : {}),
              date: today,
              nowMs,
              ids: [ulid(), ulid()],
              transferId,
            }),
            ...transferSavingOps({
              saving,
              goalId: pays?.goalId ?? null,
              transferId,
              nowMs,
              date: today,
              id: ulid(),
              origin: pays?.unheld ? UNHELD : "transfer",
            }),
          ],
          "transfer",
        )
          .then(() => {
            setNote(
              `Moved ${formatAmount(halves.sent, currencyOf(source))} from ${source.name} to ${target.name}${
                exchange
                  ? ` (${formatAmount(halves.received, currencyOf(target))} at ${
                      rates[currencyOf(source) === "ETB" ? currencyOf(target) : currencyOf(source)]
                        ?.rate ?? ""
                    })`
                  : ""
              }.${saving ? (saving.minor > 0 ? " It counts as saving." : " Taken from savings.") : ""}`,
            );
            setAmount("");
          })
          .catch((failure: unknown) => setNote(`Couldn't move it: ${message(failure)}`));
      }}
    >
      <span>Move</span>
      <input
        inputMode="decimal"
        aria-label={source ? `Amount to move, ${currencyOf(source)}` : "Amount to move"}
        placeholder="2,000"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      <select aria-label="From" value={from} onChange={(e) => setFrom(e.target.value)}>
        <option value="">from…</option>
        {accounts.map((account) => (
          <option key={account.id} value={account.id}>
            {account.name}
          </option>
        ))}
      </select>
      <select aria-label="To" value={to} onChange={(e) => setTo(e.target.value)}>
        <option value="">to…</option>
        {accounts.map((account) => (
          <option key={account.id} value={account.id}>
            {account.name}
          </option>
        ))}
      </select>
      <Button type="submit">Move</Button>
      {note && (
        <span className="meta" role="status">
          {note}
        </span>
      )}
    </form>
  );
}

/** One rate: birr for one unit, with the day it was set. */
function RateRow({ code, rates, today }: { code: string; rates: Rates; today: string }) {
  const current = rates[code];
  const saved = current?.rate ?? "";
  const [box, setBox] = useState({ saved, text: saved });
  // A new saved rate shows in the box without remounting the row (note and focus stay).
  const synced = syncRateBox(box, saved);
  if (synced !== box) setBox(synced);
  const text = synced.text;
  const setText = (value: string) => setBox({ saved, text: value });
  const [note, setNote] = useState<string | null>(null);
  const save = (value: string) => {
    const problem = value.trim() ? checkRate(value) : null;
    if (problem) {
      setNote(problem);
      return;
    }
    void transact("user", rateOps(rates, code, value, today), "money.rates")
      .then(() => setNote(value.trim() ? `1 ${code} = ${value.trim()} ETB from today.` : null))
      .catch((failure: unknown) => setNote(`Couldn't save it: ${message(failure)}`));
  };
  return (
    <li>
      <span className="money-num">1 {code} =</span>
      <input
        className="money-input"
        inputMode="decimal"
        aria-label={`ETB for one ${code}`}
        placeholder="132.50"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <span className="meta">ETB</span>
      <Button disabled={text.trim() === (current?.rate ?? "")} onClick={() => save(text)}>
        Set
      </Button>
      <span className="meta">
        {current ? `set ${showDate(current.set_on, today)}` : "no rate: left out of totals"}
      </span>
      {note && (
        <span className="meta" role="status">
          {note}
        </span>
      )}
    </li>
  );
}

/** Rates for the currencies you hold (time-first §3): totals convert at these. */
function RatesCard({ accounts, today }: { accounts: AccountRow[]; today: string }) {
  const { rates, loading } = useRates();
  if (loading) return null;
  const codes = [
    ...new Set([
      ...accounts.map(currencyOf),
      ...Object.keys(rates),
      ...CURRENCIES.filter((code) => code !== "ETB"),
    ]),
  ].filter((code) => code !== "ETB");
  return (
    <section className="card" aria-labelledby="money-rates">
      <h2 id="money-rates">Exchange rates</h2>
      <ul className="money-rates">
        {codes.map((code) => (
          <RateRow key={code} code={code} rates={rates} today={today} />
        ))}
      </ul>
      <p className="hint">
        Totals, safe to spend and net worth count other currencies at these rates, marked ≈. Update
        one when it moves; money with no rate is left out and the page says so.
      </p>
    </section>
  );
}

/** Accounts (T-058): balances, checking them against the bank, moving money. */
function AccountsView({ today }: { today: string }) {
  const accounts = useLiveQuery<AccountRow & Record<string, string | number | null>>(ACCOUNTS_SQL);
  const regulars = useLiveQuery<RegularRow & Record<string, string | number | null>>(REGULARS_SQL);
  const since = useLiveQuery<{ value_json: string }>(SAVINGS_SINCE_SQL);
  const { rates } = useRates();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<AccountRow["kind"]>("bank");
  const [currency, setCurrency] = useState("ETB");
  const [savings, setSavings] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const conversion = newConversion();
  const { total, unknown } = totalBalance(inEtb(accounts.rows, rates, conversion));
  const notes = conversionNotes(conversion, rates);
  return (
    <>
      <p className="money-headline">
        <strong className="money-num">
          {approxMark(notes)}
          {formatAmount(total)}
        </strong>{" "}
        in your accounts
        {unknown > 0 && (
          <span className="meta">
            {" "}
            · {unknown} without a balance yet: type what each one shows now
          </span>
        )}
      </p>
      <RateNotes notes={notes} />
      <section className="card" aria-label="Accounts">
        {accounts.rows.length === 0 && !accounts.loading && (
          <p className="empty">No accounts yet. Add one under Add an account.</p>
        )}
        <ul className="money-rows">
          {accounts.rows.map((account) => (
            <AccountItem
              key={account.id}
              account={account}
              all={accounts.rows}
              regulars={regulars.rows}
              today={today}
              sinceJson={since.rows[0]?.value_json}
            />
          ))}
        </ul>
        <p className="hint">
          A balance is what you typed plus everything recorded since. When the bank shows something
          else, type it under Check: the difference is booked as unrecorded spending or income.
        </p>
      </section>
      <div className="money-grid">
        <section className="card" aria-labelledby="money-move">
          <h2 id="money-move">Move money</h2>
          <TransferForm accounts={accounts.rows} today={today} />
        </section>
        <section className="card" aria-labelledby="money-new-account">
          <h2 id="money-new-account">Add an account</h2>
          <form
            className="money-toolbar"
            onSubmit={(event) => {
              event.preventDefault();
              const problem = checkAccountName(name, accounts.rows);
              if (problem) {
                setNote(problem);
                return;
              }
              void transact(
                "user",
                addAccountOps(name, kind, accounts.rows, currency, savings),
                "account",
              )
                .then(() => {
                  setNote(`Added ${name.trim()}.`);
                  setName("");
                  setSavings(false);
                })
                .catch((failure: unknown) => setNote(`Couldn't add it: ${message(failure)}`));
            }}
          >
            <input
              aria-label="New account"
              placeholder="New account, e.g. Awash"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <select
              aria-label="Kind of account"
              value={kind}
              onChange={(e) => setKind(e.target.value as AccountRow["kind"])}
            >
              <option value="bank">Bank</option>
              <option value="mobile">Mobile money</option>
              <option value="cash">Cash</option>
              <option value="other">Other (equb…)</option>
            </select>
            <select
              aria-label="Currency"
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
            >
              {CURRENCIES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
            <label className="money-inline">
              <input
                type="checkbox"
                checked={savings}
                onChange={(e) => setSavings(e.target.checked)}
              />
              <span>Savings account</span>
            </label>
            <Button type="submit">Add account</Button>
            {note && (
              <span className="meta" role="status">
                {note}
              </span>
            )}
          </form>
        </section>
      </div>
      <RatesCard accounts={accounts.rows} today={today} />
      <p className="hint money-note">
        In the capture box: <code>lunch 120 @telebirr</code> spends from telebirr;{" "}
        <code>moved 2000 cbe to telebirr</code> moves money between accounts. A savings account
        backs your goals: money moved into it counts as saving, and safe to spend leaves it out (net
        worth keeps it).
      </p>
    </>
  );
}

const TITLE_MONTH = new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: "UTC" });

/** Money (proposal 1.1): the month at a glance, and every entry to find, fix or export. */
export function Money() {
  const [today] = useState(() => logicalDate(systemClock.now()));
  const [month, setMonth] = useState(() => monthOf(today).from);
  const [tab, setTab] = useState<keyof typeof TAB_NAMES>("month");
  const [adding, setAdding] = useState(false);
  const isCurrent = month === monthOf(today).from;
  const [year = 1970, monthNo = 1] = month.split("-").map(Number);
  const openAccounts = () => setTab("accounts");
  // A move into a savings account counts as saving on every tab, not only Month.
  useSavingsSync();
  return (
    <main className="page money-page">
      <div className="layout-split">
        <aside className="side" aria-label="Money at a glance">
          <SafeCard today={today} onAccounts={openAccounts} />
          <AccountsPanel onOpen={openAccounts} />
          <Advisor today={today} framed />
          <SideAfford today={today} />
          <EmergencyCard today={today} />
        </aside>

        <div className="main">
          <section className="canvas money-canvas" aria-labelledby="money-title">
            <header className="canvas-head">
              <h1 id="money-title" className="page-title">
                <span className="visually-hidden">Money: </span>
                {TITLE_MONTH.format(Date.UTC(year, monthNo - 1, 1))},{" "}
                <span className="soft">{year}</span>
              </h1>
              <span className="money-months">
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Previous month"
                  onClick={() => setMonth(previousMonthStart(month))}
                >
                  <IconArrowLeft size={18} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Next month"
                  disabled={isCurrent}
                  onClick={() => setMonth(monthOf(shiftDate(monthOf(month).to, 1)).from)}
                >
                  <IconArrowRight size={18} />
                </button>
              </span>
              <span className="spacer" />
              <Button
                primary
                onClick={() => {
                  if (tab === "ledger" && adding) setAdding(false);
                  else {
                    setTab("ledger");
                    setAdding(true);
                  }
                }}
              >
                {tab === "ledger" && adding ? (
                  "Close"
                ) : (
                  <>
                    <IconPlus size={16} /> Add entry
                  </>
                )}
              </Button>
            </header>
            <div className="money-tabs">
              <Segmented
                label="View"
                options={(Object.keys(TAB_NAMES) as (keyof typeof TAB_NAMES)[]).map((name) => ({
                  value: name,
                  label: TAB_NAMES[name],
                }))}
                value={tab}
                onChange={setTab}
              />
            </div>
            {tab === "month" && <MonthView month={month} today={today} />}
            {tab === "ledger" && (
              <LedgerView
                month={month}
                today={today}
                adding={adding}
                onCloseAdd={() => setAdding(false)}
              />
            )}
            {tab === "regulars" && <RegularsView today={today} />}
            {tab === "loans" && <LoansView today={today} />}
            {tab === "accounts" && <AccountsView today={today} />}
            {tab === "categories" && <CategoriesView today={today} />}
          </section>
        </div>
      </div>
    </main>
  );
}
