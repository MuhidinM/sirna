/**
 * Time left on an open task (T-082). The floor is applied once, where a task
 * row becomes plan input (taskOnDay in dayplan.ts), so the planner, the chain
 * and the preview all see the same number. Why 10: docs/decisions/0012.
 */

/**
 * An open task with an estimate never shows less than this left: one that ran
 * over its estimate is still open, so it still needs some time.
 */
export const MIN_LEFT_MIN = 10;

/**
 * The least an open task can have left: MIN_LEFT_MIN, or its whole estimate
 * when that is shorter. 0 without an estimate.
 */
export function leftFloor(task: { estimateMin?: number | null }): number {
  const estimate = task.estimateMin ?? 0;
  return estimate > 0 ? Math.min(estimate, MIN_LEFT_MIN) : 0;
}

/**
 * What an open task has left: its estimate minus focus time, never under
 * leftFloor. null without an estimate.
 */
export function timeLeft(task: {
  remainingMin: number | null;
  estimateMin?: number | null;
}): number | null {
  return task.remainingMin === null ? null : Math.max(task.remainingMin, leftFloor(task));
}
