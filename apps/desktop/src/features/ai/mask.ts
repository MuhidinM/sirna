/**
 * Money amounts never go to the AI (plan §7.4, R-AI-02, ADR-0014). Before a
 * capture line is sent, each number that could be an amount becomes a token
 * (`lunch 120` → `lunch <a1>`); the reply's titles and spans are put back
 * in code. Numbers that are clearly a time, a date or a length stay, so the
 * model can still copy date words ("by 20 dec", "at 3pm", "~2h").
 */
import { MONTH_NAMES } from "../../capture/when";

export interface Masked {
  /** The line with amounts replaced by `<a1>`, `<a2>`… */
  text: string;
  /** Token → the amount as typed, to restore the reply. */
  amounts: Record<string, string>;
}

const NUMBER = /[$€£]?\d(?:[\d,]*\d)?(?:\.\d+)?k?/giu;
/** After the number: a time, an ordinal, or a length. */
const TIME_AFTER =
  /^(?::\d|\s?(?:am|pm)\b|(?:st|nd|rd|th)\b|\s?(?:h|hrs?|hours?|m|mins?|minutes?|days?|weeks?|months?)\b)/iu;
const MONTH_AFTER = new RegExp(String.raw`^\s(?:${MONTH_NAMES})\b`, "iu");
const MONTH_BEFORE = new RegExp(String.raw`\b(?:${MONTH_NAMES})\s$`, "iu");
/** Before the number: a clock time ("at 3", "by 5"), an estimate (`~2`), or part of an ISO date. */
const TIME_BEFORE = /(?:\b(?:at|by|till|until|from)\s|~|\d-)$/iu;

function isTimeOrDate(text: string, start: number, end: number, token: string): boolean {
  if (/^[$€£]|k$|,/iu.test(token)) return false;
  const before = text.slice(Math.max(0, start - 12), start);
  const after = text.slice(end, end + 12);
  if (/^[-/]\d/u.test(after) || /[-/]$/u.test(before)) return true; // 2026-12-01, 20/12
  if (TIME_AFTER.test(after)) return true;
  const value = Number(token);
  if (value <= 31 && (MONTH_AFTER.test(after) || MONTH_BEFORE.test(before))) return true;
  // "at 3", "by 5": only small numbers read as a clock time.
  return value <= 24 && TIME_BEFORE.test(before);
}

export function maskAmounts(text: string): Masked {
  const amounts: Record<string, string> = {};
  let next = 1;
  const masked = text.replace(NUMBER, (token: string, offset: number) => {
    // Inside a word ("job2", "a1") it isn't an amount.
    if (offset > 0 && /[\p{L}<]/u.test(text[offset - 1] ?? "")) return token;
    if (isTimeOrDate(text, offset, offset + token.length, token)) return token;
    const key = `<a${next++}>`;
    amounts[key] = token;
    return key;
  });
  return { text: masked, amounts };
}

/** Puts the amounts back; tokens the model made up stay as they are (grounding refuses them). */
export function unmask(text: string, amounts: Record<string, string>): string {
  return text.replace(/<a\d+>/g, (token) => amounts[token] ?? token);
}
