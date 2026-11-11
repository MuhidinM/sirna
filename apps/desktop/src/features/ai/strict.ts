/** Strict mode (plan §7.4): send area names instead of task and project titles. */
export const STRICT_KEY = "ai.strict";
export const STRICT_SQL = "SELECT value_json FROM core_settings WHERE key = 'ai.strict'";

export function isStrict(rows: { value_json: string | null }[]): boolean {
  return rows[0]?.value_json === "true";
}

/**
 * Strict mode once the setting has loaded; null before. Callers send nothing
 * while it is null, so a slow read can never leak titles.
 */
export function strictOrNull(query: {
  loading: boolean;
  rows: { value_json: string | null }[];
}): boolean | null {
  return query.loading ? null : isStrict(query.rows);
}
