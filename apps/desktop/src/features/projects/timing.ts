/**
 * The timing check for one project draft (plan §3.8): the numbers the form
 * shows, and the dates and status saved with it. Pure and tested.
 */
import {
  admitStatus,
  checkWithDate,
  type DateCheck,
  findSlot,
  type PlannedProject,
  type Slot,
  type WeekModel,
} from "./capacity";
import { hoursToMin, MAX_WEEKLY_HOURS, type ProjectDraft, realDate } from "./projects";

export type Timing =
  { kind: "date"; check: DateCheck } | { kind: "slot"; slot: Slot | null; estimateMin: number };

/** Null until there is an estimate to check. */
export function timingOf(
  draft: ProjectDraft,
  selfId: string | null,
  week: WeekModel,
  projects: PlannedProject[],
  today: string,
): Timing | null {
  const estimate = hoursToMin(draft.estimateHours);
  if (!estimate) return null;
  const others = projects.filter((project) => project.id !== selfId);
  const deadline = draft.deadline.trim();
  if (deadline && realDate(deadline))
    return { kind: "date", check: checkWithDate(estimate, deadline, today, week, others) };
  return {
    kind: "slot",
    slot: findSlot(estimate, today, week, others, hoursToMin(draft.weeklyHours)),
    estimateMin: estimate,
  };
}

export interface SavePlan {
  values: Partial<
    Record<"start_date" | "forecast_finish" | "weekly_min" | "status", string | number | null>
  >;
  /** True when a third active project was put in Next up. */
  held: boolean;
}

/** What the project was before this edit (null for a new one). */
export interface Saved {
  draft: ProjectDraft;
  start_date: string | null;
}

const planChanged = (draft: ProjectDraft, saved: Saved) =>
  (["estimateHours", "weeklyHours", "deadline", "status"] as const).some(
    (key) => draft[key].trim() !== saved.draft[key].trim(),
  );

/**
 * What to save beside the draft (R-BRN-05, plan §3.8):
 * - a third active project waits in Next up, with no dates until it starts;
 * - an open project gets dates from the check, and the weekly hours it needs
 *   when none were typed (at most MAX_WEEKLY_HOURS);
 * - a project already under way keeps its start date, and an edit that
 *   doesn't touch the estimate, hours, deadline or status keeps its dates;
 * - a deadline that has passed sets no dates.
 */
export function savePlan(
  draft: ProjectDraft,
  saved: Saved | null,
  selfId: string | null,
  timing: Timing | null,
  projects: PlannedProject[],
  today: string,
): SavePlan {
  const { status, held } = admitStatus(draft.status, projects, selfId);
  const values: SavePlan["values"] = { status };
  const open = status === "active" || status === "next_up";
  if (held || !open || (saved && !planChanged(draft, saved))) return { values, held };

  const started = saved?.start_date != null && saved.start_date <= today;
  const typedWeekly = hoursToMin(draft.weeklyHours);
  const weekly = (minutes: number) => {
    if (typedWeekly == null) values.weekly_min = Math.min(minutes, MAX_WEEKLY_HOURS * 60);
  };
  if (timing?.kind === "date" && timing.check.weeksLeft > 0) {
    if (!started) values.start_date = today;
    values.forecast_finish = draft.deadline.trim();
    weekly(timing.check.weeklyNeeded);
  } else if (timing?.kind === "slot" && timing.slot) {
    if (!started) values.start_date = timing.slot.start;
    values.forecast_finish = timing.slot.finish;
    weekly(timing.slot.weeklyMin);
  }
  return { values, held };
}
