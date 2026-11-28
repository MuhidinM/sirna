/**
 * Up next (T-086, R-RUN-03): the order work is offered in. The SQL is shared
 * with the tray (tasks.rs reads the same file), so both always agree.
 */
import { query } from "../../kernel/db";
import { todayParams } from "./today";
import upNextSql from "./queries/up_next.sql?raw";

export { upNextSql };

/** Why a task is where it is in the order. */
export const UP_NEXT_TIERS = ["in hand", "due soon", "pinned", "planned", "next"] as const;

export type UpNextRow = {
  id: string;
  title: string;
  area_id: string | null;
  /** Index into UP_NEXT_TIERS. */
  tier: number;
  due_date: string | null;
  estimate_min: number | null;
};

/** The parameters of up_next.sql: logical date, its start, now, how many. */
export function upNextParams(now: number, limit: number): [string, number, number, number] {
  const [date, start] = todayParams(now);
  return [date, start, now, limit];
}

export function loadUpNext(now: number, limit = 5): Promise<UpNextRow[]> {
  return query<UpNextRow>(upNextSql, upNextParams(now, limit));
}
