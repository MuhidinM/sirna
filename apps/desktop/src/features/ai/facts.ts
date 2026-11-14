/**
 * Fact sheets for the AI touchpoints, built from what the app already
 * computed, and the writes for accepting an AI suggestion. Pure and tested.
 */
import { type Op } from "../../kernel/db";
import { readWhen } from "../../capture/when";
import { type DateCheck, hoursLabel } from "../projects/capacity";
import { placeIdea } from "../projects/idea";
import {
  type BriefFacts,
  type CaptureGuess,
  type EstimateFacts,
  label,
  type TimingFacts,
} from "./touchpoints";

const pct = (ratio: number) => (Number.isFinite(ratio) ? Math.round(ratio * 100) : 999);
const VERDICTS = { good: "Good", tight: "Tight", too_much: "Too much" } as const;

export interface Named {
  title: string;
  area: string | null;
}

export function timingFacts(
  idea: Named,
  estimateMin: number,
  deadline: string,
  check: DateCheck,
  active: Named[],
  strict: boolean,
): TimingFacts {
  return {
    idea: label(idea.title, idea.area, strict, "project"),
    verdict: VERDICTS[check.verdict],
    estimateH: Math.round((estimateMin / 60) * 10) / 10,
    deadline,
    weeklyNeeded: hoursLabel(check.weeklyNeeded),
    loadBefore: pct(check.before),
    loadAfter: pct(check.after),
    activeProjects: active.map((p) => label(p.title, p.area, strict, "project")),
    suggestion: check.suggestion
      ? { start: check.suggestion.start, finish: check.suggestion.finish }
      : null,
  };
}

export function estimateFacts(
  idea: Named,
  others: (Named & { estimate_min: number | null })[],
  strict: boolean,
): EstimateFacts {
  return {
    idea: label(idea.title, idea.area, strict, "project"),
    area: idea.area,
    similar: others
      .filter((p) => p.estimate_min)
      .slice(0, 5)
      .map(
        (p) =>
          `${label(p.title, p.area, strict, "project")}: ${Math.round(((p.estimate_min ?? 0) / 60) * 10) / 10} h`,
      ),
  };
}

export interface BriefInputs {
  blocks: { kind: string; area: string | null; minutes: number }[];
  top: Named[];
  week: { name: string; done_min: number; target_min: number }[];
}

export function briefFacts(input: BriefInputs, strict: boolean): BriefFacts {
  const minutes = new Map<string, number>();
  for (const block of input.blocks)
    if (block.kind === "area" || block.kind === "routine" || block.kind === "fixed")
      minutes.set(block.area ?? "other", (minutes.get(block.area ?? "other") ?? 0) + block.minutes);
  return {
    blocks: [...minutes].map(([area, total]) => ({ area, minutes: total })),
    top: input.top.map((task) => label(task.title, task.area, strict, "task")),
    behind: input.week
      .filter((area) => area.target_min > 0)
      .map((area) => ({
        area: area.name,
        percent: Math.round((area.done_min / area.target_min) * 100),
      }))
      .sort((a, b) => a.percent - b.percent)
      .slice(0, 3),
  };
}

/** The writes for accepting a capture-fallback guess on a loose end. */
export function acceptGuessOps(
  note: { id: string; body: string },
  guess: CaptureGuess,
  areaIds: string[],
  nowMs: number,
  newId: () => string,
): Op[] {
  const area = guess.area && areaIds.includes(guess.area) ? guess.area : null;
  const title = guess.title.trim() || note.body;
  const done: Op = {
    op: "update",
    table: "note_items",
    id: note.id,
    values: { status: "converted" },
  };
  if (guess.kind === "note")
    return [
      {
        op: "update",
        table: "note_items",
        id: note.id,
        values: { kind: "note", status: "kept", area_id: area },
      },
    ];
  if (guess.kind === "idea") {
    const placed = placeIdea({ title }, null);
    return [
      {
        op: "insert",
        table: "project_items",
        id: newId(),
        values: { ...placed.values, area_id: area, origin: `note:${note.id}` },
      },
      done,
    ];
  }
  const when = guess.when_text ? readWhen(guess.when_text, nowMs) : null;
  return [
    {
      op: "insert",
      table: "task_items",
      id: newId(),
      values: {
        title,
        status: when?.date ? "todo" : "someday",
        due_date: when?.date ?? null,
        area_id: area,
        origin: `note:${note.id}`,
      },
    },
    done,
  ];
}

/**
 * Using an AI split: the steps become tasks with the same area and date, each
 * with its own minutes, so the planner spreads them over the coming days; the
 * big task is dropped. All under `split:<id>`, so one undo restores it.
 */
export function splitOps(
  task: {
    id: string;
    area_id: string | null;
    due_date: string | null;
    project_id?: string | null;
    planned_date?: string | null;
    deadline_stale?: number;
  },
  steps: { title: string; minutes: number }[],
  newId: () => string,
): Op[] {
  return [
    ...steps.map((step, index): Op => ({
      op: "insert",
      table: "task_items",
      id: newId(),
      values: {
        title: step.title.trim(),
        status: "todo",
        area_id: task.area_id,
        due_date: task.due_date,
        // Steps stay on the day the task was moved to, with its deadline mark (T-050).
        planned_date: task.planned_date ?? null,
        deadline_stale: task.deadline_stale ?? 0,
        project_id: task.project_id ?? null,
        estimate_min: step.minutes,
        origin: `split:${task.id}`,
        // In order: step 2 is offered once step 1 is done (T-051).
        parent_id: task.id,
        step_no: index + 1,
      },
    })),
    { op: "update", table: "task_items", id: task.id, values: { status: "dropped" } },
  ];
}
