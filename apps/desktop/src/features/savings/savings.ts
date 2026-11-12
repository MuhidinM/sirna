/**
 * Savings goals and the plant (plan §3.13; R-PRG-03). Saving is the only
 * money number on the dashboard and is kept apart from spending. The plant
 * grows by share of the goal and never wilts: taking money out only lowers
 * the number. Pure and tested.
 */
import { type Op } from "../../kernel/db";
import { parseAmount } from "../../kernel/money";

export interface GoalRow {
  id: string;
  title: string;
  target_minor: number;
  start_date: string;
  status: "active" | "done" | "paused";
  saved_minor: number;
}

export const GOALS_SQL = `
  SELECT g.id, g.title, g.target_minor, g.start_date, g.status,
         COALESCE((SELECT sum(e.amount_minor) FROM savings_entries e
                   WHERE e.goal_id = g.id AND e.deleted_at IS NULL), 0) AS saved_minor
  FROM savings_goals g
  WHERE g.deleted_at IS NULL
  ORDER BY g.status = 'done', g.created_at`;

/** Entries waiting for a goal (saved before any goal existed). */
export const UNASSIGNED_SQL = `SELECT COALESCE(sum(amount_minor), 0) AS minor, count(*) AS n
  FROM savings_entries WHERE goal_id IS NULL AND deleted_at IS NULL`;

export type Stage = 0 | 1 | 2 | 3 | 4 | 5;
export const STAGE_NAMES = ["Seed", "Sprout", "Small plant", "Bushy", "Flowering", "Tree"] as const;

/** Share of the goal saved, 0 to 1 (never below 0: a withdrawal can't kill the plant). */
export function shareSaved(goal: Pick<GoalRow, "saved_minor" | "target_minor">): number {
  if (goal.target_minor <= 0) return 0;
  return Math.max(0, Math.min(1, goal.saved_minor / goal.target_minor));
}

/** 6 stages by share: under 10%, 25%, 50%, 75%, 100%, and the tree at 100%. */
export function stageOf(share: number): Stage {
  if (share >= 1) return 5;
  if (share >= 0.75) return 4;
  if (share >= 0.5) return 3;
  if (share >= 0.25) return 2;
  if (share >= 0.1) return 1;
  return 0;
}

export interface GoalDraft {
  title: string;
  target: string; // "100,000" or "100k"
}

export function checkGoal(draft: GoalDraft): string | null {
  if (!draft.title.trim()) return "Name the goal (Laptop, Emergency fund…).";
  const target = parseAmount(draft.target.trim());
  if (target === null || target <= 0) return "Target: an amount like 100,000.";
  return null;
}

/** A new goal; entries saved before any goal existed join the first one. */
export function addGoalOps(
  draft: GoalDraft,
  today: string,
  id: string,
  unassigned: { id: string }[] = [],
): Op[] {
  return [
    {
      op: "insert",
      table: "savings_goals",
      id,
      values: {
        title: draft.title.trim(),
        target_minor: parseAmount(draft.target.trim()) ?? 0,
        start_date: today,
        status: "active",
      },
    },
    ...unassigned.map((entry): Op => ({
      op: "update",
      table: "savings_entries",
      id: entry.id,
      values: { goal_id: id },
    })),
  ];
}

export function entryOps(
  goalId: string | null,
  amountMinor: number,
  nowMs: number,
  localDate: string,
  id: string,
  origin: string,
  note: string | null = null,
): Op[] {
  return [
    {
      op: "insert",
      table: "savings_entries",
      id,
      values: {
        goal_id: goalId,
        occurred_at: nowMs,
        local_date: localDate,
        amount_minor: amountMinor,
        note,
        origin,
      },
    },
  ];
}

/** Hands waiting entries (saved without a goal) to a goal. */
export function assignOps(entryIds: string[], goalId: string): Op[] {
  return entryIds.map((id) => ({
    op: "update" as const,
    table: "savings_entries" as const,
    id,
    values: { goal_id: goalId },
  }));
}

/** A withdrawal can't take more than the goal holds. */
export function checkTakeOut(goal: Pick<GoalRow, "saved_minor">, minor: number): string | null {
  return minor > Math.max(0, goal.saved_minor) ? "That's more than this goal holds." : null;
}

export function goalStatusOps(id: string, status: GoalRow["status"]): Op[] {
  return [{ op: "update", table: "savings_goals", id, values: { status } }];
}

/**
 * Which goal a capture means: one whose name contains the word(s) given
 * (`saved 500 laptop`), else the only active goal, else none (the entry
 * waits for a goal).
 */
export function matchGoal(
  goals: Pick<GoalRow, "id" | "title" | "status">[],
  words: string | undefined,
): string | null {
  const active = goals.filter((goal) => goal.status === "active");
  const text = (words ?? "").trim().toLowerCase();
  if (text) {
    const hit =
      active.find((goal) => goal.title.toLowerCase().includes(text)) ??
      active.find((goal) => text.includes(goal.title.toLowerCase()));
    if (hit) return hit.id;
  }
  return active.length === 1 ? (active[0]?.id ?? null) : null;
}

/** This week's saving, for the Sunday question. ?1 = this Monday, ?2 = next Monday. */
export const WEEK_SAVED_SQL = `SELECT COALESCE(sum(amount_minor), 0) AS minor FROM savings_entries
  WHERE deleted_at IS NULL AND local_date >= ?1 AND local_date < ?2`;
