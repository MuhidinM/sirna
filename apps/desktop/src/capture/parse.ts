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
  | MoneyItem
  /** Several entries on one line: `lunch 120, taxi 40`. */
  | { kind: "money"; items: MoneyItem[] }
  /** Money lent or owed (T-061): `lent 1000 abel`, `abel paid back 400`. */
  | {
      kind: "loan";
      loanKind: "lent" | "borrowed" | "paid_me" | "i_paid";
      person: string;
      amount: Santim;
      date: string;
      account?: string;
      accountName?: string;
    }
  /** Between your own accounts: `moved 2000 cbe to telebirr`. */
  | {
      kind: "transfer";
      amount: Santim;
      from: string;
      to: string;
      fromName: string;
      toName: string;
      date: string;
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
  | {
      kind: "saving";
      /** Santim, positive: saved; negative: taken out. */
      amount: Santim;
      /** Words naming the goal (`laptop`), matched in the capture box. */
      goal?: string;
    }
  | { kind: "focus" };

export interface MoneyItem {
  kind: "expense" | "income";
  description: string;
  amount: Santim;
  categoryId: string;
  /** The category's name, when the capture box knows your categories. */
  categoryName?: string;
  date: string;
  area?: string;
  /** Income from a job you named (`got 18k job a`): the job's area. */
  jobId?: string;
  jobName?: string;
  /** The account (`@telebirr`); spending defaults to cash, income to the pay account. */
  account?: string;
  accountName?: string;
}

export interface ParseOptions {
  nowMs: number;
  clockStyle?: ClockStyle;
  /** Goal names (lowercase), so `saved 500 laptop` is read as saving only when a goal fits. */
  goals?: string[];
  /** Your categories, so `#fuel` on a money line picks one (T-056). */
  categories?: { id: string; name: string; kind: "expense" | "income" }[];
  /** Description (lowercase) → the category you corrected it to in the ledger. */
  learned?: Record<string, string>;
  /** Your jobs (work areas), so income names where it came from. */
  jobs?: { id: string; name: string }[];
  /** Your accounts, so `@telebirr` and transfers know them (T-058). */
  accounts?: { id: string; name: string; kind: string; pays_in: number }[];
}

type AccountOption = NonNullable<ParseOptions["accounts"]>[number];

/** An account by its short id or name (`cbe`, `E-birr`, `ebirr`). */
function findAccount(word: string, accounts: AccountOption[]): AccountOption | undefined {
  const key = squash(word);
  if (!key) return undefined;
  return (
    accounts.find((account) => account.id === key) ??
    accounts.find((account) => squash(account.name) === key)
  );
}

/** Pulls a known `@account` out of a line. */
function readAccount(text: string, accounts: AccountOption[]) {
  const match = /(?:^|\s)@([\p{L}\p{N}_-]+)/u.exec(text);
  const account = match?.[1] ? findAccount(match[1], accounts) : undefined;
  if (!match || !account) return { rest: text };
  const rest = (text.slice(0, match.index) + text.slice(match.index + match[0].length))
    .replace(/\s+/g, " ")
    .trim();
  return { rest, account };
}

const TRANSFER =
  /^(?:moved|move|transferred|transfer)\s+((?:etb\s*)?[\d.,]+k?(?:\s?(?:etb|birr|br))?)\s+(?:from\s+)?@?([\p{L}\p{N}_-]+)\s+(?:to|into)\s+@?([\p{L}\p{N}_-]+)$/iu;

const LOAN_AMOUNT = String.raw`((?:etb\s*)?\d[\d.,]*k?(?:\s?(?:etb|birr|br))?)`;
const LOAN_PERSON = String.raw`([\p{L}][\p{L}'-]*(?:\s[\p{L}][\p{L}'-]*)?)`;
const LOAN_FORMS: [
  RegExp,
  "lent" | "borrowed" | "paid_me" | "i_paid",
  "amount-first" | "person-first",
][] = [
  [
    new RegExp(
      String.raw`^(?:lent|loaned|gave a loan of)\s+${LOAN_AMOUNT}\s+(?:to\s+)?${LOAN_PERSON}$`,
      "iu",
    ),
    "lent",
    "amount-first",
  ],
  [
    new RegExp(String.raw`^(?:lent|loaned)\s+${LOAN_PERSON}\s+${LOAN_AMOUNT}$`, "iu"),
    "lent",
    "person-first",
  ],
  [
    new RegExp(String.raw`^borrowed\s+${LOAN_AMOUNT}\s+(?:from\s+)?${LOAN_PERSON}$`, "iu"),
    "borrowed",
    "amount-first",
  ],
  [
    new RegExp(String.raw`^borrowed\s+(?:from\s+)?${LOAN_PERSON}\s+${LOAN_AMOUNT}$`, "iu"),
    "borrowed",
    "person-first",
  ],
  [
    new RegExp(
      String.raw`^${LOAN_PERSON}\s+(?:paid (?:me )?back|paid me|returned|gave back)\s+${LOAN_AMOUNT}$`,
      "iu",
    ),
    "paid_me",
    "person-first",
  ],
  [
    new RegExp(String.raw`^got\s+${LOAN_AMOUNT}\s+back\s+from\s+${LOAN_PERSON}$`, "iu"),
    "paid_me",
    "amount-first",
  ],
  [
    new RegExp(String.raw`^(?:paid back|repaid|returned)\s+${LOAN_PERSON}\s+${LOAN_AMOUNT}$`, "iu"),
    "i_paid",
    "person-first",
  ],
  [
    new RegExp(String.raw`^paid\s+${LOAN_PERSON}\s+back\s+${LOAN_AMOUNT}$`, "iu"),
    "i_paid",
    "person-first",
  ],
  [
    new RegExp(String.raw`^(?:paid back|repaid)\s+${LOAN_AMOUNT}\s+to\s+${LOAN_PERSON}$`, "iu"),
    "i_paid",
    "amount-first",
  ],
];

/** `lent 1000 abel`, `borrowed 500 from sara`, `abel paid back 400`, `paid back sara 500`. */
function readLoan(text: string, options: ParseOptions): Parsed | undefined {
  const { rest, account } = readAccount(text, options.accounts ?? []);
  for (const [pattern, loanKind, order] of LOAN_FORMS) {
    const match = pattern.exec(rest);
    if (!match) continue;
    const [amountText, person] =
      order === "amount-first" ? [match[1], match[2]] : [match[2], match[1]];
    const amount = parseAmount(amountText ?? "");
    if (amount === null || amount <= 0 || !person) continue;
    const fallback = (options.accounts ?? []).find((a) => a.kind === "cash");
    const chosen = account ?? fallback;
    return {
      kind: "loan",
      loanKind,
      person: person.trim(),
      amount,
      date: logicalDate(options.nowMs),
      ...(chosen ? { account: chosen.id, accountName: chosen.name } : {}),
    };
  }
  return undefined;
}

/** `moved 2000 cbe to telebirr`: only when both are your accounts. */
function readTransfer(text: string, options: ParseOptions): Parsed | undefined {
  const match = TRANSFER.exec(text);
  if (!match) return undefined;
  const accounts = options.accounts ?? [];
  const amount = parseAmount(match[1] ?? "");
  const from = findAccount(match[2] ?? "", accounts);
  const to = findAccount(match[3] ?? "", accounts);
  if (amount === null || amount <= 0 || !from || !to || from.id === to.id) return undefined;
  return {
    kind: "transfer",
    amount,
    from: from.id,
    to: to.id,
    fromName: from.name,
    toName: to.name,
    date: logicalDate(options.nowMs),
  };
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

const SAVING =
  /^(saved|put aside|set aside|took|withdrew)\s+((?:etb\s*)?[\d.,]+k?(?:\s?(?:etb|birr|br))?)(?:\s+(.*))?$/i;

function readSaving(text: string, goals: string[]): Parsed | undefined {
  const match = SAVING.exec(text);
  if (!match) return undefined;
  const amount = parseAmount(match[2] ?? "");
  if (amount === null || amount <= 0) return undefined;
  const out = /^(took|withdrew)$/i.test(match[1] ?? "");
  const rest = (match[3] ?? "").trim();
  const words = rest.replace(/^(?:from|for|to|into|on)\s+/i, "").trim();
  const names = (goal: string) =>
    goals.some((name) => name.includes(goal.toLowerCase()) || goal.toLowerCase().includes(name));
  const marked = /[a-z]/i.test(match[2] ?? ""); // `etb`, `birr`, `br` or `k`
  if (out) {
    // Taking out names where from: `took 2000 from laptop`.
    if (!/^from\s+/i.test(rest) || !words) return undefined;
  } else if (rest && !names(words) && !marked) {
    return undefined;
  }
  return { kind: "saving", amount: out ? -amount : amount, ...(words ? { goal: words } : {}) };
}

const squash = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** A `#tag` that names one of your categories: the whole name, or its first word. */
function categoryFromTag(
  tag: string,
  categories: NonNullable<ParseOptions["categories"]>,
): NonNullable<ParseOptions["categories"]>[number] | undefined {
  const key = squash(tag);
  if (!key) return undefined;
  return (
    categories.find((category) => squash(category.name) === key) ??
    categories.find((category) => squash(category.name.split(/\s+/)[0] ?? "") === key)
  );
}

/** A job named in the words (`job a`, `Job B`), longest name first. */
function jobIn(words: string, jobs: NonNullable<ParseOptions["jobs"]>) {
  const text = ` ${words.toLowerCase().replace(/\s+/g, " ")} `;
  return [...jobs]
    .sort((a, b) => b.name.length - a.name.length)
    .find((job) => job.name.trim() && text.includes(` ${job.name.trim().toLowerCase()} `));
}

/**
 * Settles a money line's category and job (T-056): a `#tag` naming a
 * category wins, then a category you corrected before, then the keyword
 * guess. Income names its job when the words do.
 */
function finishMoney(item: MoneyItem, options: ParseOptions): MoneyItem {
  const categories = options.categories ?? [];
  const result: MoneyItem = { ...item };
  const tagged = item.area ? categoryFromTag(item.area, categories) : undefined;
  if (tagged) {
    result.categoryId = tagged.id;
    delete result.area;
  } else {
    const learned = options.learned?.[item.description.trim().toLowerCase()];
    if (learned && (categories.length === 0 || categories.some((c) => c.id === learned)))
      result.categoryId = learned;
  }
  if (item.kind === "income") {
    const job = jobIn(item.description, options.jobs ?? []);
    if (job) {
      result.jobId = job.id;
      result.jobName = job.name;
      if (!tagged && result.categoryId === "cat_income") result.categoryId = "cat_salary";
    }
  }
  const name = categories.find((category) => category.id === result.categoryId)?.name;
  if (name) result.categoryName = name;
  return result;
}

const isMoney = (parsed: Parsed): parsed is MoneyItem =>
  parsed.kind === "expense" || parsed.kind === "income";

export function parseCapture(raw: string, options: ParseOptions): Parsed {
  const transfer = readTransfer(raw.trim().replace(/\s+/g, " "), options);
  if (transfer) return transfer;
  const loan = readLoan(raw.trim().replace(/\s+/g, " "), options);
  if (loan) return loan;
  const parsed = parseMoneyLine(raw, options);
  if (isMoney(parsed)) return parsed;
  // `lunch 120, taxi 40`: several entries when every piece is money. A comma
  // before a digit is a thousands separator (`rent 1,200`), not a split.
  const pieces = raw.split(/\s*,\s*(?=\D)/).filter((piece) => piece.trim());
  if (pieces.length >= 2 && !/^\s*(?:\?|[a-z]+\s*:)/i.test(raw)) {
    const items = pieces.map((piece) => parseMoneyLine(piece, options));
    if (items.every(isMoney)) return { kind: "money", items };
  }
  return parsed;
}

/** One line, with its `@account` taken out first and money settled after. */
function parseMoneyLine(raw: string, options: ParseOptions): Parsed {
  const accounts = options.accounts ?? [];
  const { rest, account } = readAccount(raw, accounts);
  const parsed = parseOne(rest, options);
  if (!isMoney(parsed)) return account ? parseOne(raw, options) : parsed;
  const item = finishMoney(parsed, options);
  const chosen =
    account ??
    (accounts.length > 0
      ? accounts.find((a) => (item.kind === "income" ? a.pays_in === 1 : a.kind === "cash"))
      : undefined);
  return chosen ? { ...item, account: chosen.id, accountName: chosen.name } : item;
}

function parseOne(raw: string, options: ParseOptions): Parsed {
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

  // Savings (plan §3.13). Kept narrow so ordinary lines stay what they were:
  // `saved 500` / `put aside 2k`  — nothing after the amount;
  // `saved 500 laptop`            — the words name a goal;
  // `saved 500 ETB rent`          — a currency marks it as money;
  // `took 2000 from laptop`       — taking out needs `from` and a goal.
  const saving = readSaving(text, options.goals ?? []);
  if (saving) return saving;

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

  // Income: "got 18k job a", "received 5000 freelance", "earned 3000 tutoring".
  const got = /^(?:got paid|got|received|earned)\s+(.+)$/i.exec(untagged);
  if (got?.[1]) {
    const money = readMoney(got[1], true);
    // "got 3 tickets" isn't pay: the amount must look like money (100 birr or
    // more, or marked with k, birr or ETB) or the words must say pay or a job.
    const looksPaid =
      money &&
      (money.amount >= 10_000 ||
        /\d\s*(?:k|etb|birr|br)\b|\b(?:etb|birr|br)\s*\d/i.test(got[1]) ||
        INCOME_WORDS.some(([pattern]) => pattern.test(money.label)) ||
        jobIn(money.label, options.jobs ?? []) !== undefined);
    if (money && looksPaid) {
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
