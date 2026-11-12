/**
 * The capture parser (plan §3.5): one typed line becomes a task, an expense,
 * an idea, a cheat-sheet line… Deterministic; the AI fallback comes in M4.
 * The live chip and the save use this same function.
 */
import { logicalDate } from "../kernel/dates";
import { parseAmount, type Santim } from "../kernel/money";
import { type ClockStyle, localToEpoch, readWhen } from "./when";

export const PARSER_ID = "capture@1";

export type Parsed =
  | {
      kind: "task";
      title: string;
      /** `~3h`: how long it takes, so the day plan can give it more than one block. */
      estimateMin?: number;
      dueDate?: string;
      dueAt?: number;
      area?: string;
      waitingOn?: string;
    }
  | {
      kind: "expense" | "income";
      description: string;
      amount: Santim;
      categoryId: string;
      date: string;
      area?: string;
    }
  | { kind: "note" | "feedback" | "inbox"; body: string; area?: string }
  | {
      kind: "idea";
      body: string;
      area?: string;
      /** The name without the estimate and date words, when they were there. */
      title?: string;
      /** `by 20 dec` */
      deadline?: string;
      /** `~18h`, `18 hours` */
      estimateMin?: number;
    }
  | { kind: "cheat"; body: string; area?: string }
  | { kind: "search"; query: string }
  | { kind: "away"; until?: string }
  | { kind: "focus" };

export interface ParseOptions {
  nowMs: number;
  clockStyle?: ClockStyle;
}

/** Verbs that make an undated line a task rather than a loose note. */
const TASK_VERBS = new Set([
  "call",
  "email",
  "mail",
  "text",
  "message",
  "buy",
  "send",
  "book",
  "fix",
  "pay",
  "finish",
  "write",
  "read",
  "review",
  "submit",
  "apply",
  "update",
  "prepare",
  "check",
  "clean",
  "cancel",
  "renew",
  "order",
  "pick",
  "collect",
  "meet",
  "visit",
  "learn",
  "practice",
  "practise",
  "study",
  "ask",
  "reply",
  "follow",
  "start",
  "plan",
  "go",
  "get",
  "make",
  "print",
  "sign",
  "register",
  "return",
  "schedule",
  "deploy",
  "push",
  "test",
  "build",
  "design",
  "refactor",
  "install",
  "upload",
]);

const SPENT_WORDS = /^(?:paid|spent|bought|spend)\s+/i;
const PAY_WORD = /^pay\s+/i;

/** Keyword → category id (seeded in 0005_money.sql). */
const CATEGORY_WORDS: [RegExp, string][] = [
  [
    /\b(lunch|dinner|breakfast|coffee|buna|tea|shai|food|injera|bread|dabo|snack|juice|restaurant|cafe|groceries|grocery|market|meat|fruit|water bottle|pizza|burger)\b/i,
    "cat_food",
  ],
  [
    /\b(taxi|ride|bus|minibus|bajaj|fuel|benzine|petrol|transport|uber|feres|ride|parking|train)\b/i,
    "cat_transport",
  ],
  [/\b(rent|house|apartment)\b/i, "cat_housing"],
  [/\b(electric|electricity|eeu|power|water bill|utility|utilities)\b/i, "cat_utilities"],
  [/\b(airtime|data|internet|wifi|ethio ?telecom|safaricom|phone|mobile|card)\b/i, "cat_phone"],
  [/\b(medicine|pharmacy|doctor|clinic|hospital|gym|health)\b/i, "cat_health"],
  [/\b(clothes|shoes|shirt|shopping|amazon|laptop|charger|cable)\b/i, "cat_shopping"],
  [/\b(gift|family|mom|mum|dad|wedding|sadaqa|zakat|charity)\b/i, "cat_family"],
  [/\b(course|book|books|udemy|learning|class|tuition)\b/i, "cat_learning"],
];

const INCOME_WORDS: [RegExp, string][] = [[/\b(salary|payroll|wage|wages)\b/i, "cat_salary"]];

function guessCategory(text: string, income: boolean): string {
  const table = income ? INCOME_WORDS : CATEGORY_WORDS;
  for (const [pattern, id] of table) if (pattern.test(text)) return id;
  return income ? "cat_income" : "cat_other";
}

/** Pulls `#area` tags out of the text. */
function readTag(text: string): { rest: string; area?: string } {
  // A tag starts with a letter, so "issue #42" keeps its number.
  const match = /(?:^|\s)#(\p{L}[\p{L}\p{N}_-]*)/u.exec(text);
  if (!match?.[1]) return { rest: text };
  const rest = (text.slice(0, match.index) + text.slice(match.index + match[0].length))
    .replace(/\s+/g, " ")
    .trim();
  return { rest, area: match[1].toLowerCase() };
}

/** An amount token: `350`, `1,200`, `12k`, `1.5k`, `350br`, `ETB 350`. */
const AMOUNT =
  /(?:^|\s)(?:(?:etb|br|birr)\s*)?(\d[\d,]*(?:\.\d{1,2})?k?(?:\s*(?:etb|br|birr))?)(?=\s|$)/i;

/** Splits "label amount" or "amount label" when the line is only that. */
function readMoney(
  text: string,
  amountFirstOk = false,
): { label: string; amount: Santim } | undefined {
  const match = AMOUNT.exec(text);
  if (!match?.[1]) return undefined;
  // Phone numbers and codes are not money: a leading zero, or an Ethiopian
  // mobile number with or without 251 (911234567, 251911234567).
  if (/^0\d/.test(match[1]) || /^(?:251)?[79]\d{8}$/.test(match[1])) return undefined;
  const amount = parseAmount(match[1]);
  if (amount === null || amount === 0) return undefined;
  const before = text.slice(0, match.index).trim();
  const after = text.slice(match.index + match[0].length).trim();
  const label = `${before} ${after}`
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:on|for)\s+/i, "");
  if (!label || /\d/.test(label)) return undefined;
  // Only plain "label amount" is money by default. Amount first ("120 lunch"),
  // amount mid-line ("get 3 eggs today") or a task verb first ("read chapter 5",
  // "renew passport 2027") need a word we know costs money.
  const firstWord = before.split(" ")[0]?.toLowerCase() ?? "";
  const plain = before !== "" && after === "" && !TASK_VERBS.has(firstWord);
  if (!plain && !amountFirstOk && !isKnownSpend(label)) return undefined;
  return { label, amount };
}

function isKnownSpend(label: string): boolean {
  return [...CATEGORY_WORDS, ...INCOME_WORDS].some(([pattern]) => pattern.test(label));
}

function withArea<T extends object>(value: T, area: string | undefined): T & { area?: string } {
  return area ? { ...value, area } : value;
}

/** `~18h`, `about 18 hours` anywhere; a bare `18h` only at the end or before `by`. */
const MARKED_ESTIMATE = /(?:~|\babout\s+|\baround\s+)(\d+(?:\.\d+)?)\s*(?:h|hrs?|hours?)\b/i;
const BARE_ESTIMATE = /\s(\d+(?:\.\d+)?)\s*(?:h|hrs?|hours?)(?=\s*$|\s+by\b)/i;

/**
 * An idea (plan §3.8): `idea: CLI budget tool ~18h by 20 dec` reads an
 * estimate and a deadline; the name is what is left.
 */
export function readIdea(
  body: string,
  nowMs: number,
  clockStyle: ClockStyle = "western",
): Extract<Parsed, { kind: "idea" }> {
  const idea: Extract<Parsed, { kind: "idea" }> = { kind: "idea", body };
  let rest = body;
  const estimate = MARKED_ESTIMATE.exec(rest) ?? BARE_ESTIMATE.exec(` ${rest}`);
  if (estimate) {
    const minutes = Math.round(Number(estimate[1]) * 60);
    if (minutes > 0) {
      idea.estimateMin = minutes;
      rest = ` ${rest}`.replace(estimate[0], " ").trim();
    }
  }
  const when = readWhen(rest, nowMs, clockStyle);
  if (when.date) {
    idea.deadline = when.date;
    rest = when.rest;
  }
  const title = rest
    .replace(/\s+/g, " ")
    .replace(/\s*\bby\s*$/i, "")
    .trim();
  if (title && title !== body) idea.title = title;
  return idea;
}

export function parseCapture(raw: string, options: ParseOptions): Parsed {
  const { nowMs, clockStyle = "western" } = options;
  const text = raw.trim().replace(/\s+/g, " ");
  const lower = text.toLowerCase();

  // Prefixes win (plan §3.5).
  if (text.startsWith("?")) return { kind: "search", query: text.slice(1).trim() };
  if (lower === "focus" || lower === "start focus") return { kind: "focus" };
  if (/^away\b/.test(lower)) {
    const when = readWhen(text.replace(/^away\s*(?:till|until|to)?/i, ""), nowMs, clockStyle);
    return when.date ? { kind: "away", until: when.date } : { kind: "away" };
  }

  const prefix = /^(t|n|idea|pin|wait|fb)\s*:\s*/i.exec(text);
  const body = prefix ? text.slice(prefix[0].length) : text;
  const { rest: untagged, area } = readTag(body);

  switch (prefix?.[1]?.toLowerCase()) {
    case "n":
      return withArea({ kind: "note", body: untagged }, area);
    case "idea":
      return withArea(readIdea(untagged, nowMs, clockStyle), area);
    case "pin":
      return withArea({ kind: "cheat", body: untagged }, area);
    case "fb":
      return { kind: "feedback", body: untagged };
    case "wait": {
      const when = readWhen(untagged, nowMs, clockStyle);
      const waitingOn = when.rest.replace(/^(?:on|for)\s+/i, "");
      const task: Parsed = { kind: "task", title: `Waiting: ${waitingOn}`, waitingOn };
      if (when.date) task.dueDate = when.date;
      return withArea(task, area);
    }
    case "t":
      return withArea(readTask(untagged, nowMs, clockStyle), area);
    default:
      break;
  }

  // Income: "+25000 salary" or "salary 25000".
  const income = /^\+\s*(.+)$/.exec(untagged);
  if (income?.[1]) {
    const money = readMoney(income[1], true);
    if (money) {
      return withArea(
        {
          kind: "income",
          description: money.label,
          amount: money.amount,
          categoryId: guessCategory(money.label, true),
          date: logicalDate(nowMs),
        },
        area,
      );
    }
  }

  // "pay EEU 600 fri" is something to do; "paid rent 12000" happened.
  if (!PAY_WORD.test(untagged)) {
    const spent = SPENT_WORDS.test(untagged);
    const spentText = untagged.replace(SPENT_WORDS, "");
    // Spending happened, so its day words point back: "lunch 120 mon" is last Monday.
    const when = readWhen(spentText, nowMs, clockStyle, { past: true });
    const money = readMoney(when.rest, spent);
    if (money && when.minutes === undefined) {
      // "paid salary 3000 to the house help" is spending, not income.
      const isIncome = !spent && INCOME_WORDS.some(([pattern]) => pattern.test(money.label));
      return withArea(
        {
          kind: isIncome ? "income" : "expense",
          description: money.label,
          amount: money.amount,
          categoryId: guessCategory(money.label, isIncome),
          date: when.date ?? logicalDate(nowMs),
        },
        area,
      );
    }
  }

  const task = readTask(untagged, nowMs, clockStyle);
  const firstWord = untagged.split(" ")[0]?.toLowerCase() ?? "";
  if (task.kind === "task" && (task.dueDate || TASK_VERBS.has(firstWord) || area)) {
    return withArea(task, area);
  }
  return withArea({ kind: "inbox", body: untagged }, area);
}

function readTask(raw: string, nowMs: number, clockStyle: ClockStyle): Parsed {
  // Only a marked estimate (`~3h`, `about 2 hours`) on a task: a bare "2h" is too
  // easily part of the title.
  const estimate = MARKED_ESTIMATE.exec(raw);
  const minutes = estimate ? Math.round(Number(estimate[1]) * 60) : 0;
  const text =
    minutes > 0 && estimate ? raw.replace(estimate[0], " ").replace(/\s+/g, " ").trim() : raw;
  const when = readWhen(text, nowMs, clockStyle);
  // "build CLI tool by 20 dec" → "build CLI tool".
  const title = when.date ? when.rest.replace(/\s+(?:by|on|at|before|due)$/i, "") : when.rest;
  const task: Parsed = { kind: "task", title: title || text };
  if (minutes > 0) task.estimateMin = minutes;
  if (when.date) task.dueDate = when.date;
  if (when.date && when.minutes !== undefined) task.dueAt = localToEpoch(when.date, when.minutes);
  return task;
}
