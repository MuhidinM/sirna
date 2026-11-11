/** Away mode (plan §3.11): pure helpers for Today's banner. Rust owns the rules. */

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

const weekday = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

/** "Mon 16 Nov". */
export function returnLabel(date: string): string {
  return weekday.format(new Date(`${date}T00:00:00Z`));
}
