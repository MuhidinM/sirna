/**
 * Savings goals and the plant (plan §3.13; R-PRG-03). Saving is the only
 * money number on the dashboard and is kept apart from spending. The plant
 * grows by share of the goal and never wilts: taking money out only lowers
 * the number. Pure and tested.
 */
import { type Op } from "../../kernel/db";
import { parseAmount, type Santim } from "../../kernel/money";
import { type AccountRow, transferOps } from "../money/accounts";
import { type Rates, toEtb } from "../money/currency";

export interface GoalRow {
  id: string;
  title: string;
  target_minor: number;
  start_date: string;
  status: "active" | "done" | "paused";
  saved_minor: number;
  target_date: string | null;
  /**
   * The part of saved_minor sitting in a savings account (entries with an
   * account). The rest is money put aside inside your spending accounts.
   */
  held_minor?: number;
}

export const GOALS_SQL = `
  SELECT g.id, g.title, g.target_minor, g.start_date, g.status, g.target_date,
         COALESCE((SELECT sum(e.amount_minor) FROM savings_entries e
                   WHERE e.goal_id = g.id AND e.deleted_at IS NULL), 0) AS saved_minor,
         COALESCE((SELECT sum(e.amount_minor) FROM savings_entries e
                   WHERE e.goal_id = g.id AND e.deleted_at IS NULL AND e.account IS NOT NULL), 0)
           AS held_minor
  FROM savings_goals g
  WHERE g.deleted_at IS NULL
  ORDER BY g.status = 'done', g.created_at`;

/** Entries waiting for a goal; `held` is the part in a savings account. */
export const UNASSIGNED_SQL = `SELECT COALESCE(sum(amount_minor), 0) AS minor, count(*) AS n,
    COALESCE(sum(CASE WHEN account IS NOT NULL THEN amount_minor END), 0) AS held
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

// --- Savings accounts back the goals (time-first §4) ------------------------------

/**
 * Put aside: a transfer from a spending account into the savings account,
 * and the goal's entry tied to it (same transfer_id), in one write. Take
 * out (`sign` −1) is the reverse. Both accounts are in ETB, or the entry
 * is the ETB the money is worth at its rate.
 */
export function moveOps(input: {
  /** Null: the saving waits for "Give it to…" (several goals, none named). */
  goal: Pick<GoalRow, "id"> | null;
  sign: 1 | -1;
  amount: Santim;
  spend: Pick<AccountRow, "id" | "name" | "currency">;
  savings: Pick<AccountRow, "id" | "name" | "currency">;
  nowMs: number;
  date: string;
  ids: { entry: string; halves: [string, string]; transfer: string };
  /** The goal's value of the money, when the savings account isn't in ETB. */
  entryMinor?: Santim;
  /** Who wrote it: "savings" from the goal card, "capture" from the capture box. */
  origin?: string;
  /** Words kept on the saving (`laptop` from `saved 500 laptop`). */
  note?: string | null;
}): Op[] {
  const { goal, sign, amount, spend, savings, nowMs, date, ids, origin = "savings" } = input;
  const [from, to] = sign > 0 ? [spend, savings] : [savings, spend];
  return [
    ...transferOps({
      from,
      to,
      amount,
      date,
      nowMs,
      ids: ids.halves,
      transferId: ids.transfer,
      origin,
    }),
    {
      op: "insert",
      table: "savings_entries",
      id: ids.entry,
      values: {
        goal_id: goal?.id ?? null,
        occurred_at: nowMs,
        local_date: date,
        amount_minor: sign * (input.entryMinor ?? amount),
        note: input.note ?? null,
        origin,
        account: savings.id,
        transfer_id: ids.transfer,
      },
    },
  ];
}

type SavingsSide = Pick<AccountRow, "id" | "currency" | "is_savings">;

/**
 * What a transfer saves (time-first §4): into a savings account from a
 * spending one it is saved, the other way it is taken out; between two of
 * the same kind, nothing. Worth its ETB value (the goals are in birr); null
 * also when that needs a rate that isn't set.
 */
export function transferSaving(input: {
  from: SavingsSide;
  to: SavingsSide;
  /** Left the from-account, in its currency. */
  sent: Santim;
  /** Arrived in the to-account, in its currency. */
  received: Santim;
  rates: Rates;
}): { account: string; minor: Santim } | null {
  const { from, to, rates } = input;
  const into = to.is_savings === 1;
  if (into === (from.is_savings === 1)) return null;
  const minor = into
    ? toEtb(input.received, to.currency ?? "ETB", rates)
    : toEtb(input.sent, from.currency ?? "ETB", rates);
  if (minor === null || minor === 0) return null;
  return { account: into ? to.id : from.id, minor: into ? minor : -minor };
}

/**
 * The saving a transfer makes, written in the transfer's own transaction so
 * it counts at once: to the one active goal, or waiting (goal null) for
 * "Give it to…" when there are several. The sync stays only as a repair.
 */
export function transferSavingOps(input: {
  saving: { account: string; minor: Santim } | null;
  goalId: string | null;
  transferId: string;
  nowMs: number;
  date: string;
  id: string;
  origin: string;
}): Op[] {
  const { saving } = input;
  if (!saving) return [];
  return [
    {
      op: "insert",
      table: "savings_entries",
      id: input.id,
      values: {
        goal_id: input.goalId,
        occurred_at: input.nowMs,
        local_date: input.date,
        amount_minor: saving.minor,
        note: null,
        origin: input.origin,
        account: saving.account,
        transfer_id: input.transferId,
      },
    },
  ];
}

/** The goal a saving with no goal named goes to: the only active one, else none. */
export const onlyActiveGoal = (goals: Pick<GoalRow, "id" | "status">[]): string | null => {
  const active = goals.filter((goal) => goal.status === "active");
  return active.length === 1 ? (active[0]?.id ?? null) : null;
};

/** Put aside and take out need two accounts in the same currency. */
export function checkMove(
  spend: Pick<AccountRow, "id" | "currency"> | undefined,
  savings: Pick<AccountRow, "id" | "currency"> | undefined,
): string | null {
  if (!savings) return "Mark an account as savings first (Money → Accounts).";
  if (!spend) return "Pick the account the money comes from.";
  if ((spend.currency ?? "ETB") !== (savings.currency ?? "ETB"))
    return "Pick an account in the same currency as the savings account.";
  return null;
}

/** Transfer halves in a savings account that have no saving yet (or one that was removed). */
export const SAVINGS_TRANSFERS_SQL = `
  SELECT m.id, m.transfer_id, m.amount_minor, m.local_date, m.occurred_at, m.account,
         m.created_at, COALESCE(a.currency, m.currency) AS currency,
         (SELECT e.id FROM savings_entries e WHERE e.transfer_id = m.transfer_id) AS entry_id,
         (SELECT e.goal_id FROM savings_entries e WHERE e.transfer_id = m.transfer_id) AS entry_goal
  FROM money_txns m
  JOIN money_accounts a ON a.id = m.account AND a.is_savings = 1
  WHERE m.deleted_at IS NULL AND m.transfer_id IS NOT NULL AND m.transfer_id NOT LIKE 'loan:%'
    AND NOT EXISTS (SELECT 1 FROM savings_entries e
                    WHERE e.transfer_id = m.transfer_id AND e.deleted_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM money_txns o
                    JOIN money_accounts oa ON oa.id = o.account AND oa.is_savings = 1
                    WHERE o.transfer_id = m.transfer_id AND o.id <> m.id AND o.deleted_at IS NULL)`;

/** Savings tied to a transfer that is gone (deleted, or a capture undone). */
export const ORPHAN_SAVINGS_SQL = `
  SELECT e.id FROM savings_entries e
  WHERE e.deleted_at IS NULL AND e.transfer_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM money_txns m
                    WHERE m.transfer_id = e.transfer_id AND m.deleted_at IS NULL)`;

export interface SavingsTransfer {
  id: string;
  transfer_id: string;
  amount_minor: number;
  local_date: string;
  occurred_at: number;
  account: string;
  created_at: number;
  currency: string | null;
  /** A removed saving for this transfer, brought back rather than doubled. */
  entry_id: string | null;
  /** The goal that removed saving had: it keeps it when brought back. */
  entry_goal?: string | null;
}

/**
 * Any transfer into (or out of) a savings account counts as saving: with one
 * active goal it goes to that goal, with several it waits for "Give it
 * to…". Transfers from before the account became savings don't count, nor
 * does money with no rate yet. Savings whose transfer is gone go too.
 */
export function savingsSyncOps(input: {
  transfers: SavingsTransfer[];
  orphans: { id: string }[];
  goals: Pick<GoalRow, "id" | "status">[];
  since: Record<string, number>;
  rates: Rates;
  newId: () => string;
}): Op[] {
  const active = input.goals.filter((goal) => goal.status === "active");
  const goalId = active.length === 1 ? (active[0]?.id ?? null) : null;
  const goals = new Set(input.goals.map((goal) => goal.id));
  const ops: Op[] = input.orphans.map((row) => ({
    op: "delete" as const,
    table: "savings_entries" as const,
    id: row.id,
  }));
  for (const half of input.transfers) {
    if (half.created_at < (input.since[half.account] ?? 0)) continue;
    const minor = toEtb(half.amount_minor, half.currency, input.rates);
    if (minor === null || minor === 0) continue;
    // A saving brought back keeps its goal while that goal is still there.
    const kept = half.entry_goal && goals.has(half.entry_goal) ? half.entry_goal : null;
    const values = {
      goal_id: half.entry_id ? (kept ?? goalId) : goalId,
      occurred_at: half.occurred_at,
      local_date: half.local_date,
      amount_minor: minor,
      note: null,
      origin: "transfer",
      account: half.account,
      transfer_id: half.transfer_id,
    };
    ops.push(
      half.entry_id
        ? { op: "upsert", table: "savings_entries", id: half.entry_id, values }
        : { op: "insert", table: "savings_entries", id: input.newId(), values },
    );
  }
  return ops;
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

// --- Editing a goal and its pace (proposal 1.4) -----------------------------------

export interface GoalEdit {
  title: string;
  target: string;
  /** YYYY-MM-DD or "" for no date. */
  targetDate: string;
}

export function checkGoalEdit(edit: GoalEdit, today: string): string | null {
  const problem = checkGoal(edit);
  if (problem) return problem;
  if (edit.targetDate && !/^\d{4}-\d{2}-\d{2}$/.test(edit.targetDate))
    return "A date like 2027-06-30.";
  if (edit.targetDate && edit.targetDate < today) return "Pick a date from today on.";
  return null;
}

export function goalEditOps(id: string, edit: GoalEdit): Op[] {
  return [
    {
      op: "update",
      table: "savings_goals",
      id,
      values: {
        title: edit.title.trim(),
        target_minor: parseAmount(edit.target.trim()) ?? 0,
        target_date: edit.targetDate || null,
      },
    },
  ];
}

const monthIndex = (date: string) => {
  const [y = 0, m = 1] = date.split("-").map(Number);
  return y * 12 + (m - 1);
};

export interface GoalPace {
  /** Still to save. */
  left: number;
  /** A month to make the date, rounded up to whole birr; null without a date. */
  needPerMonth: number | null;
  /** Saved a month since the goal started, rounded down to whole birr. */
  averagePerMonth: number;
  /** Months counted, this month included. */
  monthsLeft: number | null;
}

/**
 * What a goal takes a month to make its date, against what you have saved a
 * month so far. Calendar months, this one included, so a date this month
 * means "all of it now". Rounded so nothing is overstated.
 */
export function goalPace(goal: GoalRow, today: string): GoalPace {
  const left = Math.max(0, goal.target_minor - Math.max(0, goal.saved_minor));
  const monthsSince = Math.max(1, monthIndex(today) - monthIndex(goal.start_date) + 1);
  const averagePerMonth = Math.floor(Math.max(0, goal.saved_minor) / monthsSince / 100) * 100;
  if (!goal.target_date) return { left, needPerMonth: null, averagePerMonth, monthsLeft: null };
  const monthsLeft = Math.max(1, monthIndex(goal.target_date) - monthIndex(today) + 1);
  const needPerMonth = Math.ceil(left / monthsLeft / 100) * 100;
  return { left, needPerMonth, averagePerMonth, monthsLeft };
}
