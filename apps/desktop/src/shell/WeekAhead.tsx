import { useState } from "react";

import { type Op, transact } from "../kernel/db";
import { ulid } from "../kernel/ulid";
import { isoWeekday } from "../features/plan/dayplan";
import { INBOX_TWO_SQL, sortInboxOps } from "../features/review/review";
import {
  MAX_OUTCOMES,
  outcomeOps,
  planKey,
  planningWeek,
  readPlan,
  skipStepOps,
  WEEK_PLAN_SQL,
} from "../features/week/outcomes";
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
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (saved.loading || inbox.loading) return null;

  const json = saved.rows[0]?.value_json;
  const plan = readPlan(json);
  const write = (ops: Op[]) =>
    ops.length === 0
      ? Promise.resolve()
      : transact("user", ops, "week:plan").catch((failure: unknown) =>
          setError(
            `Couldn't save: ${failure instanceof Error ? failure.message : String(failure)}`,
          ),
        );
  const showTriage = inbox.rows.length > 0 && !plan.skipped.includes("triage");
  const outcomesDone = plan.outcomes.length > 0 || plan.skipped.includes("outcomes");
  const showForm = editing || !outcomesDone;
  const lines = drafts ?? [...plan.outcomes, "", "", ""].slice(0, MAX_OUTCOMES);
  const sunday = isoWeekday(today) === 7;

  return (
    <section className="card week-ahead" aria-labelledby="week-ahead">
      <h2 id="week-ahead">{sunday ? "Plan next week" : "This week's plan"}</h2>
      <p className="meta">Week of {monday} · every step can be skipped.</p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      {showTriage && (
        <>
          <h3>Loose ends</h3>
          <ul>
            {inbox.rows.map((note) => (
              <li key={note.id} className="task">
                <span>{note.body}</span>
                <span className="row">
                  {(["task", "note", "drop"] as const).map((choice) => (
                    <Button
                      key={choice}
                      onClick={() => void write(sortInboxOps(note, choice, () => ulid()))}
                    >
                      {choice === "task" ? "Task" : choice === "note" ? "Note" : "Drop"}
                    </Button>
                  ))}
                </span>
              </li>
            ))}
          </ul>
          <Button onClick={() => void write(skipStepOps(json, monday, "triage"))}>
            Skip the rest
          </Button>
        </>
      )}

      <h3>Up to {MAX_OUTCOMES} outcomes</h3>
      {showForm ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void write(outcomeOps(json, monday, lines)).then(() => {
              setEditing(false);
              setDrafts(null);
            });
          }}
        >
          {lines.map((line, index) => (
            <input
              key={index}
              aria-label={`Outcome ${index + 1}`}
              placeholder={index === 0 ? "What would make this week a good one?" : ""}
              maxLength={120}
              value={line}
              onChange={(event) =>
                setDrafts(lines.map((old, at) => (at === index ? event.target.value : old)))
              }
            />
          ))}
          <div className="row">
            <Button type="submit" primary>
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
            <ol className="outcomes">
              {plan.outcomes.map((outcome) => (
                <li key={outcome}>{outcome}</li>
              ))}
            </ol>
          ) : (
            <p className="meta">Skipped for this week.</p>
          )}
          <Button onClick={() => setEditing(true)}>
            {plan.outcomes.length > 0 ? "Change" : "Add outcomes"}
          </Button>
        </>
      )}
    </section>
  );
}
