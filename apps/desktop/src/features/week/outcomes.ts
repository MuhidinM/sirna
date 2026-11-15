/**
 * The Sunday planning step (T-076; proposal 4.5, 4.6): sort loose ends two at a
 * time, then pick up to 3 outcomes for the week, shown on Today and in the
 * brief. Every step can be skipped. One setting per week holds both. Pure.
 */
import { type Op } from "../../kernel/db";
import { isoWeekday, shiftDate, weekStart } from "../plan/dayplan";

export const MAX_OUTCOMES = 3;
const MAX_OUTCOME_LENGTH = 120;

export type PlanStep = "triage" | "outcomes";

export interface WeekPlan {
  outcomes: string[];
  skipped: PlanStep[];
}

export const planKey = (monday: string) => `week.plan.${monday}`;

/** ?1 = planKey(monday). */
export const WEEK_PLAN_SQL = "SELECT value_json FROM core_settings WHERE key = ?1";

/** On Sunday you plan the week that starts tomorrow; on other days, this one. */
export function planningWeek(today: string): string {
  return isoWeekday(today) === 7 ? shiftDate(today, 1) : weekStart(today);
}

export function readPlan(valueJson: string | null | undefined): WeekPlan {
  try {
    const value = JSON.parse(valueJson ?? "null") as Partial<
      Record<keyof WeekPlan, unknown>
    > | null;
    const strings = (list: unknown) =>
      Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : [];
    return {
      outcomes: strings(value?.outcomes).slice(0, MAX_OUTCOMES),
      skipped: strings(value?.skipped).filter(
        (step): step is PlanStep => step === "triage" || step === "outcomes",
      ),
    };
  } catch {
    return { outcomes: [], skipped: [] };
  }
}

/** Trimmed, blank and repeated ones dropped, at most 3. */
export function cleanOutcomes(lines: string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const line of lines) {
    const text = line.trim().replace(/\s+/g, " ").slice(0, MAX_OUTCOME_LENGTH);
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    kept.push(text);
  }
  return kept.slice(0, MAX_OUTCOMES);
}

function planOp(monday: string, plan: WeekPlan): Op {
  return {
    op: "upsert",
    table: "core_settings",
    id: planKey(monday),
    values: { value_json: JSON.stringify(plan) },
  };
}

export function outcomeOps(
  valueJson: string | null | undefined,
  monday: string,
  lines: string[],
): Op[] {
  const plan = readPlan(valueJson);
  const outcomes = cleanOutcomes(lines);
  // Saving none counts as skipping the step, so it isn't asked again this week.
  const skipped =
    outcomes.length === 0 && !plan.skipped.includes("outcomes")
      ? [...plan.skipped, "outcomes" as const]
      : plan.skipped;
  return [planOp(monday, { outcomes, skipped })];
}

export function skipStepOps(
  valueJson: string | null | undefined,
  monday: string,
  step: PlanStep,
): Op[] {
  const plan = readPlan(valueJson);
  if (plan.skipped.includes(step)) return [];
  return [planOp(monday, { ...plan, skipped: [...plan.skipped, step] })];
}

/** "Ship the invoice · Gym 3 times", or null when none are set. */
export function outcomesText(plan: WeekPlan): string | null {
  return plan.outcomes.length > 0 ? plan.outcomes.join(" · ") : null;
}
