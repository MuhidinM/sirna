/**
 * Savings goals and the plant (plan §3.13; R-PRG-03). Saving is the only
 * money number on the dashboard and is kept apart from spending. The plant
 * grows by share of the goal and never wilts: taking money out only lowers
 * the number. Pure and tested.
 */
import { type Op } from "../../kernel/db";
import { formatAmount, parseAmount, type Santim } from "../../kernel/money";
import {
  type AccountRow,
  ACCOUNTS_SQL,
  balanceOf,
  currencyOf,
  transferOps,
} from "../money/accounts";
import { type Query } from "../projects/capacity";
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
   * account that is still savings). The rest is money put aside inside your
   * spending accounts, including an account set back to spending.
   */
  held_minor?: number;
  /**
   * saved_minor less claims and Check corrections: what was really put aside
   * over time, for the pace. Absent: the same as saved_minor.
   */
  flow_minor?: number;
}

/**
 * Entries that are real saving (money put aside or taken out), not a
 * re-label of money already in a savings account (a claim through "Give it
 * to…") or a correction after a Check (F31, F37). Month and week sums use it.
 */
export const SAVING_FLOW = `(origin IS NULL OR origin NOT IN ('claim', 'reconcile'))`;
const FLOW_E = `(e.origin IS NULL OR e.origin NOT IN ('claim', 'reconcile'))`;

/** An entry is held while its account is a savings account (not once set back to spending). */
const HELD = `e.account IN (SELECT id FROM money_accounts WHERE is_savings = 1)`;

export const GOALS_SQL = `
  SELECT g.id, g.title, g.target_minor, g.start_date, g.status, g.target_date,
         COALESCE((SELECT sum(e.amount_minor) FROM savings_entries e
                   WHERE e.goal_id = g.id AND e.deleted_at IS NULL), 0) AS saved_minor,
         COALESCE((SELECT sum(e.amount_minor) FROM savings_entries e
                   WHERE e.goal_id = g.id AND e.deleted_at IS NULL AND ${HELD}), 0)
           AS held_minor,
         COALESCE((SELECT sum(e.amount_minor) FROM savings_entries e
                   WHERE e.goal_id = g.id AND e.deleted_at IS NULL AND ${FLOW_E}), 0)
           AS flow_minor
  FROM savings_goals g
  WHERE g.deleted_at IS NULL
  ORDER BY g.status = 'done', g.created_at`;

/** Entries waiting for a goal; `held` is the part in a savings account. */
export const UNASSIGNED_SQL = `SELECT COALESCE(sum(amount_minor), 0) AS minor, count(*) AS n,
    COALESCE(sum(CASE WHEN ${HELD} THEN amount_minor END), 0) AS held
  FROM savings_entries e WHERE goal_id IS NULL AND deleted_at IS NULL`;

/**
 * Waiting entries one by one: money put aside (+) waits for a goal to go to;
 * money taken out (−) waits for the goal it came from (F33).
 */
export const WAITING_SQL = `SELECT id, amount_minor FROM savings_entries
  WHERE goal_id IS NULL AND deleted_at IS NULL ORDER BY occurred_at, id`;

/** What each goal holds in each savings account (ETB worth of its entries there). */
export const GOAL_HELD_SQL = `SELECT e.goal_id, e.account, COALESCE(sum(e.amount_minor), 0) AS minor
  FROM savings_entries e
  WHERE e.deleted_at IS NULL AND e.goal_id IS NOT NULL AND ${HELD}
  GROUP BY e.goal_id, e.account`;

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

/**
 * `others`: the goals already there (leave the goal itself out when editing).
 * Two growing goals with one name would leave a capture guessing (F110).
 */
export function checkGoal(
  draft: GoalDraft,
  others: Pick<GoalRow, "title" | "status">[] = [],
): string | null {
  const title = draft.title.trim();
  if (!title) return "Name the goal (Laptop, Emergency fund…).";
  const target = parseAmount(draft.target.trim());
  if (target === null || target <= 0) return "Target: an amount like 100,000.";
  const same = (goal: Pick<GoalRow, "title">) =>
    goal.title.trim().toLowerCase() === title.toLowerCase();
  if (others.some((goal) => goal.status !== "done" && same(goal)))
    return `You already have a goal called ${title}.`;
  return null;
}

/**
 * The waiting entries a new goal takes: savings made while no goal was
 * growing (F34). With goals there, waiting savings stay for "Give it to…".
 */
export function waitingForNewGoal(
  goals: Pick<GoalRow, "status">[],
  waiting: { id: string; amount_minor: number }[],
): { id: string }[] {
  if (goals.some((goal) => goal.status !== "done")) return [];
  return waiting.filter((entry) => entry.amount_minor > 0).map((entry) => ({ id: entry.id }));
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

/**
 * What "Give it to…" hands over, and to which goals (F33): money put aside
 * (+) to any growing goal; money taken out (−) only back to a goal that
 * holds that much, a finished one included, so no goal goes below zero.
 */
export function waitingSplit(
  waiting: { id: string; amount_minor: number }[],
  goals: Pick<GoalRow, "id" | "status" | "saved_minor">[],
): {
  saved: { ids: string[]; minor: Santim; goals: string[] };
  taken: { ids: string[]; minor: Santim; goals: string[] };
} {
  const plus = waiting.filter((entry) => entry.amount_minor > 0);
  const minus = waiting.filter((entry) => entry.amount_minor < 0);
  const taken = -minus.reduce((sum, entry) => sum + entry.amount_minor, 0);
  return {
    saved: {
      ids: plus.map((entry) => entry.id),
      minor: plus.reduce((sum, entry) => sum + entry.amount_minor, 0),
      goals: goals.filter((goal) => goal.status !== "done").map((goal) => goal.id),
    },
    taken: {
      ids: minus.map((entry) => entry.id),
      minor: taken,
      goals: goals.filter((goal) => goal.saved_minor >= taken).map((goal) => goal.id),
    },
  };
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

/**
 * Take out for a goal: only what the goal holds in savings accounts moves
 * back out of the savings account; the rest was put aside inside a spending
 * account (an old saving with no account), so it is a plain negative entry
 * with no transfer. `moved` and `plain` are the goal's ETB value of each.
 */
export function takeOutOps(
  input: Omit<Parameters<typeof moveOps>[0], "goal" | "sign" | "ids"> & {
    goal: Pick<GoalRow, "id" | "held_minor">;
    ids: { entry: string; halves: [string, string]; transfer: string; plain: string };
    /**
     * The most that can leave this savings account for the goal (ETB worth,
     * see takeOutRoom). Without it, all the goal holds in savings accounts.
     */
    available?: Santim;
  },
): { ops: Op[]; moved: Santim; plain: Santim } {
  const worth = input.entryMinor ?? input.amount;
  const room = input.available ?? Number.POSITIVE_INFINITY;
  const moved = Math.max(0, Math.min(worth, input.goal.held_minor ?? 0, room));
  const plain = worth - moved;
  const ops: Op[] = [];
  if (moved > 0) {
    // The account's own amount for the moved part (the same when it is in ETB).
    const amount = moved === worth ? input.amount : Math.round((input.amount * moved) / worth);
    ops.push(...moveOps({ ...input, sign: -1, amount, entryMinor: moved }));
  }
  if (plain > 0)
    ops.push(
      ...entryOps(
        input.goal.id,
        -plain,
        input.nowMs,
        input.date,
        input.ids.plain,
        input.origin ?? "savings",
        input.note ?? null,
      ),
    );
  return { ops, moved, plain };
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

/**
 * The goal a saving with no goal named goes to, by its sign (F32). Money
 * coming out of savings comes from a finished goal that holds it (a reached
 * goal is money you go on to spend); with two such goals it waits for "Give
 * it to…". Otherwise, and for money going in, the only active goal.
 */
export function savingGoal(
  goals: Pick<GoalRow, "id" | "status" | "saved_minor">[],
  minor: number,
): string | null {
  if (minor < 0) {
    const ripe = goals.filter((goal) => goal.status === "done" && goal.saved_minor >= -minor);
    if (ripe.length === 1) return ripe[0]?.id ?? null;
    if (ripe.length > 1) return null;
  }
  return onlyActiveGoal(goals);
}

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
  goals: Pick<GoalRow, "id" | "status" | "saved_minor">[];
  since: Record<string, number>;
  rates: Rates;
  newId: () => string;
}): Op[] {
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
    const goalId = savingGoal(input.goals, minor);
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

/**
 * The most a take-out can move out of one savings account for a goal (ETB
 * worth): what the goal's entries hold there, and never more than the
 * account holds when its balance is known (F9: after a Check found less,
 * a take-out must not push the account below zero).
 */
export function takeOutRoom(
  goalId: string,
  account: AccountRow,
  goalHeld: { goal_id: string; account: string; minor: number }[],
  rates: Rates,
): Santim {
  const here =
    goalHeld.find((row) => row.goal_id === goalId && row.account === account.id)?.minor ?? 0;
  const balance = balanceOf(account);
  const worth = balance === null ? null : toEtb(balance, currencyOf(account), rates);
  return Math.max(0, worth === null ? here : Math.min(here, worth));
}

/**
 * Take out through one savings account: no more than the goal holds, and no
 * more than that account can give plus what the goal has put aside inside
 * spending accounts (that part only lowers the number).
 */
export function checkTakeOutFrom(
  goal: Pick<GoalRow, "saved_minor" | "held_minor">,
  minor: Santim,
  available: Santim,
  accountName: string,
): string | null {
  const tooMuch = checkTakeOut(goal, minor);
  if (tooMuch) return tooMuch;
  const outside = Math.max(0, goal.saved_minor - (goal.held_minor ?? 0));
  if (minor <= available + outside) return null;
  return outside > 0
    ? `At most ${formatAmount(available + outside)}: ${accountName} holds ${formatAmount(available)} of this goal.`
    : `${accountName} holds only ${formatAmount(available)} of this goal.`;
}

export function goalStatusOps(id: string, status: GoalRow["status"]): Op[] {
  return [{ op: "update", table: "savings_goals", id, values: { status } }];
}

/**
 * Which goal a capture means: one whose name contains the word(s) given
 * (`saved 500 laptop`); with no words, the only active goal; else none (the
 * entry waits for a goal). Words that fit no goal never fall back to the only
 * active one: a misspelt or paused name must not move another goal's money.
 * A take-out (`out`) may also name a paused or finished goal.
 */
export function matchGoal(
  goals: Pick<GoalRow, "id" | "title" | "status">[],
  words: string | undefined,
  out = false,
): string | null {
  const active = goals.filter((goal) => goal.status === "active");
  const text = (words ?? "").trim().toLowerCase();
  if (!text) return active.length === 1 ? (active[0]?.id ?? null) : null;
  const fits = (list: typeof goals) => {
    // The exact name first; two goals that fit equally wait for "Give it to…" (F110).
    const exact = list.filter((goal) => goal.title.trim().toLowerCase() === text);
    const within = list.filter((goal) => goal.title.toLowerCase().includes(text));
    const around = list.filter((goal) => text.includes(goal.title.toLowerCase()));
    return [exact, within, around].find((hits) => hits.length > 0);
  };
  const hits =
    fits(active) ?? (out ? fits(goals.filter((goal) => goal.status !== "active")) : undefined);
  return hits?.length === 1 ? (hits[0]?.id ?? null) : null;
}

/** This week's saving, for the Sunday question. ?1 = this Monday, ?2 = next Monday. */
export const WEEK_SAVED_SQL = `SELECT COALESCE(sum(amount_minor), 0) AS minor FROM savings_entries
  WHERE deleted_at IS NULL AND local_date >= ?1 AND local_date < ?2 AND ${SAVING_FLOW}`;

// --- Editing a goal and its pace (proposal 1.4) -----------------------------------

export interface GoalEdit {
  title: string;
  target: string;
  /** YYYY-MM-DD or "" for no date. */
  targetDate: string;
}

export function checkGoalEdit(
  edit: GoalEdit,
  today: string,
  others: Pick<GoalRow, "title" | "status">[] = [],
): string | null {
  const problem = checkGoal(edit, others);
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
  // Money given from what an account already held isn't saving a month (F31).
  const flow = goal.flow_minor ?? goal.saved_minor;
  const averagePerMonth = Math.floor(Math.max(0, flow) / monthsSince / 100) * 100;
  if (!goal.target_date) return { left, needPerMonth: null, averagePerMonth, monthsLeft: null };
  const monthsLeft = Math.max(1, monthIndex(goal.target_date) - monthIndex(today) + 1);
  const needPerMonth = Math.ceil(left / monthsLeft / 100) * 100;
  return { left, needPerMonth, averagePerMonth, monthsLeft };
}

/**
 * What each account's goal entries hold (?: none). Entries are in ETB worth.
 * A removed goal holds nothing: its money is the account's again (F35).
 */
export const HELD_BY_ACCOUNT_SQL = `SELECT account, COALESCE(sum(amount_minor), 0) AS minor
  FROM savings_entries
  WHERE deleted_at IS NULL AND account IS NOT NULL
    AND (goal_id IS NULL OR goal_id IN (SELECT id FROM savings_goals WHERE deleted_at IS NULL))
  GROUP BY account`;

/**
 * Money already in a savings account that no goal holds yet: the balance
 * (in ETB at its rate) less what goal entries in that account hold. Money
 * that was there before the account backed the goals shows up here, so it
 * can be given to a goal without moving it (r2-18).
 */
export function unclaimed(
  accounts: AccountRow[],
  held: { account: string; minor: number }[],
  rates: Rates,
): { account: AccountRow; minor: Santim }[] {
  return accounts.filter(isSavingsAccount).flatMap((account) => {
    if (account.opening_date === null) return [];
    const balance = account.opening_minor + account.moved_minor;
    const currency = account.currency ?? "ETB";
    const worth = currency === "ETB" ? balance : toEtb(balance, currency, rates);
    if (worth === null) return [];
    const minor = worth - (held.find((row) => row.account === account.id)?.minor ?? 0);
    return minor > 0 ? [{ account, minor }] : [];
  });
}

/**
 * The mirror of unclaimed (F37): savings accounts holding less than their
 * goals count on them, after a Check found money gone. `minor` is the gap.
 */
export function overclaimed(
  accounts: AccountRow[],
  held: { account: string; minor: number }[],
  rates: Rates,
): { account: AccountRow; minor: Santim }[] {
  return accounts.filter(isSavingsAccount).flatMap((account) => {
    const balance = balanceOf(account);
    if (balance === null) return [];
    const worth = toEtb(balance, currencyOf(account), rates);
    if (worth === null) return [];
    const minor = (held.find((row) => row.account === account.id)?.minor ?? 0) - worth;
    return minor > 0 ? [{ account, minor }] : [];
  });
}

/**
 * Takes money that is already gone off a goal: a negative entry in the
 * account, no money moves (the Check booked it). Not saving (SAVING_FLOW).
 */
export function writeOffOps(
  goalId: string,
  account: string,
  minor: Santim,
  nowMs: number,
  localDate: string,
  id: string,
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
        amount_minor: -minor,
        note: "Gone from the account",
        origin: "reconcile",
        account,
      },
    },
  ];
}

/**
 * Put aside from anywhere (the week card too, F73): a move from the pay
 * account (or the first spending account) into the first savings account,
 * both in birr, with the goal's entry; only marked when there's no such pair.
 */
export function putAsideOps(input: {
  goalId: string | null;
  amount: Santim;
  accounts: Pick<AccountRow, "id" | "name" | "currency" | "is_savings" | "pays_in">[];
  nowMs: number;
  date: string;
  newId: () => string;
  origin: string;
}): { ops: Op[]; from?: string; to?: string } {
  const birr = input.accounts.filter((account) => currencyOf(account) === "ETB");
  const savings = birr.find(isSavingsAccount);
  const spend = birr.filter((account) => !isSavingsAccount(account));
  const from = spend.find((account) => account.pays_in === 1) ?? spend[0];
  if (!savings || !from)
    return {
      ops: entryOps(
        input.goalId,
        input.amount,
        input.nowMs,
        input.date,
        input.newId(),
        input.origin,
      ),
    };
  const ops = moveOps({
    goal: input.goalId ? { id: input.goalId } : null,
    sign: 1,
    amount: input.amount,
    spend: from,
    savings,
    nowMs: input.nowMs,
    date: input.date,
    ids: {
      entry: input.newId(),
      halves: [input.newId(), input.newId()],
      transfer: input.newId(),
    },
    origin: input.origin,
  });
  return { ops, from: from.name, to: savings.name };
}

const isSavingsAccount = (account: Pick<AccountRow, "is_savings">) => account.is_savings === 1;

/** What the capture box needs to save into or take out of a goal (F8, F32, F36). */
export interface SavingsContext {
  /** Each goal with what each savings account can give it on a take-out. */
  goals: (GoalRow & { room: Record<string, Santim> })[];
  /** ETB worth in each savings account that no goal holds yet. */
  unclaimed: Record<string, Santim>;
  /** The goal money taken out of savings with no goal named comes from. */
  ripe: (minor: number) => string | null;
  /** Savings accounts with no balance set yet (by id): what they hold is unknown. */
  unset: string[];
}

/**
 * The goal a saving goes to or comes from: by the words given, else by the
 * sign of `minor` (see savingGoal). A take-out may name any goal.
 */
export function goalFinder(context: SavingsContext) {
  return (words: string | undefined, minor?: number) => {
    const id =
      words === undefined && minor !== undefined
        ? context.ripe(minor)
        : matchGoal(context.goals, words, (minor ?? 0) < 0);
    return context.goals.find((row) => row.id === id) ?? null;
  };
}

export async function loadSavingsContext(read: Query, rates: Rates): Promise<SavingsContext> {
  const [goals, goalHeld, accounts, held] = await Promise.all([
    read<GoalRow & Record<string, string | number | null>>(GOALS_SQL),
    read<{ goal_id: string; account: string; minor: number }>(GOAL_HELD_SQL),
    read<AccountRow & Record<string, string | number | null>>(ACCOUNTS_SQL),
    read<{ account: string; minor: number }>(HELD_BY_ACCOUNT_SQL),
  ]);
  const savings = accounts.filter(isSavingsAccount);
  return {
    goals: goals.map((goal) => ({
      ...goal,
      room: Object.fromEntries(
        savings.map((account) => [account.id, takeOutRoom(goal.id, account, goalHeld, rates)]),
      ),
    })),
    unclaimed: Object.fromEntries(
      unclaimed(accounts, held, rates).map((row) => [row.account.id, row.minor]),
    ),
    ripe: (minor) => savingGoal(goals, minor),
    unset: savings.filter((account) => account.opening_date === null).map((row) => row.id),
  };
}

/** Gives money already in a savings account to a goal: an entry, no money moves. */
export function claimOps(
  goalId: string,
  account: string,
  minor: Santim,
  nowMs: number,
  localDate: string,
  id: string,
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
        amount_minor: minor,
        note: "Already in the account",
        origin: "claim",
        account,
      },
    },
  ];
}
