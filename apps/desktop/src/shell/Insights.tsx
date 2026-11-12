import { systemClock } from "../kernel/clock";
import { logicalDate } from "../kernel/dates";
import {
  insightRange,
  insights,
  type SessionRow,
  SESSIONS_SQL,
} from "../features/dashboard/insights";
import { useLiveQuery } from "./useLiveQuery";

/** The last 4 weeks' focus insights (plan §3.14), moving with the logical day. */
export function useInsights(today: string) {
  const range = insightRange(today);
  const sessions = useLiveQuery<SessionRow & Record<string, string | number | null>>(SESSIONS_SQL, [
    range.since,
  ]);
  return sessions.loading ? null : insights(sessions.rows, range);
}

export function InsightList({ today = logicalDate(systemClock.now()) }: { today?: string }) {
  const found = useInsights(today);
  if (!found) return null;
  if (found.length === 0)
    return <p className="meta">Insights appear after a couple of weeks of focus sessions.</p>;
  return (
    <ul className="insights">
      {found.map((insight) => (
        <li key={insight.key}>{insight.text}</li>
      ))}
    </ul>
  );
}
