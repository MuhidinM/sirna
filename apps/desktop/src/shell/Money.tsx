import { useState } from "react";

import { systemClock } from "../kernel/clock";
import { logicalDate } from "../kernel/dates";
import { transact } from "../kernel/db";
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
} from "../features/money/money";
import { shiftDate } from "../features/plan/dayplan";
import { Savings } from "./Savings";
import { Button } from "./ui";
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
  return { txns, summary, current: to >= today, loading: txns.loading || history.loading };
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
          <p className="meta">The grey bar is your usual month (the middle of the last 3).</p>
        </section>
      )}

      <section className="card" aria-labelledby="money-goals">
        <h2 id="money-goals">Savings goals</h2>
        <Savings />
      </section>
    </>
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
  submitLabel,
  onSave,
  onCancel,
}: {
  initial: TxnDraft;
  categories: Category[];
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
        const full = { ...draft, amount: parseAmount(amountText) ?? 0 };
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
});

function LedgerRow({
  row,
  categories,
  onDeleted,
}: {
  row: TxnRow;
  categories: Category[];
  onDeleted: (row: TxnRow) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (editing)
    return (
      <li>
        <TxnForm
          initial={draftOf(row)}
          categories={categories}
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
      </span>
      <span className="row task-meta">
        <span className={row.amount_minor > 0 ? "money-in" : undefined}>
          {row.amount_minor > 0 ? "+" : "−"}
          {formatAmount(Math.abs(row.amount_minor))}
        </span>
        <Button onClick={() => setEditing(true)}>Edit</Button>
        <Button
          onClick={() =>
            void transact("user", txnDeleteOps(row), `money:${row.id}`)
              .then(() => onDeleted(row))
              .catch((failure: unknown) => setError(`Couldn't delete: ${message(failure)}`))
          }
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
  const [filter, setFilter] = useState<LedgerFilter>({ text: "", categoryId: "", kind: "" });
  const [adding, setAdding] = useState(false);
  const [deleted, setDeleted] = useState<TxnRow | null>(null);
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
          Deleted {deleted.description} ({formatAmount(Math.abs(deleted.amount_minor))}).
          <Button
            onClick={() =>
              void transact("user", txnRestoreOps(deleted), `money:${deleted.id}`).then(() =>
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
                onDeleted={setDeleted}
              />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

/** Money (proposal 1.1): the month at a glance, and every entry to find, fix or export. */
export function Money() {
  const [today] = useState(() => logicalDate(systemClock.now()));
  const [month, setMonth] = useState(() => monthOf(today).from);
  const [tab, setTab] = useState<"month" | "ledger">("month");
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
        {(["month", "ledger"] as const).map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            className={tab === name ? "step current" : "step"}
            onClick={() => setTab(name)}
          >
            {name === "month" ? "Month" : "Ledger"}
          </button>
        ))}
      </div>
      {tab === "month" ? (
        <MonthView month={month} today={today} />
      ) : (
        <LedgerView month={month} today={today} />
      )}
    </main>
  );
}
