import { useState } from "react";

import { systemClock } from "../kernel/clock";
import { logicalDate } from "../kernel/dates";
import { query, transact } from "../kernel/db";
import { formatAmount, parseAmount } from "../kernel/money";
import { ulid } from "../kernel/ulid";
import {
  addGoalOps,
  assignOps,
  checkGoal,
  checkTakeOut,
  entryOps,
  type GoalDraft,
  type GoalRow,
  GOALS_SQL,
  goalStatusOps,
  shareSaved,
  STAGE_NAMES,
  stageOf,
  UNASSIGNED_SQL,
} from "../features/savings/savings";
import { Plant } from "./Plant";
import { Button } from "./ui";
import { useLiveQuery } from "./useLiveQuery";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function GoalCard({ goal }: { goal: GoalRow }) {
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const share = shareSaved(goal);
  const stage = stageOf(share);
  const move = (sign: 1 | -1) => {
    const minor = parseAmount(amount);
    if (minor === null || minor <= 0) {
      setNote("An amount like 500 or 2k.");
      return;
    }
    const tooMuch = sign < 0 ? checkTakeOut(goal, minor) : null;
    if (tooMuch) {
      setNote(tooMuch);
      return;
    }
    const now = systemClock.now();
    transact(
      "user",
      entryOps(goal.id, sign * minor, now, logicalDate(now), ulid(), "dashboard"),
      `savings:${goal.id}`,
    )
      .then(() => {
        setAmount("");
        setNote(`${sign > 0 ? "Saved" : "Took out"} ${formatAmount(minor)}`);
      })
      .catch((failure: unknown) => setNote(`Couldn't save: ${message(failure)}`));
  };
  return (
    <li className="goal">
      <Plant stage={stage} />
      <div className="goal-body">
        <strong>{goal.title}</strong>
        <span>
          {formatAmount(Math.max(0, goal.saved_minor))} of {formatAmount(goal.target_minor)}{" "}
          <span className="meta">
            · {Math.round(share * 100)}% · {STAGE_NAMES[stage]}
          </span>
        </span>
        <div className="row">
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
          <Button onClick={() => move(1)}>Put aside</Button>
          <Button onClick={() => move(-1)}>Take out</Button>
          {stage === 5 && (
            <Button
              primary
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
      <input
        aria-label="Goal name"
        placeholder="Laptop"
        value={draft.title}
        onChange={(event) => setDraft({ ...draft, title: event.target.value })}
      />
      <input
        aria-label="Target"
        inputMode="decimal"
        placeholder="100,000"
        value={draft.target}
        onChange={(event) => setDraft({ ...draft, target: event.target.value })}
      />
      <Button type="submit" primary>
        Add goal
      </Button>
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
  const [adding, setAdding] = useState(false);
  const growing = goals.rows.filter((goal) => goal.status !== "done");
  const garden = goals.rows.filter((goal) => goal.status === "done");
  const unassigned = waiting.rows[0];
  return (
    <section className="card savings" aria-labelledby="savings">
      <div className="row">
        <h2 id="savings">Savings</h2>
        {!adding && <Button onClick={() => setAdding(true)}>New goal</Button>}
      </div>
      <p className="meta">
        Capture <code>saved 500 laptop</code> or <code>took 2000 from laptop</code>. Plants only
        grow; taking money out just lowers the number.
      </p>
      {adding && <NewGoal onDone={() => setAdding(false)} />}
      {unassigned && unassigned.n > 0 && <GiveTo minor={unassigned.minor} goals={growing} />}
      {!goals.loading && growing.length === 0 && !adding && <p className="meta">No goals yet.</p>}
      <ul className="goals">
        {growing.map((goal) => (
          <GoalCard key={goal.id} goal={goal} />
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
              <Plant stage={5} size={40} />
              <span className="meta">{goal.title}</span>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
