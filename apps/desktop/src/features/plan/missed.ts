/**
 * Missed blocks (T-070; proposal 4.4): a focus block whose time has passed
 * with no focus session and no tick. Today offers Later today, Tomorrow or
 * Skip, so a missed hour finds a place instead of silently vanishing. Pure.
 */
import { type Op } from "../../kernel/db";

/**
 * Today's area blocks that ended without a session or a tick
 * (?1 = logical date, ?2 = now in ms).
 */
export const MISSED_SQL = `
  SELECT b.id, b.start_at, b.end_at, b.title, b.task_id, t.title AS task_title
  FROM day_blocks b
  LEFT JOIN task_items t ON t.id = b.task_id
  WHERE b.logical_date = ?1 AND b.deleted_at IS NULL AND b.kind = 'area'
    AND b.status = 'planned' AND b.end_at <= ?2
    -- A block made after its time (the day planned late) wasn't missed.
    AND b.created_at < b.end_at
    -- Nor one whose task you finished another way.
    AND (b.task_id IS NULL OR t.status NOT IN ('done', 'dropped'))
    AND NOT EXISTS (SELECT 1 FROM focus_sessions f WHERE f.block_id = b.id)
  ORDER BY b.start_at`;

export interface MissedBlock {
  id: string;
  start_at: number;
  end_at: number;
  title: string;
  task_id: string | null;
  task_title: string | null;
}

const QUARTER = 15 * 60_000;

/**
 * The first gap at least as long as the block, from now (rounded up to the
 * next quarter hour) until the end of the day, between today's other blocks.
 * Null when nothing that long is left.
 */
export function freeGap(
  others: { start_at: number; end_at: number; status: string }[],
  lengthMs: number,
  fromMs: number,
  untilMs: number,
): number | null {
  let start = Math.ceil(fromMs / QUARTER) * QUARTER;
  const busy = others
    .filter(
      (block) => block.status !== "skipped" && block.status !== "moved" && block.end_at > start,
    )
    .sort((a, b) => a.start_at - b.start_at);
  for (const block of busy) {
    if (block.start_at - start >= lengthMs) break;
    if (block.end_at > start) start = Math.ceil(block.end_at / QUARTER) * QUARTER;
  }
  return start + lengthMs <= untilMs ? start : null;
}

/** Later today: the same block, moved into the gap (you moved it, so replans keep it). */
export function laterTodayOps(block: MissedBlock, startMs: number): Op[] {
  return [
    {
      op: "update",
      table: "day_blocks",
      id: block.id,
      values: { start_at: startMs, end_at: startMs + (block.end_at - block.start_at) },
    },
  ];
}

/** Tomorrow: its task is planned for tomorrow, and the block is marked moved. */
export function tomorrowOps(block: MissedBlock, tomorrow: string): Op[] {
  return [
    ...(block.task_id
      ? [
          {
            op: "update" as const,
            table: "task_items" as const,
            id: block.task_id,
            values: { planned_date: tomorrow },
          },
        ]
      : []),
    { op: "update", table: "day_blocks", id: block.id, values: { status: "moved" } },
  ];
}

export function skipOps(block: MissedBlock): Op[] {
  return [{ op: "update", table: "day_blocks", id: block.id, values: { status: "skipped" } }];
}
