import { useEffect, useState } from "react";

import { systemClock } from "../kernel/clock";
import { query, transact } from "../kernel/db";
import { ulid } from "../kernel/ulid";
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
  return (
    <li className="task">
      <label>
        <input type="checkbox" checked={task.status === "done"} onChange={() => toggle(task)} />
        <span className={task.status === "done" ? "done" : undefined}>{task.title}</span>
      </label>
      <span className="meta">
        {overdue
          ? `since ${task.due_date}${task.due_at !== null ? ` ${time.format(task.due_at)}` : ""}`
          : task.due_at !== null
            ? time.format(task.due_at)
            : ""}
      </span>
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

export function Today({ onChangeWeek }: { onChangeWeek?: () => void }) {
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
        {onChangeWeek && (
          <Button onClick={onChangeWeek} className="change-week">
            Change my week
          </Button>
        )}
      </header>

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
