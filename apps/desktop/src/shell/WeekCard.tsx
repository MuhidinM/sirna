import "../theme/pages/plan-week.css";

import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";

import { systemClock } from "../kernel/clock";
import { logicalDate, showDate } from "../kernel/dates";
import { query, transact } from "../kernel/db";
import { formatAmount, parseAmount } from "../kernel/money";
import { ask } from "../features/ai/ask";
import { STRICT_SQL, strictOrNull } from "../features/ai/strict";
import { WEEK } from "../features/ai/touchpoints";
import { isoWeekday, weekStart } from "../features/plan/dayplan";
import { hoursLabel, loadWeek, MAX_ACTIVE, type Query } from "../features/projects/capacity";
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
import { type GoalRow, GOALS_SQL, putAsideOps, WEEK_SAVED_SQL } from "../features/savings/savings";
import { type AccountRow, ACCOUNTS_SQL } from "../features/money/accounts";
import { shiftDate } from "../features/plan/dayplan";
import { overCap, weekSummary } from "../features/dashboard/insights";
import { AWAY_HISTORY_SQL, type AwayChange, awayDays } from "../features/dashboard/streak";
import { InsightList } from "./Insights";
import { MonthReviewCard } from "./Money";
import { WeekPreview } from "./WeekPreview";
import { WeekAhead } from "./WeekAhead";
import { IconChart, IconClock, IconMoney, IconPlan, IconProjects } from "./icons";
import { PanelHead } from "./kit";
import { MonthPanel } from "./MonthPanel";
import { isFirstSunday } from "../features/money/review";
import { previousMonthStart } from "../features/money/money";
import { approxMark, conversionNotes, RATES_SQL, readRates } from "../features/money/currency";
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
      loadWeek(query as Query, logicalDate(systemClock.now()))
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
  if (fresh && stored.text) return <p className="ai-text">{stored.text}</p>;
  // Without the AI's paragraph (no key, offline, or before Friday): the numbers in plain words.
  if (!focus) return null;
  return (
    <p className="meta">
      {weekSummary({
        areas,
        sessions: focus.sessions,
        overrunDays: focus.overrun_days,
        nextWeekPercent: next && Number.isFinite(next.ratio) ? Math.round(next.ratio * 100) : null,
      })}
    </p>
  );
}

const ASKED_KEY = "week.saving_asked";

/** The Sunday question (plan §3.13): "Put anything aside this week?" */
function SavingQuestion({ monday, nowMs }: { monday: string; nowMs: number }) {
  const saved = useLiveQuery<{ minor: number }>(WEEK_SAVED_SQL, [monday, shiftDate(monday, 7)]);
  const goals = useLiveQuery<GoalRow & Record<string, string | number>>(GOALS_SQL);
  const accounts = useLiveQuery<AccountRow & Record<string, string | number | null>>(ACCOUNTS_SQL);
  const asked = useLiveQuery<{ value_json: string }>(
    `SELECT value_json FROM core_settings WHERE key = '${ASKED_KEY}'`,
  );
  const active = goals.rows.filter((goal) => goal.status === "active");
  const [amount, setAmount] = useState("");
  const [goalId, setGoalId] = useState("");
  const [note, setNote] = useState("");
  if (saved.loading || goals.loading || asked.loading || accounts.loading) return null;
  const minor = saved.rows[0]?.minor ?? 0;
  if (minor > 0)
    return (
      <section className="panel pw-saving" aria-labelledby="saving">
        <PanelHead id="saving" icon={<IconMoney size={18} />} title="Put aside" />
        <p className="pw-big">{formatAmount(minor)}</p>
        <p className="meta">this week.</p>
      </section>
    );
  if (asked.rows[0]?.value_json === JSON.stringify(monday)) return null;
  return (
    <section className="panel pw-saving" aria-labelledby="saving">
      <PanelHead id="saving" icon={<IconMoney size={18} />} title="Put anything aside this week?" />
      <form
        className="pw-saving-form"
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
          // Like Put aside on the goal card: the money moves into savings (F73).
          const put = putAsideOps({
            goalId: goal || null,
            amount: value,
            accounts: accounts.rows,
            nowMs,
            date: logicalDate(nowMs),
            newId: () => ulid(),
            origin: "week",
          });
          transact("user", put.ops, `week:${monday}`).catch((failure: unknown) =>
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
        <span className="pw-actions">
          <Button type="submit" className="btn-orange">
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
        </span>
        <span className="meta" role="status">
          {note}
          {active.length === 0 ? "It joins the first savings goal you add on the Dashboard." : ""}
        </span>
      </form>
    </section>
  );
}

/**
 * The week card (plan §3.10; R-CHK-04), Plan → This week. `onOpenDay` opens
 * Plan → Day on a date (a Next 7 days column).
 */
export function WeekCard({ onOpenDay }: { onOpenDay?: (date: string) => void } = {}) {
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
  const rateRows = useLiveQuery<{ value_json: string }>(RATES_SQL);
  const awayHistory = useLiveQuery<AwayChange & Record<string, string | number | null>>(
    AWAY_HISTORY_SQL,
  );
  const next = useNextWeek(monday);
  const [error, setError] = useState<string | null>(null);

  const weekMostlyDone = isoWeekday(today) >= 5;
  // Days away this week (planned to the Sunday): they never count against an area.
  const away = awayDays(awayHistory.rows, monday, shiftDate(monday, 6)).size;
  const setting = (key: string) => settings.rows.find((row) => row.key === key)?.value_json;
  const change =
    next && focus.rows[0] && !awayHistory.loading
      ? oneChange({
          awayDays: away,
          next,
          focus: focus.rows[0],
          areas: areas.rows,
          projects: projects.rows,
          weekMostlyDone,
        })
      : null;
  const showChange = change && !isHandled(setting(DISMISSED_KEY), monday);
  // Dollars count at the saved rate, not as birr (F4).
  const rates = readRates(rateRows.rows[0]?.value_json);
  const money = spendLines(spend.rows, historyWeeks(since.rows[0]?.since ?? null, monday), rates);
  const spendNotes = conversionNotes(money.conversion, rates);
  const approx = approxMark(spendNotes);
  const activeCount = projects.rows.filter((p) => p.status === "active").length;
  const write = (ops: Parameters<typeof transact>[1], context: string) =>
    transact("user", ops, context).catch((failure: unknown) =>
      setError(`Couldn't save: ${failure instanceof Error ? failure.message : String(failure)}`),
    );
  const ready = !areas.loading && !focus.loading && !settings.loading;
  const maxSpend = Math.max(1, ...money.lines.map((l) => Math.max(l.week, l.average ?? 0)));

  const doneMin = areas.rows.reduce((sum, area) => sum + area.done_min, 0);
  const targetMin = areas.rows.reduce((sum, area) => sum + area.target_min, 0);
  const range = weekRange(monday, today);

  return (
    <main className="page plan-week">
      <div className="layout-split">
        <aside className="side" aria-label="The week at a glance">
          <MonthPanel today={today} />

          <section className="panel pw-next" aria-labelledby="next">
            <PanelHead
              id="next"
              icon={<IconClock size={18} />}
              title="Next week"
              sub="Planned against your free time"
            />
            {next ? (
              <>
                <p className={next.over ? "pw-big over" : "pw-big"}>{pct(next.ratio)}</p>
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

          {showChange && (
            <section className="panel one-change" aria-labelledby="change">
              <PanelHead
                id="change"
                icon={<span className="pw-one">1</span>}
                title="One change"
                sub="For next week"
              />
              <p>{change.text}</p>
              <div className="pw-actions">
                <Button
                  className="btn-orange"
                  onClick={() => void write(applyOps(change, monday), `week:${monday}`)}
                >
                  Apply
                </Button>
                <Button onClick={() => void write(dismissOps(monday, change.key), "settings")}>
                  No
                </Button>
              </div>
            </section>
          )}

          {isoWeekday(today) >= 6 && <SavingQuestion monday={monday} nowMs={nowMs} />}
        </aside>

        <div className="main">
          <section className="canvas pw-canvas" aria-labelledby="week-title">
            <header className="canvas-head">
              <h1 id="week-title" className="page-title">
                This week, <span className="soft">{range}</span>
              </h1>
              <span className="pw-chip">{weekMostlyDone ? "Wrapping up" : "So far"}</span>
              <span className="spacer" />
              <Button
                primary
                onClick={() => {
                  const plan = document.getElementById("week-plan");
                  plan?.scrollIntoView({ behavior: "smooth", block: "start" });
                  plan?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
                }}
              >
                <IconPlan size={16} /> {isoWeekday(today) === 7 ? "Plan next week" : "Plan"}
              </Button>
            </header>
            <p className="visually-hidden">
              Week of {showDate(monday, today, { weekday: true })}
              {weekMostlyDone ? "" : " · so far"}
            </p>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}

            <WeekPreview today={today} onOpenDay={onOpenDay} />
            <WeekAhead today={today} />
          </section>

          <div className="panel-row">
            <section className="panel pw-time" aria-labelledby="time">
              <PanelHead
                id="time"
                icon={<IconChart size={18} />}
                title="Where time went"
                sub={
                  focus.rows[0] ? (
                    <>
                      {focus.rows[0].sessions} focus session
                      {focus.rows[0].sessions === 1 ? "" : "s"} · {focus.rows[0].distractions}{" "}
                      distraction{focus.rows[0].distractions === 1 ? "" : "s"} noted ·{" "}
                      {focus.rows[0].overrun_days} day
                      {focus.rows[0].overrun_days === 1 ? "" : "s"} past the cap
                    </>
                  ) : undefined
                }
              />
              <p className="pw-big">
                {hoursLabel(doneMin)} <span className="soft">of {hoursLabel(targetMin)}</span>
              </p>
              <ul className="pw-bars">
                {areas.rows.map((area) => (
                  <li key={area.id}>
                    <span className="pw-bar-name">
                      <i
                        className="pw-swatch"
                        style={{ background: `var(--area-${area.color})` }}
                        aria-hidden="true"
                      />
                      {area.name}
                    </span>
                    <span className={overCap(area) ? "pw-bar-value warn-text" : "pw-bar-value"}>
                      {hoursLabel(area.done_min)} of {hoursLabel(area.target_min)}
                      {overCap(area) ? " · over its cap" : ""}
                    </span>
                    <Bar
                      value={share(area)}
                      area={area.color as AreaColor}
                      label={`${area.name} this week`}
                    />
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

            <section className="panel pw-money" aria-labelledby="money">
              <PanelHead
                id="money"
                icon={<IconMoney size={18} />}
                title="Money"
                sub={
                  money.average !== null
                    ? `Usually ${approx}${formatAmount(money.average)} a week`
                    : "Spent this week"
                }
              />
              <p className="pw-big">
                {approx}
                {formatAmount(money.week)} <span className="soft">spent this week</span>
              </p>
              {spendNotes.missing && <p className="warn-text">{spendNotes.missing}</p>}
              <ul className="pw-spend">
                {money.lines.map((line) => (
                  <li
                    key={line.category}
                    className={
                      line.average !== null && line.week > line.average ? "over" : undefined
                    }
                  >
                    <span className="pw-bar-name">{line.category}</span>
                    <span className="pw-bar-value">
                      {formatAmount(line.week)}
                      {line.average !== null ? ` · usually ${formatAmount(line.average)}` : ""}
                    </span>
                    <span className="pw-spend-pair">
                      <span
                        className="pw-spend-bar"
                        style={{ width: `${(line.week / maxSpend) * 100}%` }}
                        aria-label={`${line.category} this week ${formatAmount(line.week)}`}
                      />
                      {line.average !== null && (
                        <span
                          className="pw-spend-bar usual"
                          style={{ width: `${(line.average / maxSpend) * 100}%` }}
                          aria-label={`${line.category} usually ${formatAmount(line.average)}`}
                        />
                      )}
                    </span>
                  </li>
                ))}
              </ul>
              {money.lines.length > 0 && (
                <p className="pw-legend" aria-hidden="true">
                  <i className="sq cream" /> This week <i className="sq usual" /> Usual
                </p>
              )}
            </section>

            <section className="panel pw-projects" aria-labelledby="projects">
              <PanelHead
                id="projects"
                icon={<IconProjects size={18} />}
                title="Projects"
                sub={
                  activeCount > MAX_ACTIVE
                    ? `${activeCount} active (limit ${MAX_ACTIVE})`
                    : `${activeCount} of ${MAX_ACTIVE} active`
                }
              />
              {projects.rows.length === 0 && (
                <p className="empty">No projects running or next up. Add one on Projects.</p>
              )}
              <ul className="list-rows pw-project-rows">
                {projects.rows.map((project) => (
                  <li key={project.id}>
                    <span className={`pw-status ${project.status}`} aria-hidden="true" />
                    <span className="grow">
                      <b>{project.title}</b>
                      <span className="meta">
                        {project.status === "next_up" ? "next up · " : ""}
                        {progressLabel(project)}
                        {project.week_min ? ` · ${hoursLabel(project.week_min)} this week` : ""}
                        {project.forecast_finish
                          ? ` · finish ~${showDate(project.forecast_finish, today)}`
                          : ""}
                      </span>
                    </span>
                    <span className="pw-actions">
                      {project.status === "next_up" ? (
                        <Button
                          disabled={activeCount >= MAX_ACTIVE}
                          title={
                            activeCount >= MAX_ACTIVE
                              ? `${activeCount} projects are already active (limit ${MAX_ACTIVE}): pause or finish one first`
                              : undefined
                          }
                          onClick={() =>
                            void write(
                              projectStatusOps(project.id, "active"),
                              `project:${project.id}`,
                            )
                          }
                        >
                          Start
                        </Button>
                      ) : (
                        <Button
                          onClick={() =>
                            void write(
                              projectStatusOps(project.id, "paused"),
                              `project:${project.id}`,
                            )
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

            <section className="panel pw-insights" aria-labelledby="week-insights">
              <PanelHead id="week-insights" title="Insights" sub="From the last 4 weeks" />
              <InsightList today={today} />
            </section>

            {isFirstSunday(today) && (
              <MonthReviewCard month={previousMonthStart(today)} today={today} />
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

/** "16 – 22 Nov", or "30 Nov – 6 Dec" across a month end. */
function weekRange(monday: string, today: string): string {
  const sunday = shiftDate(monday, 6);
  const end = showDate(sunday, today);
  // Same month and year: say the month (and year) once.
  return sunday.slice(0, 7) === monday.slice(0, 7)
    ? `${Number(monday.slice(8))} – ${end}`
    : `${showDate(monday, today)} – ${end}`;
}
