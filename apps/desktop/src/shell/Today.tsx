import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

import { systemClock } from "../kernel/clock";
import { showDate } from "../kernel/dates";
import { commitCapture, query, transact } from "../kernel/db";
import { ask } from "../features/ai/ask";
import { aiUnavailable } from "../features/ai/codes";
import { splitOps } from "../features/ai/facts";
import { STRICT_SQL, strictOrNull } from "../features/ai/strict";
import { label, SPLIT, SPLIT_MAX_MIN, type SplitReply } from "../features/ai/touchpoints";
import { ulid } from "../kernel/ulid";
import { LATER_STEPS_SQL, stepLabel } from "../features/tasks/list";
import { TODAY_PARSER_ID, todayTask } from "../capture/today";
import { toOps } from "../capture/ops";
import { ensureRepeats } from "../features/tasks/repeat";
import { AWAY_SQL, awayUntil, returnLabel } from "../features/plan/away";
import { ensureDayPlan, weekStart } from "../features/plan/dayplan";
import { useWeekOutcomes } from "./WeekAhead";
import {
  DUE_SQL,
  INBOX_SQL,
  SPENT_TODAY_SQL,
  taskMeta,
  todayParams,
  todayTopSql,
  WAITING_SQL,
} from "../features/tasks/today";
import { type BlockRow, lightDayTop, TODAY_BLOCKS_SQL } from "../features/plan/now";
import { INBOX_COUNT_SQL, inboxBadge } from "../features/review/review";
import { Brief } from "./Brief";
import { Missed } from "./Missed";
import { TodayMoney } from "./Money";
import { FocusPanel, useFocus } from "./Focus";
import { NowCards, Timeline, useBoard } from "./Timeline";
import { FocusWeek } from "./FocusWeek";
import { IconPlus } from "./icons";
import { PanelHead } from "./kit";
import { MonthPanel } from "./MonthPanel";
import { Button } from "./ui";
import { useLiveQuery } from "./useLiveQuery";
import { usePrayerTimes } from "./usePrayerTimes";
import {
  PRAYER_SETTINGS_SQL,
  prayerDate,
  prayerLine,
  ramadanLine,
  readPrayerSettings,
} from "../features/prayer/prayer";

interface TaskRow extends Record<string, string | number | null> {
  id: string;
  title: string;
  status: string;
  due_date: string | null;
  due_at: number | null;
  estimate_min: number | null;
  area_id: string | null;
  planned_date: string | null;
  deadline_stale: number;
  step_no: number | null;
  step_total: number | null;
}

/** What the split needs that today's rows don't carry: part of the day and step place. */
const SPLIT_FACTS_SQL = "SELECT planned_window, parent_id, step_no FROM task_items WHERE id = ?";

/** A task this long can be split into steps (plan §7.3, the AI's suggestion). */
export const SPLIT_FROM_MIN = 90;

/**
 * Split with AI: shows the proposed steps; nothing changes until "Use these
 * steps". Strict mode sends the area instead of the title.
 */
export function SplitTask({
  task,
  onClose,
}: {
  task: Pick<TaskRow, "id" | "title" | "estimate_min" | "area_id" | "due_date"> &
    Partial<Pick<TaskRow, "planned_date" | "deadline_stale">> & {
      project_id?: string | null;
    };
  onClose: () => void;
}) {
  const [state, setState] = useState<SplitReply | "asking" | string>("asking");
  const [using, setUsing] = useState(false);
  const strictRows = useLiveQuery<{ value_json: string | null }>(STRICT_SQL);
  const strict = strictOrNull(strictRows);
  // The AI sees the area's name, never its id.
  const area = useLiveQuery<{ name: string }>("SELECT name FROM area_items WHERE id = ?", [
    task.area_id ?? "",
  ]);
  const areaName = area.loading ? undefined : (area.rows[0]?.name ?? null);
  useEffect(() => {
    if (strict === null || areaName === undefined || !task.estimate_min) return;
    let live = true;
    void ask(SPLIT, {
      task: label(task.title, areaName, strict, "task"),
      area: areaName,
      estimateMin: task.estimate_min,
      due: task.due_date,
    }).then((result) => {
      if (live) setState(result.ok ? result.value : aiUnavailable(result.code));
    });
    return () => {
      live = false;
    };
  }, [strict, areaName, task]);
  if (state === "asking") return <p className="meta">Asking for steps…</p>;
  if (typeof state === "string")
    return (
      <p className="meta">
        {state} <Button onClick={onClose}>OK</Button>
      </p>
    );
  return (
    <div className="split ai-text">
      <ol>
        {state.steps.map((step) => (
          <li key={step.title}>
            {step.title} <span className="meta">{step.minutes} min</span>
          </li>
        ))}
      </ol>
      <div className="row">
        <Button
          disabled={using}
          onClick={() => {
            if (using) return;
            setUsing(true);
            // The steps keep the task's part of the day, and a step's new steps
            // take its place (the later steps move down), as on the Tasks page.
            void query<{
              planned_window: string | null;
              parent_id: string | null;
              step_no: number | null;
            }>(SPLIT_FACTS_SQL, [task.id])
              .then(async ([row]) => {
                const facts = {
                  planned_window: row?.planned_window ?? null,
                  parent_id: row?.parent_id ?? null,
                  step_no: row?.step_no ?? null,
                };
                const later =
                  facts.parent_id && facts.step_no
                    ? await query<{ id: string; step_no: number | null }>(LATER_STEPS_SQL, [
                        facts.parent_id,
                        facts.step_no,
                      ])
                    : [];
                return transact(
                  "user",
                  splitOps({ ...task, ...facts }, state.steps, () => ulid(), later),
                  `split:${task.id}`,
                );
              })
              .then(onClose)
              .catch(() => setUsing(false));
          }}
        >
          Use these steps
        </Button>
        <Button onClick={onClose}>Cancel</Button>
      </div>
    </div>
  );
}

const longWeekday = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  timeZone: "Africa/Addis_Ababa",
});
function toggle(task: TaskRow) {
  const done = task.status !== "done";
  void transact("user", [
    {
      op: "update",
      table: "task_items",
      id: task.id,
      values: { status: done ? "done" : "todo", completed_at: done ? systemClock.now() : null },
    },
  ]);
}

function TaskLine({ task, today }: { task: TaskRow; today: string }) {
  const [splitting, setSplitting] = useState(false);
  const big =
    task.status === "todo" &&
    (task.estimate_min ?? 0) >= SPLIT_FROM_MIN &&
    (task.estimate_min ?? 0) <= SPLIT_MAX_MIN;
  return (
    <li className="task">
      <label>
        <input type="checkbox" checked={task.status === "done"} onChange={() => toggle(task)} />
        <span className={task.status === "done" ? "done" : undefined}>
          {stepLabel(task.step_no, task.step_total) && (
            <span className="meta">{stepLabel(task.step_no, task.step_total)} </span>
          )}
          {task.title}
        </span>
      </label>
      <span className="meta">
        {taskMeta(task, today)}
        {big && !splitting && (
          <Button className="split-button" onClick={() => setSplitting(true)}>
            Split
          </Button>
        )}
      </span>
      {splitting && <SplitTask task={task} onClose={() => setSplitting(false)} />}
    </li>
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The current time, moved on at the next 03:00 and whenever the window gets
 * focus, so a window left open overnight shows the new day.
 */
function useNow(): number {
  const [nowMs, setNow] = useState(() => systemClock.now());
  const [, dayStart] = todayParams(nowMs);
  useEffect(() => {
    const nextDay = dayStart + DAY_MS;
    const timer = setTimeout(
      () => setNow(systemClock.now()),
      Math.max(1000, nextDay - systemClock.now()),
    );
    const onFocus = () => setNow(systemClock.now());
    window.addEventListener("focus", onFocus);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [dayStart]);
  return nowMs;
}

/** The current time, updated each minute, for the Now card and countdown. */
function useMinute(): number {
  const [minute, setMinute] = useState(() => systemClock.now());
  useEffect(() => {
    const timer = setInterval(() => setMinute(systemClock.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return minute;
}

export function Today({
  onOpenMoney,
  onOpenPlan,
}: { onOpenMoney?: () => void; onOpenPlan?: () => void } = {}) {
  const nowMs = useNow();
  const [today, dayStart] = todayParams(nowMs);

  // Make today's plan from the routine the first time the day is opened; a
  // planned day gets blocks for tasks timed after it was planned (heals).
  useEffect(() => {
    void ensureDayPlan(
      query,
      (ops) => transact("system", ops, "day-plan"),
      nowMs,
      () => ulid(),
    ).catch((error: unknown) => console.error("could not plan the day", error));
    // The next copy of each repeating task that was finished (T-068).
    void ensureRepeats(query, (ops) => transact("system", ops, "repeat"), today).catch(
      () => undefined,
    );
  }, [today, nowMs]);
  const top = useLiveQuery<TaskRow>(todayTopSql, [today, dayStart]);
  const due = useLiveQuery<TaskRow>(DUE_SQL, [today]);
  const waiting = useLiveQuery<{
    id: string;
    title: string;
    waiting_on: string | null;
    follow_up_date: string | null;
  }>(WAITING_SQL);
  const inbox = useLiveQuery<{ id: string; body: string }>(INBOX_SQL);
  const inboxTotal = useLiveQuery<{ n: number }>(INBOX_COUNT_SQL).rows[0]?.n ?? 0;
  const spent = useLiveQuery<{ currency: string; spent: number }>(SPENT_TODAY_SQL, [today]);
  const blocks = useLiveQuery<BlockRow & Record<string, string | number | null>>(TODAY_BLOCKS_SQL, [
    today,
  ]);
  const minuteNow = useMinute();
  // Each area's tasks inside its blocks (rule 6); the board is editable (rule 8).
  const board = useBoard(today, blocks.rows, minuteNow);
  const away = useLiveQuery<{ value_json: string }>(AWAY_SQL);
  const backOn = awayUntil(away.rows[0]?.value_json, today);
  const focus = useFocus();
  // Prayer times (T-092): one small line under the date, and Ramadan's when set.
  // Prayer days follow the calendar, not the 03:00 day: suhoor at 02:30 is the new day's.
  const prayerDay = prayerDate(minuteNow);
  const prayer = usePrayerTimes(prayerDay);
  const prayerRows = useLiveQuery<{ key: string; value_json: string | null }>(PRAYER_SETTINGS_SQL);
  const prayerSettings = readPrayerSettings(prayerRows.rows);
  const showPrayer = prayer !== null && prayerSettings.enabled;
  const ramadan = showPrayer ? ramadanLine(prayerSettings.ramadanStart, prayerDay, prayer) : null;

  // A light day keeps one task in Top 3 (F53); the rest stay under Also due.
  const light = lightDayTop(top.rows, blocks.rows);
  const topIds = new Set(light.top.map((task) => task.id));
  const moreDue = due.rows.filter((task) => !topIds.has(task.id));
  const error =
    top.error ?? due.error ?? waiting.error ?? inbox.error ?? spent.error ?? blocks.error;

  // The logical day (D22: it starts at 03:00), as the board and the brief
  // count it: at 00:30 it is still the evening before. Never a year for "today".
  const weekday = longWeekday.format(Date.parse(`${today}T12:00:00+03:00`));
  const dayMonth = showDate(today);
  const nowCards = (
    <>
      <NowCards blocks={blocks.rows} nowMs={minuteNow} focus={focus} />
      {focus && focus.kind !== null && <FocusPanel status={focus} />}
    </>
  );

  return (
    <main className="page today">
      <div className="layout-split">
        <aside className="side" aria-label="Today at a glance">
          <MonthPanel today={today} onOpen={onOpenPlan} />
          <div className="today-now in-side">{nowCards}</div>
          <LooseEnds inbox={inbox.rows} total={inboxTotal} waiting={waiting.rows} today={today} />
        </aside>

        <div className="main">
          {/* Below 1200px the side column drops under the board; the Now card
              (Start focus) shows here instead, at the top. CSS shows one of the two. */}
          <div className="today-now in-main">{nowCards}</div>
          <section className="canvas" aria-labelledby="today-title">
            <header className="canvas-head">
              <h1 id="today-title" className="page-title">
                {weekday}, <span className="soft">{dayMonth}</span>
              </h1>
              <span className="spacer" />
              <Button primary onClick={() => void invoke("open_capture").catch(() => undefined)}>
                <IconPlus size={16} /> Capture
              </Button>
            </header>
            {showPrayer && (
              <p className="meta today-prayer" aria-label="Prayer times today">
                {prayerLine(prayer)}
                {ramadan && (
                  <>
                    <br />
                    {ramadan}
                  </>
                )}
              </p>
            )}
            <p className="meta today-hint">
              Capture anything with your capture key; it shows up here.
            </p>

            {backOn && (
              <p className="row meta notice" role="status">
                Away until {returnLabel(backOn, today)}: no brief, review or block reminders.
                <Button onClick={() => void invoke("clear_away")}>I&apos;m back</Button>
              </p>
            )}
            {error && (
              <p role="alert" className="error">
                Couldn&apos;t load today: {error}
              </p>
            )}

            {/* Away mode pauses the brief (plan §3.11), as the banner says. */}
            {!backOn && !top.loading && !blocks.loading && (
              <Brief nowMs={minuteNow} today={today} blocks={blocks.rows} top={light.top} />
            )}

            <div className="today-cols">
              <div className="today-tasks">
                <WeekOutcomes monday={weekStart(today)} />

                <section aria-labelledby="top3">
                  <h2 id="top3">{light.light ? "Top task" : "Top 3"}</h2>
                  {light.light && (
                    <p className="meta">
                      {light.light === "rest"
                        ? "Rest day: one task at most."
                        : "Light day: two drained nights, so one task is enough."}
                    </p>
                  )}
                  {top.rows.length === 0 && !top.loading ? (
                    <p className="empty">
                      Tasks due or planned for today show up here; capture one with a date.
                    </p>
                  ) : (
                    <ul className="task-rows">
                      {light.top.map((task) => (
                        <TaskLine key={task.id} task={task} today={today} />
                      ))}
                    </ul>
                  )}
                  <AddForToday today={today} />
                </section>

                {moreDue.length > 0 && (
                  <section aria-labelledby="due">
                    <h2 id="due">Also due</h2>
                    <ul className="task-rows">
                      {moreDue.map((task) => (
                        <TaskLine key={task.id} task={task} today={today} />
                      ))}
                    </ul>
                  </section>
                )}

                <Missed today={today} nowMs={minuteNow} blocks={blocks.rows} />
              </div>

              <section className="today-plan" aria-labelledby="plan">
                <h2 id="plan">Today&apos;s plan</h2>
                <Timeline
                  blocks={blocks.rows}
                  nowMs={minuteNow}
                  date={today}
                  blockTasks={board.blockTasks}
                  onDone={board.onDone}
                  edit={board.edit}
                />
              </section>
            </div>
          </section>

          <div className="panel-row">
            <FocusWeek today={today} nowMs={minuteNow} />
            <section className="panel" aria-labelledby="money">
              <PanelHead id="money" title="Money today" sub="Safe to spend and what is due" />
              <TodayMoney today={today} spentToday={spent.rows} onOpen={onOpenMoney} />
            </section>
          </div>
        </div>
      </div>
    </main>
  );
}

const ADD_AREAS_SQL = "SELECT id, name FROM area_items WHERE active = 1 AND deleted_at IS NULL";
const ADD_CLOCK_SQL = "SELECT value_json FROM core_settings WHERE key = 'capture.clock_style'";

/** "Add for today" (§5): a capture dated today, saved as typed first. */
function AddForToday({ today }: { today: string }) {
  // The capture bar's areas and clock, so a line reads the same here (F83).
  const areas = useLiveQuery<{ id: string; name: string }>(ADD_AREAS_SQL);
  const clock = useLiveQuery<{ value_json: string }>(ADD_CLOCK_SQL);
  const [text, setText] = useState("");
  const [said, setSaid] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const add = () => {
    const nowMs = systemClock.now();
    const parsed = todayTask(text, today, nowMs, {
      areas: areas.rows,
      clockStyle: clock.rows[0]?.value_json === '"ethiopian"' ? "ethiopian" : "western",
    });
    if (!parsed || parsed.kind !== "task" || saving) return;
    setSaving(true);
    void commitCapture(text.trim(), toOps(parsed, { nowMs, newId: () => ulid() }), TODAY_PARSER_ID)
      .then(() => {
        setText("");
        const day = parsed.dueDate ?? today;
        setSaid(
          `Added “${parsed.title}” for ${day === today ? "today" : showDate(day, today, { weekday: true })}.`,
        );
      })
      .catch((error: unknown) =>
        setSaid(`Couldn't add it: ${error instanceof Error ? error.message : String(error)}`),
      )
      .finally(() => setSaving(false));
  };
  return (
    <form
      className="add-today"
      onSubmit={(event) => {
        event.preventDefault();
        add();
      }}
    >
      <label className="add-today-field">
        <IconPlus size={16} />
        <span className="visually-hidden">Add for today</span>
        <input
          value={text}
          placeholder="Add for today: call bank 3pm, #jobhunt send CV…"
          onChange={(event) => {
            setText(event.target.value);
            setSaid(null);
          }}
        />
      </label>
      <Button type="submit" disabled={!text.trim() || saving}>
        Add
      </Button>
      {said && (
        <p className="meta add-today-said" role="status">
          {said}
        </p>
      )}
    </form>
  );
}

/** Loose ends from captures and who you are waiting on, in the side column. */
function LooseEnds({
  inbox,
  total,
  waiting,
  today,
}: {
  today: string;
  inbox: { id: string; body: string }[];
  /** Every loose end, while the list shows the newest 10. */
  total: number;
  waiting: {
    id: string;
    title: string;
    waiting_on: string | null;
    follow_up_date: string | null;
  }[];
}) {
  return (
    <section className="panel" aria-labelledby="loose">
      <PanelHead
        id="loose"
        title="Loose ends"
        sub="Sorted in tonight's review"
        action={
          inbox.length > 0 ? (
            <span className="badge">{inboxBadge(inbox.length, total)}</span>
          ) : undefined
        }
      />
      {inbox.length === 0 && waiting.length === 0 ? (
        <p className="empty">Captures without a date and tasks you wait on show up here.</p>
      ) : (
        <ul className="list-rows">
          {inbox.map((note) => (
            <li key={note.id}>
              <span className="dot-pink" aria-hidden="true" />
              <span className="grow">{note.body}</span>
            </li>
          ))}
          {waiting.map((item) => (
            <li key={item.id}>
              <span className="dot-cream" aria-hidden="true" />
              <span className="grow">
                {/* A card dragged to Waiting has no name yet: show its title, not "Waiting on <title>". */}
                {item.waiting_on ? (
                  `Waiting on ${item.waiting_on}`
                ) : (
                  <>
                    {item.title}
                    <span className="meta"> · waiting</span>
                  </>
                )}
                {item.follow_up_date && (
                  <span className="meta"> · follow up {showDate(item.follow_up_date, today)}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        className="add-row"
        onClick={() => void invoke("open_capture").catch(() => undefined)}
      >
        <IconPlus size={16} /> Add one
      </button>
    </section>
  );
}

/** The week's outcomes from the Sunday step (T-076); nothing when none are set. */
function WeekOutcomes({ monday }: { monday: string }) {
  const outcomes = useWeekOutcomes(monday);
  if (!outcomes || outcomes.length === 0) return null;
  return (
    <section aria-labelledby="week-outcomes" className="week-outcomes">
      <h2 id="week-outcomes">This week&apos;s outcomes</h2>
      <ol className="outcomes">
        {outcomes.map((outcome) => (
          <li key={outcome}>{outcome}</li>
        ))}
      </ol>
    </section>
  );
}
