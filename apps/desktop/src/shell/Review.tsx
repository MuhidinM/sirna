import { useEffect, useState } from "react";

import { systemClock } from "../kernel/clock";
import { commitCapture, query, transact } from "../kernel/db";
import { formatAmount } from "../kernel/money";
import { ulid } from "../kernel/ulid";
import { toOps } from "../capture/ops";
import { ensureDayPlan } from "../features/plan/dayplan";
import { type BlockRow, TODAY_BLOCKS_SQL } from "../features/plan/now";
import {
  asksToShrink,
  carryOps,
  CHIPS_SQL,
  chipOps,
  chipsSince,
  INBOX_TWO_SQL,
  nextDate,
  OPEN_DUE_SQL,
  readSpending,
  REVIEW_PARSER,
  REVIEW_SQL,
  reviewOps,
  sortInboxOps,
  SPENT_LIST_SQL,
} from "../features/review/review";
import { logicalDayStart, todayParams, todayTopSql } from "../features/tasks/today";
import { Button } from "./ui";
import { useLiveQuery } from "./useLiveQuery";

type Step = 1 | 2 | 3 | 4;
type Row = Record<string, string | number | null>;

const time = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Africa/Addis_Ababa",
});

const STEPS: [Step, string][] = [
  [1, "Today"],
  [2, "Spending"],
  [3, "Energy"],
  [4, "Tomorrow"],
];

const FOCUS_DONE_SQL = `
  SELECT count(*) AS n FROM focus_sessions
  WHERE kind = 'focus' AND outcome = 'completed' AND started_at >= ?1`;

function save(date: string, values: Row) {
  return transact("user", reviewOps(date, values), "review");
}

/** Night review (plan §3.9): four steps, about 7 taps, nothing needs the network. */
export function Review({ onClose }: { onClose: () => void }) {
  // The review is for the logical day it started in, even past midnight.
  const [nowMs] = useState(() => systemClock.now());
  const [today, dayStart] = todayParams(nowMs);
  const tomorrow = nextDate(today);
  const [step, setStep] = useState<Step>(1);

  // Opening it starts tonight's row; reopening a finished review keeps its status.
  useEffect(() => {
    void query(REVIEW_SQL, [today]).then((rows) => {
      if (rows.length === 0) void save(today, { status: "open" });
    });
  }, [today]);

  const finish = async (status: "done" | "skipped", values: Row = {}) => {
    await save(today, { ...values, status });
    onClose();
  };

  return (
    <main className="review">
      <header className="review-head">
        <h1>Night review</h1>
        <ol className="steps">
          {STEPS.map(([n, label]) => (
            <li key={n}>
              <button
                type="button"
                className={n === step ? "step current" : "step"}
                aria-current={n === step ? "step" : undefined}
                onClick={() => setStep(n)}
              >
                {n} {label}
              </button>
            </li>
          ))}
        </ol>
        <Button onClick={() => void finish("skipped")}>Skip tonight</Button>
      </header>

      {step === 1 && (
        <TodayStep today={today} dayStart={dayStart} tomorrow={tomorrow} next={() => setStep(2)} />
      )}
      {step === 2 && (
        <SpendingStep
          today={today}
          nowMs={nowMs}
          next={(none) => {
            if (none) void save(today, { spent_none: 1 });
            setStep(3);
          }}
        />
      )}
      {step === 3 && (
        <section aria-labelledby="energy">
          <h2 id="energy">How was your energy?</h2>
          <div className="row">
            {[
              [1, "1 drained"],
              [2, "2 okay"],
              [3, "3 good"],
            ].map(([value, label]) => (
              <Button
                key={value}
                onClick={() => {
                  void save(today, { energy: Number(value) });
                  setStep(4);
                }}
              >
                {label}
              </Button>
            ))}
          </div>
        </section>
      )}
      {step === 4 && (
        <TomorrowStep
          tomorrow={tomorrow}
          done={(mind) => void finish("done", mind ? { mind } : {})}
        />
      )}
    </main>
  );
}

function TodayStep({
  today,
  dayStart,
  tomorrow,
  next,
}: {
  today: string;
  dayStart: number;
  tomorrow: string;
  next: () => void;
}) {
  const blocks = useLiveQuery<BlockRow & Row>(TODAY_BLOCKS_SQL, [today]);
  const open = useLiveQuery<{ id: string; title: string; carries: number; due_date: string }>(
    OPEN_DUE_SQL,
    [today],
  );
  const inbox = useLiveQuery<{ id: string; body: string }>(INBOX_TWO_SQL);
  const focus = useLiveQuery<{ n: number }>(FOCUS_DONE_SQL, [dayStart]);
  const [shrinking, setShrinking] = useState<string>();
  const [smaller, setSmaller] = useState("");

  const visible = blocks.rows.filter((b) => b.kind !== "rest");
  const sessions = focus.rows[0]?.n ?? 0;

  return (
    <section aria-labelledby="today-step">
      <h2 id="today-step">Today</h2>
      <p className="meta">
        {sessions} focus session{sessions === 1 ? "" : "s"} done.
      </p>
      <ul>
        {visible.map((block) => (
          <li key={block.id} className="task">
            <span className={block.status === "done" ? "done" : undefined}>{block.title}</span>
            <span className="meta">
              {time.format(block.start_at)} · {block.status}
            </span>
          </li>
        ))}
      </ul>

      {open.rows.length > 0 && (
        <>
          <h3>Still open</h3>
          <ul>
            {open.rows.map((task) => (
              <li key={task.id} className="task">
                <label>
                  <input
                    type="checkbox"
                    checked={false}
                    onChange={() =>
                      void transact("user", [
                        {
                          op: "update",
                          table: "task_items",
                          id: task.id,
                          values: { status: "done", completed_at: systemClock.now() },
                        },
                      ])
                    }
                  />
                  <span>{task.title}</span>
                </label>
                {asksToShrink(task.carries) && shrinking !== task.id && (
                  <span className="row">
                    <span className="meta">Make it smaller?</span>
                    <Button onClick={() => setShrinking(task.id)}>Smaller</Button>
                    <Button
                      onClick={() =>
                        void transact("user", [
                          {
                            op: "update",
                            table: "task_items",
                            id: task.id,
                            values: { status: "someday" },
                          },
                        ])
                      }
                    >
                      Someday
                    </Button>
                  </span>
                )}
                {shrinking === task.id && (
                  <form
                    className="row"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (!smaller.trim()) return;
                      void transact("user", [
                        {
                          op: "update",
                          table: "task_items",
                          id: task.id,
                          values: { title: smaller.trim(), carries: 0 },
                        },
                      ]);
                      setShrinking(undefined);
                      setSmaller("");
                    }}
                  >
                    <input
                      aria-label="A smaller first step"
                      value={smaller}
                      onChange={(event) => setSmaller(event.target.value)}
                    />
                    <Button type="submit">Save</Button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {inbox.rows.length > 0 && (
        <>
          <h3>Loose ends</h3>
          <ul>
            {inbox.rows.map((note) => (
              <li key={note.id} className="task">
                <span>{note.body}</span>
                <span className="row">
                  {(["task", "note", "drop"] as const).map((choice) => (
                    <Button
                      key={choice}
                      onClick={() =>
                        void transact(
                          "user",
                          sortInboxOps(note, choice, () => ulid()),
                        )
                      }
                    >
                      {choice === "task" ? "Task" : choice === "note" ? "Note" : "Drop"}
                    </Button>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="row actions">
        {open.rows.length > 0 && (
          <Button
            onClick={() => {
              void transact("user", carryOps(open.rows, tomorrow), "review").then(next);
            }}
          >
            All the rest to tomorrow
          </Button>
        )}
        <Button primary onClick={next}>
          Next
        </Button>
      </div>
    </section>
  );
}

function SpendingStep({
  today,
  nowMs,
  next,
}: {
  today: string;
  nowMs: number;
  next: (none: boolean) => void;
}) {
  const spent = useLiveQuery<{ id: string; description: string; amount_minor: number }>(
    SPENT_LIST_SQL,
    [today],
  );
  const chips = useLiveQuery<{
    description: string;
    amount_minor: number;
    category_id: string | null;
  }>(CHIPS_SQL, [chipsSince(today)]);
  const [text, setText] = useState("");
  const [unread, setUnread] = useState<string[]>([]);

  const add = async () => {
    const lines = readSpending(text, nowMs);
    const left: string[] = [];
    for (const line of lines) {
      if (!line.parsed) {
        left.push(line.text);
        continue;
      }
      // Store first, parse second: each line lands as a raw capture too.
      await commitCapture(
        line.text,
        toOps(line.parsed, { nowMs, newId: () => ulid() }),
        REVIEW_PARSER,
      );
    }
    setUnread(left);
    setText(left.join(", "));
  };

  return (
    <section aria-labelledby="spending">
      <h2 id="spending">What did you spend today?</h2>
      {spent.rows.length > 0 && (
        <ul>
          {spent.rows.map((txn) => (
            <li key={txn.id} className="task">
              <span>{txn.description}</span>
              <span className="meta">{formatAmount(-txn.amount_minor)}</span>
            </li>
          ))}
        </ul>
      )}
      {chips.rows.length > 0 && (
        <div className="row chips">
          {chips.rows.map((chip) => (
            <Button
              key={`${chip.description}:${chip.amount_minor}`}
              onClick={() => void transact("user", chipOps(chip, today, systemClock.now(), ulid()))}
            >
              {chip.description} {formatAmount(-chip.amount_minor)}
            </Button>
          ))}
        </div>
      )}
      <form
        className="row"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <input
          aria-label="Spending, comma separated"
          placeholder="lunch 120, taxi 40"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <Button type="submit">Add</Button>
      </form>
      {unread.length > 0 && (
        <p role="alert" className="error">
          Couldn&apos;t read: {unread.join(", ")}. Write it as “what amount”.
        </p>
      )}
      <div className="row actions">
        {spent.rows.length === 0 ? (
          <Button primary onClick={() => next(true)}>
            Nothing
          </Button>
        ) : (
          <Button primary onClick={() => next(false)}>
            Next
          </Button>
        )}
      </div>
    </section>
  );
}

function TomorrowStep({ tomorrow, done }: { tomorrow: string; done: (mind: string) => void }) {
  const start = logicalDayStart(tomorrow);
  const [ready, setReady] = useState(false);
  const [mind, setMind] = useState("");

  // Tomorrow's plan from the routine, the same way Today makes it.
  useEffect(() => {
    void ensureDayPlan(
      query,
      (ops) => transact("system", ops, "day-plan"),
      start + 60 * 60 * 1000,
      () => ulid(),
    )
      .catch((error: unknown) => console.error("could not plan tomorrow", error))
      .finally(() => setReady(true));
  }, [start]);

  const blocks = useLiveQuery<BlockRow & Row>(TODAY_BLOCKS_SQL, [tomorrow]);
  const top = useLiveQuery<{ id: string; title: string }>(
    todayTopSql,
    todayParams(start + 60 * 60 * 1000),
  );

  return (
    <section aria-labelledby="tomorrow">
      <h2 id="tomorrow">Tomorrow</h2>
      {ready && (
        <>
          <ul>
            {blocks.rows
              .filter((b) => b.kind !== "rest")
              .map((block) => (
                <li key={block.id} className="task">
                  <span>{block.title}</span>
                  <span className="meta">
                    {time.format(block.start_at)}–{time.format(block.end_at)}
                  </span>
                </li>
              ))}
          </ul>
          {top.rows.length > 0 && (
            <>
              <h3>Top 3</h3>
              <ul>
                {top.rows.map((task) => (
                  <li key={task.id} className="task">
                    {task.title}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
      <label className="field">
        <span>Anything on your mind? (optional)</span>
        <textarea value={mind} rows={2} onChange={(event) => setMind(event.target.value)} />
      </label>
      <div className="row actions">
        <Button primary onClick={() => done(mind.trim())}>
          Looks good
        </Button>
      </div>
    </section>
  );
}
