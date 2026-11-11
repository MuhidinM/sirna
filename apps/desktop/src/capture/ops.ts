/** Turns a parsed capture into database ops and a one-line echo (plan §3.5). */
import { type Op } from "../kernel/db";
import { logicalDate } from "../kernel/dates";
import { formatAmount } from "../kernel/money";
import { type Parsed } from "./parse";
import { weekdayName } from "./when";

export interface OpsContext {
  nowMs: number;
  newId: () => string;
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

export function toOps(parsed: Parsed, { nowMs, newId }: OpsContext): Op[] {
  switch (parsed.kind) {
    case "task":
      return [
        {
          op: "insert",
          table: "task_items",
          id: newId(),
          values: {
            title: parsed.title,
            status:
              parsed.dueDate || parsed.waitingOn
                ? parsed.waitingOn
                  ? "waiting"
                  : "todo"
                : "someday",
            due_date: parsed.dueDate ?? null,
            due_at: parsed.dueAt ?? null,
            remind_at: parsed.dueAt ?? null,
            area_id: parsed.area ?? null,
            waiting_on: parsed.waitingOn ?? null,
            follow_up_date: parsed.waitingOn ? (parsed.dueDate ?? null) : null,
            origin: "capture",
          },
        },
      ];
    case "expense":
    case "income":
      return [
        {
          op: "insert",
          table: "money_txns",
          id: newId(),
          values: {
            occurred_at: nowMs,
            local_date: parsed.date,
            amount_minor: parsed.kind === "expense" ? -parsed.amount : parsed.amount,
            description: parsed.description,
            category_id: parsed.categoryId,
            origin: "capture",
          },
        },
      ];
    case "note":
    case "idea":
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
export function echo(parsed: Parsed, nowMs: number): string {
  const area = "area" in parsed && parsed.area ? ` · #${parsed.area}` : "";
  switch (parsed.kind) {
    case "task": {
      if (parsed.waitingOn) {
        const follow = parsed.dueDate ? ` · follow up ${dayLabel(parsed.dueDate, nowMs)}` : "";
        return `Waiting on ${parsed.waitingOn}${follow}${area}`;
      }
      const when = parsed.dueDate
        ? ` · ${dayLabel(parsed.dueDate, nowMs)}${parsed.dueAt ? ` ${timeLabel(parsed.dueAt)}` : ""}`
        : " · Someday";
      return `Task${when}${area}`;
    }
    case "expense":
      return `${formatAmount(parsed.amount)} · ${CATEGORY_NAMES[parsed.categoryId] ?? "Other"}${area}`;
    case "income":
      return `Income ${formatAmount(parsed.amount)}${area}`;
    case "note":
      return `Note${area}`;
    case "idea":
      return `Idea${area}`;
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
  }
}
