import { useEffect, useState } from "react";

import { systemClock } from "../kernel/clock";
import { logicalDate } from "../kernel/dates";
import {
  AWAY_HISTORY_SQL,
  type AwayChange,
  awayDays,
  type Cell,
  dayFacts,
  FIRST_DAY_SQL,
  FOCUS_DAYS_SQL,
  type FocusDayRow,
  GOAL_SQL,
  HABIT_DAYS_SQL,
  type HabitDayRow,
  PLAN_DAYS_SQL,
  type PlanDayRow,
  streakOf,
  TILES_SQL,
  type Tiles,
  yearGrid,
  yearStart,
} from "../features/dashboard/streak";
import { weekStart } from "../features/plan/dayplan";
import { hoursLabel } from "../features/projects/capacity";
import { AREA_WEEK_SQL, type AreaWeek, share } from "../features/week/card";
import { type AreaColor, Bar } from "./ui";
import { useLiveQuery } from "./useLiveQuery";

const AREAS_SQL =
  "SELECT id, name FROM area_items WHERE deleted_at IS NULL AND active = 1 AND kind != 'work' ORDER BY priority_rank, name";

/** The time now, moved on every minute. */
function useMinute(): number {
  const [now, setNow] = useState(() => systemClock.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(systemClock.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function Flame({ lit }: { lit: boolean }) {
  return (
    <svg viewBox="0 0 24 32" className={lit ? "flame lit" : "flame"} aria-hidden="true">
      <path d="M12 1c1 6 8 9 8 18a8 8 0 0 1-16 0c0-5 3-7 4-11 1 3 2 4 3 5 1-4 1-8 1-12z" />
    </svg>
  );
}

const dayLabel = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

/**
 * The chart's cells are for the mouse (out of the tab order); the date field
 * next to it picks a day from the keyboard.
 */
function YearChart({ grid, onPick }: { grid: Cell[][]; onPick: (date: string) => void }) {
  return (
    <div className="year-chart" role="group" aria-label="Focus time over the last year">
      {grid.map((week) => (
        <div key={week[0]?.date} className="year-week">
          {week.map((cell) => (
            <button
              key={cell.date}
              type="button"
              tabIndex={-1}
              className={`year-cell shade-${cell.shade}${cell.outline ? " outline" : ""}${cell.future ? " future" : ""}`}
              disabled={cell.future}
              title={`${dayLabel.format(new Date(`${cell.date}T00:00:00Z`))}: ${cell.minutes ? hoursLabel(cell.minutes) : "no focus"}`}
              aria-label={`${cell.date}, ${cell.minutes} minutes`}
              onClick={() => onPick(cell.date)}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/** The dashboard (plan §3.13): tiles, the streak, the year chart and this week's areas. */
export function Dashboard() {
  const nowMs = useMinute();
  const today = logicalDate(nowMs);
  const monday = weekStart(today);
  const startMs = Date.parse(`${monday}T00:00:00Z`);
  const first = yearStart(today);
  const [area, setArea] = useState("");
  const [picked, setPicked] = useState<string | null>(null);

  const tiles = useLiveQuery<Tiles & Record<string, number>>(TILES_SQL, [startMs, nowMs]);
  const goal = useLiveQuery<{ goal_min: number }>(GOAL_SQL);
  // The streak is about all areas; the chart follows the filter.
  // The streak goes back to the first day Sirna has anything for; the chart shows a year.
  const firstDay = useLiveQuery<{ first: string | null }>(FIRST_DAY_SQL);
  const since =
    firstDay.rows[0]?.first && firstDay.rows[0].first < first ? firstDay.rows[0].first : first;
  const allFocus = useLiveQuery<FocusDayRow & Record<string, string | number>>(FOCUS_DAYS_SQL, [
    since,
    "",
  ]);
  const awayHistory = useLiveQuery<AwayChange & Record<string, string | number | null>>(
    AWAY_HISTORY_SQL,
  );
  const habits = useLiveQuery<HabitDayRow & Record<string, string | number>>(HABIT_DAYS_SQL, [
    first,
    area,
  ]);
  const areaFocus = useLiveQuery<FocusDayRow & Record<string, string | number>>(FOCUS_DAYS_SQL, [
    first,
    area,
  ]);
  const plans = useLiveQuery<PlanDayRow & Record<string, string | number>>(PLAN_DAYS_SQL, [since]);
  const areas = useLiveQuery<{ id: string; name: string }>(AREAS_SQL);
  const week = useLiveQuery<AreaWeek & Record<string, string | number>>(AREA_WEEK_SQL, [
    startMs,
    nowMs,
  ]);

  const away = awayDays(awayHistory.rows, since, today);
  const days = dayFacts(since, today, allFocus.rows, plans.rows, [], away);
  const streak = streakOf(days, today);
  const grid = yearGrid(
    dayFacts(first, today, areaFocus.rows, plans.rows, habits.rows, away),
    today,
  );
  const pickedCell = picked ? grid.flat().find((cell) => cell.date === picked) : undefined;
  const t = tiles.rows[0];
  const goalMin = goal.rows[0]?.goal_min ?? 0;

  return (
    <main className="dashboard">
      <h1>Dashboard</h1>

      <section className="tiles" aria-label="This week">
        <div className="card tile">
          <span className="meta">Focus this week</span>
          <strong>{hoursLabel(t?.focus_min ?? 0)}</strong>
          {goalMin > 0 && (
            <>
              <Bar
                value={(t?.goal_focus_min ?? 0) / goalMin}
                label="Focus in Grow and Admin areas against the week's goal"
              />
              <span className="meta">
                {hoursLabel(t?.goal_focus_min ?? 0)} of {hoursLabel(goalMin)} aimed for in your
                areas
              </span>
            </>
          )}
        </div>
        <div className="card tile">
          <span className="meta">Sessions</span>
          <strong>{t?.sessions ?? 0}</strong>
        </div>
        <div className="card tile">
          <span className="meta">Breaks taken</span>
          <strong>{hoursLabel(t?.break_min ?? 0)}</strong>
        </div>
        <div className="card tile">
          <span className="meta">Distractions noted</span>
          <strong>{t?.distractions ?? 0}</strong>
        </div>
      </section>

      <section className="card streak" aria-label="Focus streak">
        <Flame lit={streak.alive} />
        <div>
          <strong className="streak-number">{streak.current}</strong>{" "}
          <span>day{streak.current === 1 ? "" : "s"}</span>
          <p className="meta">
            Best: {streak.best} · {streak.freeLeft === 1 ? "1 free miss" : "No free miss"} left this
            week · rest days and light days never break it
          </p>
        </div>
      </section>

      <section className="card" aria-labelledby="year">
        <div className="row">
          <h2 id="year">The year</h2>
          <select aria-label="Area" value={area} onChange={(event) => setArea(event.target.value)}>
            <option value="">All areas</option>
            {areas.rows.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </select>
        </div>
        <YearChart grid={grid} onPick={setPicked} />
        <label className="field inline">
          <span className="meta">Look up a day</span>
          <input
            type="date"
            min={first}
            max={today}
            value={picked ?? ""}
            onChange={(event) => setPicked(event.target.value || null)}
          />
        </label>
        <p className="meta legend">
          Less <span className="year-cell shade-0" /> <span className="year-cell shade-1" />{" "}
          <span className="year-cell shade-2" /> <span className="year-cell shade-3" />{" "}
          <span className="year-cell shade-4" /> 3 h+ · <span className="year-cell outline" /> rest
          or away
          {pickedCell && (
            <>
              {" "}
              · {dayLabel.format(new Date(`${pickedCell.date}T00:00:00Z`))}:{" "}
              {pickedCell.minutes ? hoursLabel(pickedCell.minutes) : "no focus"}
            </>
          )}
        </p>
      </section>

      <section className="card" aria-labelledby="areas">
        <h2 id="areas">Areas this week</h2>
        <ul className="area-bars">
          {week.rows.map((row) => (
            <li key={row.id}>
              <span>{row.name}</span>
              <Bar
                value={share(row)}
                area={row.color as AreaColor}
                label={`${row.name} this week`}
              />
              <span className="meta">
                {hoursLabel(row.done_min)} of {hoursLabel(row.target_min)}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
