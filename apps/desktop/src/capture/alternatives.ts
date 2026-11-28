/**
 * Tab in the capture box cycles through other readings of the same line
 * (plan §3.5: "Tab flips"), so a wrong guess costs one key, not a retype.
 */
import { logicalDate } from "../kernel/dates";
import { formatAmount } from "../kernel/money";
import { type Parsed, readIdea } from "./parse";

const NEXT_WEEKDAY = /\bnext\s+(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/i;
const DAY_MS = 24 * 60 * 60 * 1000;
const dayMs = (date: string) => Date.parse(`${date}T00:00:00Z`);
const daysBetween = (from: string, to: string) => Math.round((dayMs(to) - dayMs(from)) / DAY_MS);
const addDays = (date: string, days: number) =>
  new Date(dayMs(date) + days * DAY_MS).toISOString().slice(0, 10);

/** The parser's reading first, then the other useful kinds, without repeats. */
export function readings(parsed: Parsed, raw: string, nowMs: number): Parsed[] {
  const text = raw
    .trim()
    .replace(/^(t|n|note|idea|pin|wait|fb)\s*:\s*/i, "")
    .replace(/(?:^|\s)#[\p{L}\p{N}_-]+/gu, "")
    .trim();
  const area = "area" in parsed ? parsed.area : undefined;
  const withArea = <T extends Parsed>(value: T): T => (area ? { ...value, area } : value);

  const options: Parsed[] = [parsed];
  if (
    parsed.kind === "search" ||
    parsed.kind === "away" ||
    parsed.kind === "back" ||
    parsed.kind === "city" ||
    parsed.kind === "focus"
  )
    return options;
  // "idea:" with nothing after it: nothing to read another way.
  if (parsed.kind === "inbox" && parsed.body === "") return options;

  const title =
    parsed.kind === "task" ? parsed.title : "description" in parsed ? parsed.description : text;

  if (parsed.kind === "expense") {
    // "buy charger 600" might be a plan, not a purchase. Use the parsed amount,
    // not the first number in the line.
    const amount = formatAmount(parsed.amount, "").trim();
    options.push(withArea({ kind: "task", title: `${parsed.description} ${amount}`.trim() }));
  }
  // An expense already offered its task, amount kept: a second one would look the same.
  if (parsed.kind !== "task" && parsed.kind !== "expense")
    options.push(withArea({ kind: "task", title }));
  if (parsed.kind !== "idea") options.push(withArea(readIdea(text, nowMs)));
  if (parsed.kind !== "note") options.push(withArea({ kind: "note", body: text }));
  if (parsed.kind !== "cheat") options.push(withArea({ kind: "cheat", body: text }));
  // "next fri" said early in the week may mean the Friday after (F82): Tab offers it.
  if (
    parsed.kind === "task" &&
    parsed.dueDate &&
    !parsed.repeat &&
    NEXT_WEEKDAY.test(raw) &&
    daysBetween(logicalDate(nowMs), parsed.dueDate) < 7
  ) {
    const later = addDays(parsed.dueDate, 7);
    options.splice(1, 0, {
      ...parsed,
      dueDate: later,
      ...(parsed.dueAt !== undefined ? { dueAt: parsed.dueAt + 7 * DAY_MS } : {}),
    });
  }
  if (parsed.kind === "task" && !parsed.dueDate) {
    // A someday task can be meant for today.
    options.splice(1, 0, { ...parsed, dueDate: logicalDate(nowMs) });
  }
  return options;
}
