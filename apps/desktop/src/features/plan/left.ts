/**
 * Time left on an open task (T-082). No imports: SQL in dayplan.ts reads the
 * floor while the plan modules are still loading.
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
