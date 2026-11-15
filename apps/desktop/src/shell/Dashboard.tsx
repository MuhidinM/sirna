import "../theme/pages/dashboard.css";

import { type CSSProperties, type ReactNode, useEffect, useState } from "react";

import { systemClock } from "../kernel/clock";
import { transact } from "../kernel/db";
import {
  CARDS,
  type CardId,
  type CardPlace,
  LAYOUT_SQL,
  layoutOps,
  moveTo,
  readLayout,
  setSize,
  span,
  toggleHidden,
} from "../features/dashboard/layout";
import { logicalDate, showDate } from "../kernel/dates";
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
import {
  IconArrowLeft,
  IconArrowRight,
  IconBolt,
  IconChart,
  IconCheck,
  IconClock,
  IconPencil,
  IconPlay,
} from "./icons";
import { InsightList } from "./Insights";
import { type Bar as ChartBar, BarChart, PanelHead } from "./kit";
import { Savings } from "./Savings";
import { type AreaColor, Bar, Button } from "./ui";
import { useLiveQuery } from "./useLiveQuery";

const labelOf = (id: CardId) => CARDS.find((card) => card.id === id)?.label ?? id;

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

const monthLabel = new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" });

/** A month name over the first week that starts in it. */
function monthMarks(grid: Cell[][]): { column: number; label: string }[] {
  const marks: { column: number; label: string }[] = [];
  let last = "";
  grid.forEach((week, column) => {
    const month = week[0]?.date.slice(0, 7);
    if (!month || month === last) return;
    last = month;
    // Skip a first column that only catches the end of a month.
    if (column === 0 && week[0]?.date.slice(8) !== "01") return;
    marks.push({ column, label: monthLabel.format(new Date(`${month}-01T00:00:00Z`)) });
  });
  return marks;
}

/**
 * The chart's cells are for the mouse (out of the tab order); the date field
 * next to it picks a day from the keyboard. Columns share the width, so the
 * year squeezes instead of scrolling.
 */
function YearChart({
  grid,
  today,
  picked,
  onPick,
}: {
  grid: Cell[][];
  today: string;
  picked: string | null;
  onPick: (date: string) => void;
}) {
  const style = { "--weeks": grid.length } as CSSProperties;
  return (
    <div className="year-wrap" style={style}>
      <div className="year-months" aria-hidden="true">
        {monthMarks(grid).map((mark) => (
          <span key={mark.column} style={{ gridColumnStart: mark.column + 1 }}>
            {mark.label}
          </span>
        ))}
      </div>
      <div className="year-chart" role="group" aria-label="Focus time over the last year">
        {grid.map((week) => (
          <div key={week[0]?.date} className="year-week">
            {week.map((cell) => (
              <button
                key={cell.date}
                type="button"
                tabIndex={-1}
                className={`year-cell shade-${cell.shade}${cell.outline ? " outline" : ""}${cell.future ? " future" : ""}${cell.date === today ? " today" : ""}${cell.date === picked ? " picked" : ""}`}
                disabled={cell.future}
                title={`${showDate(cell.date, today, { weekday: true })}: ${cell.minutes ? hoursLabel(cell.minutes) : "no focus"}`}
                aria-label={`${showDate(cell.date, today, { weekday: true })}, ${cell.minutes} minutes`}
                onClick={() => onPick(cell.date)}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** This week's areas: target (cap) against done (body), the busiest one highlighted. */
function AreaChart({ rows }: { rows: AreaWeek[] }) {
  const busiest = rows.reduce<AreaWeek | null>(
    (best, row) => (row.done_min > (best?.done_min ?? 0) ? row : best),
    null,
  );
  const bars: ChartBar[] = rows.map((row) => ({
    label: row.name,
    total: row.target_min / 60,
    done: row.done_min / 60,
    highlight: row.id === busiest?.id,
    tipTitle: row.name,
    tip: [
      { label: "Target", value: hoursLabel(row.target_min), tone: "yellow" },
      { label: "Done", value: hoursLabel(row.done_min), tone: "cream" },
    ],
  }));
  const done = rows.reduce((sum, row) => sum + row.done_min, 0);
  return <BarChart bars={bars} unit="h" ariaLabel={`Areas this week: ${hoursLabel(done)} done`} />;
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
  const [arranging, setArranging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saved = useLiveQuery<{ value_json: string }>(LAYOUT_SQL);
  // Changes show at once and build on each other; each new layout is then saved.
  const [local, setLocal] = useState<CardPlace[] | null>(null);
  const savedLayout = saved.rows[0]?.value_json;
  const layout = local ?? readLayout(savedLayout);
  const save = (change: (current: CardPlace[]) => CardPlace[]) =>
    setLocal((current) => change(current ?? readLayout(savedLayout)));
  useEffect(() => {
    if (!local) return;
    transact("user", layoutOps(local), "settings").catch((failure: unknown) =>
      setError(
        `Couldn't save the layout: ${failure instanceof Error ? failure.message : String(failure)}`,
      ),
    );
  }, [local]);

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

  const loose = layout.filter((place) => !place.hidden);
  /** One step among the cards in the grid (hidden ones are stepped over). */
  const step = (id: CardId, by: -1 | 1) => {
    const at = loose.findIndex((place) => place.id === id);
    const other = loose[at + by];
    if (other) save((current) => moveTo(current, id, other.id));
  };

  const cards: Record<CardId, ReactNode> = {
    savings: <Savings />,
    tiles: (
      <div className="canvas dash-tiles">
        <section className="dash-stats" aria-label="This week">
          <div className="dash-stat tone-orange">
            <span className="dash-stat-top">
              <span className="dash-stat-label">Focus this week</span>
              <span className="dash-stat-icon" aria-hidden="true">
                <IconClock size={16} />
              </span>
            </span>
            <strong className="dash-stat-value">{hoursLabel(t?.focus_min ?? 0)}</strong>
            {goalMin > 0 && (
              <>
                <Bar
                  value={(t?.goal_focus_min ?? 0) / goalMin}
                  label="Focus in Grow and Admin areas against the week's goal"
                />
                <span className="dash-stat-sub">
                  {hoursLabel(t?.goal_focus_min ?? 0)} of {hoursLabel(goalMin)} aimed for in your
                  areas
                </span>
              </>
            )}
          </div>
          <div className="dash-stat tone-purple">
            <span className="dash-stat-top">
              <span className="dash-stat-label">Sessions</span>
              <span className="dash-stat-icon" aria-hidden="true">
                <IconPlay size={16} />
              </span>
            </span>
            <strong className="dash-stat-value">{t?.sessions ?? 0}</strong>
          </div>
          <div className="dash-stat tone-cream">
            <span className="dash-stat-top">
              <span className="dash-stat-label">Breaks taken</span>
              <span className="dash-stat-icon" aria-hidden="true">
                <IconCheck size={16} />
              </span>
            </span>
            <strong className="dash-stat-value">{hoursLabel(t?.break_min ?? 0)}</strong>
          </div>
          <div className="dash-stat tone-pink">
            <span className="dash-stat-top">
              <span className="dash-stat-label">Distractions noted</span>
              <span className="dash-stat-icon" aria-hidden="true">
                <IconBolt size={16} />
              </span>
            </span>
            <strong className="dash-stat-value">{t?.distractions ?? 0}</strong>
          </div>
        </section>
      </div>
    ),
    streak: (
      <section
        className={`panel dash-streak${streak.alive ? " alive" : ""}`}
        aria-label="Focus streak"
      >
        <PanelHead
          icon={<Flame lit={streak.alive} />}
          title="Focus streak"
          sub="Rest days and light days never break it"
        />
        <p className="dash-streak-count">
          <strong className="streak-number">{streak.current}</strong>{" "}
          <span>day{streak.current === 1 ? "" : "s"}</span>
        </p>
        <div className="dash-chips">
          <span className="dash-chip">Best: {streak.best}</span>
          <span className={streak.freeLeft === 1 ? "dash-chip" : "dash-chip pink"}>
            {streak.freeLeft === 1 ? "1 free miss" : "No free miss"} left this week
          </span>
        </div>
      </section>
    ),
    year: (
      <section className="panel dash-year" aria-labelledby="year">
        <PanelHead
          id="year"
          title="The year"
          sub="Focus time per day"
          action={
            <select
              aria-label="Area"
              value={area}
              onChange={(event) => setArea(event.target.value)}
            >
              <option value="">All areas</option>
              {areas.rows.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </select>
          }
        />
        <YearChart grid={grid} today={today} picked={picked} onPick={setPicked} />
        <div className="year-foot">
          <p className="meta legend">
            Less <span className="year-cell shade-0" /> <span className="year-cell shade-1" />{" "}
            <span className="year-cell shade-2" /> <span className="year-cell shade-3" />{" "}
            <span className="year-cell shade-4" /> 3 h+ · <span className="year-cell outline" />{" "}
            rest or away
            {pickedCell && (
              <>
                {" "}
                ·{" "}
                <span className="dash-chip pink">
                  {showDate(pickedCell.date, today, { weekday: true })}:{" "}
                  {pickedCell.minutes ? hoursLabel(pickedCell.minutes) : "no focus"}
                </span>
              </>
            )}
          </p>
          <label className="field year-lookup">
            <span>Look up a day</span>
            <input
              type="date"
              min={first}
              max={today}
              value={picked ?? ""}
              onChange={(event) => setPicked(event.target.value || null)}
            />
          </label>
        </div>
      </section>
    ),
    insights: (
      <section className="panel dash-insights" aria-labelledby="insights">
        <PanelHead
          id="insights"
          icon={<IconBolt size={18} />}
          title="Insights"
          sub="Last 4 weeks"
        />
        <InsightList today={today} />
      </section>
    ),
    areas: (
      <section className="panel dash-areas" aria-labelledby="areas">
        <PanelHead
          id="areas"
          icon={<IconChart size={18} />}
          title="Areas this week"
          sub="Done against each weekly target"
        />
        {week.rows.length > 0 && <AreaChart rows={week.rows} />}
        <ul className="dash-area-rows">
          {week.rows.map((row) => (
            <li key={row.id}>
              <span className="dash-area-name">
                <i
                  className="dash-dot"
                  style={{ "--dot": `var(--area-${row.color})` } as CSSProperties}
                  aria-hidden="true"
                />
                {row.name}
              </span>
              <Bar
                value={share(row)}
                area={row.color as AreaColor}
                label={`${row.name} this week`}
              />
              <span className="meta num">
                {hoursLabel(row.done_min)} of {hoursLabel(row.target_min)}
              </span>
            </li>
          ))}
        </ul>
        {!week.loading && week.rows.length === 0 && (
          <p className="empty">No area has a weekly target yet. Set one in Plan, Routine.</p>
        )}
      </section>
    ),
  };

  return (
    <main className="page dash">
      <section className="canvas dash-canvas" aria-labelledby="dash-title">
        <header className="canvas-head">
          <h1 id="dash-title" className="page-title">
            Dashboard, <span className="soft">week of {showDate(monday, today)}</span>
          </h1>
          <span className="spacer" />
          {error && (
            <span role="alert" className="error">
              {error}
            </span>
          )}
          <Button primary onClick={() => setArranging(!arranging)}>
            <IconPencil size={16} /> {arranging ? "Done arranging" : "Arrange"}
          </Button>
        </header>
        {arranging && (
          <p className="meta dash-help">
            Drag a card onto another to move it, or use the arrows. Sizes: S, M, L. Hidden cards
            wait below.
          </p>
        )}
      </section>

      <div className="dash-board">
        <div className="dash-cells">
          {loose.map((place, index) => (
            <div
              key={place.id}
              className={`dash-cell span-${span(place.size)}${arranging ? " arranging" : ""}`}
              draggable={arranging}
              onDragStart={(event) => event.dataTransfer.setData("text/plain", place.id)}
              onDragOver={(event) => {
                if (arranging) event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                const id = event.dataTransfer.getData("text/plain");
                if (CARDS.some((card) => card.id === id))
                  save((current) => moveTo(current, id as CardId, place.id));
              }}
            >
              {arranging && (
                <div className="dash-controls" aria-label={`Arrange ${labelOf(place.id)}`}>
                  <strong>{labelOf(place.id)}</strong>
                  <Button
                    className="dash-icon"
                    aria-label="Move earlier"
                    aria-disabled={index === 0}
                    onClick={() => step(place.id, -1)}
                  >
                    <IconArrowLeft size={16} />
                  </Button>
                  <Button
                    className="dash-icon"
                    aria-label="Move later"
                    aria-disabled={index === loose.length - 1}
                    onClick={() => step(place.id, 1)}
                  >
                    <IconArrowRight size={16} />
                  </Button>
                  <span className="dash-sizes">
                    {(["S", "M", "L"] as const).map((size) => (
                      <Button
                        key={size}
                        className="dash-icon"
                        aria-label={`Size ${size}`}
                        aria-pressed={place.size === size}
                        onClick={() => save((current) => setSize(current, place.id, size))}
                      >
                        {size}
                      </Button>
                    ))}
                  </span>
                  <Button
                    className="btn-ghost"
                    onClick={() => save((current) => toggleHidden(current, place.id))}
                  >
                    Hide
                  </Button>
                </div>
              )}
              {cards[place.id as keyof typeof cards]}
            </div>
          ))}
        </div>
      </div>

      {arranging && layout.some((place) => place.hidden) && (
        <section className="panel dash-hidden" aria-label="Hidden cards">
          <PanelHead title="Hidden" sub="Show a card to put it back" />
          <div className="dash-chips">
            {layout
              .filter((place) => place.hidden)
              .map((place) => (
                <Button
                  key={place.id}
                  onClick={() => save((current) => toggleHidden(current, place.id))}
                >
                  Show {labelOf(place.id)}
                </Button>
              ))}
          </div>
        </section>
      )}
    </main>
  );
}
