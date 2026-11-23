/** Turns a parsed capture into database ops and a one-line echo (plan §3.5). */
import { type Op } from "../kernel/db";
import { logicalDate } from "../kernel/dates";
import { formatAmount, formatNumber } from "../kernel/money";
import { placeIdea, type Placement } from "../features/projects/idea";
import { transferOps } from "../features/money/accounts";
import { ruleText } from "../features/money/regulars";
import { loanEchoText, loanOps } from "../features/money/loans";
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

function transferPieceOps(parsed: TransferItem, nowMs: number, newId: () => string): Op[] {
  return inCurrency(
    transferOps({
      from: { id: parsed.from, name: parsed.fromName },
      to: { id: parsed.to, name: parsed.toName },
      amount: parsed.amount,
      date: parsed.date,
      nowMs,
      ids: [newId(), newId()],
      transferId: newId(),
      origin: "capture",
    }),
    parsed.currency,
  );
}

function savingOp(
  parsed: SavingItem,
  nowMs: number,
  id: string,
  goal: { id: string; title: string } | null | undefined,
): Op {
  return {
    op: "insert",
    table: "savings_entries",
    id,
    values: {
      goal_id: goal?.id ?? null,
      occurred_at: nowMs,
      local_date: logicalDate(nowMs),
      amount_minor: parsed.amount,
      note: parsed.goal ?? null,
      origin: "capture",
    },
  };
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
      return transferPieceOps(piece, nowMs, newId);
    case "saving":
      return [savingOp(piece, nowMs, newId(), goalOf ? goalOf(piece.goal) : null)];
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
      return transferPieceOps(parsed, nowMs, newId);
    case "idea":
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
      return [savingOp(parsed, nowMs, newId(), savingGoal)];
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

/** One record of a several-item line, short: `lunch 120`, `lent Abel 1,500`. */
export function pieceText(piece: MoneyPiece): string {
  switch (piece.kind) {
    case "expense":
      return `${piece.description} ${listAmount(piece.amount, piece.currency)}`;
    case "income":
      return `+${listAmount(piece.amount, piece.currency)} ${piece.description}`;
    case "saving":
      return `${piece.amount > 0 ? "saved" : "took out"} ${listAmount(Math.abs(piece.amount), undefined)}${piece.goal ? ` ${piece.goal}` : ""}`;
    case "transfer":
      return `moved ${listAmount(piece.amount, piece.currency)} ${piece.fromName} → ${piece.toName}`;
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

/** The short confirmation shown in the capture box. */
export function echo(
  parsed: Parsed,
  nowMs: number,
  idea?: Placement,
  savingGoal?: { id: string; title: string } | null,
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
      const when = parsed.dueDate
        ? ` · ${dayLabel(parsed.dueDate, nowMs)}${span}`
        : parsed.estimateMin
          ? " · planned into free time"
          : " · Someday";
      const size =
        parsed.estimateMin && parsed.dueAt === undefined
          ? ` · ~${Math.round((parsed.estimateMin / 60) * 10) / 10} h`
          : "";
      const repeat = parsed.repeat ? ` · ${ruleText(parsed.repeat)}` : "";
      return `Task${when}${repeat}${size}${area}`;
    }
    case "transfer":
      return `Moved ${formatAmount(parsed.amount, parsed.currency)} · ${parsed.fromName} → ${parsed.toName}`;
    case "afford":
      return "Checking…";
    case "loan": {
      const text = parsed.currency
        ? capitalise(pieceText(parsed))
        : loanEchoText(parsed.loanKind, parsed.person, parsed.amount, null);
      return `${text}${parsed.accountName && parsed.account !== "cash" ? ` · ${parsed.accountName}` : ""}`;
    }
    case "expense":
      return `${formatAmount(parsed.amount, parsed.currency)} · ${categoryOf(parsed)}${accountOf(parsed)}${area}`;
    case "income":
      return `Income · ${formatAmount(parsed.amount, parsed.currency)} · ${parsed.jobName ?? categoryOf(parsed)}${accountOf(parsed)}${area}`;
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
      return "Saved · will ask tonight";
    case "search":
      return `Search: ${parsed.query}`;
    case "away":
      return parsed.until ? `Away until ${dayLabel(parsed.until, nowMs)}` : "Away";
    case "focus":
      return "Focus";
    case "saving": {
      const what = parsed.amount > 0 ? "Saved" : "Took out";
      const where = savingGoal
        ? ` · ${savingGoal.title}`
        : savingGoal === null
          ? " · no goal yet: add one on the Dashboard"
          : "";
      return `${what} ${formatAmount(Math.abs(parsed.amount))}${where}`;
    }
  }
}
