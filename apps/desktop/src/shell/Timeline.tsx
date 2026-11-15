import { type CSSProperties } from "react";

import { type JobTask } from "../features/plan/jobs";
import { type BlockRow, firstStep, formatMinutes, nowAndNext } from "../features/plan/now";
import { type FocusStatus, startFocus } from "./Focus";
import { EventCard, NowCard, toneOf } from "./kit";
import { Button } from "./ui";

const time = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Africa/Addis_Ababa",
});

/** "12.00", as in the reference. */
const dot = (ms: number) => time.format(ms).replace(":", ".");
const range = (block: BlockRow) => `${dot(block.start_at)} – ${dot(block.end_at)}`;

/** The yellow Now card: the current block, or the next one, with the time left. */
export function NowCards({
  blocks,
  nowMs,
  focus,
}: {
  blocks: BlockRow[];
  nowMs: number;
  focus?: FocusStatus | undefined;
}) {
  const { now, next, minutesToNext } = nowAndNext(blocks, nowMs);
  const canFocus = focus?.kind === null && (now?.kind === "area" || !now);
  if (now) {
    const left = Math.max(0, Math.round((now.end_at - nowMs) / 60_000));
    return (
      <NowCard
        when={range(now)}
        left={`${formatMinutes(left)} left`}
        title={now.title}
        sub={
          now.kind === "area"
            ? `First step: ${firstStep(now)}`
            : next
              ? `Then ${next.title} at ${dot(next.start_at)}`
              : undefined
        }
      >
        {canFocus && (
          <Button className="btn-orange" onClick={() => void startFocus(now.id)}>
            Start focus
          </Button>
        )}
      </NowCard>
    );
  }
  return (
    <NowCard
      when={next ? `Next at ${dot(next.start_at)}` : "Free time"}
      left={next && minutesToNext !== undefined ? formatMinutes(minutesToNext) : null}
      title={next ? next.title : "Nothing else today"}
      sub={next ? "Free time until then." : "The rest of the day is yours."}
    >
      {canFocus && (
        <Button className="btn-orange" onClick={() => void startFocus(null)}>
          Start focus
        </Button>
      )}
    </NowCard>
  );
}

/** The board fits about this tall; a long day packs its hours closer. */
const BOARD_PX = 680;
const MAX_PX_PER_MIN = 1.1;
const MIN_PX_PER_MIN = 0.62;
/** Cards shorter than this many pixels show one line. */
const SHORT_PX = 66;

/** Side-by-side lanes for blocks that overlap (calendar events over a routine). */
function lanes(blocks: BlockRow[]): Map<string, { lane: number; of: number }> {
  const sorted = [...blocks].sort((a, b) => a.start_at - b.start_at || b.end_at - a.end_at);
  const out = new Map<string, { lane: number; of: number }>();
  let group: BlockRow[] = [];
  let groupEnd = -Infinity;
  const flush = () => {
    const ends: number[] = [];
    const placed: { id: string; lane: number }[] = [];
    for (const block of group) {
      let lane = ends.findIndex((end) => end <= block.start_at);
      if (lane === -1) lane = ends.length;
      ends[lane] = block.end_at;
      placed.push({ id: block.id, lane });
    }
    for (const p of placed) out.set(p.id, { lane: p.lane, of: ends.length });
    group = [];
  };
  for (const block of sorted) {
    if (group.length > 0 && block.start_at >= groupEnd) flush();
    groupEnd = group.length === 0 ? block.end_at : Math.max(groupEnd, block.end_at);
    group.push(block);
  }
  if (group.length) flush();
  return out;
}

/** Today's blocks on an hour grid: event cards sized by length, a line at now. */
export function Timeline({
  blocks,
  nowMs,
  jobTasks,
  listUnder,
  onDone,
}: {
  blocks: BlockRow[];
  nowMs: number;
  /** Each job's open tasks (T-067), shown under that job's next block. */
  jobTasks?: Map<string, JobTask[]>;
  listUnder?: Set<string>;
  onDone?: (task: JobTask) => void;
}) {
  const { now } = nowAndNext(blocks, nowMs);
  if (blocks.length === 0) {
    return <p className="empty">No plan yet. Finish setup and today&apos;s blocks appear here.</p>;
  }
  const hour = 3_600_000;
  const first = Math.floor(Math.min(...blocks.map((b) => b.start_at)) / hour) * hour;
  const last = Math.ceil(Math.max(...blocks.map((b) => b.end_at)) / hour) * hour;
  const perMin = Math.min(
    MAX_PX_PER_MIN,
    Math.max(MIN_PX_PER_MIN, BOARD_PX / ((last - first) / 60_000)),
  );
  const y = (ms: number) => ((ms - first) / 60_000) * perMin;
  const hours: number[] = [];
  for (let t = first; t <= last; t += hour) hours.push(t);
  // Rest is a soft band behind the day, not a card beside it.
  const rest = blocks.filter((block) => block.kind === "rest");
  const placed = lanes(blocks.filter((block) => block.kind !== "rest"));
  const showNow = nowMs >= first && nowMs <= last;
  return (
    <div
      className="day-board"
      style={{ height: `${y(last) + 16}px` } as CSSProperties}
      role="list"
      aria-label="Today's plan"
    >
      <div className="day-hours" aria-hidden="true">
        {hours.map((t) => (
          <span key={t} className="day-hour" style={{ top: y(t) }}>
            {dot(t)}
          </span>
        ))}
        {showNow && (
          <span className="day-hour now" style={{ top: y(nowMs) }}>
            {dot(nowMs)}
          </span>
        )}
      </div>
      <div className="day-lanes">
        {hours.map((t) => (
          <span key={t} className="day-line" style={{ top: y(t) }} aria-hidden="true" />
        ))}
        {showNow && <span className="day-line now" style={{ top: y(nowMs) }} aria-hidden="true" />}
        {rest.map((block) => (
          <div
            key={block.id}
            className="day-rest"
            style={{ top: y(block.start_at), height: y(block.end_at) - y(block.start_at) }}
          >
            <span>
              {block.title} · {range(block)}
            </span>
          </div>
        ))}
        {blocks
          .filter((block) => block.kind !== "rest")
          .map((block) => {
            const lane = placed.get(block.id) ?? { lane: 0, of: 1 };
            const minutes = (block.end_at - block.start_at) / 60_000;
            const short = ((block.end_at - block.start_at) / 60_000) * perMin < SHORT_PX;
            const tasks =
              block.area_id && listUnder?.has(block.id) ? (jobTasks?.get(block.area_id) ?? []) : [];
            const style: CSSProperties = {
              top: y(block.start_at),
              height: Math.max(26, y(block.end_at) - y(block.start_at) - 4),
              left: `calc(${(lane.lane / lane.of) * 100}% + ${lane.lane ? 4 : 0}px)`,
              width: `calc(${100 / lane.of}% - ${lane.of > 1 ? 4 : 0}px)`,
            };
            const color = block.kind === "rest" ? "rest" : (block.color ?? "admin");
            return (
              <div role="listitem" key={block.id}>
                <EventCard
                  tone={toneOf(color)}
                  label={
                    short
                      ? range(block)
                      : `${range(block)}${block.kind === "fixed" ? " · fixed" : ""}`
                  }
                  title={block.title}
                  art={!short && block.kind === "fixed" && minutes >= 90}
                  faded={block.end_at <= nowMs || block.status === "done"}
                  current={block.id === now?.id}
                  className={short ? "short" : undefined}
                  style={style}
                >
                  {!short && block.task_title && block.kind === "area" && (
                    <span className="event-label">{block.task_title}</span>
                  )}
                  {tasks.length > 0 && !short && (
                    <ul className="event-check" aria-label={`${block.title} tasks`}>
                      {tasks.slice(0, Math.max(1, Math.floor((minutes - 40) / 18))).map((task) => (
                        <li key={task.id}>
                          <label>
                            <input
                              type="checkbox"
                              checked={false}
                              onChange={() => onDone?.(task)}
                            />
                            {task.title}
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}
                </EventCard>
              </div>
            );
          })}
      </div>
    </div>
  );
}
