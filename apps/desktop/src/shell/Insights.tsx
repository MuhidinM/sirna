import { systemClock } from "../kernel/clock";
import { logicalDate } from "../kernel/dates";
import {
  insightRange,
  insights,
  type SessionRow,
  SESSIONS_SQL,
} from "../features/dashboard/insights";
import { RATES_SQL, readRates } from "../features/money/currency";
import { monthLabel } from "../features/money/money";
import {
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
  return useLiveQuery<Row<AreaWeekRow>>(AREA_WEEK_SQL, [
    logicalDayStart(monday),
    logicalDayStart(shiftDate(monday, 7)),
  ]);
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
  const days = useLiveQuery<Row<JobBlockRow>>(JOB_DAYS_SQL, [from, to]);
  const weeks = [
    useAreaWeek(today, 4),
    useAreaWeek(today, 3),
    useAreaWeek(today, 2),
    useAreaWeek(today, 1),
  ];
  const gapFrom = shiftDate(today, -7 * GAP_WEEKS);
  const gapTo = shiftDate(today, -1);
  const blocks = useLiveQuery<Row<GapBlock>>(GAP_BLOCKS_SQL, [gapFrom, gapTo]);
  const sessions = useLiveQuery<Row<GapSession>>(GAP_SESSIONS_SQL, [
    logicalDayStart(gapFrom),
    logicalDayStart(today),
  ]);
  const all = [minutes, pay, rates, days, blocks, sessions, ...weeks];
  if (all.some((q) => q.loading)) return null;
  const out: EffortInsight[] = [];
  const byMonth = ratesByMonth(minutes.rows, pay.rows, readRates(rates.rows[0]?.value_json));
  const compare = compareRates(byMonth.get(month) ?? []);
  if (compare) out.push({ key: "jobRate", id: "jobRate", text: compareText(compare) });
  out.push(...skipInsights(jobSkips(days.rows), monthLabel(month).split(" ")[0] ?? month));
  out.push(...areaGaps(weeks.map((w) => w.rows)));
  out.push(...gapInsights(blocks.rows, sessions.rows));
  return out;
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
          ? "Insights appear after a couple of weeks of focus sessions, or a full month of job hours."
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
