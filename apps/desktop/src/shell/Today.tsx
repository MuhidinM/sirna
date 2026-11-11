import { systemClock } from "../kernel/clock";
import { transact } from "../kernel/db";
import { formatAmount } from "../kernel/money";
import {
  DUE_SQL,
  INBOX_SQL,
  SPENT_TODAY_SQL,
  todayParams,
  todayTopSql,
  WAITING_SQL,
} from "../features/tasks/today";
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
        {task.due_at !== null ? time.format(task.due_at) : overdue ? `since ${task.due_date}` : ""}
      </span>
    </li>
  );
}

export function Today() {
  const nowMs = systemClock.now();
  const [today, dayStart] = todayParams(nowMs);
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

  const topIds = new Set(top.rows.map((task) => task.id));
  const moreDue = due.rows.filter((task) => !topIds.has(task.id));
  const error = top.error ?? due.error ?? waiting.error ?? inbox.error ?? spent.error;

  return (
    <main className="today">
      <header>
        <h1>{longDate.format(nowMs)}</h1>
        <p className="meta">Capture anything with your capture key; it shows up here.</p>
      </header>

      {error && (
        <p role="alert" className="error">
          Couldn&apos;t load today: {error}
        </p>
      )}

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
