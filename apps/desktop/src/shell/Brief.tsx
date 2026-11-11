import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

import { transact } from "../kernel/db";
import {
  BRIEF_DISMISSED_KEY,
  type BriefChecks,
  type BriefTask,
  buildBrief,
  WEEK_SQL,
  weekStart,
  type BriefArea,
} from "../features/brief/brief";
import { type BlockRow } from "../features/plan/now";
import { toMinutes } from "../features/plan/routine";
import { Button } from "./ui";
import { useLiveQuery } from "./useLiveQuery";

const SETTINGS_SQL = `
  SELECT key, value_json FROM core_settings
  WHERE key IN ('day.wake', 'day.hard_stop', '${BRIEF_DISMISSED_KEY}')`;

function useChecks(): BriefChecks | undefined {
  const [checks, setChecks] = useState<BriefChecks>();
  useEffect(() => {
    invoke<BriefChecks>("brief_checks")
      .then(setChecks)
      .catch(() => setChecks({ notificationsMuted: false, autostartOff: false }));
  }, []);
  return checks;
}

function setting(rows: { key: string; value_json: string }[], key: string): unknown {
  const row = rows.find((r) => r.key === key);
  return row ? (JSON.parse(row.value_json) as unknown) : undefined;
}

function dismiss(today: string) {
  void transact("user", [
    {
      op: "upsert",
      table: "core_settings",
      id: BRIEF_DISMISSED_KEY,
      values: { value_json: JSON.stringify(today) },
    },
  ]);
}

/**
 * The morning brief at the top of Today (plan §3.4). It stays until "Start my
 * day"; after that a one-line button brings it back for the rest of the day.
 */
export function Brief({
  nowMs,
  today,
  blocks,
  top,
}: {
  nowMs: number;
  today: string;
  blocks: BlockRow[];
  top: BriefTask[];
}) {
  const settings = useLiveQuery<{ key: string; value_json: string }>(SETTINGS_SQL);
  const week = useLiveQuery<BriefArea & Record<string, string | number>>(WEEK_SQL, [
    weekStart(nowMs),
    nowMs,
  ]);
  const checks = useChecks();
  const [reopened, setReopened] = useState(false);
  const ready = !settings.loading && !week.loading && checks !== undefined;

  useEffect(() => {
    if (ready) void invoke("brief_ready").catch(() => undefined);
  }, [ready]);

  if (!ready) return null;
  const dismissed = setting(settings.rows, BRIEF_DISMISSED_KEY) === today;
  if (dismissed && !reopened) {
    return (
      <Button className="brief-reopen" onClick={() => setReopened(true)}>
        Morning brief
      </Button>
    );
  }

  const wake = setting(settings.rows, "day.wake");
  const stop = setting(settings.rows, "day.hard_stop");
  const lines = buildBrief({
    nowMs,
    today,
    blocks,
    top,
    week: week.rows,
    checks,
    wakeMin: toMinutes(typeof wake === "string" ? wake : "06:00"),
    hardStopMin: toMinutes(typeof stop === "string" ? stop : "22:00"),
  });

  return (
    <section className="brief card" aria-label="Morning brief">
      <dl>
        {lines.map((line, index) => (
          <div key={index} className={line.tone === "warn" ? "brief-line warn" : "brief-line"}>
            <dt>{line.label}</dt>
            <dd>
              <span>{line.text}</span>
              {line.meta && <span className="meta">{line.meta}</span>}
            </dd>
          </div>
        ))}
      </dl>
      {!dismissed && (
        <Button primary onClick={() => dismiss(today)}>
          Start my day
        </Button>
      )}
      {dismissed && <Button onClick={() => setReopened(false)}>Hide</Button>}
    </section>
  );
}
