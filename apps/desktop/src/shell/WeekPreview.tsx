import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

import { systemClock } from "../kernel/clock";
import { query, transact } from "../kernel/db";
import { formatMinutes } from "../features/plan/now";
import { type Query } from "../features/plan/dayplan";
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

const dayName = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});
const weekday = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "UTC" });
const at = (minutes: number) =>
  `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

const AREA_COLORS_SQL = "SELECT id, color FROM area_items WHERE deleted_at IS NULL";

/** The planner over the next 7 days, reloaded after any write. */
function usePreview(today: string): Preview | null {
  const [preview, setPreview] = useState<Preview | null>(null);
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
          · due {task.dueDate}
          {task.shortMin !== null && task.shortMin > 0
            ? ` · ${formatMinutes(task.shortMin)} short`
            : ""}
          {task.finishes ? ` · done ${task.finishes} at this pace` : " · no time for it this week"}
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

/** Next 7 days (T-069): what each day holds, and what won't make its deadline. */
export function WeekPreview({ today }: { today: string }) {
  const preview = usePreview(today);
  const colors = useLiveQuery<{ id: string; color: string }>(AREA_COLORS_SQL);
  if (!preview) return null;
  const colorOf = new Map(colors.rows.map((row) => [row.id, row.color]));
  const lateCount = preview.late.length;
  return (
    <section className="pw-section pw-preview" aria-labelledby="week-preview">
      <div className="pw-section-head">
        <div>
          <h2 id="week-preview">Next 7 days</h2>
          <p className="meta">
            A forecast from your routine and tasks; nothing changes until you act.
          </p>
        </div>
        {lateCount === 0 ? (
          <span className="pw-chip">Everything due this week fits.</span>
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
          return (
            <li key={day.date} className={isToday ? "pw-day today" : "pw-day"}>
              <strong className="visually-hidden">
                {dayName.format(ms)}
                {isToday ? ", today" : ""}
              </strong>
              <div className="pw-day-head" aria-hidden="true">
                <span className="pw-day-name">{weekday.format(ms)}</span>
                <span className="pw-day-num">{Number(day.date.slice(8))}</span>
              </div>
              {day.blocks.length === 0 ? (
                <p className="pw-day-empty">{day.light ? "light day" : "free time kept open"}</p>
              ) : (
                <div className="pw-day-cards">
                  {day.blocks.map((block, index) => (
                    <EventCard
                      key={`${block.startMin}-${index}`}
                      tone={toneOf(block.areaId ? colorOf.get(block.areaId) : null)}
                      label={`${at(block.startMin)} · ${formatMinutes(block.durationMin)}`}
                      title={block.title}
                    />
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
