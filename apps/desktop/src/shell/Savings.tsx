import { useState } from "react";
import "../theme/pages/savings.css";

import { systemClock } from "../kernel/clock";
import { logicalDate } from "../kernel/dates";
import { query, transact } from "../kernel/db";
import { formatAmount, parseAmount } from "../kernel/money";
import { ulid } from "../kernel/ulid";
import {
  addGoalOps,
  assignOps,
  checkGoal,
  checkGoalEdit,
  checkTakeOut,
  type GoalEdit,
  goalEditOps,
  goalPace,
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
import { IconPencil, IconPlus } from "./icons";
import { PanelHead } from "./kit";
import { SavingsTree } from "./SavingsTree";
import { Button } from "./ui";
import { useLiveQuery } from "./useLiveQuery";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

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
function GoalCard({ goal, seed }: { goal: GoalRow; seed: number }) {
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState(false);
  const today = logicalDate(systemClock.now());
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
            Capture <code>saved 500 laptop</code> or <code>took 2000 from laptop</code>. Plants only
            grow; taking money out just lowers the number.
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
          <GoalCard key={goal.id} goal={goal} seed={index + 3} />
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
