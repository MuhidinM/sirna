import { showDate } from "../kernel/dates";
import { shiftDate, weekStart } from "../features/plan/dayplan";
import { formatMinutes } from "../features/plan/now";
import { FOCUSED_BY_DAY_SQL } from "../features/week/card";
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

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** "2 h 10 min", the app's one way to write a length of time. */
const hours = (minutes: number) => formatMinutes(Math.round(minutes));

/** This week's focus: planned (cap) against done (body), today highlighted. */
export function FocusWeek({ today, nowMs }: { today: string; nowMs: number }) {
  const monday = weekStart(today);
  const sunday = shiftDate(monday, 6);
  const planned = useLiveQuery<{ day: string; minutes: number }>(PLANNED_SQL, [monday, sunday]);
  // A running session counts up to now, as on Plan's "Where time went" (reg1-5).
  const focused = useLiveQuery<{ day: string; minutes: number }>(FOCUSED_BY_DAY_SQL, [
    monday,
    sunday,
    nowMs,
  ]);
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
      tipTitle: day === today ? "Today" : showDate(day, today, { weekday: true }),
      tip: [
        { label: "Focus planned", value: hours(plan), tone: "yellow" },
        { label: "Focused", value: hours(done), tone: "cream" },
      ],
    };
  });
  return (
    <section className="panel" aria-labelledby="focus-week">
      <PanelHead
        id="focus-week"
        icon={<IconChart size={18} />}
        title="Weekly focus overview"
        sub={
          <>
            This week: <b>{hours(totalDone)}</b> focused
          </>
        }
      />
      <BarChart bars={bars} unit="h" ariaLabel={`Focus this week: ${hours(totalDone)} focused`} />
    </section>
  );
}
