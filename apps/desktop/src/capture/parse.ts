/**
 * The capture parser (plan §3.5): one typed line becomes a task, an expense,
 * an idea, a cheat-sheet line… Deterministic; the AI fallback comes in M4.
 * The live chip and the save use this same function.
 */
import { logicalDate } from "../kernel/dates";
import { parseAmount, type Santim } from "../kernel/money";
import { type ClockStyle, type DayWindow, localToEpoch, readWhen } from "./when";
import { parseRule, type Rule } from "../features/money/regulars";
import { onOrAfter } from "../features/tasks/repeat";
import { transferAmounts } from "../features/money/accounts";
import { type Rates, toEtb } from "../features/money/currency";
import { transferSaving } from "../features/savings/savings";

export const PARSER_ID = "capture@1";

export type Parsed =
  | {
      kind: "task";
      title: string;
      /** `~3h`: how long it takes, so the day plan can give it more than one block. */
      estimateMin?: number;
      dueDate?: string;
      dueAt?: number;
      /** `tomorrow morning`, `tonight`: a part of the day instead of a time. */
      plannedWindow?: DayWindow;
      area?: string;
      waitingOn?: string;
      /** `every fri`: a new copy comes once this one is done (T-068). */
      repeat?: Rule;
    }
  | MoneyItem
  /**
   * Several money records on one line, split by commas or " and ":
   * `+25000 salary, saved 500 laptop, lent Abel 1500, moved 2000 cbo to cash`.
   */
  | { kind: "money"; items: MoneyPiece[] }
  /** A question, not a record (T-074): `afford 4500 shoes`. Nothing is written. */
  | {
      kind: "afford";
      amount: Santim;
      what?: string;
      /** `afford $200`: the amount is in this currency; answered in birr at the rate. */
      currency?: string;
    }
  | LoanItem
  | TransferItem
  | {
      kind: "note" | "feedback" | "inbox";
      body: string;
      area?: string;
      /**
       * Why a money line was kept as a loose end instead of saved as money
       * (`No USD account yet: …`): the echo says it.
       */
      why?: string;
    }
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
  | SavingItem
  | { kind: "focus" };

/** Money lent or owed (T-061): `lent 1000 abel`, `abel paid back 400`. */
export interface LoanItem {
  kind: "loan";
  loanKind: "lent" | "borrowed" | "paid_me" | "i_paid";
  person: string;
  amount: Santim;
  date: string;
  account?: string;
  accountName?: string;
  /** ISO code when not birr: `lent abel $50`, or the account's currency. */
  currency?: string;
}

/** Between your own accounts: `moved 2000 cbe to telebirr`. */
export interface TransferItem {
  kind: "transfer";
  amount: Santim;
  from: string;
  to: string;
  fromName: string;
  toName: string;
  date: string;
  /** The from-account's currency when not birr; `amount` is in it. */
  currency?: string;
  /** Between two currencies: what arrives, in `toCurrency`, at the saved rate. */
  received?: Santim;
  toCurrency?: string;
  /** "at 132.50", for the echo, when the halves differ in currency. */
  at?: string;
  /** Into (or out of) a savings account: the goal's share, signed ETB minor units. */
  saving?: { account: string; minor: Santim };
}

/** An account a saving moves between: its id, name and currency when not birr. */
export interface AccountRef {
  id: string;
  name: string;
  currency?: string;
}

export interface SavingItem {
  kind: "saving";
  /** Minor units of `currency` (birr when not given), positive: saved; negative: taken out. */
  amount: Santim;
  /** Words naming the goal (`laptop`), matched in the capture box. */
  goal?: string;
  /** `@telebirr` on the line: where the money comes from (or goes back to). */
  account?: string;
  /** ISO code when not birr (`saved $50 laptop`). */
  currency?: string;
  /** The goal's value in ETB minor units, signed, when `currency` isn't birr. */
  worth?: Santim;
  /**
   * Like Put aside (time-first §4): the money moves from `spend` into
   * `savings` (the reverse when taken out). Both are in `currency`.
   */
  spend?: AccountRef;
  savings?: AccountRef;
  /** Why it is only marked as saved, with no transfer ("no USD savings account"). */
  unbacked?: string;
}

/** One record of a several-item money line. */
export type MoneyPiece = MoneyItem | LoanItem | TransferItem | SavingItem;

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
  /** ISO code when not birr (`$200`, `50 eur`, or the account's currency): minor units of it. */
  currency?: string;
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
  /** Your accounts, so `@telebirr` and transfers know them (T-058); `currency` defaults to ETB. */
  accounts?: {
    id: string;
    name: string;
    kind: string;
    pays_in: number;
    currency?: string;
    is_savings?: number;
  }[];
  /** Your areas and jobs, so `for job a` and `#joba` name one (time-first §1 rule 3). */
  areas?: { id: string; name: string }[];
  /** People with an open loan, so "abel paid back 400" is read only when Abel owes you. */
  loanPeople?: { name: string; owedToMe: number; iOwe: number }[];
  /** Saved rates (`money.rates`), for transfers and savings across currencies. */
  rates?: Rates;
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

/** `afford 4500 shoes`, `can i afford 2k?` */
const AFFORD =
  /^(?:can i )?afford\s+((?:etb\s*)?\d[\d.,]*k?(?:\s?(?:etb|birr|br))?)(?:\s+(?:a |an |the )?(.+?))?\s*\??$/i;

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
/** Words that are never a person: days, fillers, things. */
const NOT_A_PERSON =
  /^(?:today|tonight|tomorrow|yesterday|now|later|next|this|last|week|month|morning|evening|mon|monday|tue|tuesday|wed|wednesday|thu|thursday|fri|friday|sat|saturday|sun|sunday|the|a|an|my|your|his|her|their|it|him|them|me|you|loan|money|back|cash|some|all|shoes|book|books|item|items|order)$/i;

function isPerson(name: string, options: ParseOptions): boolean {
  const words = name.trim().split(/\s+/);
  if (words.some((word) => NOT_A_PERSON.test(word))) return false;
  const key = squash(name);
  const named = (list: { name: string }[] | undefined) =>
    (list ?? []).some((item) => squash(item.name) === key);
  // A job, account or category is not someone you lend to.
  if (named(options.jobs) || named(options.accounts) || named(options.categories)) return false;
  return true;
}

function readLoan(text: string, options: ParseOptions): Parsed | undefined {
  const { rest, account } = readAccount(text, options.accounts ?? []);
  for (const [pattern, loanKind, order] of LOAN_FORMS) {
    const match = pattern.exec(rest);
    if (!match) continue;
    const [amountText, person] =
      order === "amount-first" ? [match[1], match[2]] : [match[2], match[1]];
    const amount = parseAmount(amountText ?? "");
    if (amount === null || amount <= 0 || !person || !isPerson(person, options)) continue;
    // Being paid back, or paying back, needs a loan that is open that way:
    // "job a paid me 18k" is pay, "returned shoes 500" is a refund.
    if (loanKind === "paid_me" || loanKind === "i_paid") {
      const open = (options.loanPeople ?? []).find((p) => squash(p.name) === squash(person));
      if (!open || (loanKind === "paid_me" ? open.owedToMe : open.iOwe) <= 0) continue;
    }
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

const isPiece = (parsed: Parsed): parsed is MoneyPiece =>
  isMoney(parsed) ||
  parsed.kind === "loan" ||
  parsed.kind === "transfer" ||
  parsed.kind === "saving";

/** Where a several-item line splits: a comma not inside a number (`rent 1,200`). */
const COMMA_SPLIT = /\s*,\s*(?=\D)/;
const LOAN_VERB = /^\s*(lent|loaned|borrowed)\s/i;

/**
 * Splits one comma piece on " and " only when every half is a money piece:
 * "lunch 120 and taxi 40" splits, "salt and pepper 50" does not. A verbless
 * half after a loan takes the loan's verb: "lent abel 1500 and kebede 200",
 * unless it names a spending category ("and lunch 120").
 */
function splitOnAnd(piece: string, options: ParseOptions): string[] {
  const halves = piece.split(/\s+and\s+/i).filter((half) => half.trim());
  if (halves.length < 2) return [piece];
  const out: string[] = [];
  let verb: string | undefined;
  for (const half of halves) {
    let text = half;
    let item = parsePiece(text, options);
    // "lunch 120" names a spending category, so it stays an expense.
    const spending = item.kind === "expense" && item.categoryId !== "cat_other";
    if (verb && item.kind !== "loan" && !spending && !LOAN_VERB.test(text)) {
      const lent = parsePiece(`${verb} ${text.trim()}`, options);
      if (lent.kind === "loan") {
        text = `${verb} ${text.trim()}`;
        item = lent;
      }
    }
    if (!isPiece(item) && !isStuck(item)) return [piece];
    verb = item.kind === "loan" ? LOAN_VERB.exec(text)?.[1] : undefined;
    out.push(text);
  }
  return out;
}

export function parseCapture(raw: string, options: ParseOptions): Parsed {
  const parsed = parsePiece(raw, options);
  if (isMoney(parsed) || parsed.kind === "afford" || parsed.kind === "transfer") return parsed;
  // `lunch 120, taxi 40`, `+25000 salary, saved 500 laptop and lent abel 1500`:
  // several records when every piece is money (time-first §2).
  const pieces = raw
    .split(COMMA_SPLIT)
    .filter((piece) => piece.trim())
    .flatMap((piece) => splitOnAnd(piece, options));
  if (pieces.length >= 2 && !/^\s*(?:\?|[a-z]+\s*:)/i.test(raw)) {
    // "lunch 120, taxi 40 @telebirr": an account on the last piece only is
    // for the whole line.
    const accounts = options.accounts ?? [];
    const own = pieces.map((piece) => readAccount(piece, accounts).account);
    const shared =
      own.length > 1 && own.slice(0, -1).every((a) => !a) ? own[own.length - 1] : undefined;
    const items = pieces.map((piece) =>
      parsePiece(
        shared && !readAccount(piece, accounts).account ? `${piece} @${shared.id}` : piece,
        options,
      ),
    );
    if (items.every(isPiece)) return { kind: "money", items };
    // One piece can't be saved as money (no account in its currency, …):
    // the whole line stays a loose end and the echo says why.
    const stuck = items.find(isStuck);
    if (stuck && items.every((item) => isPiece(item) || isStuck(item)))
      return looseEnd(raw, stuck.why);
  }
  return parsed;
}

type Stuck = { kind: "inbox"; body: string; why: string };
const isStuck = (parsed: Parsed): parsed is Stuck =>
  parsed.kind === "inbox" && typeof parsed.why === "string";

/** A line kept as a loose end, not money, with the reason for the echo. */
const looseEnd = (raw: string, why: string): Stuck => ({
  kind: "inbox",
  body: raw.trim().replace(/\s+/g, " "),
  why,
});

/** ISO codes by what people type: `$`, `usd`, `dollars`, `€`, `eur`, `£`, `gbp`. */
const CURRENCY_OF: Record<string, string> = {
  $: "USD",
  usd: "USD",
  dollar: "USD",
  dollars: "USD",
  "€": "EUR",
  eur: "EUR",
  euro: "EUR",
  euros: "EUR",
  "£": "GBP",
  gbp: "GBP",
};
const NUMBER = String.raw`\d[\d,]*(?:\.\d{1,2})?k?`;
const CURRENCY_AMOUNT = new RegExp(
  String.raw`(?<=^|[\s+])(?:([$€£])\s?(${NUMBER})|(usd|eur|gbp)\s?(${NUMBER})|(${NUMBER})\s?(usd|eur|gbp|dollars?|euros?))(?=$|[\s,.?!])`,
  "iu",
);

/** `$200`, `200 usd`, `usd 200`, `€50`, `50 eur`, `£20`, `20 gbp`: the number left bare, and its currency. */
export function readCurrency(text: string): { rest: string; currency?: string; word?: string } {
  const match = CURRENCY_AMOUNT.exec(text);
  if (!match) return { rest: text };
  const unit = (match[1] ?? match[3] ?? match[6] ?? "").toLowerCase();
  const number = match[2] ?? match[4] ?? match[5] ?? "";
  const currency = CURRENCY_OF[unit];
  if (!currency || !number) return { rest: text };
  const rest = text.slice(0, match.index) + number + text.slice(match.index + match[0].length);
  return { rest, currency, word: unit };
}

const currencyOf = (account: AccountOption | undefined) => account?.currency ?? "ETB";

/** The first spending (not savings) account kept in a currency. */
const homeIn = (accounts: AccountOption[], code: string) =>
  accounts.find((a) => currencyOf(a) === code && a.is_savings !== 1);

const refOf = (account: AccountOption): AccountRef => ({
  id: account.id,
  name: account.name,
  ...(currencyOf(account) !== "ETB" ? { currency: currencyOf(account) } : {}),
});

/** "CBO is in ETB; use @wise or drop the usd". */
function wrongAccount(
  account: AccountOption,
  code: string,
  word: string | undefined,
  accounts: AccountOption[],
): string {
  const other = homeIn(accounts, code);
  return `${account.name} is in ${currencyOf(account)}; ${other ? `use @${other.id} or ` : ""}drop the ${word ?? code.toLowerCase()}`;
}

const noAccountIn = (code: string) => `No ${code} account yet: add one in Money → Accounts`;
const setRate = (code: string) => `Set a ${code} rate in Money → Accounts first`;

/**
 * One record's worth of text. A currency (`$200`, `50 eur`) is read off
 * first; with no `@account`, the first spending account kept in that
 * currency is used. Without one, `@wise` gives its own currency. Birr is
 * left unmarked. An entry's currency is always its account's: a line that
 * can't keep to that is a loose end that says why (time-first §3).
 */
function parsePiece(raw: string, options: ParseOptions): Parsed {
  const accounts = options.accounts ?? [];
  const text = raw.trim().replace(/\s+/g, " ");
  const { rest, currency, word } = readCurrency(text);
  const named = readAccount(rest, accounts).account;
  let parsed = parsePlain(rest, options);
  if (
    currency &&
    !named &&
    parsed.kind !== "transfer" &&
    parsed.kind !== "saving" &&
    parsed.kind !== "afford"
  ) {
    const home = homeIn(accounts, currency);
    if (home) parsed = parsePlain(`${rest} @${home.id}`, options);
  }
  if (parsed.kind === "transfer") return settleTransfer(parsed, currency, word, text, options);
  if (parsed.kind === "saving") return settleSaving(parsed, currency, word, text, options);
  if (parsed.kind === "afford") return currency ? { ...parsed, currency } : parsed;
  if (isMoney(parsed) || parsed.kind === "loan") {
    const account = accounts.find((a) => a.id === parsed.account);
    if (!account) {
      if (currency && accounts.length > 0) return looseEnd(text, noAccountIn(currency));
      return currency ? { ...parsed, currency } : parsed;
    }
    if (currency && currencyOf(account) !== currency)
      return looseEnd(
        text,
        named ? wrongAccount(account, currency, word, accounts) : noAccountIn(currency),
      );
    const code = currencyOf(account);
    return code === "ETB" ? parsed : { ...parsed, currency: code };
  }
  // A question or a task with a currency in it: read the line as typed.
  return currency ? parsePlain(raw, options) : parsed;
}

/**
 * `moved $200 from wise to cbo`: the from-half in Wise's dollars, the
 * to-half the birr it is worth at the saved rate. Into or out of a savings
 * account it is saving too, and says how much.
 */
function settleTransfer(
  parsed: TransferItem,
  typed: string | undefined,
  word: string | undefined,
  text: string,
  options: ParseOptions,
): Parsed {
  const accounts = options.accounts ?? [];
  const rates = options.rates ?? {};
  const from = accounts.find((a) => a.id === parsed.from);
  const to = accounts.find((a) => a.id === parsed.to);
  if (!from || !to) return typed ? { ...parsed, currency: typed } : parsed;
  const amounts = transferAmounts({ from, to, amount: parsed.amount, rates, typed, word });
  if ("problem" in amounts) return looseEnd(text, amounts.problem);
  const fromCode = currencyOf(from);
  const toCode = currencyOf(to);
  const foreign = fromCode === "ETB" ? toCode : fromCode;
  const saving = transferSaving({
    from,
    to,
    sent: amounts.sent,
    received: amounts.received,
    rates,
  });
  const rate = rates[foreign];
  return {
    ...parsed,
    amount: amounts.sent,
    ...(fromCode !== "ETB" ? { currency: fromCode } : {}),
    ...(fromCode !== toCode
      ? {
          received: amounts.received,
          toCurrency: toCode,
          ...(rate ? { at: `at ${rate.rate}` } : {}),
        }
      : {}),
    ...(saving ? { saving } : {}),
  };
}

/**
 * `saved 500 laptop` is Put aside (time-first §4): from the pay account (or
 * `@account`) into the first savings account in that currency. `took 2000
 * from laptop` is the reverse. With no savings account in that currency it
 * is only marked as saved, as before, and says so.
 */
function settleSaving(
  parsed: SavingItem,
  typed: string | undefined,
  word: string | undefined,
  text: string,
  options: ParseOptions,
): Parsed {
  const accounts = options.accounts ?? [];
  const { account: namedId, ...saving } = parsed;
  const named = namedId ? accounts.find((a) => a.id === namedId) : undefined;
  const code = typed ?? (named ? currencyOf(named) : "ETB");
  if (named && currencyOf(named) !== code)
    return looseEnd(text, wrongAccount(named, code, word, accounts));
  const worth = toEtb(parsed.amount, code, options.rates ?? {});
  if (worth === null) return looseEnd(text, setRate(code));
  const base: SavingItem = { ...saving, ...(code !== "ETB" ? { currency: code, worth } : {}) };
  if (accounts.length === 0) return base;
  const savings =
    named?.is_savings === 1
      ? named
      : accounts.find((a) => a.is_savings === 1 && currencyOf(a) === code);
  const spend =
    named && named.is_savings !== 1
      ? named
      : (accounts.find((a) => a.pays_in === 1 && a.is_savings !== 1 && currencyOf(a) === code) ??
        homeIn(accounts, code));
  if (!savings) return { ...base, unbacked: `no ${code} savings account` };
  if (!spend) return { ...base, unbacked: `no ${code} account to take it from` };
  return { ...base, spend: refOf(spend), savings: refOf(savings) };
}

function parsePlain(raw: string, options: ParseOptions): Parsed {
  const transfer = readTransfer(raw.trim().replace(/\s+/g, " "), options);
  if (transfer) return transfer;
  const asked = AFFORD.exec(raw.trim().replace(/\s+/g, " "));
  if (asked) {
    const amount = parseAmount(asked[1] ?? "");
    if (amount !== null && amount > 0) {
      const what = asked[2]?.trim();
      return what ? { kind: "afford", amount, what } : { kind: "afford", amount };
    }
  }
  const loan = readLoan(raw.trim().replace(/\s+/g, " "), options);
  if (loan) return loan;
  return parseMoneyLine(raw, options);
}

/** One line, with its `@account` taken out first and money settled after. */
function parseMoneyLine(raw: string, options: ParseOptions): Parsed {
  const accounts = options.accounts ?? [];
  const { rest, account } = readAccount(raw, accounts);
  let parsed = parseOne(rest, options);
  // `saved 500 laptop @telebirr`: the money comes from Telebirr.
  if (parsed.kind === "saving" && account) return { ...parsed, account: account.id };
  // "got 5000 @telebirr": without the account nothing names the money, so
  // read the whole line and keep the account.
  if (!isMoney(parsed) && account) {
    const whole = parseOne(raw, options);
    if (!isMoney(whole)) return whole;
    parsed = {
      ...whole,
      description:
        whole.description.replace(/(?:^|\s)@[\p{L}\p{N}_-]+/gu, "").trim() || whole.description,
    };
  }
  if (!isMoney(parsed)) return parsed;
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
  const { rest: untagged, area: tag } = readTag(body);
  const area = tag ? (areaNamed(tag, options.areas ?? [])?.id ?? tag) : undefined;

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
      return withArea(readTask(untagged, nowMs, clockStyle, options.areas), area);
    default:
      break;
  }

  // Income: "got 18k job a", "received 5000 freelance", "earned 3000 tutoring".
  const got = /^(?:got paid|got|received|earned)\s+(.+)$/i.exec(untagged);
  if (got?.[1]) {
    // "got 5000" with nothing after it is income all the same.
    const bare = /^\S+$/.test(got[1].trim()) ? parseAmount(got[1].trim()) : null;
    const money = readMoney(got[1], true) ?? (bare ? { label: "income", amount: bare } : undefined);
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

  const task = readTask(untagged, nowMs, clockStyle, options.areas);
  const firstWord = untagged.split(" ")[0]?.toLowerCase() ?? "";
  if (task.kind === "task" && (task.dueDate || TASK_VERBS.has(firstWord) || area || task.area)) {
    return withArea(task, area);
  }
  return withArea({ kind: "inbox", body: untagged }, area);
}

/** A repeat at the end of a task: `every fri`, `monthly 1`, `every weekday`, `daily`. */
const REPEAT_TAIL =
  /\s+((?:every|weekly|monthly|daily)\b(?:\s+(?:on\s+)?(?:the\s+)?[\w,]+(?:\s*(?:,|and)\s*\w+)*)?)$/i;

type AreaOption = NonNullable<ParseOptions["areas"]>[number];

/**
 * The area or job a name means: its id (`joba`), its whole name (`Job A`,
 * `job a`) or, when only one area starts with it, its first word (`coding`
 * for Coding skills). Names only: nothing is guessed from other words.
 */
export function areaNamed(words: string, areas: AreaOption[]): AreaOption | undefined {
  const key = squash(words);
  if (!key) return undefined;
  const exact = areas.find((area) => area.id === key || squash(area.name) === key);
  if (exact) return exact;
  const first = areas.filter((area) => squash(area.name.split(/\s+/)[0] ?? "") === key);
  return first.length === 1 ? first[0] : undefined;
}

/** `update CV for job hunt`: a trailing `for <area or job>` names the area and leaves the title. */
function readForArea(title: string, areas: AreaOption[]): { rest: string; area?: string } {
  const match = /\s+for\s+(.+)$/i.exec(title);
  const area = match?.[1] ? areaNamed(match[1], areas) : undefined;
  if (!match || !area) return { rest: title };
  const rest = title.slice(0, match.index).trim();
  // "pay for gym": a bare verb says too little, so the title stays whole.
  return { rest: TASK_VERBS.has(rest.toLowerCase()) ? title : rest, area: area.id };
}

const CONNECTOR_TAIL = /\s+(?:by|on|at|before|due|from)$/i;

function readTask(
  raw: string,
  nowMs: number,
  clockStyle: ClockStyle,
  areas: AreaOption[] = [],
): Extract<Parsed, { kind: "task" }> {
  // `t: timesheet every fri`: the repeat comes off before the date words.
  const tail = REPEAT_TAIL.exec(raw);
  const rule = tail?.[1] ? parseRule(tail[1]) : null;
  if (rule && tail) {
    const task = readTask(raw.slice(0, tail.index), nowMs, clockStyle, areas);
    task.repeat = rule;
    if (!task.dueDate) {
      const first = onOrAfter(rule, logicalDate(nowMs));
      if (first) task.dueDate = first;
    }
    return task;
  }
  // Only a marked estimate (`~3h`, `about 2 hours`) on a task: a bare "2h" is too
  // easily part of the title.
  const estimate = MARKED_ESTIMATE.exec(raw);
  const minutes = estimate ? Math.round(Number(estimate[1]) * 60) : 0;
  const text =
    minutes > 0 && estimate ? raw.replace(estimate[0], " ").replace(/\s+/g, " ").trim() : raw;
  const taskLine = TASK_VERBS.has(text.trim().split(/\s+/)[0]?.toLowerCase() ?? "");
  const when = readWhen(text, nowMs, clockStyle, { taskLine });
  // "build CLI tool by 20 dec" → "build CLI tool".
  let title = when.date ? when.rest.replace(CONNECTOR_TAIL, "") : when.rest;
  const named = readForArea(title, areas);
  title = named.rest.replace(CONNECTOR_TAIL, "");
  const task: Extract<Parsed, { kind: "task" }> = { kind: "task", title: title || text };
  // A range (`3-4:30pm`) or `for 45 min` is how long it takes, unless `~2h` said so.
  const length = minutes > 0 ? minutes : (when.durationMin ?? 0);
  if (length > 0) task.estimateMin = length;
  if (when.date) task.dueDate = when.date;
  if (when.date && when.minutes !== undefined) task.dueAt = localToEpoch(when.date, when.minutes);
  if (when.window) task.plannedWindow = when.window;
  if (named.area) task.area = named.area;
  return task;
}
