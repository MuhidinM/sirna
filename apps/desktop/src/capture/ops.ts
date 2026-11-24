/** Turns a parsed capture into database ops and a one-line echo (plan §3.5). */
import { type Op } from "../kernel/db";
import { localDate, logicalDate } from "../kernel/dates";
import { formatAmount, formatNumber } from "../kernel/money";
import { placeIdea, type Placement } from "../features/projects/idea";
import { PROJECT_STATUSES } from "../features/projects/projects";
import { transferOps } from "../features/money/accounts";
import { fromEtb, type Rates } from "../features/money/currency";
import { ruleText } from "../features/money/regulars";
import { loanEchoText, loanOps } from "../features/money/loans";
import { moveOps, transferSavingOps } from "../features/savings/savings";
import {
  type LoanItem,
  type MoneyItem,
  type MoneyPiece,
  type Parsed,
  type SavingItem,
  type TransferItem,
} from "./parse";
import { weekdayName } from "./when";

export interface OpsContext {
  nowMs: number;
  newId: () => string;
  /** Where an idea lands (features/projects/idea.ts); without it, an unplaced idea. */
  idea?: Placement;
  /** The goal a saving goes to (matched in the capture box); null waits for one. */
  savingGoal?: { id: string; title: string } | null;
  /** The goal each saving on a several-item line goes to, by its words. */
  goalOf?: (words: string | undefined) => { id: string; title: string } | null;
}

/**
 * An open project with the same title, case and spaces aside (F91). Done and
 * dropped ones don't count: starting one again is a new project.
 */
export const SAME_PROJECT_SQL = `SELECT id, status FROM project_items
  WHERE deleted_at IS NULL AND status NOT IN ('done', 'dropped')
    AND lower(trim(title)) = lower(trim(?))
  ORDER BY created_at`;

/** The placement for an idea you already have: nothing is saved, the echo says where it is. */
export function sameProject(placement: Placement, row: { id: string; status: string }): Placement {
  const label = PROJECT_STATUSES.find((entry) => entry.status === row.status)?.label ?? row.status;
  return {
    ...placement,
    existing: row.id,
    echo:
      row.status === "idea"
        ? "Already an idea · see Projects"
        : `Already a project (${label}) · see Projects`,
  };
}

/** Sets `currency` on the money rows of some ops, when it isn't birr. */
function inCurrency(ops: Op[], currency: string | undefined): Op[] {
  if (!currency || currency === "ETB") return ops;
  return ops.map((op) =>
    op.op === "insert" && (op.table === "money_txns" || op.table === "money_loans")
      ? { ...op, values: { ...op.values, currency } }
      : op,
  );
}

const CATEGORY_NAMES: Record<string, string> = {
  cat_food: "Food",
  cat_transport: "Transport",
  cat_housing: "Housing",
  cat_utilities: "Utilities",
  cat_phone: "Phone and internet",
  cat_health: "Health",
  cat_shopping: "Shopping",
  cat_family: "Family and gifts",
  cat_learning: "Learning",
  cat_other: "Other",
  cat_salary: "Salary",
  cat_income: "Other income",
};

function moneyOp(item: MoneyItem, nowMs: number, id: string): Op {
  return {
    op: "insert",
    table: "money_txns",
    id,
    values: {
      occurred_at: nowMs,
      local_date: item.date,
      amount_minor: item.kind === "expense" ? -item.amount : item.amount,
      description: item.description,
      category_id: item.categoryId,
      // Income from a job you named: the Money page groups by it.
      area_id: item.jobId ?? null,
      ...(item.account ? { account: item.account } : {}),
      ...(item.currency && item.currency !== "ETB" ? { currency: item.currency } : {}),
      origin: "capture",
    },
  };
}

/** " · telebirr" when it isn't the usual account (cash for spending). */
const accountOf = (item: MoneyItem) =>
  item.accountName && !(item.kind === "expense" && item.account === "cash")
    ? ` · ${item.accountName}`
    : "";

const categoryOf = (item: MoneyItem) =>
  item.categoryName ?? CATEGORY_NAMES[item.categoryId] ?? "Other";

/** The project an idea capture becomes, before its week is known. */
export function ideaInput(parsed: Extract<Parsed, { kind: "idea" }>) {
  return {
    title: parsed.title ?? parsed.body,
    ...(parsed.area ? { area: parsed.area } : {}),
    ...(parsed.estimateMin ? { estimateMin: parsed.estimateMin } : {}),
    ...(parsed.deadline ? { deadline: parsed.deadline } : {}),
  };
}

function loanPieceOps(parsed: LoanItem, nowMs: number, newId: () => string): Op[] {
  return inCurrency(
    loanOps({
      person: parsed.person,
      kind: parsed.loanKind,
      amount: parsed.amount,
      date: parsed.date,
      account: parsed.account ?? "cash",
      nowMs,
      id: newId(),
      txnId: newId(),
    }),
    parsed.currency,
  );
}

/**
 * Each half in its own account's currency: between two currencies the
 * to-half is what the parser worked out at the rate. Into or out of a
 * savings account, the saving is written in the same transaction (time-first
 * §4), to the only active goal or waiting for one.
 */
function transferPieceOps(parsed: TransferItem, context: OpsContext): Op[] {
  const { nowMs, newId } = context;
  const transferId = newId();
  const ops = transferOps({
    from: { id: parsed.from, name: parsed.fromName, currency: parsed.currency ?? "ETB" },
    to: {
      id: parsed.to,
      name: parsed.toName,
      currency: parsed.toCurrency ?? parsed.currency ?? "ETB",
    },
    amount: parsed.amount,
    ...(parsed.received !== undefined ? { received: parsed.received } : {}),
    date: parsed.date,
    nowMs,
    ids: [newId(), newId()],
    transferId,
    origin: "capture",
  }).map((op) => withoutBirr(op));
  if (!parsed.saving) return ops;
  return [
    ...ops,
    ...transferSavingOps({
      saving: parsed.saving,
      goalId: context.goalOf?.(undefined)?.id ?? null,
      transferId,
      nowMs,
      date: parsed.date,
      id: newId(),
      origin: "capture",
    }),
  ];
}

/** Birr is the column's default: left unmarked, like every other capture. */
function withoutBirr(op: Op): Op {
  if (op.op !== "insert" || op.values.currency !== "ETB") return op;
  const { currency: _birr, ...values } = op.values;
  return { ...op, values };
}

/**
 * `saved 500 laptop` is Put aside: a transfer into the savings account and
 * the goal's entry tied to it. With no savings account in that currency,
 * only the entry (worth its birr), as before.
 */
function savingOps(
  parsed: SavingItem,
  nowMs: number,
  newId: () => string,
  goal: { id: string; title: string } | null | undefined,
): Op[] {
  const date = logicalDate(nowMs);
  const worth = parsed.worth ?? parsed.amount;
  if (parsed.spend && parsed.savings) {
    const currency = parsed.currency ?? "ETB";
    return moveOps({
      goal: goal ?? null,
      sign: parsed.amount < 0 ? -1 : 1,
      amount: Math.abs(parsed.amount),
      spend: { ...parsed.spend, currency },
      savings: { ...parsed.savings, currency },
      nowMs,
      date,
      ids: { entry: newId(), halves: [newId(), newId()], transfer: newId() },
      entryMinor: Math.abs(worth),
      origin: "capture",
      note: parsed.goal ?? null,
    }).map((op) => withoutBirr(op));
  }
  return [
    {
      op: "insert",
      table: "savings_entries",
      id: newId(),
      values: {
        goal_id: goal?.id ?? null,
        occurred_at: nowMs,
        local_date: date,
        amount_minor: worth,
        note: parsed.goal ?? null,
        origin: "capture",
      },
    },
  ];
}

function pieceOps(piece: MoneyPiece, context: OpsContext): Op[] {
  const { nowMs, newId, goalOf } = context;
  switch (piece.kind) {
    case "expense":
    case "income":
      return [moneyOp(piece, nowMs, newId())];
    case "loan":
      return loanPieceOps(piece, nowMs, newId);
    case "transfer":
      return transferPieceOps(piece, context);
    case "saving":
      return savingOps(piece, nowMs, newId, goalOf ? goalOf(piece.goal) : null);
  }
}

export function toOps(parsed: Parsed, context: OpsContext): Op[] {
  const { nowMs, newId, idea, savingGoal } = context;
  switch (parsed.kind) {
    case "task":
      return [
        {
          op: "insert",
          table: "task_items",
          id: newId(),
          values: {
            title: parsed.title,
            // An undated task with an estimate is meant to be done soon: the day
            // planner fits it into free slots. Without either, it waits as someday.
            status: parsed.waitingOn
              ? "waiting"
              : parsed.dueDate || parsed.estimateMin
                ? "todo"
                : "someday",
            due_date: parsed.dueDate ?? null,
            due_at: parsed.dueAt ?? null,
            remind_at: parsed.dueAt ?? null,
            estimate_min: parsed.estimateMin ?? null,
            area_id: parsed.area ?? null,
            waiting_on: parsed.waitingOn ?? null,
            follow_up_date: parsed.waitingOn ? (parsed.dueDate ?? null) : null,
            repeat_json: parsed.repeat ? JSON.stringify(parsed.repeat) : null,
            // `tomorrow morning`: the day planner places it in that part of the day.
            ...(parsed.plannedWindow
              ? { planned_window: parsed.plannedWindow, planned_date: parsed.dueDate ?? null }
              : {}),
            origin: "capture",
          },
        },
      ];
    case "expense":
    case "income":
      return [moneyOp(parsed, nowMs, newId())];
    case "money":
      return parsed.items.flatMap((item) => pieceOps(item, context));
    case "afford":
      // A question: the line is kept as typed, nothing else is written.
      return [];
    case "loan":
      return loanPieceOps(parsed, nowMs, newId);
    case "transfer":
      return transferPieceOps(parsed, context);
    case "idea":
      // Already a project with this title: the line is kept, no second project (F91).
      if (idea?.existing) return [];
      return [
        {
          op: "insert",
          table: "project_items",
          id: newId(),
          values: (idea ?? placeIdea(ideaInput(parsed), null)).values,
        },
      ];
    case "note":
    case "feedback":
    case "inbox":
    case "cheat":
      return [
        {
          op: "insert",
          table: "note_items",
          id: newId(),
          values: {
            kind: parsed.kind,
            status: parsed.kind === "inbox" ? "inbox" : "kept",
            body: parsed.body,
            area_id: "area" in parsed ? (parsed.area ?? null) : null,
            origin: "capture",
          },
        },
      ];
    case "saving":
      return savingOps(parsed, nowMs, newId, savingGoal);
    case "search":
    case "away":
    case "focus":
      return [];
  }
}

function dayLabel(date: string, nowMs: number): string {
  const today = logicalDate(nowMs);
  if (date === today) return "Today";
  const tomorrow = logicalDate(nowMs + 24 * 60 * 60 * 1000);
  if (date === tomorrow) return "Tomorrow";
  if (date === logicalDate(nowMs - 24 * 60 * 60 * 1000)) return "Yesterday";
  const [, month = "", day = ""] = date.split("-");
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${weekdayName(date)} ${Number(day)} ${months[Number(month) - 1] ?? ""}`;
}

function timeLabel(epochMs: number): string {
  // Local Addis time, 24-hour (plan §3.5: the chip always shows a 24-hour time).
  const local = new Date(epochMs + 3 * 60 * 60 * 1000);
  return `${String(local.getUTCHours()).padStart(2, "0")}:${String(local.getUTCMinutes()).padStart(2, "0")}`;
}

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** An amount on a list: bare for birr (`1,500`), with its sign otherwise (`$200`). */
const listAmount = (amount: number, currency: string | undefined) =>
  currency && currency !== "ETB" ? formatAmount(amount, currency) : formatNumber(amount);

/** " (26,500 ETB at 132.50)" when the halves of a transfer are in two currencies. */
const arrived = (piece: TransferItem) =>
  piece.received !== undefined && piece.toCurrency
    ? ` (${formatAmount(piece.received, piece.toCurrency)}${piece.at ? ` ${piece.at}` : ""})`
    : "";

/** " · counts as saving" / " · taken from savings" for a transfer into or out of one. */
const savingNote = (piece: TransferItem) =>
  piece.saving ? (piece.saving.minor > 0 ? " · counts as saving" : " · taken from savings") : "";

/** " (telebirr)" after a piece when it isn't the usual account, as accountOf (F109). */
const pieceAccount = (item: MoneyItem) =>
  item.accountName && !(item.kind === "expense" && item.account === "cash")
    ? ` (${item.accountName})`
    : "";

/** " · Yesterday" when money is booked on another day than today (F79). */
const bookedOn = (item: MoneyItem, nowMs: number) =>
  item.date && item.date !== logicalDate(nowMs) ? ` · ${dayLabel(item.date, nowMs)}` : "";

/** One record of a several-item line, short: `lunch 120`, `lent Abel 1,500`. */
export function pieceText(piece: MoneyPiece): string {
  switch (piece.kind) {
    case "expense":
      return `${piece.description} ${listAmount(piece.amount, piece.currency)}${pieceAccount(piece)}`;
    case "income":
      return `+${listAmount(piece.amount, piece.currency)} ${piece.description}${pieceAccount(piece)}`;
    case "saving":
      return `${piece.amount > 0 ? "saved" : "took out"} ${listAmount(Math.abs(piece.amount), piece.currency)}${piece.goal ? ` ${piece.goal}` : ""}${piece.unbacked ? ` (${piece.unbacked}, money stays put)` : ""}`;
    case "transfer":
      return `moved ${listAmount(piece.amount, piece.currency)} ${piece.fromName} → ${piece.toName}${arrived(piece)}`;
    case "loan": {
      const amount = listAmount(piece.amount, piece.currency);
      switch (piece.loanKind) {
        case "lent":
          return `lent ${piece.person} ${amount}`;
        case "borrowed":
          return `borrowed ${amount} from ${piece.person}`;
        case "paid_me":
          return `${piece.person} paid back ${amount}`;
        case "i_paid":
          return `paid back ${piece.person} ${amount}`;
      }
    }
  }
}

/** The afford answer's colour (time-first §2): Fine green, Tight yellow, Not now pink. */
export type AffordState = "fine" | "tight" | "notnow";

export function affordState(answer: string): AffordState | undefined {
  if (answer.startsWith("Fine")) return "fine";
  if (answer.startsWith("Tight")) return "tight";
  if (answer.startsWith("Not now")) return "notnow";
  return undefined;
}

/**
 * `groceries 1200 @wise` with $300 in Wise: the number went in as dollars,
 * more than the account holds, so the chip says so and what 1,200 birr would
 * be. Only a hint: the line still saves as typed.
 */
export function balanceNote(
  parsed: Parsed,
  balances: Record<string, number | null>,
  rates: Rates,
): string {
  if (parsed.kind !== "expense" || !parsed.bare || !parsed.account || !parsed.currency) return "";
  const balance = balances[parsed.account];
  if (balance === null || balance === undefined || parsed.amount <= balance) return "";
  const held = ` · only ${formatAmount(balance, parsed.currency)} there`;
  const birr = fromEtb(parsed.amount, parsed.currency, rates);
  return birr === null
    ? held
    : `${held}; ${formatNumber(parsed.amount)} birr would be ≈ ${formatAmount(birr, parsed.currency)}`;
}

/** "tomorrow" mid-line; a dated day ("Fri 27 Nov") keeps its capitals. */
const midLine = (label: string) =>
  label === "Today" || label === "Tomorrow" || label === "Yesterday" ? label.toLowerCase() : label;

/** The short confirmation shown in the capture box. */
export function echo(
  parsed: Parsed,
  nowMs: number,
  idea?: Placement,
  savingGoal?: { id: string; title: string } | null,
  /** Whether you have an active savings goal: "no goal yet" or "no goal named" (F76). */
  goals: { hasGoals?: boolean } = {},
): string {
  const area = "area" in parsed && parsed.area ? ` · #${parsed.area}` : "";
  switch (parsed.kind) {
    case "task": {
      if (parsed.waitingOn) {
        const follow = parsed.dueDate ? ` · follow up ${dayLabel(parsed.dueDate, nowMs)}` : "";
        return `Waiting on ${parsed.waitingOn}${follow}${area}`;
      }
      // "Today 15:00–16:00" when it has a time and a length; "Tomorrow morning".
      const span =
        parsed.dueAt !== undefined && parsed.estimateMin
          ? ` ${timeLabel(parsed.dueAt)}–${timeLabel(parsed.dueAt + parsed.estimateMin * 60_000)}`
          : parsed.dueAt !== undefined
            ? ` ${timeLabel(parsed.dueAt)}`
            : parsed.plannedWindow
              ? ` ${parsed.plannedWindow}`
              : "";
      // "tonight" typed after midnight is the calendar evening: say Tonight, not Tomorrow.
      const tonight =
        parsed.plannedWindow === "evening" &&
        parsed.dueAt === undefined &&
        parsed.dueDate === localDate(nowMs) &&
        parsed.dueDate !== logicalDate(nowMs);
      const when = tonight
        ? " · Tonight"
        : parsed.dueDate
          ? ` · ${dayLabel(parsed.dueDate, nowMs)}${span}`
          : parsed.estimateMin
            ? " · planned into free time"
            : " · Someday";
      const size =
        parsed.estimateMin && parsed.dueAt === undefined
          ? parsed.estimateMin < 60
            ? ` · ~${parsed.estimateMin} min`
            : ` · ~${Math.round((parsed.estimateMin / 60) * 10) / 10} h`
          : "";
      const repeat = parsed.repeat ? ` · ${ruleText(parsed.repeat)}` : "";
      return `Task${when}${repeat}${size}${area}`;
    }
    case "transfer":
      return `Moved ${formatAmount(parsed.amount, parsed.currency)} · ${parsed.fromName} → ${parsed.toName}${arrived(parsed)}${savingNote(parsed)}`;
    case "afford":
      return "Checking…";
    case "loan": {
      const text = parsed.currency
        ? capitalise(pieceText(parsed))
        : loanEchoText(parsed.loanKind, parsed.person, parsed.amount, null);
      return `${text}${parsed.accountName && parsed.account !== "cash" ? ` · ${parsed.accountName}` : ""}`;
    }
    // No `#area` here: a money line doesn't save one, so the echo doesn't claim it (F78).
    case "expense":
      return `${formatAmount(parsed.amount, parsed.currency)} · ${categoryOf(parsed)}${bookedOn(parsed, nowMs)}${accountOf(parsed)}`;
    case "income":
      return `Income · ${formatAmount(parsed.amount, parsed.currency)} · ${parsed.jobName ?? categoryOf(parsed)}${bookedOn(parsed, nowMs)}${accountOf(parsed)}`;
    case "money": {
      // Birr spending adds up; other currencies are listed with their sign.
      const out = parsed.items.filter(
        (item): item is MoneyItem => item.kind === "expense" && (item.currency ?? "ETB") === "ETB",
      );
      const total = out.reduce((sum, item) => sum + item.amount, 0);
      const parts = parsed.items.map(pieceText);
      return `${parsed.items.length} entries · ${parts.join(", ")}${out.length ? ` · ${formatAmount(total)} out` : ""}`;
    }
    case "note":
      return `Note${area}`;
    case "idea":
      return idea ? `${idea.echo}${area}` : `Idea${area}`;
    case "cheat":
      return `Pinned to cheat sheet${area}`;
    case "feedback":
      return "Feedback noted";
    case "inbox":
      // "Inbox", not "Saved": after `saved 300 car` that read as money saved (F76).
      return parsed.why ?? "Inbox · will ask tonight";
    case "search":
      return `Search: ${parsed.query}`;
    case "away":
      // With no day, set_away keeps you away until tomorrow (F41).
      return `Away until ${midLine(parsed.until ? dayLabel(parsed.until, nowMs) : "Tomorrow")}`;
    case "focus":
      return "Focus";
    case "saving": {
      const what = parsed.amount > 0 ? "Saved" : "Took out";
      const where = savingGoal
        ? ` · ${savingGoal.title}`
        : savingGoal === null
          ? goals.hasGoals
            ? " · no goal named: give it one on the Dashboard"
            : " · no goal yet: add one on the Dashboard"
          : "";
      const moved =
        parsed.spend && parsed.savings
          ? parsed.amount > 0
            ? ` · ${parsed.spend.name} → ${parsed.savings.name}`
            : ` · ${parsed.savings.name} → ${parsed.spend.name}`
          : parsed.unbacked
            ? ` · ${parsed.unbacked}, so the money stays where it is`
            : "";
      return `${what} ${formatAmount(Math.abs(parsed.amount), parsed.currency)}${where}${moved}`;
    }
  }
}
