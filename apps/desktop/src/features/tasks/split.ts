import { type Op } from "../../kernel/db";
import { splitOps } from "../ai/facts";
import { SPLIT_MAX_MIN } from "../ai/touchpoints";

/**
 * Split any open task into steps (time-first §5): you type your own steps, one
 * per line, or ask the AI for a suggestion that lands in the same box for you
 * to edit. The app parses and checks the lines; nothing changes until "Use
 * these steps", and the whole split is one undo (`split:<id>`).
 */

export interface StepDraft {
  title: string;
  /** Minutes you typed ("30 min", "1h 15m"), or a share of the estimate; null when unknown. */
  minutes: number | null;
}

export const MAX_STEPS = 12;
export const STEP_TITLE_MAX = 80;
export const STEP_MIN = 5;
export const STEP_MAX = 480;

/** Any open task can be split; done, dropped and someday tasks cannot. */
export function canSplit(task: { status: string }): boolean {
  return task.status === "todo";
}

/**
 * The AI can suggest steps only for an estimate it can share out: two steps of
 * at least 10 min, at most six of 240 (the SPLIT touchpoint's limits).
 */
export function canSuggest(estimateMin: number | null | undefined): boolean {
  return estimateMin != null && estimateMin >= 20 && estimateMin <= SPLIT_MAX_MIN;
}

const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;
const DURATION =
  /^(.*?)[\s\-–—:,(]*(?:(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:ute)?s?)?)?\)?\s*$/i;

function parseLine(line: string): StepDraft | null {
  const text = line.replace(BULLET, "").trim();
  if (!text) return null;
  const match = DURATION.exec(text);
  const [, title = "", h, m] = match ?? [];
  if (match && (h !== undefined || m !== undefined) && title.trim()) {
    const minutes = Math.round(Number(h ?? 0) * 60 + Number(m ?? 0));
    return { title: title.trim(), minutes };
  }
  return { title: text, minutes: null };
}

/**
 * One step per line. A trailing time ("— 30 min", "(45m)", "1h", "1h 30m") is
 * that step's minutes. Steps without a time share what is left of the task's
 * estimate evenly (rounded to 5 min); with no estimate, or nothing left, they
 * stay unknown.
 */
export function parseSteps(text: string, estimateMin: number | null = null): StepDraft[] {
  const steps = text
    .split(/\r?\n/)
    .map(parseLine)
    .filter((step): step is StepDraft => step !== null);
  const unknown = steps.filter((step) => step.minutes === null).length;
  if (!unknown || !estimateMin) return steps;
  const given = steps.reduce((sum, step) => sum + (step.minutes ?? 0), 0);
  const share = Math.round((estimateMin - given) / unknown / 5) * 5;
  if (share < STEP_MIN) return steps;
  return steps.map((step) => (step.minutes === null ? { ...step, minutes: share } : step));
}

/** The AI's steps as lines for the box, in the format parseSteps reads back. */
export function stepsText(steps: { title: string; minutes: number }[]): string {
  return steps.map((step) => `${step.title} — ${step.minutes} min`).join("\n");
}

/** Why these steps can't be used yet, or null. */
export function checkSteps(steps: StepDraft[]): string | null {
  if (steps.length < 2) return "Type at least two steps, one per line.";
  if (steps.length > MAX_STEPS) return `At most ${MAX_STEPS} steps: anything bigger is a project.`;
  if (steps.some((step) => step.title.length > STEP_TITLE_MAX))
    return `Keep each step under ${STEP_TITLE_MAX} characters.`;
  if (
    steps.some(
      (step) => step.minutes !== null && (step.minutes < STEP_MIN || step.minutes > STEP_MAX),
    )
  )
    return `Each step takes ${STEP_MIN} min to ${STEP_MAX / 60} h.`;
  return null;
}

/** Total minutes of the steps whose time is known. */
export function stepsMinutes(steps: StepDraft[]): number {
  return steps.reduce((sum, step) => sum + (step.minutes ?? 0), 0);
}

/**
 * Your own steps become tasks exactly like an AI split (same area, dates,
 * project, order; the big task is dropped). A step with no time keeps no
 * estimate instead of a made-up one.
 */
export function manualSplitOps(
  task: Parameters<typeof splitOps>[0],
  steps: StepDraft[],
  newId: () => string,
  later: Parameters<typeof splitOps>[3] = [],
): Op[] {
  const ops = splitOps(
    task,
    steps.map((step) => ({ title: step.title, minutes: step.minutes ?? 0 })),
    newId,
    later,
  );
  return ops.map((op, index) =>
    op.op === "insert" && steps[index]?.minutes === null
      ? { ...op, values: { ...op.values, estimate_min: null } }
      : op,
  );
}
