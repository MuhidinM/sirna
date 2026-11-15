import { shiftDate, weekStart } from "../features/plan/dayplan";
import { IconChart } from "./icons";
import { type Bar, BarChart, PanelHead } from "./kit";
import { useLiveQuery } from "./useLiveQuery";

/** Planned focus minutes per day of the week (area blocks not skipped or moved). */
const PLANNED_SQL = `
  SELECT logical_date AS day, sum((end_at - start_at) / 60000) AS minutes
  FROM day_blocks
  WHERE deleted_at IS NULL AND kind = 'area' AND status NOT IN ('skipped', 'moved')
    AND logical_date BETWEEN ?1 AND ?2
  GROUP BY logical_date`;

/**
 * Focused minutes per day. Addis is UTC+3 and the day starts at 03:00, so the
 * logical date is the UTC date of the start.
 */
const FOCUSED_SQL = `
  SELECT date(started_at / 1000, 'unixepoch') AS day,
         sum(max(0, (COALESCE(ended_at, started_at) - started_at - paused_ms) / 60000)) AS minutes
  FROM focus_sessions
  WHERE kind = 'focus' AND date(started_at / 1000, 'unixepoch') BETWEEN ?1 AND ?2
  GROUP BY day`;

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const hours = (minutes: number) => {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h > 0 ? `${h}hr ${m}min` : `${m}min`;
};

/** This week's focus: planned (cap) against done (body), today highlighted. */
export function FocusWeek({ today }: { today: string }) {
  const monday = weekStart(today);
  const sunday = shiftDate(monday, 6);
  const planned = useLiveQuery<{ day: string; minutes: number }>(PLANNED_SQL, [monday, sunday]);
  const focused = useLiveQuery<{ day: string; minutes: number }>(FOCUSED_SQL, [monday, sunday]);
  if (planned.loading || focused.loading) return null;
  const totalDone = focused.rows.reduce((sum, row) => sum + row.minutes, 0);
  const bars: Bar[] = DAYS.map((label, i) => {
    const day = shiftDate(monday, i);
    const plan = planned.rows.find((row) => row.day === day)?.minutes ?? 0;
    const done = focused.rows.find((row) => row.day === day)?.minutes ?? 0;
    return {
      label,
      total: plan / 60,
      done: done / 60,
      highlight: day === today,
      tipTitle: day === today ? "Today" : day,
      tip: [
        { label: "Planned", value: hours(plan), tone: "yellow" },
        { label: "Focused", value: hours(done), tone: "cream" },
      ],
    };
  });
  return (
    <section className="panel" aria-labelledby="focus-week">
      <PanelHead
        id="focus-week"
        title="Weekly focus overview"
        sub={
          <>
            This week: <b>{hours(totalDone)}</b> focused
          </>
        }
        action={
          <span className="icon-btn" aria-hidden="true">
            <IconChart size={18} />
          </span>
        }
      />
      <BarChart bars={bars} unit="hr" ariaLabel={`Focus this week: ${hours(totalDone)} focused`} />
    </section>
  );
}
