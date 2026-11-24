/**
 * Pure layout and wording for the day board's cards (Timeline.tsx), kept
 * apart so they can be tested without a window.
 */
import { type BlockRow, blockProgress } from "../features/plan/now";

/**
 * The task a block names, when the card should show it under the title. An
 * area block's title is often "Job hunt: Apply: …" already, so a task name the
 * title contains is not shown a second time.
 */
export function taskLine(block: Pick<BlockRow, "kind" | "title" | "task_title">): string | null {
  if (block.kind !== "area" || !block.task_title) return null;
  return block.title.includes(block.task_title) ? null : block.task_title;
}

/**
 * The small line on a card. Status (fixed, skipped, done, focus minutes) comes
 * straight after the time, before the task name, so a narrow card cuts the
 * optional part, not the status.
 */
export function cardLabel(
  block: Pick<
    BlockRow,
    "kind" | "title" | "task_title" | "status" | "start_at" | "end_at" | "focused_min"
  >,
  range: string,
  short: boolean,
): string {
  const progress = blockProgress(block);
  const skipped = block.status === "skipped";
  const status = [
    block.kind === "fixed" ? "fixed" : "",
    skipped ? "skipped" : "",
    progress.done && !skipped ? "done" : "",
    short && progress.focusedMin > 0 && !progress.done
      ? `${progress.focusedMin}/${progress.lengthMin} min`
      : "",
  ].filter(Boolean);
  const task = short ? taskLine(block) : null;
  return [range, ...status, ...(task ? [task] : [])].join(" · ");
}

/**
 * Where a card sits across the board when blocks overlap. The first lane (the
 * earliest, longest block, often a fixed one) keeps at least half the width;
 * the blocks beside it share the rest. Without this a 4-hour block shrinks to a
 * third of the board because of two short blocks inside it.
 */
export function laneBox(lane: { lane: number; of: number }): { left: string; width: string } {
  if (lane.of <= 1) return { left: "0%", width: "100%" };
  const first = Math.max(50, 100 / lane.of);
  const other = (100 - first) / (lane.of - 1);
  if (lane.lane === 0) return { left: "0%", width: `calc(${first}% - 4px)` };
  return {
    left: `calc(${first + (lane.lane - 1) * other}% + 4px)`,
    width: `calc(${other}% - 4px)`,
  };
}

/** Hour labels this close (px) to the now label are hidden so the two never overlap. */
export const NOW_LABEL_GAP_PX = 14;
