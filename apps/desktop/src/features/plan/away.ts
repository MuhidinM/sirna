/** Away mode (plan §3.11): pure helpers for Today's banner. Rust owns the rules. */
import { showDate } from "../../kernel/dates";

export const AWAY_SQL = "SELECT value_json FROM core_settings WHERE key = 'away.until'";

/** The return date while away on `today`, else undefined. */
export function awayUntil(valueJson: string | undefined, today: string): string | undefined {
  if (!valueJson) return undefined;
  try {
    const value: unknown = JSON.parse(valueJson);
    return typeof value === "string" && value > today ? value : undefined;
  } catch {
    return undefined;
  }
}

/** "Mon 16 Nov", with the year only when it differs from `today`'s. */
export function returnLabel(date: string, today?: string): string {
  return showDate(date, today, { weekday: true });
}
