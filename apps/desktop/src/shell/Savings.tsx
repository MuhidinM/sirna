import { useEffect, useState } from "react";
import "../theme/pages/savings.css";

import { systemClock } from "../kernel/clock";
import { logicalDate } from "../kernel/dates";
import { type Op, query, transact } from "../kernel/db";
import { formatAmount, parseAmount } from "../kernel/money";
import { ulid } from "../kernel/ulid";
import {
  type AccountRow,
  ACCOUNTS_SQL,
  currencyOf,
  isSavings,
  payAccount,
  readSavingsSince,
  SAVINGS_SINCE_SQL,
  spending,
} from "../features/money/accounts";
import { RATES_SQL, readRates, toEtb } from "../features/money/currency";
import {
  addGoalOps,
  assignOps,
  checkGoal,
  checkGoalEdit,
  checkTakeOut,
  type GoalEdit,
  goalEditOps,
  goalPace,
  checkMove,
  entryOps,
  type GoalDraft,
  type GoalRow,
  GOALS_SQL,
  goalStatusOps,
  moveOps,
  ORPHAN_SAVINGS_SQL,
  SAVINGS_TRANSFERS_SQL,
  type SavingsTransfer,
  savingsSyncOps,
  shareSaved,
  STAGE_NAMES,
  stageOf,
  UNASSIGNED_SQL,
} from "../features/savings/savings";
import { IconPencil, IconPlus } from "./icons";
import { PanelHead } from "./kit";
import { SavingsTree } from "./SavingsTree";
import { Button } from "./ui";
import { useLiveQuery } from "./useLiveQuery";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

type Rows<T> = T & Record<string, string | number | null>;

/**
 * Any transfer into or out of a savings account is saving (time-first §4):
 * the capture box's `moved 2000 from cbo to cbo savings` too. Each time the
 * data changes, transfers without their saving get one, and savings whose
 * transfer was deleted go. Written as a rule, so it is logged like any change.
 */
/** What the sync last wrote, shared: two mounted pages must not write it twice. */
let lastSync = "";

export function useSavingsSync() {
  const transfers = useLiveQuery<Rows<SavingsTransfer>>(SAVINGS_TRANSFERS_SQL);
  const orphans = useLiveQuery<{ id: string }>(ORPHAN_SAVINGS_SQL);
  const goals = useLiveQuery<Rows<GoalRow>>(GOALS_SQL);
  const since = useLiveQuery<{ value_json: string }>(SAVINGS_SINCE_SQL);
  const rates = useLiveQuery<{ value_json: string }>(RATES_SQL);
  const loading =
    transfers.loading || orphans.loading || goals.loading || since.loading || rates.loading;
  const ops: Op[] = loading
    ? []
    : savingsSyncOps({
        transfers: transfers.rows,
        orphans: orphans.rows,
        goals: goals.rows,
        since: readSavingsSince(since.rows[0]?.value_json),
        rates: readRates(rates.rows[0]?.value_json),
        newId: () => ulid(),
      });
  // The same rows twice (before the change comes back) must not write twice.
  const key = [...transfers.rows.map((row) => row.id), ...orphans.rows.map((row) => row.id)].join();
  useEffect(() => {
    if (ops.length === 0 || lastSync === key) return;
    lastSync = key;
    void transact("rule:savings", ops, "savings").catch(() => {
      lastSync = "";
    });
  });
}

/** Spending accounts to take from, and savings accounts to put into. */
function useMoneyAccounts() {
  const accounts = useLiveQuery<Rows<AccountRow>>(ACCOUNTS_SQL);
  const rates = useLiveQuery<{ value_json: string }>(RATES_SQL);
  return {
    spend: spending(accounts.rows),
    savings: accounts.rows.filter(isSavings),
    pay: payAccount(spending(accounts.rows)),
    rates: readRates(rates.rows[0]?.value_json),
  };
}

/** "1,250 a month to make June · you save about 900" (proposal 1.4). */
function paceText(goal: GoalRow, today: string): string {
  const pace = goalPace(goal, today);
  if (pace.left === 0) return "Reached.";
  const saving = `you save about ${formatAmount(pace.averagePerMonth)} a month`;
  if (pace.needPerMonth === null) return `No date set · ${saving}.`;
  const by = new Intl.DateTimeFormat("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(Date.parse(`${goal.target_date}T00:00:00Z`));
  const behind = pace.averagePerMonth < pace.needPerMonth;
  return `${formatAmount(pace.needPerMonth)} a month to make ${by} · ${saving}${behind ? ", behind" : ""}.`;
}

function GoalEditForm({ goal, onDone }: { goal: GoalRow; onDone: () => void }) {
  const [edit, setEdit] = useState<GoalEdit>({
    title: goal.title,
    target: String(goal.target_minor / 100),
    targetDate: goal.target_date ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const set = (part: Partial<GoalEdit>) => setEdit((old) => ({ ...old, ...part }));
  return (
    <form
      className="row new-goal"
      onSubmit={(event) => {
        event.preventDefault();
        const problem = checkGoalEdit(edit, logicalDate(systemClock.now()));
        if (problem) {
          setError(problem);
          return;
        }
        transact("user", goalEditOps(goal.id, edit), `savings:${goal.id}`)
          .then(onDone)
          .catch((failure: unknown) => setError(`Couldn't save: ${message(failure)}`));
      }}
    >
      <label className="field">
        <span>Name</span>
        <input value={edit.title} onChange={(e) => set({ title: e.target.value })} />
      </label>
      <label className="field">
        <span>Target (ETB)</span>
        <input
          inputMode="decimal"
          value={edit.target}
          onChange={(e) => set({ target: e.target.value })}
        />
      </label>
      <label className="field">
        <span>Reach it by (optional)</span>
        <input
          type="date"
          value={edit.targetDate}
          onChange={(e) => set({ targetDate: e.target.value })}
        />
      </label>
      <Button type="submit">Save</Button>
      <Button onClick={onDone}>Cancel</Button>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </form>
  );
}

/** "22.5K", "1.2M": short amounts for the milestones beside the stem. */
function short(minor: number): string {
  const birr = minor / 100;
  if (birr >= 1_000_000) return `${+(birr / 1_000_000).toFixed(1)}M`;
  if (birr >= 10_000) return `${+(birr / 1_000).toFixed(1)}K`;
  return formatAmount(minor).replace(/ ETB$/, "");
}

const monthYear = new Intl.DateTimeFormat("en-GB", {
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** A goal as a night scene with its plant (docs/design.md → Savings tree). */
function GoalCard({
  goal,
  seed,
  accounts,
}: {
  goal: GoalRow;
  seed: number;
  accounts: ReturnType<typeof useMoneyAccounts>;
}) {
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState(false);
  const [fromId, setFromId] = useState("");
  const [savingsId, setSavingsId] = useState("");
  const today = logicalDate(systemClock.now());
  const share = shareSaved(goal);
  const stage = stageOf(share);
  const savings = accounts.savings.find((row) => row.id === savingsId) ?? accounts.savings[0];
  // The account the money comes from (or goes back to): in the savings account's currency.
  const choices = accounts.spend.filter((row) => currencyOf(row) === currencyOf(savings));
  const spend =
    choices.find((row) => row.id === fromId) ??
    choices.find((row) => row.id === accounts.pay) ??
    choices[0];
  const move = (sign: 1 | -1) => {
    const minor = parseAmount(amount);
    if (minor === null || minor <= 0) {
      setNote("An amount like 500 or 2k.");
      return;
    }
    // With no savings account yet, a saving is only marked (money stays where it is).
    const backed = savings !== undefined;
    const problem = backed ? checkMove(spend, savings) : null;
    if (problem) {
      setNote(problem);
      return;
    }
    const worth = backed ? toEtb(minor, currencyOf(savings), accounts.rates) : minor;
    if (worth === null) {
      setNote(`Set a ${currencyOf(savings)} rate first (Money → Accounts).`);
      return;
    }
    const tooMuch = sign < 0 ? checkTakeOut(goal, worth) : null;
    if (tooMuch) {
      setNote(tooMuch);
      return;
    }
    const now = systemClock.now();
    const date = logicalDate(now);
    const ops =
      backed && spend
        ? moveOps({
            goal,
            sign,
            amount: minor,
            spend,
            savings,
            nowMs: now,
            date,
            ids: { entry: ulid(), halves: [ulid(), ulid()], transfer: ulid() },
            entryMinor: worth,
          })
        : entryOps(goal.id, sign * minor, now, date, ulid(), "dashboard");
    transact("user", ops, `savings:${goal.id}`)
      .then(() => {
        setAmount("");
        const shown = formatAmount(minor, currencyOf(savings));
        setNote(
          backed && spend
            ? sign > 0
              ? `Moved ${shown} from ${spend.name} to ${savings.name}`
              : `Moved ${shown} from ${savings.name} to ${spend.name}`
            : `${sign > 0 ? "Saved" : "Took out"} ${shown}`,
        );
      })
      .catch((failure: unknown) => setNote(`Couldn't save: ${message(failure)}`));
  };
  const target = goal.target_minor;
  const title = goal.target_date
    ? `${goal.title} by ${monthYear.format(Date.parse(`${goal.target_date}T00:00:00Z`))}`
    : goal.title;
  return (
    <li className="goal">
      <div className="goal-scene">
        <div
          className="goal-picture"
          role="img"
          aria-label={`${goal.title}: a plant at ${Math.round(share * 100)}% (${STAGE_NAMES[stage]})`}
        >
          <SavingsTree
            share={share}
            seed={seed}
            milestones={[short(target * 0.25), short(target * 0.5), short(target * 0.75)]}
            goalLabel={`Goal: ${short(target)}`}
          />
        </div>
        <div className="goal-top">
          <h3>{title}</h3>
          <button
            type="button"
            className="icon-btn goal-edit"
            aria-label={`Edit ${goal.title}`}
            aria-expanded={editing}
            onClick={() => setEditing((on) => !on)}
          >
            <IconPencil size={17} />
          </button>
        </div>
        <div className="goal-amount">
          <strong>{formatAmount(Math.max(0, goal.saved_minor))}</strong>
          <span>
            of {formatAmount(target)} · {Math.round(share * 100)}% reached · {STAGE_NAMES[stage]}
          </span>
        </div>
      </div>
      <div className="goal-controls">
        <p className="meta goal-pace">{paceText(goal, today)}</p>
        {editing && <GoalEditForm goal={goal} onDone={() => setEditing(false)} />}
        <div className="row goal-move">
          <input
            inputMode="decimal"
            aria-label={`Amount for ${goal.title}`}
            placeholder="500"
            value={amount}
            onChange={(event) => {
              setNote("");
              setAmount(event.target.value);
            }}
          />
          {savings && (
            <>
              <select
                aria-label={`Account the money comes from, ${goal.title}`}
                title="From (or back to)"
                value={spend?.id ?? ""}
                onChange={(event) => setFromId(event.target.value)}
              >
                {choices.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                  </option>
                ))}
              </select>
              {accounts.savings.length > 1 && (
                <select
                  aria-label={`Savings account, ${goal.title}`}
                  value={savings.id}
                  onChange={(event) => setSavingsId(event.target.value)}
                >
                  {accounts.savings.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name}
                    </option>
                  ))}
                </select>
              )}
            </>
          )}
          <Button onClick={() => move(1)}>Put aside</Button>
          <Button className="btn-ghost" onClick={() => move(-1)}>
            Take out
          </Button>
          {stage === 5 && (
            <Button
              className="btn-orange"
              onClick={() =>
                void transact("user", goalStatusOps(goal.id, "done"), `savings:${goal.id}`).catch(
                  (failure: unknown) => setNote(`Couldn't save: ${message(failure)}`),
                )
              }
            >
              Plant it in the garden
            </Button>
          )}
          <span className="meta" role="status">
            {note}
          </span>
        </div>
      </div>
    </li>
  );
}

function NewGoal({ onDone }: { onDone: () => void }) {
  const [draft, setDraft] = useState<GoalDraft>({ title: "", target: "" });
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="row new-goal"
      onSubmit={(event) => {
        event.preventDefault();
        const problem = checkGoal(draft);
        if (problem) {
          setError(problem);
          return;
        }
        const today = logicalDate(systemClock.now());
        // Savings made before any goal existed join the first one.
        query<{ id: string }>(
          "SELECT id FROM savings_entries WHERE goal_id IS NULL AND deleted_at IS NULL",
        )
          .then((waiting) => transact("user", addGoalOps(draft, today, ulid(), waiting), "savings"))
          .then(onDone)
          .catch((failure: unknown) => setError(`Couldn't add it: ${message(failure)}`));
      }}
    >
      <label className="field">
        <span>Goal name</span>
        <input
          placeholder="Laptop"
          value={draft.title}
          onChange={(event) => setDraft({ ...draft, title: event.target.value })}
        />
      </label>
      <label className="field">
        <span>Target (ETB)</span>
        <input
          inputMode="decimal"
          placeholder="100,000"
          value={draft.target}
          onChange={(event) => setDraft({ ...draft, target: event.target.value })}
        />
      </label>
      <Button type="submit">Add goal</Button>
      <Button onClick={onDone}>Cancel</Button>
      {error && (
        <span role="alert" className="error">
          {error}
        </span>
      )}
    </form>
  );
}

/** Savings made without a goal: give them to one (or they join the next goal you add). */
function GiveTo({ minor, goals }: { minor: number; goals: GoalRow[] }) {
  const [goalId, setGoalId] = useState("");
  const [note, setNote] = useState("");
  return (
    <p className="row meta">
      {formatAmount(minor)} saved without a goal.
      {goals.length > 0 ? (
        <>
          <select aria-label="Give to" value={goalId} onChange={(e) => setGoalId(e.target.value)}>
            <option value="">Give it to…</option>
            {goals.map((goal) => (
              <option key={goal.id} value={goal.id}>
                {goal.title}
              </option>
            ))}
          </select>
          <Button
            disabled={!goalId}
            onClick={() =>
              void query<{ id: string }>(
                "SELECT id FROM savings_entries WHERE goal_id IS NULL AND deleted_at IS NULL",
              )
                .then((rows) =>
                  transact(
                    "user",
                    assignOps(
                      rows.map((row) => row.id),
                      goalId,
                    ),
                    "savings",
                  ),
                )
                .catch((failure: unknown) => setNote(`Couldn't save: ${message(failure)}`))
            }
          >
            Give
          </Button>
        </>
      ) : (
        " It joins the first goal you add."
      )}
      {note}
    </p>
  );
}

/** Savings goals with their plants, and a garden of finished ones (plan §3.13). */
export function Savings() {
  const goals = useLiveQuery<GoalRow & Record<string, string | number>>(GOALS_SQL);
  const waiting = useLiveQuery<{ minor: number; n: number }>(UNASSIGNED_SQL);
  const accounts = useMoneyAccounts();
  useSavingsSync();
  const backing = accounts.savings.map((row) => row.name).join(", ");
  const [adding, setAdding] = useState(false);
  const growing = goals.rows.filter((goal) => goal.status !== "done");
  const garden = goals.rows.filter((goal) => goal.status === "done");
  const unassigned = waiting.rows[0];
  return (
    <section className="panel savings" aria-labelledby="savings">
      <PanelHead
        id="savings"
        title="Savings"
        sub={
          <>
            {backing ? (
              <>
                Put aside moves money into {backing}; a move into it from anywhere (
                <code>moved 2000 from cbo to cbo savings</code>) counts as saving.
              </>
            ) : (
              <>
                Capture <code>saved 500 laptop</code> or <code>took 2000 from laptop</code>.
              </>
            )}{" "}
            Plants only grow; taking money out just lowers the number.
          </>
        }
        action={
          !adding && (
            <Button onClick={() => setAdding(true)}>
              <IconPlus size={16} /> New goal
            </Button>
          )
        }
      />
      {adding && <NewGoal onDone={() => setAdding(false)} />}
      {unassigned && unassigned.n > 0 && <GiveTo minor={unassigned.minor} goals={growing} />}
      {!goals.loading && growing.length === 0 && !adding && (
        <p className="empty">No goals yet. Add one with New goal and watch its plant grow.</p>
      )}
      <ul className="goals">
        {growing.map((goal, index) => (
          <GoalCard key={goal.id} goal={goal} seed={index + 3} accounts={accounts} />
        ))}
      </ul>
      {garden.length > 0 && (
        <div className="garden" aria-label="Garden: goals reached">
          {garden.map((goal) => (
            <span
              key={goal.id}
              className="garden-tree"
              title={`${goal.title} · ${formatAmount(goal.target_minor)}`}
            >
              <SavingsTree share={1} compact />
              <span className="meta">{goal.title}</span>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
