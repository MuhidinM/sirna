import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

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
import { Button } from "./ui";

const dayName = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});
const at = (minutes: number) =>
  `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** The planner over the next 7 days, reloaded after any write. */
function usePreview(today: string): Preview | null {
  const [preview, setPreview] = useState<Preview | null>(null);
  useEffect(() => {
    const load = () => {
      loadPreview(query as Query, today)
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
    <li className="task">
      <span className="warn-text">
        {task.title}
        <span className="meta">
          {" "}
          · due {task.dueDate}
          {task.shortMin !== null && task.shortMin > 0
            ? ` · ${formatMinutes(task.shortMin)} short`
            : ""}
          {task.finishes ? ` · done ${task.finishes} at this pace` : " · no time for it this week"}
        </span>
      </span>
      <span className="row task-meta">
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
  if (!preview) return null;
  return (
    <section className="card" aria-labelledby="week-preview">
      <h2 id="week-preview">Next 7 days</h2>
      {preview.late.length > 0 ? (
        <>
          <p className="warn-text">
            {preview.late.length} task{preview.late.length === 1 ? "" : "s"} won&apos;t be done by
            {preview.late.length === 1 ? " its" : " their"} deadline at this pace:
          </p>
          <ul className="task-list">
            {preview.late.map((task) => (
              <LateRow key={task.id} task={task} today={today} />
            ))}
          </ul>
        </>
      ) : (
        <p className="meta">Everything due this week fits.</p>
      )}
      <ul className="plain-list week-strip">
        {preview.days.map((day) => (
          <li key={day.date} className="row money-line">
            <strong>{dayName.format(Date.parse(`${day.date}T00:00:00Z`))}</strong>
            <span className="meta">
              {day.blocks.length === 0
                ? day.light
                  ? "light day"
                  : "free time kept open"
                : day.blocks
                    .map(
                      (block) =>
                        `${at(block.startMin)} ${block.title} (${formatMinutes(block.durationMin)})`,
                    )
                    .join(" · ")}
            </span>
          </li>
        ))}
      </ul>
      <p className="meta">A forecast from your routine and tasks; nothing changes until you act.</p>
    </section>
  );
}
