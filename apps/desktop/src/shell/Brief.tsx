import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";

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
import { CHANGED_SQL, type ChangedCounts } from "../features/brief/changed";
import { AT_RISK_SQL, riskLine, type RiskRow, risks } from "../features/projects/risk";
import { type BlockRow } from "../features/plan/now";
import { logicalDayStart } from "../features/tasks/today";
import { toMinutes } from "../features/plan/routine";
import { ask } from "../features/ai/ask";
import { briefFacts } from "../features/ai/facts";
import { isStrict, STRICT_SQL } from "../features/ai/strict";
import { BRIEF } from "../features/ai/touchpoints";
import { useInsights } from "./Insights";
import { Button } from "./ui";
import { useLiveQuery } from "./useLiveQuery";

const SETTINGS_SQL = `
  SELECT key, value_json FROM core_settings
  WHERE key IN ('day.wake', 'day.hard_stop', '${BRIEF_DISMISSED_KEY}')`;

const DAY_MS = 24 * 60 * 60 * 1000;

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
  const changed = useLiveQuery<ChangedCounts & Record<string, number>>(CHANGED_SQL, [
    logicalDayStart(today) - DAY_MS,
    today,
  ]);
  const risky = useLiveQuery<RiskRow & Record<string, string | number | null>>(AT_RISK_SQL);
  const found = useInsights(today);
  const checks = useChecks();
  const [reopened, setReopened] = useState(false);
  const ready =
    !settings.loading &&
    !week.loading &&
    !changed.loading &&
    !risky.loading &&
    found !== null &&
    checks !== undefined;

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
    changed: changed.rows[0],
    atRisk: riskLine(risks(risky.rows, today)),
    insight: found?.[0]?.text ?? null,
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
      <AiLine today={today} blocks={blocks} top={top} week={week.rows} />
      {!dismissed && (
        <Button primary onClick={() => dismiss(today)}>
          Start my day
        </Button>
      )}
      {dismissed && <Button onClick={() => setReopened(false)}>Hide</Button>}
    </section>
  );
}

const AI_LINE_KEY = "ai.brief_line";
const AI_LINE_SQL = "SELECT value_json FROM core_settings WHERE key = 'ai.brief_line'";

/** Codes that mean "set up the AI first": worth trying again the same day. */
const notSetUp = (code: string) => code === "no-key" || code === "bad-model";

/**
 * One line from the AI, asked at most once a day and kept in settings
 * (plan §7.3: 1 request a day). Nothing shows when there is none.
 */
function AiLine({
  today,
  blocks,
  top,
  week,
}: {
  today: string;
  blocks: BlockRow[];
  top: BriefTask[];
  week: BriefArea[];
}) {
  const saved = useLiveQuery<{ value_json: string | null }>(AI_LINE_SQL);
  const strictRows = useLiveQuery<{ value_json: string | null }>(STRICT_SQL);
  // Asked once per mount; the saved line covers the rest of the day.
  const asked = useRef(false);
  let stored: { date?: string; line?: string | null } = {};
  try {
    stored = JSON.parse(saved.rows[0]?.value_json ?? "{}") as typeof stored;
  } catch {
    stored = {};
  }
  const fresh = stored.date === today;
  useEffect(() => {
    // Wait for today's plan: a line written before the blocks exist would stay all day.
    if (saved.loading || strictRows.loading || fresh || asked.current || blocks.length === 0)
      return;
    asked.current = true;
    const names = new Map(week.map((area) => [area.id, area.name]));
    const facts = briefFacts(
      {
        blocks: blocks.map((block) => ({
          kind: block.kind,
          area: block.area_id ? (names.get(block.area_id) ?? null) : null,
          minutes: Math.round((block.end_at - block.start_at) / 60_000),
        })),
        top: top.map((task) => ({ title: task.title, area: null })),
        week,
      },
      isStrict(strictRows.rows),
    );
    void ask(BRIEF, facts).then((result) => {
      if (!result.ok && notSetUp(result.code)) return;
      void transact(
        "system",
        [
          {
            op: "upsert",
            table: "core_settings",
            id: AI_LINE_KEY,
            values: {
              value_json: JSON.stringify({
                date: today,
                line: result.ok ? result.value.line : null,
              }),
            },
          },
        ],
        "ai:brief",
      );
    });
  }, [saved.loading, strictRows.loading, fresh, blocks, top, week, today, strictRows.rows]);
  if (!fresh || !stored.line) return null;
  return <p className="ai-text brief-ai">{stored.line}</p>;
}
