import { useState } from "react";

import { type Op, transact } from "../kernel/db";
import { localToEpoch } from "../capture/when";
import { type BlockRow } from "../features/plan/now";
import { shiftDate } from "../features/plan/dayplan";
import {
  freeGap,
  laterTodayOps,
  MISSED_SQL,
  type MissedBlock,
  skipOps,
  tomorrowOps,
} from "../features/plan/missed";
import { toMinutes } from "../features/plan/routine";
import { Button } from "./ui";
import { useLiveQuery } from "./useLiveQuery";

const clock = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Africa/Addis_Ababa",
});

/** At most this many at once: the oldest misses matter least. */
const SHOWN = 3;

/**
 * Missed blocks (T-070): focus blocks that ended with nothing done. Each can
 * move later today (into the first free gap before your hard stop), to
 * tomorrow, or be skipped.
 */
export function Missed({
  today,
  nowMs,
  blocks,
}: {
  today: string;
  nowMs: number;
  blocks: BlockRow[];
}) {
  const missed = useLiveQuery<MissedBlock & Record<string, string | number | null>>(MISSED_SQL, [
    today,
    nowMs,
  ]);
  const stop = useLiveQuery<{ value_json: string }>(
    "SELECT value_json FROM core_settings WHERE key = 'day.hard_stop'",
  );
  const [error, setError] = useState<string | null>(null);
  if (missed.loading || missed.rows.length === 0) return null;
  let hardStop = "22:00";
  try {
    const parsed: unknown = JSON.parse(stop.rows[0]?.value_json ?? '"22:00"');
    if (typeof parsed === "string") hardStop = parsed;
  } catch {
    hardStop = "22:00";
  }
  const until = localToEpoch(today, toMinutes(hardStop));
  const write = (ops: Op[], id: string) =>
    void transact("user", ops, `block:${id}`).catch((failure: unknown) =>
      setError(`Couldn't move it: ${failure instanceof Error ? failure.message : String(failure)}`),
    );
  const shown = missed.rows.slice(-SHOWN);
  return (
    <section aria-labelledby="missed">
      <h2 id="missed">Missed</h2>
      <ul className="task-list">
        {shown.map((block) => {
          const gap = freeGap(
            blocks.filter((other) => other.id !== block.id),
            block.end_at - block.start_at,
            nowMs,
            until,
          );
          return (
            <li key={block.id} className="task">
              <span>
                {block.task_title ?? block.title}
                <span className="meta">
                  {" "}
                  · {clock.format(block.start_at)}–{clock.format(block.end_at)}
                </span>
              </span>
              <span className="row task-meta">
                {gap !== null && (
                  <Button onClick={() => write(laterTodayOps(block, gap), block.id)}>
                    Later today ({clock.format(gap)})
                  </Button>
                )}
                <Button onClick={() => write(tomorrowOps(block, shiftDate(today, 1)), block.id)}>
                  Tomorrow
                </Button>
                <Button onClick={() => write(skipOps(block), block.id)}>Skip</Button>
              </span>
            </li>
          );
        })}
      </ul>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
