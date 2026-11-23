import "../theme/pages/plan-week.css";

import { useEffect, useState } from "react";

import { systemClock } from "../kernel/clock";
import { logicalDate, showDate } from "../kernel/dates";
import { query, transact } from "../kernel/db";
import { ulid } from "../kernel/ulid";
import { ensureDayPlan, shiftDate } from "../features/plan/dayplan";
import { type BlockRow, TODAY_BLOCKS_SQL } from "../features/plan/now";
import { IconArrowLeft, IconArrowRight } from "./icons";
import { Timeline, useBoard } from "./Timeline";
import { Button } from "./ui";
import { useLiveQuery } from "./useLiveQuery";

const longWeekday = new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" });

/** The current time, updated each minute, for the now line. */
function useMinute(): number {
  const [minute, setMinute] = useState(() => systemClock.now());
  useEffect(() => {
    const timer = setInterval(() => setMinute(systemClock.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return minute;
}

/**
 * Plan → Day (time-first §1 rule 8): any date's full board, the same hour
 * grid as Today, and every block on it can be moved, resized, changed,
 * deleted or added. A day from today on that has no plan yet gets one from
 * the routine when it is opened.
 */
export function DayPlan({ date, onDate }: { date: string; onDate: (date: string) => void }) {
  const nowMs = useMinute();
  const today = logicalDate(nowMs);
  // The dates whose plan run has finished, and why one failed.
  const [planned, setPlanned] = useState<Set<string>>(() => new Set());
  const [failure, setFailure] = useState<{ date: string; message: string } | null>(null);
  const planning = date >= today && !planned.has(date);
  const failed = failure?.date === date ? failure.message : null;

  useEffect(() => {
    if (date < today) return;
    void ensureDayPlan(
      query,
      (ops) => transact("system", ops, "day-plan"),
      systemClock.now(),
      () => ulid(),
      date,
    )
      .catch((error: unknown) =>
        setFailure({ date, message: error instanceof Error ? error.message : String(error) }),
      )
      .finally(() => setPlanned((old) => new Set(old).add(date)));
  }, [date, today]);

  const blocks = useLiveQuery<BlockRow & Record<string, string | number | null>>(TODAY_BLOCKS_SQL, [
    date,
  ]);
  const board = useBoard(date, blocks.rows);
  const ms = Date.parse(`${date}T00:00:00Z`);
  const when =
    date === today
      ? "today"
      : date === shiftDate(today, 1)
        ? "tomorrow"
        : date === shiftDate(today, -1)
          ? "yesterday"
          : null;

  return (
    <main className="page plan-week plan-day">
      <section className="canvas" aria-labelledby="day-title">
        <header className="canvas-head">
          <h1 id="day-title" className="page-title">
            {longWeekday.format(ms)}, <span className="soft">{showDate(date, today)}</span>
          </h1>
          {when && <span className="pw-chip">{when}</span>}
          <span className="spacer" />
          <div className="pd-stepper" role="group" aria-label="Pick a day">
            <button
              type="button"
              className="icon-btn"
              aria-label="Previous day"
              onClick={() => onDate(shiftDate(date, -1))}
            >
              <IconArrowLeft />
            </button>
            <label className="pd-date">
              <span className="visually-hidden">Date</span>
              <input
                type="date"
                value={date}
                onChange={(event) => {
                  if (/^\d{4}-\d{2}-\d{2}$/.test(event.target.value)) onDate(event.target.value);
                }}
              />
            </label>
            <button
              type="button"
              className="icon-btn"
              aria-label="Next day"
              onClick={() => onDate(shiftDate(date, 1))}
            >
              <IconArrowRight />
            </button>
            {date !== today && <Button onClick={() => onDate(today)}>Today</Button>}
          </div>
        </header>

        {failed && (
          <p role="alert" className="error">
            Couldn&apos;t plan this day: {failed}
          </p>
        )}
        {blocks.error && (
          <p role="alert" className="error">
            Couldn&apos;t load this day: {blocks.error}
          </p>
        )}
        {planning && blocks.rows.length === 0 ? (
          <p className="meta">Planning this day…</p>
        ) : (
          <>
            {blocks.rows.length === 0 && (
              <p className="empty">
                {date < today
                  ? "Nothing was planned for this day."
                  : "Nothing planned yet. Click an hour to add a block."}
              </p>
            )}
            <Timeline
              blocks={blocks.rows}
              nowMs={nowMs}
              date={date}
              areaTasks={board.areaTasks}
              onDone={board.onDone}
              edit={board.edit}
              label={`Plan for ${showDate(date, today, { weekday: true })}`}
            />
          </>
        )}
      </section>
    </main>
  );
}
