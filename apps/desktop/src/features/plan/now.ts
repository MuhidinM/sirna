/** What is happening now and next in today's plan (plan §3.4). Pure. */

export interface BlockRow {
  id: string;
  start_at: number;
  end_at: number;
  kind: "fixed" | "routine" | "area" | "rest";
  area_id: string | null;
  task_id: string | null;
  title: string;
  status: string;
  color: string | null;
  task_title: string | null;
}

export const TODAY_BLOCKS_SQL = `
  SELECT b.id, b.start_at, b.end_at, b.kind, b.area_id, b.task_id, b.title, b.status,
         a.color, t.title AS task_title
  FROM day_blocks AS b
  LEFT JOIN area_items AS a ON a.id = b.area_id
  LEFT JOIN task_items AS t ON t.id = b.task_id AND t.deleted_at IS NULL
  WHERE b.logical_date = ? AND b.deleted_at IS NULL
  ORDER BY b.start_at`;

export interface NowAndNext {
  now: BlockRow | undefined;
  next: BlockRow | undefined;
  /** Minutes until `next` starts. */
  minutesToNext: number | undefined;
}

/** The block covering `nowMs` (the shortest one when they overlap), and the next to start. */
export function nowAndNext(blocks: BlockRow[], nowMs: number): NowAndNext {
  const covering = blocks
    .filter((block) => block.start_at <= nowMs && nowMs < block.end_at && block.kind !== "rest")
    .sort((a, b) => a.end_at - a.start_at - (b.end_at - b.start_at));
  const now = covering[0];
  const next = blocks.find((block) => block.start_at > nowMs && block.kind !== "rest");
  return {
    now,
    next,
    minutesToNext: next ? Math.ceil((next.start_at - nowMs) / 60000) : undefined,
  };
}

/** "48 min", "2 h 5 min". */
export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** The first step to show for a block: its task, else the block's own title. */
export function firstStep(block: BlockRow): string {
  return block.task_title ?? block.title;
}
