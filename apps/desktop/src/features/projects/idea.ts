/**
 * An `idea:` capture becomes a project (plan §3.8; R-PRJ-01, R-PRJ-02).
 * - With an estimate and no date it is placed by itself: the slot finder's
 *   first weeks under 85%, Active if it can start now, else Next up.
 * - With a date it stays an idea with its verdict saved; Projects shows the
 *   card and its options.
 * - Without an estimate it waits as an idea (the AI suggests one from T-038).
 * Everything is written in the capture's own transaction, so Ctrl+Z in the
 * capture box (or undoing the capture) takes it all back.
 */
import { type SqlValue } from "../../kernel/db";
import {
  checkWithDate,
  type DateCheck,
  findSlot,
  firstMonday,
  hoursLabel,
  MAX_ACTIVE,
  type PlannedProject,
  type Slot,
  type WeekModel,
  weekLoad,
} from "./capacity";
import { weekStart } from "../plan/dayplan";
import { MAX_WEEKLY_HOURS } from "./projects";

export interface IdeaInput {
  title: string;
  area?: string;
  estimateMin?: number;
  deadline?: string;
}

export interface WeekPlan {
  week: WeekModel;
  projects: PlannedProject[];
  today: string;
  /** Known area ids; a #tag that isn't one stays in the name instead. */
  areaIds?: string[];
}

/** The projects a capture made, so a fix (Up arrow) can leave them out of the week. */
export const REPLACED_PROJECTS_SQL = `SELECT entity_id FROM core_activity
  WHERE context = ? AND entity_type = 'project_items' AND action = 'insert'`;

export interface Placement {
  values: Record<string, SqlValue>;
  echo: string;
}

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Mon 16 Nov" */
export function shortDay(date: string): string {
  const at = new Date(`${date}T00:00:00Z`);
  return `${days[at.getUTCDay()] ?? ""} ${at.getUTCDate()} ${months[at.getUTCMonth()] ?? ""}`;
}

const percent = (ratio: number) => (Number.isFinite(ratio) ? `${Math.round(ratio * 100)}%` : "∞");

export const VERDICT_LABEL = { good: "Good", tight: "Tight", too_much: "Too much" } as const;

/** What a dated idea's card shows later, saved as last_check_json. */
export function checkJson(check: DateCheck): string {
  return JSON.stringify({
    verdict: check.verdict,
    weeklyNeeded: check.weeklyNeeded,
    before: check.before,
    after: Number.isFinite(check.after) ? check.after : null,
    reasons: check.reasons,
    suggestion: check.suggestion
      ? { start: check.suggestion.start, finish: check.suggestion.finish }
      : null,
  });
}

/** Status for work the slot finder placed: Active when it can start this coming week. */
export function placedStatus(slot: Slot, plan: WeekPlan): "active" | "next_up" {
  const first = firstMonday(plan.today);
  const running = weekLoad(plan.week, plan.projects, first).activeProjects;
  const activeNow = plan.projects.filter((p) => p.status === "active").length;
  return slot.start === first && running < MAX_ACTIVE && activeNow < MAX_ACTIVE
    ? "active"
    : "next_up";
}

export function placeIdea(idea: IdeaInput, plan: WeekPlan | null): Placement {
  // project_items.area_id must name a real area; an unknown #tag stays readable.
  const known = idea.area !== undefined && plan?.areaIds?.includes(idea.area) === true;
  const values: Record<string, SqlValue> = {
    title: idea.area && !known ? `${idea.title} #${idea.area}` : idea.title,
    area_id: known ? (idea.area ?? null) : null,
    estimate_min: idea.estimateMin ?? null,
    estimate_by: idea.estimateMin ? "user" : null,
    deadline: idea.deadline ?? null,
    status: "idea",
    origin: "capture",
  };
  const due = idea.deadline ? ` · by ${shortDay(idea.deadline)}` : "";
  if (!idea.estimateMin) return { values, echo: `Idea${due} · add hours to place it, e.g. "~10h"` };
  if (!plan) return { values, echo: `Idea${due} · saved; couldn't read your week` };

  if (idea.deadline) {
    const check = checkWithDate(
      idea.estimateMin,
      idea.deadline,
      plan.today,
      plan.week,
      plan.projects,
    );
    values.last_check_json = checkJson(check);
    const label = VERDICT_LABEL[check.verdict];
    if (check.weeksLeft <= 0)
      return { values, echo: `${label} · the date has passed · see Projects` };
    return {
      values,
      echo: `${label} · ${hoursLabel(check.weeklyNeeded)}/week · load ${percent(check.before)} → ${percent(check.after)} · see Projects`,
    };
  }

  const slot = findSlot(idea.estimateMin, plan.today, plan.week, plan.projects);
  if (!slot) return { values, echo: "Idea · no room in the next year at 85% load" };
  values.status = placedStatus(slot, plan);
  values.start_date = slot.start;
  values.forecast_finish = slot.finish;
  values.weekly_min = Math.min(slot.weeklyMin, MAX_WEEKLY_HOURS * 60);
  const weeks = slot.weeks.length;
  return {
    values,
    echo: `${idea.title} · starts ${shortDay(slot.start)} · ${hoursLabel(slot.weeklyMin)}/week · ~${weeks} week${weeks === 1 ? "" : "s"} · Ctrl+Z undoes`,
  };
}

// Acting on an idea from its card in Projects -----------------------------------

export type IdeaAction =
  | { kind: "place" } // undated: the slot finder's weeks
  | { kind: "suggested" } // dated: move the date to the slot finder's finish
  | { kind: "keep" } // dated: start now and finish by the date
  | { kind: "drop" }
  | { kind: "estimate"; minutes: number };

export interface IdeaRow {
  id: string;
  estimate_min: number | null;
  deadline: string | null;
}

/** The update for an action on an idea's card; null when it can't apply. */
export function ideaActionValues(
  project: IdeaRow,
  action: IdeaAction,
  plan: WeekPlan,
): Record<string, SqlValue> | null {
  const others = { ...plan, projects: plan.projects.filter((p) => p.id !== project.id) };
  if (action.kind === "drop") return { status: "dropped" };
  if (action.kind === "estimate")
    return action.minutes > 0 ? { estimate_min: action.minutes, estimate_by: "user" } : null;
  const estimate = project.estimate_min;
  if (!estimate) return null;

  if (action.kind === "keep") {
    if (!project.deadline) return null;
    const check = checkWithDate(estimate, project.deadline, plan.today, plan.week, others.projects);
    if (check.weeksLeft <= 0) return null;
    // Starting now with 2 projects already running would make 3 (R-BRN-05).
    if (weekLoad(plan.week, others.projects, weekStart(plan.today)).activeProjects >= MAX_ACTIVE)
      return null;
    if (others.projects.filter((p) => p.status === "active").length >= MAX_ACTIVE) return null;
    return {
      status: "active",
      start_date: plan.today,
      forecast_finish: project.deadline,
      weekly_min: Math.min(check.weeklyNeeded, MAX_WEEKLY_HOURS * 60),
      last_check_json: checkJson(check),
    };
  }

  const slot = findSlot(estimate, plan.today, plan.week, others.projects);
  if (!slot) return null;
  return {
    status: placedStatus(slot, others),
    start_date: slot.start,
    forecast_finish: slot.finish,
    weekly_min: Math.min(slot.weeklyMin, MAX_WEEKLY_HOURS * 60),
    ...(action.kind === "suggested" ? { deadline: slot.finish } : {}),
  };
}
