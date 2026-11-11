/**
 * Tab in the capture box cycles through other readings of the same line
 * (plan §3.5: "Tab flips"), so a wrong guess costs one key, not a retype.
 */
import { logicalDate } from "../kernel/dates";
import { formatAmount } from "../kernel/money";
import { type Parsed, readIdea } from "./parse";

/** The parser's reading first, then the other useful kinds, without repeats. */
export function readings(parsed: Parsed, raw: string, nowMs: number): Parsed[] {
  const text = raw
    .trim()
    .replace(/^(t|n|idea|pin|wait|fb)\s*:\s*/i, "")
    .replace(/(?:^|\s)#[\p{L}\p{N}_-]+/gu, "")
    .trim();
  const area = "area" in parsed ? parsed.area : undefined;
  const withArea = <T extends Parsed>(value: T): T => (area ? { ...value, area } : value);

  const options: Parsed[] = [parsed];
  if (parsed.kind === "search" || parsed.kind === "away" || parsed.kind === "focus") return options;

  const title =
    parsed.kind === "task" ? parsed.title : "description" in parsed ? parsed.description : text;

  if (parsed.kind === "expense") {
    // "buy charger 600" might be a plan, not a purchase. Use the parsed amount,
    // not the first number in the line.
    const amount = formatAmount(parsed.amount, "").trim();
    options.push(withArea({ kind: "task", title: `${parsed.description} ${amount}`.trim() }));
  }
  if (parsed.kind !== "task") options.push(withArea({ kind: "task", title }));
  if (parsed.kind !== "idea") options.push(withArea(readIdea(text, nowMs)));
  if (parsed.kind !== "note") options.push(withArea({ kind: "note", body: text }));
  if (parsed.kind !== "cheat") options.push(withArea({ kind: "cheat", body: text }));
  if (parsed.kind === "task" && !parsed.dueDate) {
    // A someday task can be meant for today.
    options.splice(1, 0, { ...parsed, dueDate: logicalDate(nowMs) });
  }
  return options;
}
