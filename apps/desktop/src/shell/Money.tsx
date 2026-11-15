import { useEffect, useRef, useState } from "react";

import { systemClock } from "../kernel/clock";
import { logicalDate } from "../kernel/dates";
import { type Op, query, transact } from "../kernel/db";
import { formatAmount, parseAmount } from "../kernel/money";
import { ulid } from "../kernel/ulid";
import {
  byDay,
  CATEGORIES_SQL,
  checkTxn,
  filterLedger,
  HISTORY_SQL,
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
  type AccountRow,
  ACCOUNTS_SQL,
  addAccountOps,
  balanceOf,
  checkAccountName,
  checkHide,
  checkTransfer,
  DAY_MOVED_SQL,
  hideAccountOps,
  payAccount,
  reconcileOps,
  reconcileText,
  renameAccountOps,
  setPayAccountOps,
  spendAccount,
  totalBalance,
  transferOps,
} from "../features/money/accounts";
import {
  checkRegular,
  type DueItem,
  dueItems,
  dueLines,
  dueWindow,
  type RegularDraft,
  regularOps,
  type RegularRow,
  REGULARS_SQL,
  regularText,
  REGULAR_TXNS_SQL,
  type RegularTxn,
  removeRegularOps,
  settleOps,
} from "../features/money/regulars";
import {
  balances,
  checkLoan,
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
import { addGoalOps, type GoalRow, GOALS_SQL, UNASSIGNED_SQL } from "../features/savings/savings";
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
import { Savings } from "./Savings";
import { Bar, Button } from "./ui";
import { useLiveQuery } from "./useLiveQuery";

interface Category extends Record<string, string> {
  id: string;
  name: string;
  kind: "expense" | "income";
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const birr = (minor: number) => formatAmount(minor).replace(/ ETB$/, "");

function useMonth(month: string, today: string) {
  const { from, to } = monthOf(month);
  const txns = useLiveQuery<TxnRow & Record<string, string | number | null>>(TXNS_SQL, [from, to]);
  const saved = useLiveQuery<{ minor: number }>(SAVED_SQL, [from, to]);
  const history = useLiveQuery<HistoryRow & Record<string, string | number | null>>(
    HISTORY_SQL,
    historyParams(month),
  );
  // A past month is seen from its last day; this month from today.
  const asOf = to < today ? to : today;
  const summary = monthSummary({
    txns: txns.rows,
    saved: saved.rows[0]?.minor ?? 0,
    history: history.rows,
    today: asOf,
  });
  return {
    txns,
    summary,
    usual: usualByCategory(history.rows),
    current: to >= today,
    loading: txns.loading || history.loading,
  };
}

/** Safe to spend for the month `today` is in (T-062). */
export function useSafe(today: string) {
  const { from, to, days } = monthOf(today);
  const accounts = useLiveQuery<AccountRow & Record<string, string | number | null>>(ACCOUNTS_SQL);
  const goals = useLiveQuery<GoalRow & Record<string, string | number | null>>(GOALS_SQL);
  const saved = useLiveQuery<{ goal_id: string; minor: number }>(GOAL_MONTH_SQL, [from, to]);
  const waiting = useLiveQuery<{ minor: number; n: number }>(UNASSIGNED_SQL);
  const { items, loading } = useDue(today);
  const safe = safeToSpend({
    accounts: accounts.rows,
    goals: goals.rows,
    savedThisMonth: Object.fromEntries(saved.rows.map((row) => [row.goal_id, row.minor])),
    due: items,
    today,
    daysInMonth: days,
    unassigned: waiting.rows[0]?.minor ?? 0,
  });
  return {
    safe,
    goals: goals.rows,
    loading: loading || accounts.loading || goals.loading || saved.loading || waiting.loading,
  };
}

function SafeCard({ today }: { today: string }) {
  const { safe, loading } = useSafe(today);
  const [open, setOpen] = useState(false);
  if (loading) return null;
  if (!safe.known)
    return (
      <p className="meta">
        Set what one of your accounts shows (Accounts tab) and Sirna can tell you what is safe to
        spend each day, after bills, pay still to come and your goals.
      </p>
    );
  return (
    <section className="card" aria-labelledby="safe">
      <h2 id="safe">Safe to spend</h2>
      <p className={safe.total <= 0 ? "warn-text" : undefined}>
        <strong>{safeLine(safe)}</strong>
        <span className="meta"> · {safe.daysLeft} days left</span>
      </p>
      <Button onClick={() => setOpen((shown) => !shown)}>{open ? "Hide the sum" : "How?"}</Button>
      {open && (
        <ul className="plain-list">
          {safe.lines.map((line) => (
            <li key={line.label} className="row money-line">
              <span>{line.label}</span>
              <span>
                {line.amount < 0 ? "−" : "+"}
                {formatAmount(Math.abs(line.amount))}
              </span>
            </li>
          ))}
          <li className="row money-line">
            <strong>Safe to spend</strong>
            <strong>{formatAmount(safe.total)}</strong>
          </li>
        </ul>
      )}
      {safe.unknownAccounts > 0 && (
        <p className="meta">
          {safe.unknownAccounts} account{safe.unknownAccounts === 1 ? "" : "s"} without a balance
          yet aren&apos;t counted.
        </p>
      )}
    </section>
  );
}

function EmergencyCard({ today }: { today: string }) {
  const { goals, loading } = useSafe(today);
  const history = useLiveQuery<HistoryRow & Record<string, string | number | null>>(
    HISTORY_SQL,
    historyParams(today),
  );
  const [note, setNote] = useState<string | null>(null);
  if (loading || history.loading) return null;
  const month = essentialMonth(usualByCategory(history.rows));
  const fund = goals.find((goal) => isEmergency(goal) && goal.status !== "done");
  if (fund) {
    const covered = monthsCovered(fund.saved_minor, month);
    return (
      <p>
        Emergency fund:{" "}
        <strong>
          {covered === null
            ? formatAmount(Math.max(0, fund.saved_minor))
            : `covers ${covered} months`}
        </strong>
        <span className="meta">
          {" "}
          of essentials · aim for {EMERGENCY_MONTHS}
          {month !== null ? ` (${formatAmount(month)} a month)` : ""}
        </span>
      </p>
    );
  }
  return (
    <p className="row">
      <span className="meta">
        No emergency fund yet. {EMERGENCY_MONTHS} months of essentials
        {month !== null
          ? ` is about ${formatAmount(emergencyTarget(month))}`
          : " (known after a month of entries)"}
        .
      </span>
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
        <span className="meta" role="status">
          {note}
        </span>
      )}
    </p>
  );
}

function MonthView({ month, today }: { month: string; today: string }) {
  const { summary, current, loading } = useMonth(month, today);
  if (loading) return null;
  const biggest = Math.max(
    1,
    ...summary.categories.map((line) => Math.max(line.spent, line.usual ?? 0)),
  );
  const empty = summary.in === 0 && summary.out === 0 && summary.saved === 0;
  return (
    <>
      {!current && <MonthReviewCard month={month} today={today} />}
      <div className="tiles">
        <div className="card tile">
          <span className="meta">In</span>
          <strong>{birr(summary.in)}</strong>
        </div>
        <div className="card tile">
          <span className="meta">Out</span>
          <strong>{birr(summary.out)}</strong>
        </div>
        <div className="card tile">
          <span className="meta">Saved</span>
          <strong>{birr(summary.saved)}</strong>
        </div>
        <div className="card tile">
          <span className="meta">{summary.left >= 0 ? "Left" : "Over"}</span>
          <strong className={summary.left < 0 ? "warn-text" : undefined}>
            {birr(Math.abs(summary.left))}
          </strong>
          {current && summary.perDay !== null && (
            <span className="meta">about {birr(summary.perDay)} a day</span>
          )}
        </div>
      </div>
      {empty && (
        <p className="meta">
          Nothing recorded {current ? "yet this month" : "that month"}. Type money in the capture
          box (<code>lunch 120</code>, <code>+18000 salary</code>) or add it in Ledger.
        </p>
      )}
      {current && (
        <p className="meta">
          Day {summary.day} of {summary.days}. Left = in − out − saved this month.
        </p>
      )}
      {current && <Advisor today={today} />}
      {current && <SafeCard today={today} />}
      {current && <AffordBox today={today} summary={summary} />}
      {current && <EmergencyCard today={today} />}

      {summary.sources.length > 0 && (
        <section className="card" aria-labelledby="money-in">
          <h2 id="money-in">Money in</h2>
          <ul className="plain-list">
            {summary.sources.map((source) => (
              <li key={source.name} className="row money-line">
                <span>{source.name}</span>
                <span>{formatAmount(source.amount)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {summary.categories.length > 0 && (
        <section className="card" aria-labelledby="money-out">
          <h2 id="money-out">Where it went</h2>
          <ul className="spend-bars">
            {summary.categories.map((line) => (
              <li key={line.id}>
                <span>{line.name}</span>
                <span className="spend-pair">
                  <span
                    className="spend-bar"
                    style={{ width: `${(line.spent / biggest) * 100}%` }}
                    aria-label={`${line.name} ${formatAmount(line.spent)}`}
                  />
                  {line.usual !== null && (
                    <span
                      className="spend-bar usual"
                      style={{ width: `${(line.usual / biggest) * 100}%` }}
                      aria-label={`${line.name} usually ${formatAmount(line.usual)}`}
                    />
                  )}
                </span>
                <span className="meta">
                  {formatAmount(line.spent)}
                  {line.usual !== null ? ` · usually ${formatAmount(line.usual)}` : ""}
                </span>
              </li>
            ))}
          </ul>
          {summary.categories.some((line) => line.usual !== null) && (
            <p className="meta">The grey bar is your usual month (the middle of the last 3).</p>
          )}
        </section>
      )}

      <JobRatesCard month={month} today={today} />
      {current && <CapsCard summary={summary} />}

      <Savings />
    </>
  );
}

/** Caps this month (T-063): spent against each cap, with where the month is. */
function CapsCard({ summary }: { summary: ReturnType<typeof monthSummary> }) {
  const caps = useLiveQuery<{ id: string; name: string; cap_minor: number }>(CAPS_SQL);
  if (caps.loading) return null;
  if (caps.rows.length === 0)
    return (
      <p className="meta">
        No caps yet. Set one per category under Categories; Sirna suggests amounts from your usual
        month.
      </p>
    );
  const spent = new Map(summary.categories.map((line) => [line.id, line.spent]));
  return (
    <section className="card" aria-labelledby="money-caps">
      <h2 id="money-caps">Caps this month</h2>
      <ul className="plain-list caps">
        {caps.rows.map((cap) => {
          const used = spent.get(cap.id) ?? 0;
          const status = capStatus(used, cap.cap_minor, summary.day, summary.days);
          return (
            <li key={cap.id} className="cap-line">
              <span className="row money-line">
                <span>{cap.name}</span>
                <span className={status.over || status.ahead ? "warn-text" : "meta"}>
                  {formatAmount(used)} of {formatAmount(cap.cap_minor)}
                  {status.over
                    ? ` · over by ${formatAmount(used - cap.cap_minor)}`
                    : ` · ${formatAmount(status.left)} left${status.ahead ? ", spending fast" : ""}`}
                </span>
              </span>
              <span className="cap-bar">
                <Bar
                  value={status.share}
                  label={`${cap.name} ${Math.round(status.share * 100)}% of its cap`}
                />
                <span
                  className="cap-pace"
                  style={{ left: `${status.pace * 100}%` }}
                  title={`Day ${summary.day} of ${summary.days}`}
                />
              </span>
            </li>
          );
        })}
      </ul>
      <p className="meta">The mark is how far through the month you are.</p>
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
      <p>{finding.text}</p>
      {stored && <p className="meta">{stored}</p>}
      <span className="row">
        {finding.actions.map((action) => (
          <Button
            key={action.label}
            primary
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
        <span role="alert" className="error">
          {error}
        </span>
      )}
    </li>
  );
}

/** The advisor: what needs you about money today, if anything. */
export function Advisor({ today }: { today: string }) {
  const { shown, hiddenJson, loading } = useAdvisor(today);
  const tips = useLiveQuery<{ value_json: string }>(
    "SELECT value_json FROM core_settings WHERE key = ?",
    [TIPS_KEY],
  );
  const strict = strictOrNull(useLiveQuery<{ value_json: string | null }>(STRICT_SQL));
  if (loading || tips.loading || shown.length === 0) return null;
  return (
    <section className="card advisor" aria-labelledby="advisor">
      <h2 id="advisor">Worth a look</h2>
      <ul className="plain-list">
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
    <section className="card" aria-labelledby="afford">
      <h2 id="afford">Can I afford it?</h2>
      <form
        className="row task-filters"
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
        <div className={answer.verdict === "Fine" ? "afford fine" : "afford warn-text"}>
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
        </div>
      )}
    </section>
  );
}

/** The month review (T-066): the month that `month` starts, seen from `today`. */
export function MonthReviewCard({ month, today }: { month: string; today: string }) {
  const { summary, usual, loading } = useMonth(month, today);
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
  });
  if (review.in === 0 && review.out === 0) return null;
  return (
    <section className="card" aria-labelledby="month-review">
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
          Net worth now: {formatAmount(review.netWorth)} (accounts, plus owed to you, less what you
          owe)
        </p>
      )}
    </section>
  );
}

/** Birr per hour for each job (T-073): this month's pay over its blocks' hours. */
function JobRatesCard({ month, today }: { month: string; today: string }) {
  const { from, to } = monthOf(month);
  const [nowMs] = useState(() => systemClock.now());
  const minutes = useLiveQuery<{ area_id: string; name: string; minutes: number }>(
    JOB_MINUTES_SQL,
    [from, to, nowMs],
  );
  const pay = useLiveQuery<{ area_id: string; minor: number }>(JOB_PAY_SQL, [from, to]);
  if (minutes.loading || pay.loading || minutes.rows.length === 0) return null;
  const rates = jobRates(minutes.rows, pay.rows);
  return (
    <section className="card" aria-labelledby="job-rates">
      <h2 id="job-rates">Your jobs</h2>
      <ul className="plain-list">
        {rates.map((rate) => (
          <li key={rate.areaId} className="row money-line">
            <span>{rate.name}</span>
            <span className="meta">
              {formatAmount(rate.pay)} for {Math.round(rate.minutes / 60)} h
              {rate.perHour !== null ? ` · about ${formatAmount(rate.perHour)} an hour` : ""}
            </span>
          </li>
        ))}
      </ul>
      <p className="meta">
        Hours are the job&apos;s blocks {to < today ? "that month" : "so far this month"} (skipped
        or moved ones left out); pay is income you recorded for that job.
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
  const set = (part: Partial<TxnDraft>) => setDraft((old) => ({ ...old, ...part }));
  const shown = categories.filter(
    (category) => category.kind === (draft.kind === "in" ? "income" : "expense"),
  );
  return (
    <form
      className="txn-form"
      onSubmit={(event) => {
        event.preventDefault();
        const full = {
          ...draft,
          amount: parseAmount(amountText) ?? 0,
          account:
            draft.account || (draft.kind === "in" ? payAccount(accounts) : spendAccount(accounts)),
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
      <div className="row">
        <label className="field">
          <span>In or out</span>
          <select
            value={draft.kind}
            onChange={(e) => set({ kind: e.target.value as TxnDraft["kind"], categoryId: "" })}
          >
            <option value="out">Out (spent)</option>
            <option value="in">In (received)</option>
          </select>
        </label>
        <label className="field">
          <span>Amount (ETB)</span>
          <input
            inputMode="decimal"
            value={amountText}
            placeholder="e.g. 120 or 2k"
            onChange={(e) => setAmountText(e.target.value)}
          />
        </label>
        <label className="field">
          <span>What</span>
          <input value={draft.description} onChange={(e) => set({ description: e.target.value })} />
        </label>
        <label className="field">
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
        <label className="field">
          <span>Account</span>
          <select
            value={
              draft.account || (draft.kind === "in" ? payAccount(accounts) : spendAccount(accounts))
            }
            onChange={(e) => set({ account: e.target.value })}
          >
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Date</span>
          <input type="date" value={draft.date} onChange={(e) => set({ date: e.target.value })} />
        </label>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="row">
        <Button type="submit" primary>
          {submitLabel}
        </Button>
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
      <li>
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
  return (
    <li className="task">
      <span>
        {row.description}
        {row.category && <span className="meta"> · {row.category}</span>}
        {row.account_name && <span className="meta"> · {row.account_name}</span>}
      </span>
      <span className="row task-meta">
        <span className={row.amount_minor > 0 ? "money-in" : undefined}>
          {row.amount_minor > 0 ? "+" : "−"}
          {formatAmount(Math.abs(row.amount_minor))}
        </span>
        {!row.transfer_id && <Button onClick={() => setEditing(true)}>Edit</Button>}
        <Button
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
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </li>
  );
}

function LedgerView({ month, today }: { month: string; today: string }) {
  const { txns } = useMonth(month, today);
  const categories = useLiveQuery<Category>(CATEGORIES_SQL);
  const accounts = useLiveQuery<AccountRow & Record<string, string | number | null>>(ACCOUNTS_SQL);
  const [filter, setFilter] = useState<LedgerFilter>({ text: "", categoryId: "", kind: "" });
  const [adding, setAdding] = useState(false);
  const [deleted, setDeleted] = useState<{ label: TxnRow; restore: Op[] } | null>(null);
  const halvesOf = (row: TxnRow) =>
    row.transfer_id ? txns.rows.filter((other) => other.transfer_id === row.transfer_id) : [row];
  const [note, setNote] = useState("");
  const shown = filterLedger(txns.rows, filter);
  const set = (part: Partial<LedgerFilter>) => setFilter((old) => ({ ...old, ...part }));
  const exportCsv = () => {
    const url = URL.createObjectURL(new Blob([toCsv(shown)], { type: "text/csv" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `sirna-money-${monthOf(month).key}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    setNote(`Exported ${shown.length} entries to your Downloads folder.`);
  };
  return (
    <>
      <div className="row task-filters">
        <input
          type="search"
          placeholder="Search"
          aria-label="Search entries"
          value={filter.text}
          onChange={(e) => set({ text: e.target.value })}
        />
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
        <Button onClick={() => setAdding((open) => !open)}>{adding ? "Close" : "Add entry"}</Button>
        <Button onClick={exportCsv} disabled={shown.length === 0}>
          Export CSV
        </Button>
      </div>
      {adding && (
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
      )}
      {deleted && (
        <p className="row" role="status">
          Deleted {deleted.label.description} ({formatAmount(Math.abs(deleted.label.amount_minor))}
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
        <p className="meta" role="status">
          {note}
        </p>
      )}
      {txns.error && (
        <p role="alert" className="error">
          Couldn&apos;t load entries: {txns.error}
        </p>
      )}
      {!txns.loading && shown.length === 0 && (
        <p className="meta">
          {txns.rows.length === 0 ? "No entries this month." : "Nothing matches."}
        </p>
      )}
      {byDay(shown).map((day) => (
        <section key={day.date} className="ledger-day" aria-label={day.date}>
          <h3 className="row money-line">
            <span>{day.date}</span>
            <span className="meta">
              {day.net >= 0 ? "+" : "−"}
              {formatAmount(Math.abs(day.net))}
            </span>
          </h3>
          <ul className="task-list">
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
      ))}
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
    <li className="task">
      <span className="row task-meta">
        <input
          className="category-name"
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
      <span className="row task-meta">
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
        <span className="row task-meta">
          <span className="meta">
            {row.cap_minor !== null ? `Cap ${formatAmount(row.cap_minor)} a month` : "No cap"}
          </span>
          <input
            className="category-name"
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
              Use {birr(suggested)} (your usual)
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
        className="row task-filters"
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
        <Button type="submit" primary>
          Add
        </Button>
        {note && (
          <span className="meta" role="status">
            {note}
          </span>
        )}
      </form>
      {suggestions.length > 0 && (
        <p className="row">
          <span className="meta">
            {suggestions.length} categor{suggestions.length === 1 ? "y has" : "ies have"} no cap
            yet. Start with your usual month for each:
          </span>
          <Button
            primary
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
      {(["expense", "income"] as const).map((group) => (
        <section
          key={group}
          className="card"
          aria-label={group === "expense" ? "Spending" : "Income"}
        >
          <h2>{group === "expense" ? "Spending" : "Income"}</h2>
          <ul className="task-list">
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
      {hidden.length > 0 && (
        <p className="meta">
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
  spentToday: number;
  onOpen?: (() => void) | undefined;
}) {
  const { summary, loading } = useMonth(monthOf(today).from, today);
  const { safe, loading: safeLoading } = useSafe(today);
  if (loading || safeLoading) return null;
  const short = (minor: number) => formatAmount(minor).replace(/ ETB$/, "");
  return (
    <>
      <p className="row money-today">
        <span>
          {safe.known
            ? `Spent ${short(spentToday)} today · ${safeLine(safe)}`
            : moneyLine(summary, spentToday)}
        </span>
        {onOpen && <Button onClick={onOpen}>Money</Button>}
      </p>
      <TodayDue today={today} />
      <Advisor today={today} />
    </>
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
  const settle = () => {
    const minor = amount.trim() ? (parseAmount(amount) ?? 0) : open;
    const problem = checkLoan(person.person, minor);
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
        account: account || spendAccount(accounts),
        nowMs: systemClock.now(),
        id: ulid(),
        txnId: ulid(),
      }),
      "loan",
    )
      .then(() => {
        setNote(loanEchoText(kind, person.person, minor, Math.max(0, open - minor)));
        setAmount("");
      })
      .catch((failure: unknown) => setNote(`Couldn't save: ${message(failure)}`));
  };
  return (
    <li className="task">
      <span>
        {person.person}
        <span className="meta">
          {" "}
          · {formatAmount(open)} since {person.since}
          {person.followUp ? ` · ask on ${person.followUp}` : ""}
        </span>
      </span>
      <span className="row task-meta">
        <input
          className="category-name"
          inputMode="decimal"
          aria-label={`Amount paid back, ${person.person}`}
          placeholder={`all ${birr(open)}`}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <select
          aria-label="Account"
          value={account || spendAccount(accounts)}
          onChange={(e) => setAccount(e.target.value)}
        >
          {accounts.map((row) => (
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
      className="row task-filters"
      onSubmit={(event) => {
        event.preventDefault();
        const minor = parseAmount(amount) ?? 0;
        const problem = checkLoan(person, minor);
        if (problem) {
          setNote(problem);
          return;
        }
        void transact(
          "user",
          loanOps({
            person,
            kind,
            amount: minor,
            date: today,
            account: account || spendAccount(accounts),
            nowMs: systemClock.now(),
            id: ulid(),
            txnId: ulid(),
            followUp: followUp || null,
          }),
          "loan",
        )
          .then(() => {
            setNote(loanEchoText(kind, person.trim(), minor, null));
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
          </option>
        ))}
      </select>
      <label className="row">
        <span className="meta">ask on</span>
        <input type="date" value={followUp} onChange={(e) => setFollowUp(e.target.value)} />
      </label>
      <Button type="submit" primary>
        Save
      </Button>
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
  const total = (list: PersonBalance[], key: "owedToMe" | "iOwe") =>
    list.reduce((sum, person) => sum + person[key], 0);
  return (
    <>
      <LoanForm accounts={accounts.rows} today={today} />
      <section className="card" aria-labelledby="owed-to-me">
        <h2 id="owed-to-me">Owed to you · {formatAmount(total(owedToMe, "owedToMe"))}</h2>
        {owedToMe.length === 0 ? (
          <p className="meta">Nobody owes you anything.</p>
        ) : (
          <ul className="task-list">
            {owedToMe.map((person) => (
              <PersonRow
                key={person.person}
                person={person}
                accounts={accounts.rows}
                today={today}
              />
            ))}
          </ul>
        )}
      </section>
      <section className="card" aria-labelledby="i-owe">
        <h2 id="i-owe">You owe · {formatAmount(total(iOwe, "iOwe"))}</h2>
        {iOwe.length === 0 ? (
          <p className="meta">You don&apos;t owe anyone.</p>
        ) : (
          <ul className="task-list">
            {iOwe.map((person) => (
              <PersonRow
                key={person.person}
                person={person}
                accounts={accounts.rows}
                today={today}
              />
            ))}
          </ul>
        )}
      </section>
      <p className="meta">
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
  const { from, to, shownFrom } = dueWindow(today);
  const regulars = useLiveQuery<RegularRow & Record<string, string | number | null>>(REGULARS_SQL);
  const txns = useLiveQuery<RegularTxn & Record<string, string | number | null>>(REGULAR_TXNS_SQL, [
    from,
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
          void transact(
            "user",
            settleOps(item, today, systemClock.now(), ulid()),
            `regular:${item.regular.id}`,
          ).catch((failure: unknown) => setError(`Couldn't record it: ${message(failure)}`))
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
    <li className="task">
      <span>
        {pay ? (item.regular.job ?? item.regular.name) : item.regular.name}
        <span className="meta">
          {" "}
          · {item.date} · {formatAmount(item.regular.amount_minor)}
          {item.done > 0 && item.left > 0
            ? ` · ${formatAmount(item.left)} still to ${pay ? "come" : "pay"}`
            : ""}
        </span>
      </span>
      <span className="row task-meta">
        <span
          className={
            item.state === "late" ? "warn-text" : item.state === "paid" ? "money-in" : "meta"
          }
        >
          {STATE_TEXT[item.state]}
        </span>
        {item.state !== "paid" && <SettleButton item={item} today={today} />}
      </span>
    </li>
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

function RegularForm() {
  const accounts = useLiveQuery<AccountRow & Record<string, string | number | null>>(ACCOUNTS_SQL);
  const categories = useLiveQuery<Category>(CATEGORIES_SQL);
  const jobs = useLiveQuery<{ id: string; name: string }>(JOBS_SQL);
  const [draft, setDraft] = useState<RegularDraft>(emptyRegular("bill", ""));
  const [amountText, setAmountText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const set = (part: Partial<RegularDraft>) => setDraft((old) => ({ ...old, ...part }));
  const account =
    draft.account ||
    (draft.kind === "pay" ? payAccount(accounts.rows) : spendAccount(accounts.rows));
  return (
    <form
      className="txn-form"
      onSubmit={(event) => {
        event.preventDefault();
        const full = { ...draft, account, amount: parseAmount(amountText) ?? 0 };
        const problem = checkRegular(full);
        if (problem) {
          setNote(problem);
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
      <div className="row">
        <label className="field">
          <span>Kind</span>
          <select
            value={draft.kind}
            onChange={(e) => setDraft(emptyRegular(e.target.value as RegularDraft["kind"], ""))}
          >
            <option value="bill">A bill I pay</option>
            <option value="pay">Pay I receive</option>
          </select>
        </label>
        {draft.kind === "pay" ? (
          <label className="field">
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
          <label className="field">
            <span>Name</span>
            <input
              value={draft.name}
              placeholder="Rent"
              onChange={(e) => set({ name: e.target.value })}
            />
          </label>
        )}
        <label className="field">
          <span>Amount (ETB)</span>
          <input
            inputMode="decimal"
            value={amountText}
            placeholder={draft.kind === "pay" ? "18,000" : "6,000"}
            onChange={(e) => setAmountText(e.target.value)}
          />
        </label>
        <label className="field">
          <span>When</span>
          <input
            value={draft.ruleText}
            placeholder="monthly 10"
            onChange={(e) => set({ ruleText: e.target.value })}
          />
        </label>
        {draft.kind === "bill" && (
          <label className="field">
            <span>Category</span>
            <select value={draft.categoryId} onChange={(e) => set({ categoryId: e.target.value })}>
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
        <label className="field">
          <span>{draft.kind === "pay" ? "Lands in" : "Paid from"}</span>
          <select value={account} onChange={(e) => set({ account: e.target.value })}>
            {accounts.rows.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="row">
        <Button type="submit" primary>
          Add
        </Button>
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
      <ul className="task-list">
        {suggestions.slice(0, 3).map((suggestion) => (
          <li key={suggestion.key} className="task">
            <span>{suggestion.text}</span>
            <span className="row task-meta">
              <Button primary onClick={() => write(trackOps(suggestion, ulid()))}>
                Track it
              </Button>
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
  if (loading) return null;
  const pay = items.filter((item) => item.regular.kind === "pay");
  const bills = items.filter((item) => item.regular.kind === "bill");
  const expected = pay.reduce((sum, item) => sum + item.regular.amount_minor, 0);
  const received = pay.reduce((sum, item) => sum + item.done, 0);
  return (
    <>
      <section className="card" aria-labelledby="regular-pay">
        <h2 id="regular-pay">Pay this month</h2>
        {pay.length === 0 ? (
          <p className="meta">
            Add each job&apos;s pay below (yours: the 10th and the 21st, into CBO). Income you
            capture as <code>got 18k job a</code> counts toward it.
          </p>
        ) : (
          <>
            <p>
              {formatAmount(received)} of {formatAmount(expected)} received
            </p>
            <ul className="task-list">
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
          <p className="meta">No bills yet. Add rent and the others below.</p>
        ) : (
          <ul className="task-list">
            {bills.map((item) => (
              <DueRow key={`${item.regular.id}${item.date}`} item={item} today={today} />
            ))}
          </ul>
        )}
      </section>
      <SuggestedRegulars today={today} regulars={regulars} />
      <RegularForm />
      {regulars.length > 0 && (
        <section className="card" aria-labelledby="regular-all">
          <h2 id="regular-all">All regulars</h2>
          <ul className="task-list">
            {regulars.map((row) => (
              <li key={row.id} className="task">
                <span>
                  {row.kind === "pay" ? (row.job ?? row.name) : row.name}
                  <span className="meta"> · {regularText(row)}</span>
                </span>
                <Button
                  onClick={() =>
                    void transact("user", removeRegularOps(row.id), `regular:${row.id}`).catch(
                      (failure: unknown) => setError(`Couldn't remove it: ${message(failure)}`),
                    )
                  }
                >
                  Remove
                </Button>
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
    </>
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
  const lines = dueLines(open);
  return (
    <ul className="task-list">
      {open.map((item, index) => (
        <li key={`${item.regular.id}${item.date}`} className="task">
          <span className={item.state === "late" ? "warn-text" : undefined}>{lines[index]}</span>
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
}: {
  account: AccountRow;
  all: AccountRow[];
  regulars: RegularRow[];
  today: string;
}) {
  const [name, setName] = useState(account.name);
  const [typed, setTyped] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const balance = balanceOf(account);
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
    <li className="task">
      <span className="row task-meta">
        <input
          className="category-name"
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
        <strong>{balance === null ? "Balance not set" : formatAmount(balance)}</strong>
        {account.pays_in === 1 && <span className="meta">pay lands here</span>}
      </span>
      <span className="row task-meta">
        <input
          className="category-name"
          inputMode="decimal"
          aria-label={`Balance of ${account.name} now`}
          placeholder={balance === null ? "Balance now" : "Bank shows…"}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
        <Button onClick={reconcile} disabled={!typed.trim()}>
          {balance === null ? "Set" : "Check"}
        </Button>
        {account.pays_in !== 1 && (
          <Button
            onClick={() => void write(setPayAccountOps(account.id, all), "Pay will land here.")}
          >
            Pay lands here
          </Button>
        )}
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
  return (
    <form
      className="row task-filters"
      onSubmit={(event) => {
        event.preventDefault();
        const minor = parseAmount(amount) ?? 0;
        const problem = checkTransfer(from, to, minor);
        const source = accounts.find((account) => account.id === from);
        const target = accounts.find((account) => account.id === to);
        if (problem || !source || !target) {
          setNote(problem ?? "Pick both accounts.");
          return;
        }
        void transact(
          "user",
          transferOps({
            from: source,
            to: target,
            amount: minor,
            date: today,
            nowMs: systemClock.now(),
            ids: [ulid(), ulid()],
            transferId: ulid(),
          }),
          "transfer",
        )
          .then(() => {
            setNote(`Moved ${formatAmount(minor)} from ${source.name} to ${target.name}.`);
            setAmount("");
          })
          .catch((failure: unknown) => setNote(`Couldn't move it: ${message(failure)}`));
      }}
    >
      <span>Move</span>
      <input
        inputMode="decimal"
        aria-label="Amount to move"
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
      <Button type="submit" primary>
        Move
      </Button>
      {note && (
        <span className="meta" role="status">
          {note}
        </span>
      )}
    </form>
  );
}

/** Accounts (T-058): balances, checking them against the bank, moving money. */
function AccountsView({ today }: { today: string }) {
  const accounts = useLiveQuery<AccountRow & Record<string, string | number | null>>(ACCOUNTS_SQL);
  const regulars = useLiveQuery<RegularRow & Record<string, string | number | null>>(REGULARS_SQL);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<AccountRow["kind"]>("bank");
  const [note, setNote] = useState<string | null>(null);
  const { total, unknown } = totalBalance(accounts.rows);
  return (
    <>
      <p>
        <strong>{formatAmount(total)}</strong> in your accounts
        {unknown > 0 && (
          <span className="meta">
            {" "}
            · {unknown} without a balance yet: type what each one shows now
          </span>
        )}
      </p>
      <section className="card" aria-label="Accounts">
        <ul className="task-list">
          {accounts.rows.map((account) => (
            <AccountItem
              key={account.id}
              account={account}
              all={accounts.rows}
              regulars={regulars.rows}
              today={today}
            />
          ))}
        </ul>
        <p className="meta">
          A balance is what you typed plus everything recorded since. When the bank shows something
          else, type it under Check: the difference is booked as unrecorded spending or income.
        </p>
      </section>
      <TransferForm accounts={accounts.rows} today={today} />
      <form
        className="row task-filters"
        onSubmit={(event) => {
          event.preventDefault();
          const problem = checkAccountName(name, accounts.rows);
          if (problem) {
            setNote(problem);
            return;
          }
          void transact("user", addAccountOps(name, kind, accounts.rows), "account")
            .then(() => {
              setNote(`Added ${name.trim()}.`);
              setName("");
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
        <Button type="submit">Add account</Button>
        {note && (
          <span className="meta" role="status">
            {note}
          </span>
        )}
      </form>
      <p className="meta">
        In the capture box: <code>lunch 120 @telebirr</code> spends from telebirr;{" "}
        <code>moved 2000 cbe to telebirr</code> moves money between accounts.
      </p>
    </>
  );
}

/** Money (proposal 1.1): the month at a glance, and every entry to find, fix or export. */
export function Money() {
  const [today] = useState(() => logicalDate(systemClock.now()));
  const [month, setMonth] = useState(() => monthOf(today).from);
  const [tab, setTab] = useState<keyof typeof TAB_NAMES>("month");
  const isCurrent = month === monthOf(today).from;
  return (
    <main className="review money">
      <header className="review-head">
        <h1>Money</h1>
        <div className="row">
          <Button aria-label="Previous month" onClick={() => setMonth(previousMonthStart(month))}>
            ‹
          </Button>
          <span>{monthLabel(monthOf(month).key)}</span>
          <Button
            aria-label="Next month"
            disabled={isCurrent}
            onClick={() => setMonth(monthOf(shiftDate(monthOf(month).to, 1)).from)}
          >
            ›
          </Button>
        </div>
      </header>
      <div className="row" role="tablist" aria-label="View">
        {(Object.keys(TAB_NAMES) as (keyof typeof TAB_NAMES)[]).map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            className={tab === name ? "step current" : "step"}
            onClick={() => setTab(name)}
          >
            {TAB_NAMES[name]}
          </button>
        ))}
      </div>
      {tab === "month" && <MonthView month={month} today={today} />}
      {tab === "ledger" && <LedgerView month={month} today={today} />}
      {tab === "regulars" && <RegularsView today={today} />}
      {tab === "loans" && <LoansView today={today} />}
      {tab === "accounts" && <AccountsView today={today} />}
      {tab === "categories" && <CategoriesView today={today} />}
    </main>
  );
}
