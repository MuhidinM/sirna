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
  claimOps,
  GOAL_HELD_SQL,
  HELD_BY_ACCOUNT_SQL,
  overclaimed,
  unclaimed,
  checkGoal,
  checkGoalEdit,
  checkTakeOut,
  checkTakeOutFrom,
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
  takeOutOps,
  takeOutRoom,
  WAITING_SQL,
  waitingForNewGoal,
  waitingSplit,
  writeOffOps,
} from "../features/savings/savings";
import { IconPencil, IconPlus } from "./icons";
import { PanelHead } from "./kit";
import { SavingsTree } from "./SavingsTree";
import { Button } from "./ui";
import { useLiveQuery } from "./useLiveQuery";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

type Rows<T> = T & Record<string, string | number | null>;

/**
 * A repair, not the main path (time-first §4): the capture box, Put aside and
 * Move money write a transfer's saving in the transfer's own transaction.
 * This only catches what slipped through (a dollar transfer saved before its
 * rate was set, data from an older version):
 * transfers without their saving get one, and savings whose transfer was
 * deleted go. Written as a rule, so it is logged like any change.
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
    all: accounts.rows,
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

function GoalEditForm({
  goal,
  others,
  onDone,
}: {
  goal: GoalRow;
  /** The other goals, so two can't share a name. */
  others: GoalRow[];
  onDone: () => void;
}) {
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
        const problem = checkGoalEdit(edit, logicalDate(systemClock.now()), others);
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
      {/* Pause keeps the money put aside but stops the goal asking for more (F35). */}
      <Button
        className="btn-ghost"
        onClick={() =>
          void transact(
            "user",
            goalStatusOps(goal.id, goal.status === "paused" ? "active" : "paused"),
            `savings:${goal.id}`,
          )
            .then(onDone)
            .catch((failure: unknown) => setError(`Couldn't save: ${message(failure)}`))
        }
      >
        {goal.status === "paused" ? "Resume" : "Pause"}
      </Button>
      <Button
        className="btn-ghost"
        onClick={() => {
          // Its money stays in the account and shows as "no goal has yet".
          if (
            goal.saved_minor > 0 &&
            !window.confirm(
              `Remove ${goal.title}? Its ${formatAmount(goal.saved_minor)} stays where it is, with no goal.`,
            )
          )
            return;
          void transact(
            "user",
            [{ op: "delete", table: "savings_goals", id: goal.id }],
            `savings:${goal.id}`,
          )
            .then(onDone)
            .catch((failure: unknown) => setError(`Couldn't remove it: ${message(failure)}`));
        }}
      >
        Remove goal
      </Button>
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
  others,
  seed,
  accounts,
  goalHeld,
  free,
}: {
  goal: GoalRow;
  /** The other goals, so an edit can't reuse a name. */
  others: GoalRow[];
  seed: number;
  accounts: ReturnType<typeof useMoneyAccounts>;
  /** What each goal holds in each savings account. */
  goalHeld: { goal_id: string; account: string; minor: number }[];
  /** What each savings account holds that no goal has (ETB worth, by id). */
  free: Record<string, number>;
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
    const worth = backed ? toEtb(minor, currencyOf(savings), accounts.rates) : minor;
    if (worth === null) {
      setNote(`Set a ${currencyOf(savings)} rate first (Money → Accounts).`);
      return;
    }
    // Only a savings account in its currency (dollars in Wise, F36): Put aside
    // gives the goal what the account already holds; there's nowhere to take out to.
    if (backed && choices.length === 0) {
      const code = currencyOf(savings);
      if (sign < 0) {
        setNote(`No ${code} account to move it to; the money stays in ${savings.name}.`);
        return;
      }
      // No balance set: what it holds is unknown, not nothing.
      if (savings.opening_date === null) {
        setNote(`${savings.name} has no balance yet: set it in Accounts first.`);
        return;
      }
      const room = free[savings.id] ?? 0;
      if (worth > room) {
        setNote(
          `${savings.name} holds ${formatAmount(room)} no goal has yet: give that much or less.`,
        );
        return;
      }
      const now = systemClock.now();
      transact(
        "user",
        claimOps(goal.id, savings.id, worth, now, logicalDate(now), ulid()),
        `savings:${goal.id}`,
      )
        .then(() => {
          setAmount("");
          setNote(`Gave ${formatAmount(minor, code)} that ${savings.name} already holds`);
        })
        .catch((failure: unknown) => setNote(`Couldn't save: ${message(failure)}`));
      return;
    }
    const problem = backed ? checkMove(spend, savings) : null;
    if (problem) {
      setNote(problem);
      return;
    }
    // Never more than the goal holds, nor more than the chosen account can give (F9).
    const available = backed ? takeOutRoom(goal.id, savings, goalHeld, accounts.rates) : 0;
    const tooMuch =
      sign > 0
        ? null
        : backed
          ? checkTakeOutFrom(goal, worth, available, savings.name)
          : checkTakeOut(goal, worth);
    if (tooMuch) {
      setNote(tooMuch);
      return;
    }
    const now = systemClock.now();
    const date = logicalDate(now);
    const ids = { entry: ulid(), halves: [ulid(), ulid()] as [string, string], transfer: ulid() };
    const moveInput = backed && spend ? { amount: minor, spend, savings, nowMs: now, date } : null;
    // Take out moves through the savings account only what the goal holds there.
    const out =
      moveInput && sign < 0
        ? takeOutOps({
            ...moveInput,
            goal,
            ids: { ...ids, plain: ulid() },
            entryMinor: worth,
            available,
          })
        : null;
    const ops = out
      ? out.ops
      : moveInput
        ? moveOps({ ...moveInput, goal, sign, ids, entryMinor: worth })
        : entryOps(goal.id, sign * minor, now, date, ulid(), "dashboard");
    transact("user", ops, `savings:${goal.id}`)
      .then(() => {
        setAmount("");
        const shown = formatAmount(minor, currencyOf(savings));
        if (out && moveInput) {
          // The part never in the savings account was set aside in your
          // spending accounts: only the goal's number goes down (F75).
          const plain = `${formatAmount(out.plain)} was already in your spending accounts, so only the goal went down`;
          setNote(
            out.plain === 0
              ? `Moved ${shown} from ${moveInput.savings.name} to ${moveInput.spend.name}`
              : out.moved === 0
                ? `Took out ${formatAmount(out.plain)}: it was already in your spending accounts, so only the goal went down`
                : `Moved ${formatAmount(out.moved)} from ${moveInput.savings.name} back to ${moveInput.spend.name}; the other ${plain}`,
          );
          return;
        }
        setNote(
          moveInput
            ? `Moved ${shown} from ${moveInput.spend.name} to ${moveInput.savings.name}`
            : `${sign > 0 ? "Saved" : "Took out"} ${shown}`,
        );
      })
      .catch((failure: unknown) => setNote(`Couldn't save: ${message(failure)}`));
  };
  const target = goal.target_minor;
  // Where the goal's money is (F75): in savings accounts, or set aside in spending ones.
  const inSavings = Math.max(0, goal.held_minor ?? 0);
  const inSpending = Math.max(0, goal.saved_minor - inSavings);
  const where = accounts.savings.length === 1 ? accounts.savings[0]?.name : "savings accounts";
  const split =
    accounts.savings.length > 0 && inSavings !== Math.max(0, goal.saved_minor)
      ? `${formatAmount(inSavings)} in ${where} · ${formatAmount(inSpending)} set aside in your spending accounts`
      : null;
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
          <h3 title={title}>{title}</h3>
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
        <p className="meta goal-pace">
          {goal.status === "paused"
            ? "Paused: kept aside, not asking for more."
            : paceText(goal, today)}
        </p>
        {split && <p className="meta goal-split">{split}</p>}
        {editing && <GoalEditForm goal={goal} others={others} onDone={() => setEditing(false)} />}
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
              {choices.length > 0 && (
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
              )}
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

function NewGoal({ goals, onDone }: { goals: GoalRow[]; onDone: () => void }) {
  const [draft, setDraft] = useState<GoalDraft>({ title: "", target: "" });
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="row new-goal"
      onSubmit={(event) => {
        event.preventDefault();
        const problem = checkGoal(draft, goals);
        if (problem) {
          setError(problem);
          return;
        }
        const today = logicalDate(systemClock.now());
        // Savings made while no goal was growing join the first one; with
        // goals there they wait for "Give it to…" (F34).
        query<{ id: string; amount_minor: number }>(WAITING_SQL)
          .then((waiting) =>
            transact(
              "user",
              addGoalOps(draft, today, ulid(), waitingForNewGoal(goals, waiting)),
              "savings",
            ),
          )
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

/**
 * Entries waiting for a goal (F33). Savings made without a goal: give them
 * to one (or they join the next goal you add). Money taken out of savings
 * with several goals: say which goal it came from, among those holding that
 * much, so no goal goes below zero.
 */
function Waiting({
  minor,
  ids,
  goals,
  taken,
}: {
  minor: number;
  ids: string[];
  goals: GoalRow[];
  taken: boolean;
}) {
  const [goalId, setGoalId] = useState("");
  const [note, setNote] = useState("");
  const chosen = goals.some((goal) => goal.id === goalId) ? goalId : "";
  return (
    <p className="row meta">
      {taken
        ? `${formatAmount(minor)} taken out of savings. Which goal did it come from?`
        : `${formatAmount(minor)} saved without a goal.`}
      {goals.length > 0 ? (
        <>
          <select
            aria-label={taken ? "Taken from" : "Give to"}
            value={chosen}
            onChange={(e) => setGoalId(e.target.value)}
          >
            <option value="">{taken ? "It came from…" : "Give it to…"}</option>
            {goals.map((goal) => (
              <option key={goal.id} value={goal.id}>
                {goal.title}
              </option>
            ))}
          </select>
          <Button
            disabled={!chosen}
            onClick={() =>
              void transact("user", assignOps(ids, chosen), "savings").catch((failure: unknown) =>
                setNote(`Couldn't save: ${message(failure)}`),
              )
            }
          >
            {taken ? "Take it from there" : "Give"}
          </Button>
        </>
      ) : taken ? (
        " No goal holds that much."
      ) : (
        " It joins the first goal you add."
      )}
      {note}
    </p>
  );
}

/**
 * A savings account holding less than its goals count on it (F37), after a
 * Check found money gone: take the gap off a goal. No money moves.
 */
function Overclaimed({
  account,
  minor,
  holders,
}: {
  account: AccountRow;
  minor: number;
  /** Goals with money counted in this account, and how much. */
  holders: { goal: GoalRow; here: number }[];
}) {
  const [goalId, setGoalId] = useState("");
  const [note, setNote] = useState("");
  const goals = holders.map((holder) => holder.goal);
  const picked = holders.find((holder) => holder.goal.id === goalId);
  const chosen = picked?.goal;
  const cut = picked ? Math.min(minor, picked.here, Math.max(0, picked.goal.saved_minor)) : 0;
  return (
    <p className="row meta">
      Goals count {formatAmount(minor)} more in {account.name} than it holds.
      {goals.length > 0 && (
        <>
          <select
            aria-label={`Take the gap in ${account.name} off`}
            value={goalId}
            onChange={(e) => setGoalId(e.target.value)}
          >
            <option value="">Take it off…</option>
            {goals.map((goal) => (
              <option key={goal.id} value={goal.id}>
                {goal.title}
              </option>
            ))}
          </select>
          <Button
            disabled={!chosen || cut <= 0}
            onClick={() => {
              if (!chosen) return;
              const now = systemClock.now();
              void transact(
                "user",
                writeOffOps(chosen.id, account.id, cut, now, logicalDate(now), ulid()),
                `savings:${chosen.id}`,
              ).catch((failure: unknown) => setNote(`Couldn't save: ${message(failure)}`));
            }}
          >
            {chosen ? `Take ${formatAmount(cut)} off ${chosen.title}` : "Take it off"}
          </Button>
        </>
      )}
      {note}
    </p>
  );
}

/**
 * Money already in a savings account that no goal holds (it was there before
 * the account backed the goals): give some or all of it to a goal, no move.
 */
function Unclaimed({
  account,
  minor,
  goals,
}: {
  account: AccountRow;
  minor: number;
  goals: GoalRow[];
}) {
  const [goalId, setGoalId] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const give = () => {
    const chosen = amount.trim() === "" ? minor : parseAmount(amount.trim());
    if (chosen === null || chosen <= 0)
      return setNote("An amount like 5,000, or leave it empty for all.");
    if (chosen > minor) return setNote(`At most ${formatAmount(minor)}.`);
    const now = systemClock.now();
    setNote("");
    void transact(
      "user",
      claimOps(goalId, account.id, chosen, now, logicalDate(now), ulid()),
      "savings",
    ).catch((failure: unknown) => setNote(`Couldn't save: ${message(failure)}`));
  };
  return (
    <p className="row meta">
      {account.name} holds {formatAmount(minor)} no goal has yet
      {currencyOf(account) !== "ETB" ? " (in birr at your rate)" : ""}.
      {goals.length > 0 ? (
        <>
          <select
            aria-label={`Give from ${account.name} to`}
            value={goalId}
            onChange={(e) => setGoalId(e.target.value)}
          >
            <option value="">Give it to…</option>
            {goals.map((goal) => (
              <option key={goal.id} value={goal.id}>
                {goal.title}
              </option>
            ))}
          </select>
          <input
            aria-label="How much (empty: all)"
            placeholder="all"
            inputMode="decimal"
            size={9}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <Button disabled={!goalId} onClick={give}>
            Give
          </Button>
        </>
      ) : (
        " Add a goal to give it one."
      )}
      {note && <span role="alert"> {note}</span>}
    </p>
  );
}

/** Savings goals with their plants, and a garden of finished ones (plan §3.13). */
export function Savings() {
  const goals = useLiveQuery<GoalRow & Record<string, string | number>>(GOALS_SQL);
  const waiting = useLiveQuery<{ id: string; amount_minor: number }>(WAITING_SQL);
  const heldBy = useLiveQuery<{ account: string; minor: number }>(HELD_BY_ACCOUNT_SQL);
  const goalHeld = useLiveQuery<{ goal_id: string; account: string; minor: number }>(GOAL_HELD_SQL);
  const accounts = useMoneyAccounts();
  useSavingsSync();
  const backing = accounts.savings.map((row) => row.name).join(", ");
  const [adding, setAdding] = useState(false);
  const [note, setNote] = useState("");
  const growing = goals.rows.filter((goal) => goal.status !== "done");
  const garden = goals.rows.filter((goal) => goal.status === "done");
  const split = waitingSplit(waiting.rows, goals.rows);
  const pick = (ids: string[]) => goals.rows.filter((goal) => ids.includes(goal.id));
  const free = heldBy.loading ? [] : unclaimed(accounts.all, heldBy.rows, accounts.rates);
  const over = heldBy.loading ? [] : overclaimed(accounts.all, heldBy.rows, accounts.rates);
  // A savings account with no balance yet: totals can't count it (F55).
  const unset = accounts.savings.filter((row) => row.opening_date === null);
  const bringBack = (goal: GoalRow) =>
    void transact("user", goalStatusOps(goal.id, "active"), `savings:${goal.id}`)
      .then(() => setNote(`${goal.title} is growing again.`))
      .catch((failure: unknown) => setNote(`Couldn't save: ${message(failure)}`));
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
            Plants never wilt; taking money out moves the plant back.
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
      {adding && <NewGoal goals={goals.rows} onDone={() => setAdding(false)} />}
      {unset.map((row) => (
        <p key={row.id} className="meta">
          {row.name} has no balance yet: set it in Accounts.
        </p>
      ))}
      {split.saved.ids.length > 0 && (
        <Waiting
          minor={split.saved.minor}
          ids={split.saved.ids}
          goals={pick(split.saved.goals)}
          taken={false}
        />
      )}
      {split.taken.ids.length > 0 && (
        <Waiting
          minor={split.taken.minor}
          ids={split.taken.ids}
          goals={pick(split.taken.goals)}
          taken
        />
      )}
      {free.map(({ account, minor }) => (
        <Unclaimed key={account.id} account={account} minor={minor} goals={growing} />
      ))}
      {over.map(({ account, minor }) => (
        <Overclaimed
          key={account.id}
          account={account}
          minor={minor}
          holders={goalHeld.rows.flatMap((row) => {
            const goal = goals.rows.find((one) => one.id === row.goal_id);
            return row.account === account.id && goal && row.minor > 0
              ? [{ goal, here: row.minor }]
              : [];
          })}
        />
      ))}
      {!goals.loading && growing.length === 0 && !adding && (
        <p className="empty">No goals yet. Add one with New goal and watch its plant grow.</p>
      )}
      <ul className="goals">
        {growing.map((goal, index) => (
          <GoalCard
            key={goal.id}
            goal={goal}
            others={goals.rows.filter((other) => other.id !== goal.id)}
            seed={index + 3}
            accounts={accounts}
            goalHeld={goalHeld.rows}
            free={Object.fromEntries(free.map((row) => [row.account.id, row.minor]))}
          />
        ))}
      </ul>
      {garden.length > 0 && (
        <section className="garden-wrap" aria-labelledby="garden">
          <h4 id="garden" className="meta">
            Garden · goals reached
          </h4>
          <div className="garden">
            {garden.map((goal) => (
              <button
                type="button"
                key={goal.id}
                className="garden-tree"
                title={`Bring ${goal.title} back to growing`}
                onClick={() => bringBack(goal)}
              >
                <SavingsTree share={1} compact />
                <span className="meta">{goal.title}</span>
                <span className="meta">{formatAmount(goal.target_minor)}</span>
              </button>
            ))}
          </div>
        </section>
      )}
      {note && (
        <p className="meta" role="status">
          {note}
        </p>
      )}
    </section>
  );
}
