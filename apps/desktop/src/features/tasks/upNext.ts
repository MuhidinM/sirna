/**
 * Up next (T-086, R-RUN-03): the order work is offered in. The SQL is shared
 * with the tray (tasks.rs reads the same file), so both always agree.
 */
import { todayParams } from "./today";
import upNextSql from "./queries/up_next.sql?raw";

export { upNextSql };

export type UpNextRow = {
  id: string;
  title: string;
  area_id: string | null;
  /** 0 in hand, 1 due soon, 2 pinned, 3 planned, 4 the rest (up_next.sql). */
  tier: number;
  due_date: string | null;
  estimate_min: number | null;
};

/** The parameters of up_next.sql: logical date, its start, now, how many. */
export function upNextParams(now: number, limit: number): [string, number, number, number] {
  const [date, start] = todayParams(now);
  return [date, start, now, limit];
}
