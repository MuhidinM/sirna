import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";

import { systemClock } from "../kernel/clock";
import { logicalDate } from "../kernel/dates";
import { query, transact } from "../kernel/db";
import { formatAmount, parseAmount } from "../kernel/money";
import { ask } from "../features/ai/ask";
import { STRICT_SQL, strictOrNull } from "../features/ai/strict";
import { WEEK } from "../features/ai/touchpoints";
import { isoWeekday, weekStart } from "../features/plan/dayplan";
import { hoursLabel, loadWeek, type Query } from "../features/projects/capacity";
import {
  AREA_WEEK_SQL,
  type AreaWeek,
  DISMISSED_KEY,
  dismissOps,
  FOCUS_WEEK_SQL,
  type FocusWeek,
  applyOps,
  historyWeeks,
  isHandled,
  type NextWeek,
  nextWeek,
  oneChange,
  progressLabel,
  PROJECTS_WEEK_SQL,
  projectStatusOps,
  type ProjectWeek,
  share,
  SPEND_SINCE_SQL,
  SPEND_SQL,
  spendLines,
  spendParams,
  type SpendRow,
} from "../features/week/card";

import { ulid } from "../kernel/ulid";
import { entryOps, type GoalRow, GOALS_SQL, WEEK_SAVED_SQL } from "../features/savings/savings";
import { shiftDate } from "../features/plan/dayplan";
import { type AreaColor, Bar, Button } from "./ui";
import { useLiveQuery } from "./useLiveQuery";

const PARAGRAPH_KEY = "ai.week_paragraph";
const SETTINGS_SQL = `SELECT key, value_json FROM core_settings WHERE key IN ('${DISMISSED_KEY}', '${PARAGRAPH_KEY}')`;
const pct = (ratio: number) => (Number.isFinite(ratio) ? `${Math.round(ratio * 100)}%` : "—");

/** The time now, moved on every minute so live numbers keep counting. */
function useMinute(): number {
  const [now, setNow] = useState(() => systemClock.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(systemClock.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** Next week's load, reloaded after any write. */
function useNextWeek(monday: string): NextWeek | null {
  const [next, setNext] = useState<NextWeek | null>(null);
  useEffect(() => {
    const load = () => {
      loadWeek(query as Query)
        .then(({ week, projects }) => setNext(nextWeek(week, projects, monday)))
        .catch(() => setNext(null));
    };
    load();
    const unlisten = listen("data-changed", load);
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, [monday]);
  return next;
}

/** The AI's paragraph for card 1: once a week, from Friday, kept in settings. */
function WeekParagraph({
  monday,
  saved,
  areas,
  focus,
  next,
  ready,
}: {
  monday: string;
  saved: string | undefined;
  areas: AreaWeek[];
  focus: FocusWeek | undefined;
  next: NextWeek | null;
  ready: boolean;
}) {
  const strict = strictOrNull(useLiveQuery<{ value_json: string | null }>(STRICT_SQL));
  const asked = useRef(false);
  let stored: { monday?: string; text?: string | null } = {};
  try {
    stored = JSON.parse(saved ?? "{}") as typeof stored;
  } catch {
    stored = {};
  }
  const fresh = stored.monday === monday;
  useEffect(() => {
    // Area names and numbers only, so strict mode changes nothing here; it still waits for it.
    if (!ready || fresh || asked.current || !focus || !next || strict === null) return;
    asked.current = true;
    void ask(WEEK, {
      areas: areas.map((a) => ({
        area: a.name,
        doneH: Math.round((a.done_min / 60) * 10) / 10,
        targetH: Math.round((a.target_min / 60) * 10) / 10,
      })),
      sessions: focus.sessions,
      distractions: focus.distractions,
      overrunDays: focus.overrun_days,
      nextWeekLoad: Number.isFinite(next.ratio) ? Math.round(next.ratio * 100) : 999,
    }).then((result) => {
      // Only a paragraph is kept; a failure is tried again next time the card opens.
      if (!result.ok) return;
      void transact(
        "system",
        [
          {
            op: "upsert",
            table: "core_settings",
            id: PARAGRAPH_KEY,
            values: {
              value_json: JSON.stringify({
                monday,
                text: result.value.paragraph,
              }),
            },
          },
        ],
        "ai:week",
      );
    });
  }, [ready, fresh, focus, next, strict, areas, monday]);
  if (!fresh || !stored.text) return null;
  return <p className="ai-text">{stored.text}</p>;
}

const ASKED_KEY = "week.saving_asked";

/** The Sunday question (plan §3.13): "Put anything aside this week?" */
function SavingQuestion({ monday, nowMs }: { monday: string; nowMs: number }) {
  const saved = useLiveQuery<{ minor: number }>(WEEK_SAVED_SQL, [monday, shiftDate(monday, 7)]);
  const goals = useLiveQuery<GoalRow & Record<string, string | number>>(GOALS_SQL);
  const asked = useLiveQuery<{ value_json: string }>(
    `SELECT value_json FROM core_settings WHERE key = '${ASKED_KEY}'`,
  );
  const active = goals.rows.filter((goal) => goal.status === "active");
  const [amount, setAmount] = useState("");
  const [goalId, setGoalId] = useState("");
  const [note, setNote] = useState("");
  if (saved.loading || goals.loading || asked.loading) return null;
  const minor = saved.rows[0]?.minor ?? 0;
  if (minor > 0)
    return (
      <section className="card" aria-labelledby="saving">
        <h2 id="saving">Saving</h2>
        <p>{formatAmount(minor)} put aside this week.</p>
      </section>
    );
  if (asked.rows[0]?.value_json === JSON.stringify(monday)) return null;
  return (
    <section className="card" aria-labelledby="saving">
      <h2 id="saving">Put anything aside this week?</h2>
      <form
        className="row"
        onSubmit={(event) => {
          event.preventDefault();
          const value = parseAmount(amount);
          if (value === null || value <= 0) {
            setNote("An amount like 500 or 2k.");
            return;
          }
          const goal = goalId || (active.length === 1 ? (active[0]?.id ?? "") : "");
          if (active.length > 1 && !goal) {
            setNote("Pick the goal it's for.");
            return;
          }
          transact(
            "user",
            entryOps(goal || null, value, nowMs, logicalDate(nowMs), ulid(), "week"),
            `week:${monday}`,
          ).catch((failure: unknown) =>
            setNote(
              `Couldn't save: ${failure instanceof Error ? failure.message : String(failure)}`,
            ),
          );
        }}
      >
        <input
          inputMode="decimal"
          aria-label="Amount put aside"
          placeholder="500"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
        />
        {active.length > 1 && (
          <select
            aria-label="Goal"
            value={goalId}
            onChange={(event) => setGoalId(event.target.value)}
          >
            <option value="">Pick a goal</option>
            {active.map((goal) => (
              <option key={goal.id} value={goal.id}>
                {goal.title}
              </option>
            ))}
          </select>
        )}
        <Button type="submit" primary>
          Save
        </Button>
        <Button
          onClick={() =>
            void transact(
              "user",
              [
                {
                  op: "upsert",
                  table: "core_settings",
                  id: ASKED_KEY,
                  values: { value_json: JSON.stringify(monday) },
                },
              ],
              "settings",
            )
          }
        >
          No
        </Button>
        <span className="meta" role="status">
          {note}
          {active.length === 0 ? "It joins the first savings goal you add on the Dashboard." : ""}
        </span>
      </form>
    </section>
  );
}

/** The week card (plan §3.10; R-CHK-04). */
export function WeekCard() {
  const nowMs = useMinute();
  const today = logicalDate(nowMs);
  const monday = weekStart(today);
  const startMs = Date.parse(`${monday}T00:00:00Z`); // 03:00 in Addis: the logical day's start
  const areas = useLiveQuery<AreaWeek & Record<string, string | number>>(AREA_WEEK_SQL, [
    startMs,
    nowMs,
  ]);
  const focus = useLiveQuery<FocusWeek & Record<string, number>>(FOCUS_WEEK_SQL, [startMs, nowMs]);
  const projects = useLiveQuery<ProjectWeek & Record<string, string | number | null>>(
    PROJECTS_WEEK_SQL,
    [startMs, nowMs],
  );
  const spend = useLiveQuery<SpendRow & Record<string, string | number>>(
    SPEND_SQL,
    spendParams(monday),
  );
  const since = useLiveQuery<{ since: string | null }>(
    SPEND_SINCE_SQL,
    spendParams(monday).slice(0, 2),
  );
  const settings = useLiveQuery<{ key: string; value_json: string }>(SETTINGS_SQL);
  const next = useNextWeek(monday);
  const [error, setError] = useState<string | null>(null);

  const weekMostlyDone = isoWeekday(today) >= 5;
  const setting = (key: string) => settings.rows.find((row) => row.key === key)?.value_json;
  const change =
    next && focus.rows[0]
      ? oneChange({
          next,
          focus: focus.rows[0],
          areas: areas.rows,
          projects: projects.rows,
          weekMostlyDone,
        })
      : null;
  const showChange = change && !isHandled(setting(DISMISSED_KEY), monday);
  const money = spendLines(spend.rows, historyWeeks(since.rows[0]?.since ?? null, monday));
  const activeCount = projects.rows.filter((p) => p.status === "active").length;
  const write = (ops: Parameters<typeof transact>[1], context: string) =>
    transact("user", ops, context).catch((failure: unknown) =>
      setError(`Couldn't save: ${failure instanceof Error ? failure.message : String(failure)}`),
    );
  const ready = !areas.loading && !focus.loading && !settings.loading;
  const maxSpend = Math.max(1, ...money.lines.map((l) => Math.max(l.week, l.average ?? 0)));

  return (
    <main className="review week-card">
      <header className="review-head">
        <h1>This week</h1>
        <p className="meta">
          Week of {monday}
          {weekMostlyDone ? "" : " · so far"}
        </p>
      </header>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      <section className="card" aria-labelledby="time">
        <h2 id="time">Where time went</h2>
        {focus.rows[0] && (
          <p className="meta">
            {focus.rows[0].sessions} focus sessions · {focus.rows[0].distractions} distractions
            noted · {focus.rows[0].overrun_days} day{focus.rows[0].overrun_days === 1 ? "" : "s"}{" "}
            past the cap
          </p>
        )}
        <ul className="area-bars">
          {areas.rows.map((area) => (
            <li key={area.id}>
              <span>{area.name}</span>
              <Bar
                value={share(area)}
                area={area.color as AreaColor}
                label={`${area.name} this week`}
              />
              <span className="meta">
                {hoursLabel(area.done_min)} of {hoursLabel(area.target_min)}
              </span>
            </li>
          ))}
        </ul>
        <WeekParagraph
          monday={monday}
          saved={setting(PARAGRAPH_KEY)}
          areas={areas.rows}
          focus={focus.rows[0]}
          next={next}
          ready={ready && weekMostlyDone}
        />
      </section>

      <section className="card" aria-labelledby="next">
        <h2 id="next">Next week</h2>
        {next ? (
          <>
            <Bar value={next.ratio} label="Next week's load" />
            <p className={next.over ? "warn-text" : "meta"}>
              {pct(next.ratio)} of your free time planned ({hoursLabel(next.committed)} of{" "}
              {hoursLabel(next.capacity)}) · {next.activeProjects} project
              {next.activeProjects === 1 ? "" : "s"} running
              {next.over ? " · over the 85% line" : ""}
            </p>
          </>
        ) : (
          <p className="meta">…</p>
        )}
      </section>

      <section className="card" aria-labelledby="projects">
        <h2 id="projects">Projects</h2>
        {projects.rows.length === 0 && <p className="meta">No active projects.</p>}
        <ul>
          {projects.rows.map((project) => (
            <li key={project.id} className="task">
              <span>
                {project.title}{" "}
                <span className="meta">
                  {project.status === "next_up" ? "next up · " : ""}
                  {progressLabel(project)}
                  {project.week_min ? ` · ${hoursLabel(project.week_min)} this week` : ""}
                  {project.forecast_finish ? ` · finish ~${project.forecast_finish}` : ""}
                </span>
              </span>
              <span className="row">
                {project.status === "next_up" ? (
                  <Button
                    disabled={activeCount >= 2}
                    title={
                      activeCount >= 2
                        ? "Two projects are already active: pause or finish one first"
                        : undefined
                    }
                    onClick={() =>
                      void write(projectStatusOps(project.id, "active"), `project:${project.id}`)
                    }
                  >
                    Start
                  </Button>
                ) : (
                  <Button
                    onClick={() =>
                      void write(projectStatusOps(project.id, "paused"), `project:${project.id}`)
                    }
                  >
                    Pause
                  </Button>
                )}
                <Button
                  onClick={() =>
                    void write(projectStatusOps(project.id, "done"), `project:${project.id}`)
                  }
                >
                  Done
                </Button>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card" aria-labelledby="money">
        <h2 id="money">Money</h2>
        <p>
          {formatAmount(money.week)} spent this week{" "}
          {money.average !== null && (
            <span className="meta">· usually {formatAmount(money.average)} a week</span>
          )}
        </p>
        <ul className="spend-bars">
          {money.lines.map((line) => (
            <li key={line.category}>
              <span>{line.category}</span>
              <span className="spend-pair">
                <span
                  className="spend-bar"
                  style={{ width: `${(line.week / maxSpend) * 100}%` }}
                  aria-label={`${line.category} this week ${formatAmount(line.week)}`}
                />
                {line.average !== null && (
                  <span
                    className="spend-bar usual"
                    style={{ width: `${(line.average / maxSpend) * 100}%` }}
                    aria-label={`${line.category} usually ${formatAmount(line.average)}`}
                  />
                )}
              </span>
              <span className="meta">
                {formatAmount(line.week)}
                {line.average !== null ? ` · usually ${formatAmount(line.average)}` : ""}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {isoWeekday(today) >= 6 && <SavingQuestion monday={monday} nowMs={nowMs} />}

      {showChange && (
        <section className="card one-change" aria-labelledby="change">
          <h2 id="change">One change</h2>
          <p>{change.text}</p>
          <div className="row">
            <Button primary onClick={() => void write(applyOps(change, monday), `week:${monday}`)}>
              Apply
            </Button>
            <Button onClick={() => void write(dismissOps(monday, change.key), "settings")}>
              No
            </Button>
          </div>
        </section>
      )}
    </main>
  );
}
