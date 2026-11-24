import { useState } from "react";

import { showDate } from "../kernel/dates";
import { type Op, transact } from "../kernel/db";
import { ulid } from "../kernel/ulid";
import { isoWeekday } from "../features/plan/dayplan";
import {
  INBOX_COUNT_SQL,
  INBOX_TWO_SQL,
  inboxBadge,
  sortInbox,
  type SortChoice,
  SORTED,
} from "../features/review/review";
import {
  MAX_OUTCOMES,
  outcomeOps,
  planKey,
  planningWeek,
  readPlan,
  skipStepOps,
  WEEK_PLAN_SQL,
} from "../features/week/outcomes";
import { cancelOnEscape, refocusSoon, returnsFocus } from "./keys";
import { Button } from "./ui";
import { useLiveQuery } from "./useLiveQuery";

/** This week's outcomes, for Today and the brief (T-076). */
export function useWeekOutcomes(monday: string): string[] | null {
  const plan = useLiveQuery<{ value_json: string | null }>(WEEK_PLAN_SQL, [planKey(monday)]);
  return plan.loading ? null : readPlan(plan.rows[0]?.value_json).outcomes;
}

/**
 * The planning step on the week card (T-076; proposal 4.5, 4.6): loose ends two
 * at a time, then up to 3 outcomes for the week. Each step can be skipped.
 */
export function WeekAhead({ today }: { today: string }) {
  const monday = planningWeek(today);
  const saved = useLiveQuery<{ value_json: string | null }>(WEEK_PLAN_SQL, [planKey(monday)]);
  const inbox = useLiveQuery<{ id: string; body: string }>(INBOX_TWO_SQL);
  const inboxTotal = useLiveQuery<{ n: number }>(INBOX_COUNT_SQL).rows[0]?.n ?? 0;
  const [lastSort, setLastSort] = useState<{ body: string; choice: SortChoice; undo: Op[] }>();
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (saved.loading || inbox.loading) return null;

  const json = saved.rows[0]?.value_json;
  const plan = readPlan(json);
  /** True once saved; on a failure the error shows and what you typed stays. */
  const write = (ops: Op[]): Promise<boolean> =>
    ops.length === 0
      ? Promise.resolve(true)
      : transact("user", ops, "week:plan").then(
          () => {
            setError(null);
            return true;
          },
          (failure: unknown) => {
            setError(
              `Couldn't save: ${failure instanceof Error ? failure.message : String(failure)}`,
            );
            return false;
          },
        );
  const sort = (note: { id: string; body: string }, choice: SortChoice) => {
    const sorted = sortInbox(note, choice, () => ulid());
    void write(sorted.ops).then((saved) => {
      if (saved) setLastSort({ body: note.body, choice, undo: sorted.undo });
    });
  };
  const showTriage =
    (inbox.rows.length > 0 || lastSort !== undefined) && !plan.skipped.includes("triage");
  const outcomesDone = plan.outcomes.length > 0 || plan.skipped.includes("outcomes");
  const showForm = editing || !outcomesDone;
  const lines = drafts ?? [...plan.outcomes, "", "", ""].slice(0, MAX_OUTCOMES);
  const sunday = isoWeekday(today) === 7;

  return (
    <section className="pw-section week-ahead" id="week-plan" aria-labelledby="week-ahead">
      <div className="pw-section-head">
        <div>
          <h2 id="week-ahead">{sunday ? "Plan next week" : "This week's plan"}</h2>
          <p className="meta">
            Week of {showDate(monday, today, { weekday: true })} · every step can be skipped.
          </p>
        </div>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      <div className="pw-ahead-cols">
        {showTriage && (
          <div className="pw-step">
            <h3>
              <span className="pw-step-no" aria-hidden="true">
                1
              </span>
              Loose ends{" "}
              {inbox.rows.length > 0 && (
                <span className="badge">{inboxBadge(inbox.rows.length, inboxTotal)}</span>
              )}
            </h3>
            {lastSort && (
              <p className="meta" role="status">
                {SORTED[lastSort.choice]}: {lastSort.body}{" "}
                <button
                  type="button"
                  className="link-btn"
                  onClick={() =>
                    void write(lastSort.undo).then((saved) => {
                      if (saved) setLastSort(undefined);
                    })
                  }
                >
                  Undo
                </button>
              </p>
            )}
            <ul className="pw-loose">
              {inbox.rows.map((note) => (
                <li key={note.id}>
                  <span className="pw-loose-body">{note.body}</span>
                  <span className="pw-actions">
                    {(["task", "note", "drop"] as const).map((choice) => (
                      <Button
                        key={choice}
                        className={choice === "drop" ? "btn-ghost btn-danger" : undefined}
                        onClick={() => sort(note, choice)}
                      >
                        {choice === "task" ? "Task" : choice === "note" ? "Note" : "Drop"}
                      </Button>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
            <Button
              className="btn-ghost"
              onClick={() => void write(skipStepOps(json, monday, "triage"))}
            >
              Skip the rest
            </Button>
          </div>
        )}

        <div className="pw-step">
          <h3>
            <span className="pw-step-no" aria-hidden="true">
              {showTriage ? 2 : 1}
            </span>
            Up to {MAX_OUTCOMES} outcomes
          </h3>
          {showForm ? (
            // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Escape cancels; keydown bubbles from its fields
            <form
              className="pw-outcome-form"
              onKeyDown={
                // Escape cancels an edit, as Cancel does; the first fill has no Cancel.
                editing
                  ? cancelOnEscape(() => {
                      setEditing(false);
                      setDrafts(null);
                      refocusSoon("week-outcomes");
                    })
                  : undefined
              }
              onSubmit={(event) => {
                event.preventDefault();
                void write(outcomeOps(json, monday, lines)).then((saved) => {
                  if (!saved) return;
                  setEditing(false);
                  setDrafts(null);
                });
              }}
            >
              {lines.map((line, index) => (
                <label key={index} className="pw-outcome-field">
                  <span className="pw-outcome-no" aria-hidden="true">
                    {index + 1}
                  </span>
                  <input
                    aria-label={`Outcome ${index + 1}`}
                    placeholder={index === 0 ? "What would make this week a good one?" : ""}
                    maxLength={120}
                    value={line}
                    onChange={(event) =>
                      setDrafts(lines.map((old, at) => (at === index ? event.target.value : old)))
                    }
                  />
                </label>
              ))}
              <div className="pw-actions">
                <Button type="submit" className="btn-orange">
                  Save
                </Button>
                {!plan.skipped.includes("outcomes") && plan.outcomes.length === 0 && (
                  <Button onClick={() => void write(skipStepOps(json, monday, "outcomes"))}>
                    Skip
                  </Button>
                )}
                {editing && (
                  <Button
                    onClick={() => {
                      setEditing(false);
                      setDrafts(null);
                    }}
                  >
                    Cancel
                  </Button>
                )}
              </div>
            </form>
          ) : (
            <>
              {plan.outcomes.length > 0 ? (
                <ol className="pw-outcomes">
                  {plan.outcomes.map((outcome) => (
                    <li key={outcome}>{outcome}</li>
                  ))}
                </ol>
              ) : (
                <p className="meta">Skipped for this week.</p>
              )}
              <div className="pw-actions">
                <Button {...returnsFocus("week-outcomes")} onClick={() => setEditing(true)}>
                  {plan.outcomes.length > 0 ? "Change" : "Add outcomes"}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
