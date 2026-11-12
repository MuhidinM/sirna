import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

import { systemClock } from "../kernel/clock";
import { query, transact } from "../kernel/db";
import { ask } from "../features/ai/ask";
import { aiUnavailable } from "../features/ai/codes";
import { splitOps } from "../features/ai/facts";
import { STRICT_SQL, strictOrNull } from "../features/ai/strict";
import { label, SPLIT, SPLIT_MAX_MIN, type SplitReply } from "../features/ai/touchpoints";
import { ulid } from "../kernel/ulid";
import { AWAY_SQL, awayUntil, returnLabel } from "../features/plan/away";
import { ensureDayPlan } from "../features/plan/dayplan";
import { formatAmount } from "../kernel/money";
import {
  DUE_SQL,
  INBOX_SQL,
  SPENT_TODAY_SQL,
  todayParams,
  todayTopSql,
  WAITING_SQL,
} from "../features/tasks/today";
import { type BlockRow, TODAY_BLOCKS_SQL } from "../features/plan/now";
import { Brief } from "./Brief";
import { FocusPanel, useFocus } from "./Focus";
import { NowCards, Timeline } from "./Timeline";
import { Button } from "./ui";
import { useLiveQuery } from "./useLiveQuery";

interface TaskRow extends Record<string, string | number | null> {
  id: string;
  title: string;
  status: string;
  due_date: string | null;
  due_at: number | null;
  estimate_min: number | null;
  area_id: string | null;
}

/** A task this long can be split into steps (plan §7.3, the AI's suggestion). */
const SPLIT_FROM_MIN = 90;

/**
 * Split with AI: shows the proposed steps; nothing changes until "Use these
 * steps". Strict mode sends the area instead of the title.
 */
function SplitTask({ task, onClose }: { task: TaskRow; onClose: () => void }) {
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
          primary
          disabled={using}
          onClick={() => {
            if (using) return;
            setUsing(true);
            void transact(
              "user",
              splitOps(task, state.steps, () => ulid()),
              `split:${task.id}`,
            )
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

const longDate = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "short",
  timeZone: "Africa/Addis_Ababa",
});
const time = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
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
  const overdue = task.due_date !== null && task.due_date < today;
  const [splitting, setSplitting] = useState(false);
  const big =
    task.status === "todo" &&
    (task.estimate_min ?? 0) >= SPLIT_FROM_MIN &&
    (task.estimate_min ?? 0) <= SPLIT_MAX_MIN;
  return (
    <li className="task">
      <label>
        <input type="checkbox" checked={task.status === "done"} onChange={() => toggle(task)} />
        <span className={task.status === "done" ? "done" : undefined}>{task.title}</span>
      </label>
      <span className="meta">
        {task.estimate_min ? `~${Math.round((task.estimate_min / 60) * 10) / 10} h · ` : ""}
        {overdue
          ? `since ${task.due_date}${task.due_at !== null ? ` ${time.format(task.due_at)}` : ""}`
          : task.due_at !== null
            ? time.format(task.due_at)
            : ""}
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

export function Today() {
  const nowMs = useNow();
  const [today, dayStart] = todayParams(nowMs);

  // Make today's plan from the routine the first time the day is opened.
  useEffect(() => {
    void ensureDayPlan(
      query,
      (ops) => transact("system", ops, "day-plan"),
      nowMs,
      () => ulid(),
    ).catch((error: unknown) => console.error("could not plan the day", error));
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
  const spent = useLiveQuery<{ spent: number }>(SPENT_TODAY_SQL, [today]);
  const blocks = useLiveQuery<BlockRow & Record<string, string | number | null>>(TODAY_BLOCKS_SQL, [
    today,
  ]);
  const minuteNow = useMinute();
  const away = useLiveQuery<{ value_json: string }>(AWAY_SQL);
  const backOn = awayUntil(away.rows[0]?.value_json, today);
  const focus = useFocus();

  const topIds = new Set(top.rows.map((task) => task.id));
  const moreDue = due.rows.filter((task) => !topIds.has(task.id));
  const error =
    top.error ?? due.error ?? waiting.error ?? inbox.error ?? spent.error ?? blocks.error;

  return (
    <main className="today">
      <header>
        <h1>{longDate.format(nowMs)}</h1>
        <p className="meta">Capture anything with your capture key; it shows up here.</p>
      </header>

      {backOn && (
        <p className="row meta" role="status">
          Away until {returnLabel(backOn)}: no brief, review or block reminders.
          <Button onClick={() => void invoke("clear_away")}>I&apos;m back</Button>
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          Couldn&apos;t load today: {error}
        </p>
      )}

      {!top.loading && !blocks.loading && (
        <Brief nowMs={minuteNow} today={today} blocks={blocks.rows} top={top.rows} />
      )}
      {focus && focus.kind !== null && <FocusPanel status={focus} />}
      <NowCards blocks={blocks.rows} nowMs={minuteNow} focus={focus} />

      <section aria-labelledby="top3">
        <h2 id="top3">Top 3</h2>
        {top.rows.length === 0 && !top.loading ? (
          <p className="empty">Nothing due today. Captures with a date land here.</p>
        ) : (
          <ul>
            {top.rows.map((task) => (
              <TaskLine key={task.id} task={task} today={today} />
            ))}
          </ul>
        )}
      </section>

      {moreDue.length > 0 && (
        <section aria-labelledby="due">
          <h2 id="due">Also due</h2>
          <ul>
            {moreDue.map((task) => (
              <TaskLine key={task.id} task={task} today={today} />
            ))}
          </ul>
        </section>
      )}

      {waiting.rows.length > 0 && (
        <section aria-labelledby="waiting">
          <h2 id="waiting">Waiting on</h2>
          <ul>
            {waiting.rows.map((item) => (
              <li key={item.id} className="task">
                <span>{item.waiting_on ?? item.title}</span>
                <span className="meta">
                  {item.follow_up_date ? `follow up ${item.follow_up_date}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="plan">
        <h2 id="plan">Today&apos;s plan</h2>
        <Timeline blocks={blocks.rows} nowMs={minuteNow} />
      </section>

      <section aria-labelledby="money">
        <h2 id="money">Spent today</h2>
        <p className="figure">{formatAmount(spent.rows[0]?.spent ?? 0)}</p>
      </section>

      {inbox.rows.length > 0 && (
        <section aria-labelledby="inbox">
          <h2 id="inbox">Loose ends ({inbox.rows.length})</h2>
          <p className="meta">Sorted in tonight&apos;s review.</p>
          <ul>
            {inbox.rows.map((note) => (
              <li key={note.id}>{note.body}</li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
