import { useEffect, useRef } from "react";

import { ask } from "../features/ai/ask";
import { INSIGHT, type InsightFacts } from "../features/ai/touchpoints";
import {
  AWAY_HISTORY_SQL,
  type AwayChange,
  awayDays,
  FIRST_DAY_SQL,
} from "../features/dashboard/streak";
import { systemClock } from "../kernel/clock";
import { logicalDate } from "../kernel/dates";
import { transact } from "../kernel/db";
import {
  insightRange,
  insights,
  type SessionRow,
  SESSIONS_SQL,
} from "../features/dashboard/insights";
import { RATES_SQL, readRates } from "../features/money/currency";
import { monthLabel } from "../features/money/money";
import {
  AREA_CREATED_SQL,
  areaGaps,
  type AreaWeekRow,
  compareRates,
  compareText,
  type EffortInsight,
  gapInsights,
  type GapBlock,
  GAP_BLOCKS_SQL,
  type GapSession,
  GAP_SESSIONS_SQL,
  GAP_WEEKS,
  INSIGHT_AI_SQL,
  insightFacts,
  insightWording,
  insightWordingOps,
  JOB_DAYS_SQL,
  JOB_MONTH_MINUTES_SQL,
  JOB_MONTH_PAY_SQL,
  type JobBlockRow,
  jobSkips,
  lastFullMonth,
  monthDates,
  type MonthMinutes,
  type MonthPay,
  ratesByMonth,
  skipInsights,
} from "../features/insights/effort";
import { shiftDate, weekStart } from "../features/plan/carry";
import { logicalDayStart } from "../features/tasks/today";
import { AREA_WEEK_SQL } from "../features/week/card";
import { useLiveQuery } from "./useLiveQuery";

type Row<T> = T & Record<string, string | number | null>;

/** The last 4 weeks' focus insights (plan §3.14), moving with the logical day. */
export function useInsights(today: string) {
  const range = insightRange(today);
  const sessions = useLiveQuery<Row<SessionRow>>(SESSIONS_SQL, [range.since]);
  return sessions.loading ? null : insights(sessions.rows, range);
}

/** One full week's minutes per area, `weeksBack` weeks before this one. */
function useAreaWeek(today: string, weeksBack: number) {
  const monday = shiftDate(weekStart(today), -7 * weeksBack);
  const rows = useLiveQuery<Row<AreaWeekRow>>(AREA_WEEK_SQL, [
    logicalDayStart(monday),
    logicalDayStart(shiftDate(monday, 7)),
  ]);
  return { monday, ...rows };
}

/**
 * Effort against return (T-080) for the Dashboard: jobs from the last full
 * month (pay compared as a ratio only, skipped days), areas under target for
 * the last 4 full weeks, and job gaps from the last 2 weeks.
 */
export function useEffortInsights(today: string): EffortInsight[] | null {
  const month = lastFullMonth(today);
  const { from, to } = monthDates(month);
  const minutes = useLiveQuery<Row<MonthMinutes>>(JOB_MONTH_MINUTES_SQL, [from, to]);
  const pay = useLiveQuery<Row<MonthPay>>(JOB_MONTH_PAY_SQL, [from, to]);
  const rates = useLiveQuery<{ value_json: string }>(RATES_SQL);
  const wording = useLiveQuery<{ value_json: string }>(INSIGHT_AI_SQL);
  const days = useLiveQuery<Row<JobBlockRow>>(JOB_DAYS_SQL, [from, to]);
  const weeks = [
    useAreaWeek(today, 4),
    useAreaWeek(today, 3),
    useAreaWeek(today, 2),
    useAreaWeek(today, 1),
  ];
  const firstDay = useLiveQuery<{ first: string | null }>(FIRST_DAY_SQL);
  const created = useLiveQuery<{ id: string; created_at: number }>(AREA_CREATED_SQL);
  const awayHistory = useLiveQuery<Row<AwayChange>>(AWAY_HISTORY_SQL);
  const gapFrom = shiftDate(today, -7 * GAP_WEEKS);
  const gapTo = shiftDate(today, -1);
  const blocks = useLiveQuery<Row<GapBlock>>(GAP_BLOCKS_SQL, [gapFrom, gapTo]);
  const sessions = useLiveQuery<Row<GapSession>>(GAP_SESSIONS_SQL, [
    logicalDayStart(gapFrom),
    logicalDayStart(today),
  ]);
  const all = [
    minutes,
    pay,
    rates,
    wording,
    days,
    firstDay,
    created,
    awayHistory,
    blocks,
    sessions,
    ...weeks,
  ];
  if (all.some((q) => q.loading)) return null;
  const out: EffortInsight[] = [];
  const byMonth = ratesByMonth(minutes.rows, pay.rows, readRates(rates.rows[0]?.value_json));
  const compare = compareRates(byMonth.get(month) ?? []);
  if (compare) {
    const template = compareText(compare);
    out.push({
      key: "jobRate",
      id: "jobRate",
      text: insightWording(template, wording.rows[0]?.value_json),
      reword: { template, facts: insightFacts(compare) },
    });
  }
  out.push(...skipInsights(jobSkips(days.rows), monthLabel(month).split(" ")[0] ?? month));
  out.push(
    ...areaGaps(
      weeks.map((w) => ({
        monday: w.monday,
        rows: w.rows,
        awayDays: awayDays(awayHistory.rows, w.monday, shiftDate(w.monday, 6)).size,
      })),
      firstDay.rows[0]?.first ?? null,
      Object.fromEntries(created.rows.map((r) => [r.id, r.created_at])),
    ),
  );
  out.push(...gapInsights(blocks.rows, sessions.rows));
  return out;
}

/**
 * Asks the AI once per template to reword an insight; the reply is saved
 * through the activity log (actor ai:insight), so it can be undone. With the
 * AI off or a bad reply nothing is saved and the template text stays.
 */
function useReword(insight: EffortInsight | undefined) {
  const asked = useRef<string | null>(null);
  const template = insight?.reword?.template ?? null;
  const facts = insight?.reword ? JSON.stringify(insight.reword.facts) : null;
  const shown = insight?.text ?? null;
  useEffect(() => {
    if (template === null || facts === null || shown !== template || asked.current === template)
      return;
    asked.current = template;
    void ask(INSIGHT, JSON.parse(facts) as InsightFacts).then((result) => {
      if (result.ok)
        void transact("ai:insight", insightWordingOps(template, result.value.line), "insight");
    });
  }, [template, facts, shown]);
}

export function InsightList({
  today = logicalDate(systemClock.now()),
  effort = false,
}: {
  today?: string;
  /** Also the effort-against-return insights (the Dashboard). */
  effort?: boolean;
}) {
  const found = useInsights(today);
  if (!found) return null;
  if (!effort) return <Insights found={found} />;
  return <WithEffort today={today} found={found} />;
}

function WithEffort({ today, found }: { today: string; found: { key: string; text: string }[] }) {
  const effort = useEffortInsights(today);
  useReword(effort?.find((e) => e.reword));
  if (!effort) return null;
  return (
    <Insights found={[...found, ...effort.map((e) => ({ key: e.id, text: e.text }))]} effort />
  );
}

function Insights({
  found,
  effort = false,
}: {
  found: { key: string; text: string }[];
  effort?: boolean;
}) {
  if (found.length === 0)
    return (
      <p className="empty">
        {effort
          ? "Insights appear after a couple of weeks of focus sessions, or a month of hours and tagged pay for two jobs."
          : "Insights appear after a couple of weeks of focus sessions."}
      </p>
    );
  return (
    <ul className="insights">
      {found.map((insight) => (
        <li key={insight.key}>{insight.text}</li>
      ))}
    </ul>
  );
}
