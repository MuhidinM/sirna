/**
 * "What changed since yesterday" (plan §3.14, from InBoard): one brief line
 * counting what moved from the start of yesterday's logical day until now.
 */

export interface ChangedCounts {
  captured: number;
  done: number;
  moved: number;
  follow_ups: number;
}

/**
 * ?1 = start of yesterday's logical day (UTC ms), ?2 = today's logical date.
 * Moved = tasks whose due date changed (carried, rescheduled), each once.
 */
export const CHANGED_SQL = `
  SELECT
    (SELECT count(*) FROM core_raw_items
      WHERE source = 'capture' AND received_at >= ?1 AND parse_status != 'ignored') AS captured,
    (SELECT count(*) FROM task_items
      WHERE deleted_at IS NULL AND status = 'done' AND completed_at >= ?1) AS done,
    (SELECT count(DISTINCT entity_id) FROM core_activity
      WHERE entity_type = 'task_items' AND action = 'update' AND at >= ?1
        AND json_extract(after_json, '$.due_date') IS NOT NULL
        AND json_extract(before_json, '$.due_date') IS NOT json_extract(after_json, '$.due_date')) AS moved,
    (SELECT count(*) FROM task_items
      WHERE deleted_at IS NULL AND status = 'waiting' AND follow_up_date <= ?2) AS follow_ups`;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "3 captured · 2 done · 1 moved · 1 follow-up due"; undefined when nothing changed. */
export function changedText(counts: ChangedCounts | undefined): string | undefined {
  if (!counts) return undefined;
  const parts: string[] = [];
  if (counts.captured > 0) parts.push(`${counts.captured} captured`);
  if (counts.done > 0) parts.push(`${counts.done} done`);
  if (counts.moved > 0) parts.push(`${counts.moved} moved`);
  if (counts.follow_ups > 0)
    parts.push(`${plural(counts.follow_ups, "follow-up", "follow-ups")} due`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}
