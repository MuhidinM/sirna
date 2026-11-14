/** Turns a parsed capture into database ops and a one-line echo (plan §3.5). */
import { type Op } from "../kernel/db";
import { logicalDate } from "../kernel/dates";
import { formatAmount } from "../kernel/money";
import { placeIdea, type Placement } from "../features/projects/idea";
import { type MoneyItem, type Parsed } from "./parse";
import { weekdayName } from "./when";

export interface OpsContext {
  nowMs: number;
  newId: () => string;
  /** Where an idea lands (features/projects/idea.ts); without it, an unplaced idea. */
  idea?: Placement;
  /** The goal a saving goes to (matched in the capture box); null waits for one. */
  savingGoal?: { id: string; title: string } | null;
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
      origin: "capture",
    },
  };
}

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

export function toOps(parsed: Parsed, { nowMs, newId, idea, savingGoal }: OpsContext): Op[] {
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
            origin: "capture",
          },
        },
      ];
    case "expense":
    case "income":
      return [moneyOp(parsed, nowMs, newId())];
    case "money":
      return parsed.items.map((item) => moneyOp(item, nowMs, newId()));
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
      return [
        {
          op: "insert",
          table: "savings_entries",
          id: newId(),
          values: {
            goal_id: savingGoal?.id ?? null,
            occurred_at: nowMs,
            local_date: logicalDate(nowMs),
            amount_minor: parsed.amount,
            note: parsed.goal ?? null,
            origin: "capture",
          },
        },
      ];
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
      const when = parsed.dueDate
        ? ` · ${dayLabel(parsed.dueDate, nowMs)}${parsed.dueAt ? ` ${timeLabel(parsed.dueAt)}` : ""}`
        : parsed.estimateMin
          ? " · planned into free time"
          : " · Someday";
      const size = parsed.estimateMin
        ? ` · ~${Math.round((parsed.estimateMin / 60) * 10) / 10} h`
        : "";
      return `Task${when}${size}${area}`;
    }
    case "expense":
      return `${formatAmount(parsed.amount)} · ${categoryOf(parsed)}${area}`;
    case "income":
      return `Income · ${formatAmount(parsed.amount)} · ${parsed.jobName ?? categoryOf(parsed)}${area}`;
    case "money": {
      const out = parsed.items.filter((item) => item.kind === "expense");
      const total = out.reduce((sum, item) => sum + item.amount, 0);
      const parts = parsed.items.map(
        (item) => `${item.description} ${formatAmount(item.amount, "").trim()}`,
      );
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
