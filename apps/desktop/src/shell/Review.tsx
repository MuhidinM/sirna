import "../theme/pages/plan-review.css";

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
import { ask } from "../features/ai/ask";
import { aiUnavailable } from "../features/ai/codes";
import { acceptGuessOps } from "../features/ai/facts";
import { STRICT_SQL, strictOrNull } from "../features/ai/strict";
import { CAPTURE, type CaptureGuess, REVIEW } from "../features/ai/touchpoints";
import { IconCheck, IconClock } from "./icons";
import { EventCard, PanelHead, type Tone, toneOf } from "./kit";
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

  const [reply, setReply] = useState<{ mind: string; energy: number | null } | null>(null);
  const [energy, setEnergy] = useState<number | null>(null);
  // Unknown counts as strict: nothing is sent until the setting has loaded.
  const strict = strictOrNull(useLiveQuery<{ value_json: string | null }>(STRICT_SQL)) ?? true;
  const finish = async (status: "done" | "skipped", values: Row = {}) => {
    await save(today, { ...values, status });
    // Something on your mind gets a short reply before the review closes (§7.3).
    // Strict mode sends no free text.
    if (status === "done" && typeof values.mind === "string" && values.mind && !strict)
      setReply({ mind: values.mind, energy });
    else onClose();
  };
  if (reply)
    return (
      <ReplyStep mind={reply.mind} energy={reply.energy} dayStart={dayStart} onClose={onClose} />
    );

  return (
    <main className="page plan-review">
      <section className="canvas rv" aria-labelledby="review-title">
        <header className="canvas-head">
          <h1 id="review-title" className="page-title">
            Night <span className="soft">review</span>
          </h1>
          <ol className="rv-steps" aria-label="Steps">
            {STEPS.map(([n, label]) => (
              <li key={n}>
                <button
                  type="button"
                  className={n === step ? "rv-step current" : n < step ? "rv-step past" : "rv-step"}
                  aria-current={n === step ? "step" : undefined}
                  onClick={() => setStep(n)}
                >
                  <span className="rv-step-n">{n}</span> {label}
                </button>
              </li>
            ))}
          </ol>
          <span className="spacer" />
          <Button className="btn-ghost rv-skip" onClick={() => void finish("skipped")}>
            Skip tonight
          </Button>
        </header>

        {step === 1 && (
          <TodayStep
            today={today}
            dayStart={dayStart}
            tomorrow={tomorrow}
            next={() => setStep(2)}
          />
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
          <section className="rv-step-body" aria-labelledby="energy">
            <h2 id="energy" className="rv-title">
              How was your energy?
            </h2>
            <div className="rv-energy">
              {ENERGY.map(([value, number, word, tone]) => (
                <Button
                  key={value}
                  className={`rv-energy-pick tone-${tone}`}
                  onClick={() => {
                    void save(today, { energy: value });
                    setEnergy(value);
                    setStep(4);
                  }}
                >
                  <span className="rv-energy-n">{number}</span> <span>{word}</span>
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
      </section>
    </main>
  );
}

const ENERGY: [number, string, string, Tone][] = [
  [1, "1", "drained", "pink"],
  [2, "2", "okay", "cream"],
  [3, "3", "good", "leaf"],
];

/** A block of the day as a small event card. */
function BlockCard({ block, label }: { block: BlockRow; label: string }) {
  const done = block.status === "done";
  return (
    <li>
      <EventCard
        tone={toneOf(block.color ?? "admin")}
        label={label}
        title={<span className={done ? "done" : undefined}>{block.title}</span>}
      >
        {done && (
          <span className="rv-done-mark" aria-hidden="true">
            <IconCheck size={14} />
          </span>
        )}
      </EventCard>
    </li>
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
  const areas = useLiveQuery<{ id: string; name: string }>(
    "SELECT id, name FROM area_items WHERE deleted_at IS NULL AND active = 1",
  );
  const strict = strictOrNull(useLiveQuery<{ value_json: string | null }>(STRICT_SQL)) ?? true;
  // Guesses belong to the notes they were asked for; new loose ends can ask again.
  const shown = inbox.rows.map((note) => note.id).join(",");
  const [asked, setAsked] = useState<{
    for: string;
    guesses: Map<string, CaptureGuess> | "asking";
  } | null>(null);
  const guesses = asked && asked.for === shown ? asked.guesses : null;
  const [guessNote, setGuessNote] = useState("");
  const suggest = () => {
    const forNotes = shown;
    setAsked({ for: forNotes, guesses: "asking" });
    void ask(CAPTURE, {
      notes: inbox.rows.map((note) => ({ ref: note.id, body: note.body })),
      areas: areas.rows,
    }).then((result) => {
      if (result.ok) {
        setAsked({
          for: forNotes,
          guesses: new Map(result.value.items.map((item) => [item.ref, item])),
        });
        setGuessNote(result.value.items.length ? "" : "No suggestions.");
      } else {
        setAsked(null);
        setGuessNote(aiUnavailable(result.code));
      }
    });
  };
  const focus = useLiveQuery<{ n: number }>(FOCUS_DONE_SQL, [dayStart]);
  const [shrinking, setShrinking] = useState<string>();
  const [smaller, setSmaller] = useState("");

  const visible = blocks.rows.filter((b) => b.kind !== "rest");
  const sessions = focus.rows[0]?.n ?? 0;

  return (
    <div className="rv-step-body">
      <div className="rv-grid">
        <section className="card rv-card rv-wide" aria-labelledby="today-step">
          <PanelHead
            id="today-step"
            icon={<IconClock size={18} />}
            title="Today"
            sub={`${sessions} focus session${sessions === 1 ? "" : "s"} done.`}
          />
          {visible.length === 0 ? (
            <p className="empty">No blocks today. Blocks from your routine show here.</p>
          ) : (
            <ul className="rv-blocks">
              {visible.map((block) => (
                <BlockCard
                  key={block.id}
                  block={block}
                  label={`${time.format(block.start_at)} · ${block.status}`}
                />
              ))}
            </ul>
          )}
        </section>

        {open.rows.length > 0 && (
          <section className="card rv-card" aria-labelledby="still-open">
            <PanelHead
              id="still-open"
              title="Still open"
              sub="Tick what you did"
              action={<span className="badge">{open.rows.length}</span>}
            />
            <ul className="task-rows">
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
                    <span className="rv-actions">
                      <span className="meta">Make it smaller?</span>
                      <Button className="rv-pill" onClick={() => setShrinking(task.id)}>
                        Smaller
                      </Button>
                      <Button
                        className="rv-pill"
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
                      className="rv-inline"
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
                      <Button type="submit" className="rv-dark">
                        Save
                      </Button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {inbox.rows.length > 0 && (
          <section className="card rv-card" aria-labelledby="loose-ends">
            <PanelHead
              id="loose-ends"
              title="Loose ends"
              sub="Make each one a task, a note, or drop it"
              action={<span className="badge">{inbox.rows.length}</span>}
            />
            {(!strict && guesses === null) || guesses === "asking" || guessNote ? (
              <p className="rv-ai">
                {!strict && guesses === null && (
                  <Button className="rv-pill rv-ai-btn" onClick={suggest}>
                    Suggest with AI
                  </Button>
                )}
                {guesses === "asking" && <span className="meta">Asking…</span>}
                {guessNote && <span className="meta">{guessNote}</span>}
              </p>
            ) : null}
            <ul className="rv-sort-rows">
              {inbox.rows.map((note) => (
                <li key={note.id}>
                  <span className="rv-sort-body">{note.body}</span>
                  <span className="rv-sort">
                    {guesses instanceof Map && guesses.get(note.id) && (
                      <GuessButton
                        note={note}
                        guess={guesses.get(note.id) as CaptureGuess}
                        areaIds={areas.rows.map((area) => area.id)}
                      />
                    )}
                    {(["task", "note", "drop"] as const).map((choice) => (
                      <Button
                        key={choice}
                        className={`rv-pick rv-pick-${choice}${choice === "drop" ? " btn-ghost btn-danger" : ""}`}
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
          </section>
        )}
      </div>

      <div className="rv-foot">
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
    </div>
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

  const total = spent.rows.reduce((sum, txn) => sum + txn.amount_minor, 0);

  return (
    <div className="rv-step-body">
      <div className="rv-grid">
        <section className="card rv-card" aria-labelledby="spending">
          <PanelHead
            id="spending"
            title="What did you spend today?"
            sub={
              spent.rows.length > 0
                ? `${formatAmount(-total)} so far`
                : "One line each, comma separated"
            }
          />
          {spent.rows.length > 0 && (
            <ul className="task-rows">
              {spent.rows.map((txn) => (
                <li key={txn.id} className="task">
                  <span>{txn.description}</span>
                  <span className="rv-amount">{formatAmount(-txn.amount_minor)}</span>
                </li>
              ))}
            </ul>
          )}
          <form
            className="rv-inline rv-add"
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
            <Button type="submit" className="rv-dark">
              Add
            </Button>
          </form>
          {unread.length > 0 && (
            <p role="alert" className="error">
              Couldn&apos;t read: {unread.join(", ")}. Write it as “what amount”.
            </p>
          )}
        </section>

        {chips.rows.length > 0 && (
          <section className="card rv-card" aria-labelledby="spend-again">
            <PanelHead id="spend-again" title="Again today?" sub="Tap one to add it" />
            <div className="rv-chips">
              {chips.rows.map((chip) => (
                <Button
                  key={`${chip.description}:${chip.amount_minor}`}
                  className="rv-chip"
                  onClick={() =>
                    void transact("user", chipOps(chip, today, systemClock.now(), ulid()))
                  }
                >
                  {chip.description} {formatAmount(-chip.amount_minor)}
                </Button>
              ))}
            </div>
          </section>
        )}
      </div>
      <div className="rv-foot">
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
    </div>
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

  const tomorrowBlocks = blocks.rows.filter((b) => b.kind !== "rest");

  return (
    <div className="rv-step-body">
      <div className="rv-grid">
        <section className="card rv-card rv-wide" aria-labelledby="tomorrow">
          <PanelHead id="tomorrow" icon={<IconClock size={18} />} title="Tomorrow" />
          {!ready ? (
            <p className="meta">Planning tomorrow…</p>
          ) : tomorrowBlocks.length === 0 ? (
            <p className="empty">No blocks for tomorrow yet. Blocks from your routine show here.</p>
          ) : (
            <ul className="rv-blocks">
              {tomorrowBlocks.map((block) => (
                <BlockCard
                  key={block.id}
                  block={block}
                  label={`${time.format(block.start_at)}–${time.format(block.end_at)}`}
                />
              ))}
            </ul>
          )}
        </section>
        {ready && top.rows.length > 0 && (
          <section className="card rv-card" aria-labelledby="tomorrow-top">
            <PanelHead id="tomorrow-top" title="Top 3" />
            <ol className="rv-top">
              {top.rows.map((task) => (
                <li key={task.id}>{task.title}</li>
              ))}
            </ol>
          </section>
        )}
        <section className="card rv-card" aria-label="On your mind">
          <label className="field">
            <span>Anything on your mind? (optional)</span>
            <textarea value={mind} rows={3} onChange={(event) => setMind(event.target.value)} />
          </label>
        </section>
      </div>
      <div className="rv-foot">
        <Button primary onClick={() => done(mind.trim())}>
          Looks good
        </Button>
      </div>
    </div>
  );
}

const KIND_LABEL = { task: "Task", note: "Note", idea: "Idea" } as const;

/** One AI guess for a loose end: shown, used only when you press it. */
function GuessButton({
  note,
  guess,
  areaIds,
}: {
  note: { id: string; body: string };
  guess: CaptureGuess;
  areaIds: string[];
}) {
  const area = guess.area && areaIds.includes(guess.area) ? ` · #${guess.area}` : "";
  const when = guess.when_text ? ` · ${guess.when_text}` : "";
  return (
    <Button
      className="rv-guess"
      title={`AI, ${guess.confidence} confidence`}
      onClick={() =>
        void transact(
          "user",
          acceptGuessOps(note, guess, areaIds, systemClock.now(), () => ulid()),
          `review:ai:${note.id}`,
        )
      }
    >
      {KIND_LABEL[guess.kind]}: {guess.title}
      {area}
      {when}
    </Button>
  );
}

const DONE_TODAY_SQL =
  "SELECT count(*) AS n FROM task_items WHERE deleted_at IS NULL AND status = 'done' AND completed_at >= ?";

/** A short reply to what is on your mind; the review closes after it. */
function ReplyStep({
  mind,
  energy,
  dayStart,
  onClose,
}: {
  mind: string;
  energy: number | null;
  dayStart: number;
  onClose: () => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    let live = true;
    // Plan §7.1: if the AI isn't back within 4 s, the plain text shows.
    const timer = setTimeout(() => setWaited(true), 4000);
    void query<{ n: number }>(DONE_TODAY_SQL, [dayStart])
      .then(([row]) => ask(REVIEW, { mind, energy, doneToday: row?.n ?? 0 }))
      .then((result) => {
        if (live && result.ok) setText(result.value.reply);
        else if (live) setWaited(true);
      });
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [mind, energy, dayStart]);
  return (
    <main className="page plan-review">
      <section className="canvas rv rv-reply" aria-labelledby="saved">
        <h1 id="saved" className="page-title">
          Saved for <span className="soft">tomorrow</span>
        </h1>
        <blockquote className="rv-mind">{mind}</blockquote>
        {text ? (
          <p className="ai-text">{text}</p>
        ) : waited ? (
          <p>Noted. Sleep well.</p>
        ) : (
          <p className="meta">…</p>
        )}
        <div className="rv-foot">
          <Button primary onClick={onClose}>
            Good night
          </Button>
        </div>
      </section>
    </main>
  );
}
