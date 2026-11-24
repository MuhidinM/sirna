/**
 * Money lent and owed (T-061; your answer 4): who owes you, whom you owe,
 * partial repayments and a follow-up date. Each event also moves money in an
 * account, kept out of in and out. Pure and tested, integer santim.
 */
import { type Op } from "../../kernel/db";
import { showDate } from "../../kernel/dates";
import { formatAmount, type Santim } from "../../kernel/money";
import { type Conversion, convert, type Rates, rowCurrencySql } from "./currency";

export type LoanKind = "lent" | "borrowed" | "paid_me" | "i_paid";

export interface LoanEvent {
  id: string;
  person: string;
  kind: LoanKind;
  amount_minor: number;
  local_date: string;
  account: string;
  note: string | null;
  follow_up_date: string | null;
  /** The account's currency (ETB when not given): a loan is kept per currency. */
  currency?: string | null;
}

export const LOANS_SQL = `SELECT l.id, l.person, l.kind, l.amount_minor, l.local_date, l.account,
    l.note, l.follow_up_date, ${rowCurrencySql("l")} AS currency
  FROM money_loans l LEFT JOIN money_accounts acc ON acc.id = l.account
  WHERE l.deleted_at IS NULL ORDER BY l.local_date, l.created_at`;

export interface PersonBalance {
  /** As first typed. */
  person: string;
  /** Open: they owe you. */
  owedToMe: Santim;
  /** Open: you owe them. */
  iOwe: Santim;
  /** The oldest still-open lending or borrowing date. */
  since: string | null;
  /** The latest follow-up date set, if any. */
  followUp: string | null;
  events: LoanEvent[];
  /** Amounts are in this currency: the same person in two currencies is two lines. */
  currency?: string;
}

export const personKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, " ");

type Lot = { date: string; left: number; mine: boolean; account: string };

/** Each person and currency's events, with the amounts still open, oldest first. */
function openLots(events: LoanEvent[]): Map<string, PersonBalance & { lots: Lot[] }> {
  const people = new Map<string, PersonBalance & { lots: Lot[] }>();
  for (const event of [...events].sort((a, b) => a.local_date.localeCompare(b.local_date))) {
    const currency = event.currency ?? "ETB";
    const key = `${personKey(event.person)}|${currency}`;
    let person = people.get(key);
    if (!person) {
      person = {
        person: event.person.trim(),
        owedToMe: 0,
        iOwe: 0,
        since: null,
        followUp: null,
        events: [],
        currency,
        lots: [],
      };
      people.set(key, person);
    }
    person.events.push(event);
    if (event.follow_up_date && (!person.followUp || event.follow_up_date > person.followUp))
      person.followUp = event.follow_up_date;
    // Net position: positive = they owe me.
    const sign = event.kind === "lent" || event.kind === "i_paid" ? 1 : -1;
    let amount = event.amount_minor;
    // Settle against open lots on the other side first, oldest first.
    for (const lot of person.lots) {
      if (amount === 0) break;
      if (lot.left === 0 || lot.mine === sign > 0) continue;
      const take = Math.min(lot.left, amount);
      lot.left -= take;
      amount -= take;
    }
    if (amount > 0)
      person.lots.push({
        date: event.local_date,
        left: amount,
        mine: sign > 0,
        account: event.account,
      });
  }
  return people;
}

/**
 * What you still owe, per currency, counting only debts whose money came into
 * one of `accounts`. Repayments settle from every account, so a borrow into
 * Cash paid back from Telebirr is cleared even when Telebirr isn't counted.
 */
export function owedThrough(
  events: LoanEvent[],
  accounts: ReadonlySet<string>,
): { currency: string; amount: number }[] {
  return [...openLots(events).values()]
    .map((person) => ({
      currency: person.currency ?? "ETB",
      amount: person.lots
        .filter((lot) => !lot.mine && accounts.has(lot.account))
        .reduce((sum, lot) => sum + lot.left, 0),
    }))
    .filter((debt) => debt.amount > 0);
}

/**
 * Open amounts per person. Repayments clear the oldest first, so "since" is
 * the date of the oldest amount still open. Paying back more than was lent
 * turns the rest the other way (they now owe you less, or you owe them).
 * Dollars and birr never settle each other: each currency is its own line.
 */
export function balances(events: LoanEvent[]): PersonBalance[] {
  const people = openLots(events);
  return [...people.values()]
    .map(({ lots, ...person }) => {
      const open = lots.filter((lot) => lot.left > 0);
      return {
        ...person,
        owedToMe: open.filter((lot) => lot.mine).reduce((sum, lot) => sum + lot.left, 0),
        iOwe: open.filter((lot) => !lot.mine).reduce((sum, lot) => sum + lot.left, 0),
        since: open[0]?.date ?? null,
      };
    })
    .sort(
      (a, b) => (a.since ?? "9").localeCompare(b.since ?? "9") || a.person.localeCompare(b.person),
    );
}

/** "abel" reads as a name: "Abel" (F108). */
const named = (person: string) => person.charAt(0).toUpperCase() + person.slice(1);

const VERB: Record<LoanKind, (person: string) => string> = {
  lent: (person) => `Lent to ${named(person)}`,
  borrowed: (person) => `Borrowed from ${named(person)}`,
  paid_me: (person) => `${named(person)} paid back`,
  i_paid: (person) => `Paid back ${named(person)}`,
};

/** The event, and the money it moves in an account (kept out of in and out). */
export function loanOps(input: {
  person: string;
  kind: LoanKind;
  amount: Santim;
  date: string;
  account: string;
  nowMs: number;
  id: string;
  txnId: string;
  note?: string | null;
  followUp?: string | null;
  /** The account's currency. */
  currency?: string;
}): Op[] {
  const out = input.kind === "lent" || input.kind === "i_paid";
  const currency = input.currency ? { currency: input.currency } : {};
  return [
    {
      op: "insert",
      table: "money_loans",
      id: input.id,
      values: {
        person: input.person.trim(),
        kind: input.kind,
        amount_minor: input.amount,
        local_date: input.date,
        account: input.account,
        note: input.note ?? null,
        follow_up_date: input.followUp ?? null,
        ...currency,
      },
    },
    {
      op: "insert",
      table: "money_txns",
      id: input.txnId,
      values: {
        account: input.account,
        occurred_at: input.nowMs,
        local_date: input.date,
        amount_minor: out ? -input.amount : input.amount,
        description: VERB[input.kind](input.person.trim()),
        category_id: null,
        origin: "loan",
        transfer_id: `loan:${input.id}`,
        ...currency,
      },
    },
  ];
}

export function checkLoan(person: string, amount: Santim): string | null {
  if (!person.trim()) return "Who: a name.";
  if (!Number.isSafeInteger(amount) || amount <= 0) return "An amount above zero.";
  return null;
}

/**
 * Paying back more than is open would flip the rest into a debt the other
 * way without a word (F24): refuse it and say how much is open.
 */
export function checkRepayment(
  person: Pick<PersonBalance, "person" | "owedToMe" | "iOwe" | "currency">,
  amount: Santim,
): string | null {
  const theyOwe = person.owedToMe > 0;
  const open = theyOwe ? person.owedToMe : person.iOwe;
  if (amount <= open) return null;
  const currency = person.currency ?? "ETB";
  const name = named(person.person);
  const said = theyOwe
    ? `${name} owes you ${formatAmount(open, currency)}`
    : `You owe ${name} ${formatAmount(open, currency)}`;
  return `${said}, not ${formatAmount(amount, currency)}. Pay back up to that, and add the rest as a new loan.`;
}

export function followUpOps(eventId: string, date: string | null): Op[] {
  return [{ op: "update", table: "money_loans", id: eventId, values: { follow_up_date: date } }];
}

/**
 * One follow-up date per person: set on the latest event, cleared on the
 * others, so it can be moved earlier or removed.
 */
export function personFollowUpOps(person: PersonBalance, date: string | null): Op[] {
  const last = person.events[person.events.length - 1];
  if (!last) return [];
  return person.events.flatMap((event) =>
    event.id === last.id
      ? followUpOps(event.id, date)
      : event.follow_up_date !== null
        ? followUpOps(event.id, null)
        : [],
  );
}

/** The loan event behind a ledger entry (`transfer_id = loan:<id>`), if it is one. */
export const loanIdOf = (transferId: string | null | undefined) =>
  transferId?.startsWith("loan:") ? transferId.slice(5) : null;

export const LOAN_SQL = `SELECT id, person, kind, amount_minor, local_date, account, note,
    follow_up_date, currency
  FROM money_loans WHERE id = ?`;

/** Puts a deleted loan event back as it was. */
export function loanRestoreOps(event: LoanEvent): Op[] {
  return [
    {
      op: "upsert",
      table: "money_loans",
      id: event.id,
      values: {
        person: event.person,
        kind: event.kind,
        amount_minor: event.amount_minor,
        local_date: event.local_date,
        account: event.account,
        note: event.note,
        follow_up_date: event.follow_up_date,
        ...(event.currency ? { currency: event.currency } : {}),
      },
    },
  ];
}

/** "Abel owes you 600 ETB since 1 Nov" for the brief, when a follow-up is due. */
export function followUpLines(people: PersonBalance[], today: string): string[] {
  return people
    .filter((person) => person.followUp !== null && person.followUp <= today)
    .filter((person) => person.owedToMe > 0 || person.iOwe > 0)
    .map((person) =>
      person.owedToMe > 0
        ? `${person.person} owes you ${formatAmount(person.owedToMe, person.currency ?? "ETB")} since ${person.since ? showDate(person.since, today) : "?"}`
        : `You owe ${person.person} ${formatAmount(person.iOwe, person.currency ?? "ETB")} since ${person.since ? showDate(person.since, today) : "?"}`,
    );
}

export function loanEchoText(
  kind: LoanKind,
  person: string,
  amount: Santim,
  open: Santim | null,
  currency = "ETB",
): string {
  const base = `${VERB[kind](person)} · ${formatAmount(amount, currency)}`;
  if (open === null) return base;
  if (kind === "paid_me")
    return open > 0 ? `${base} · ${formatAmount(open, currency)} still open` : `${base} · settled`;
  if (kind === "i_paid")
    return open > 0
      ? `${base} · you still owe ${formatAmount(open, currency)}`
      : `${base} · settled`;
  return base;
}

/** Owed to you less what you owe, in ETB: other currencies at their rate, or left out. */
export function owedInEtb(people: PersonBalance[], rates: Rates, conversion: Conversion): Santim {
  return people.reduce(
    (sum, person) =>
      sum + (convert(conversion, rates, person.owedToMe - person.iOwe, person.currency) ?? 0),
    0,
  );
}

/** What is open with one person in one currency. */
export interface OpenLoan {
  currency: string;
  owedToMe: Santim;
  iOwe: Santim;
}

/**
 * People with an open loan for the capture parser, each name once: someone
 * owing in birr and in dollars is one person (owing either way in any
 * currency is enough to read "abel paid back 400"). `open` keeps each
 * currency apart, so a repayment lands in the loan's currency and can't
 * go past what is owed (F24, F27).
 */
export function loanPeople(
  people: Pick<PersonBalance, "person" | "owedToMe" | "iOwe" | "currency">[],
): { name: string; owedToMe: number; iOwe: number; open: OpenLoan[] }[] {
  const byKey = new Map<
    string,
    { name: string; owedToMe: number; iOwe: number; open: OpenLoan[] }
  >();
  for (const person of people) {
    const key = personKey(person.person);
    const line = {
      currency: person.currency ?? "ETB",
      owedToMe: person.owedToMe,
      iOwe: person.iOwe,
    };
    const seen = byKey.get(key);
    if (seen) {
      seen.owedToMe = Math.max(seen.owedToMe, person.owedToMe);
      seen.iOwe = Math.max(seen.iOwe, person.iOwe);
      seen.open.push(line);
    } else
      byKey.set(key, {
        name: person.person,
        owedToMe: person.owedToMe,
        iOwe: person.iOwe,
        open: [line],
      });
  }
  return [...byKey.values()];
}
