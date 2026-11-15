/**
 * Money lent and owed (T-061; your answer 4): who owes you, whom you owe,
 * partial repayments and a follow-up date. Each event also moves money in an
 * account, kept out of in and out. Pure and tested, integer santim.
 */
import { type Op } from "../../kernel/db";
import { showDate } from "../../kernel/dates";
import { formatAmount, type Santim } from "../../kernel/money";

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
}

export const LOANS_SQL = `SELECT id, person, kind, amount_minor, local_date, account, note, follow_up_date
  FROM money_loans WHERE deleted_at IS NULL ORDER BY local_date, created_at`;

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
}

export const personKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Open amounts per person. Repayments clear the oldest first, so "since" is
 * the date of the oldest amount still open. Paying back more than was lent
 * turns the rest the other way (they now owe you less, or you owe them).
 */
export function balances(events: LoanEvent[]): PersonBalance[] {
  const people = new Map<
    string,
    PersonBalance & { lots: { date: string; left: number; mine: boolean }[] }
  >();
  for (const event of [...events].sort((a, b) => a.local_date.localeCompare(b.local_date))) {
    const key = personKey(event.person);
    let person = people.get(key);
    if (!person) {
      person = {
        person: event.person.trim(),
        owedToMe: 0,
        iOwe: 0,
        since: null,
        followUp: null,
        events: [],
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
    if (amount > 0) person.lots.push({ date: event.local_date, left: amount, mine: sign > 0 });
  }
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

const VERB: Record<LoanKind, (person: string) => string> = {
  lent: (person) => `Lent to ${person}`,
  borrowed: (person) => `Borrowed from ${person}`,
  paid_me: (person) => `${person} paid back`,
  i_paid: (person) => `Paid back ${person}`,
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
}): Op[] {
  const out = input.kind === "lent" || input.kind === "i_paid";
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
      },
    },
  ];
}

export function checkLoan(person: string, amount: Santim): string | null {
  if (!person.trim()) return "Who: a name.";
  if (!Number.isSafeInteger(amount) || amount <= 0) return "An amount above zero.";
  return null;
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

export const LOAN_SQL = `SELECT id, person, kind, amount_minor, local_date, account, note, follow_up_date
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
        ? `${person.person} owes you ${formatAmount(person.owedToMe)} since ${person.since ? showDate(person.since, today) : "?"}`
        : `You owe ${person.person} ${formatAmount(person.iOwe)} since ${person.since ? showDate(person.since, today) : "?"}`,
    );
}

export function loanEchoText(
  kind: LoanKind,
  person: string,
  amount: Santim,
  open: Santim | null,
): string {
  const base = `${VERB[kind](person)} · ${formatAmount(amount)}`;
  if (open === null) return base;
  if (kind === "paid_me")
    return open > 0 ? `${base} · ${formatAmount(open)} still open` : `${base} · settled`;
  if (kind === "i_paid")
    return open > 0 ? `${base} · you still owe ${formatAmount(open)}` : `${base} · settled`;
  return base;
}
