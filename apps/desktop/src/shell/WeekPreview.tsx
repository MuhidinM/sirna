import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

import { systemClock } from "../kernel/clock";
import { showDate } from "../kernel/dates";
import { query, transact } from "../kernel/db";
import { formatMinutes } from "../features/plan/now";
import { healPlans, isoWeekday, type Query, shiftDate } from "../features/plan/dayplan";
import { ulid } from "../kernel/ulid";
import { PLANNED_RANGE_SQL, weekColumn } from "../features/plan/edit";
import { ROUTINE_SQL, type RoutineRow } from "../features/plan/editor";
import {
  type LateTask,
  loadPreview,
  planTodayOps,
  pushDeadlineOps,
  type WeekPreview as Preview,
} from "../features/plan/preview";
import { EventCard, toneOf } from "./kit";
import { Button } from "./ui";
import { useLiveQuery } from "./useLiveQuery";

const weekday = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "UTC" });
const at = (minutes: number) =>
  `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

const AREA_COLORS_SQL = "SELECT id, color FROM area_items WHERE deleted_at IS NULL";

/** A column shows this many cards; "+N more" opens the day for the rest. */
export const COLUMN_CARDS = 6;

type PlannedRow = {
  logical_date: string;
  start_at: number;
  end_at: number;
  kind: string;
  area_id: string | null;
  title: string;
};

/** The planner over the next 7 days, reloaded after any write. */
function usePreview(today: string): Preview | null {
  const [preview, setPreview] = useState<Preview | null>(null);
  // Planned days get blocks for tasks timed after they were planned.
  useEffect(() => {
    void healPlans(
      query as Query,
      (ops) => transact("system", ops, "day-plan"),
      systemClock.now(),
      () => ulid(),
    ).catch(() => undefined);
  }, [today]);
  useEffect(() => {
    const load = () => {
      loadPreview(query as Query, today, systemClock.now())
        .then(setPreview)
        .catch(() => setPreview(null));
    };
    load();
    const unlisten = listen("data-changed", load);
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, [today]);
  return preview;
}

function LateRow({ task, today }: { task: LateTask; today: string }) {
  const [error, setError] = useState<string | null>(null);
  const write = (ops: Parameters<typeof transact>[1]) =>
    void transact("user", ops, `task:${task.id}`).catch((failure: unknown) =>
      setError(
        `Couldn't change it: ${failure instanceof Error ? failure.message : String(failure)}`,
      ),
    );
  return (
    <li className="pw-late-row">
      <span className="pw-dot" aria-hidden="true" />
      <span className="pw-late-text">
        <b>{task.title}</b>
        <span className="meta">
          {" "}
          · due {showDate(task.dueDate, today)}
          {task.shortMin !== null && task.shortMin > 0
            ? ` · ${formatMinutes(task.shortMin)} short`
            : ""}
          {task.finishes
            ? ` · done ${showDate(task.finishes, today)} at this pace`
            : " · no time for it this week"}
        </span>
      </span>
      <span className="pw-actions">
        <Button onClick={() => write(planTodayOps(task.id, today))}>Start today</Button>
        <Button onClick={() => write(pushDeadlineOps(task))}>Push a week</Button>
      </span>
      {error && (
        <span role="alert" className="error">
          {error}
        </span>
      )}
    </li>
  );
}

/**
 * Next 7 days (T-069; time-first §1 rule 8): what each day holds, and what
 * won't make its deadline. A day already planned shows its blocks; a later
 * one shows the routine with the forecast. A column opens that day in
 * Plan → Day.
 */
export function WeekPreview({
  today,
  onOpenDay,
}: {
  today: string;
  onOpenDay?: ((date: string) => void) | undefined;
}) {
  const preview = usePreview(today);
  const colors = useLiveQuery<{ id: string; color: string }>(AREA_COLORS_SQL);
  const planned = useLiveQuery<PlannedRow>(PLANNED_RANGE_SQL, [today, shiftDate(today, 6)]);
  const routine = useLiveQuery<RoutineRow & Record<string, string | number | null>>(ROUTINE_SQL);
  if (!preview)
    return (
      <section className="pw-section pw-preview" aria-labelledby="week-preview">
        <h2 id="week-preview">Next 7 days</h2>
        <p className="meta">Checking the week…</p>
      </section>
    );
  const colorOf = new Map(colors.rows.map((row) => [row.id, row.color]));
  const lateCount = preview.late.length;
  return (
    <section className="pw-section pw-preview" aria-labelledby="week-preview">
      <div className="pw-section-head">
        <div>
          <h2 id="week-preview">Next 7 days</h2>
          <p className="meta">A forecast from your routine and tasks; open a day to change it.</p>
        </div>
        {/* The late-task check, said once (time first §5). */}
        {lateCount === 0 ? (
          <span className="pw-chip" role="status">
            Nothing is late: everything due this week fits.
          </span>
        ) : (
          <span className="pw-chip warn">
            <span className="badge">{lateCount}</span> late at this pace
          </span>
        )}
      </div>

      <ol className="pw-days">
        {preview.days.map((day) => {
          const ms = Date.parse(`${day.date}T00:00:00Z`);
          const isToday = day.date === today;
          // Away (plan §3.11): no plan to show, whatever was planned before.
          const blocks = day.away
            ? []
            : weekColumn(
                day.date,
                planned.rows.filter((row) => row.logical_date === day.date),
                routine.rows.filter((row) => row.weekday === isoWeekday(day.date)),
                day.blocks,
              );
          const shown = blocks.slice(0, COLUMN_CARDS);
          const more = blocks.length - shown.length;
          const open = onOpenDay ? () => onOpenDay(day.date) : undefined;
          const name = `${showDate(day.date, today, { weekday: true })}${isToday ? ", today" : ""}`;
          return (
            <li key={day.date} className={isToday ? "pw-day today" : "pw-day"}>
              {open ? (
                <button
                  type="button"
                  className="pw-day-head pw-day-open"
                  aria-label={`Open ${name}`}
                  onClick={open}
                >
                  <span className="pw-day-name">{weekday.format(ms)}</span>
                  <span className="pw-day-num">{Number(day.date.slice(8))}</span>
                </button>
              ) : (
                <>
                  <span className="visually-hidden">{name}</span>
                  <div className="pw-day-head" aria-hidden="true">
                    <span className="pw-day-name">{weekday.format(ms)}</span>
                    <span className="pw-day-num">{Number(day.date.slice(8))}</span>
                  </div>
                </>
              )}
              {blocks.length === 0 ? (
                <p className="pw-day-empty">
                  {day.away ? "Away" : day.light ? "Light day" : "Free time kept open"}
                </p>
              ) : (
                <div className="pw-day-cards">
                  {shown.map((block, index) => (
                    <EventCard
                      key={`${block.startMin}-${index}`}
                      tone={toneOf(block.areaId ? colorOf.get(block.areaId) : null)}
                      label={`${at(block.startMin)} · ${formatMinutes(block.durationMin)}`}
                      title={block.title}
                    />
                  ))}
                  {more > 0 &&
                    (open ? (
                      <button
                        type="button"
                        className="pw-more"
                        aria-label={`Open ${name}: ${more} more`}
                        onClick={open}
                      >
                        +{more} more
                      </button>
                    ) : (
                      <span className="pw-more">+{more} more</span>
                    ))}
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {lateCount > 0 && (
        <div className="pw-late">
          <p className="pw-late-lead">
            {lateCount} task{lateCount === 1 ? "" : "s"} won&apos;t be done by
            {lateCount === 1 ? " its" : " their"} deadline at this pace:
          </p>
          <ul className="pw-late-list">
            {preview.late.map((task) => (
              <LateRow key={task.id} task={task} today={today} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
