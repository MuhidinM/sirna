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
/** After the number: a time, an ordinal, or a length. A bare `m` is read apart (see below). */
const TIME_AFTER =
  /^(?::\d|\s?(?:am|pm)\b|(?:st|nd|rd|th)\b|\s?(?:h|hrs?|hours?|mins?|minutes?|days?|weeks?|months?)\b)/iu;
/** `90m` is minutes; `120m for laptop` may be money, so a bigger number stays masked. */
const MINUTES_AFTER = /^\s?m\b/iu;
const MAX_BARE_MINUTES = 90;
/** Birr after the number: always an amount, whatever comes before it. */
const MONEY_AFTER = /^\s?(?:ብር|birr\b|br\b)/iu;
/** Amharic clock words around the number: `ከጠዋቱ 3`, `ማታ 2`, `3 ሰዓት`. */
const ETHIOPIC_TIME_BEFORE = /(?:ከጠዋቱ|ከሰዓት|ከሰአት|በኋላ|ከምሽቱ|ከሌሊቱ|ከቀኑ|ማታ|ጠዋት|ምሽት|ሌሊት)\s?$/u;
const ETHIOPIC_TIME_AFTER = /^\s?(?:ሰዓት|ሰአት)/u;
const MONTH_AFTER = new RegExp(String.raw`^\s(?:${MONTH_NAMES})\b`, "iu");
const MONTH_BEFORE = new RegExp(String.raw`\b(?:${MONTH_NAMES})\s$`, "iu");
/** Before the number: a clock time ("at 3", "by 5"), an estimate (`~2`), or part of an ISO date. */
const TIME_BEFORE = /(?:\b(?:at|by|till|until|from)\s|~|\d-)$/iu;

function isTimeOrDate(text: string, start: number, end: number, token: string): boolean {
  if (/^[$€£]|k$|,/iu.test(token)) return false;
  const before = text.slice(Math.max(0, start - 12), start);
  const after = text.slice(end, end + 12);
  if (MONEY_AFTER.test(after)) return false;
  if (/^[-/]\d/u.test(after) || /[-/]$/u.test(before)) return true; // 2026-12-01, 20/12
  if (TIME_AFTER.test(after)) return true;
  const value = Number(token);
  if (MINUTES_AFTER.test(after)) return value <= MAX_BARE_MINUTES;
  // `ከጠዋቱ 3`, `3 ሰዓት`: an hour on either clock.
  if (value <= 24 && (ETHIOPIC_TIME_BEFORE.test(before) || ETHIOPIC_TIME_AFTER.test(after)))
    return true;
  if (value <= 31 && (MONTH_AFTER.test(after) || MONTH_BEFORE.test(before))) return true;
  // "at 3", "by 5": only small numbers read as a clock time.
  return value <= 24 && TIME_BEFORE.test(before);
}

/**
 * Part of a word, not an amount: Latin letters on both sides (`mp3s`, `b2b`),
 * or a short id (`a1`, `job2`, the `<a1>` tokens themselves). An amount stuck
 * to its word (`lunch120`, `ምሳ120`) is still an amount.
 */
function inWord(text: string, start: number, end: number): boolean {
  const word = /\p{L}+$/u.exec(text.slice(0, start))?.[0];
  if (!word) return false;
  if (/^(?:[a-z]|job)$/iu.test(word)) return true;
  return /^[a-z]+$/iu.test(word) && /^[a-z]/iu.test(text.slice(end, end + 1));
}

export function maskAmounts(text: string): Masked {
  const amounts: Record<string, string> = {};
  let next = 1;
  const masked = text.replace(NUMBER, (token: string, offset: number) => {
    if (inWord(text, offset, offset + token.length)) return token;
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
