/**
 * Accounts (T-058; proposal 2.1): CBO, CBE, E-birr, telebirr, cash and any
 * you add. A balance is computed, never stored: the opening balance plus every
 * entry from the opening date on. Reconcile books the gap; a transfer is two
 * linked entries kept out of in and out. Pure and tested, integer santim.
 */
import { type Op } from "../../kernel/db";
import { formatAmount, type Santim } from "../../kernel/money";
import { type Conversion, convert, exchangeAt, type Rates } from "./currency";

export interface AccountRow {
  id: string;
  name: string;
  kind: "cash" | "bank" | "mobile" | "other";
  opening_minor: number;
  opening_date: string | null;
  pays_in: number;
  sort_order: number;
  /** Entries counted toward the balance (from the opening date, or all). */
  moved_minor: number;
  /** The account's currency; ETB when not given. Its entries are in it too. */
  currency?: string;
  /** 1 = a savings account: backs the goals, left out of safe to spend. */
  is_savings?: number;
}

export const ACCOUNTS_SQL = `
  SELECT a.id, a.name, a.kind, a.opening_minor, a.opening_date, a.pays_in, a.sort_order,
         a.currency, a.is_savings,
         COALESCE((SELECT sum(m.amount_minor) FROM money_txns m
                   WHERE m.account = a.id AND m.deleted_at IS NULL
                     AND (a.opening_date IS NULL OR m.local_date >= a.opening_date)), 0)
           AS moved_minor
  FROM money_accounts a
  WHERE a.deleted_at IS NULL
  ORDER BY a.sort_order, a.name`;

/** Entries in an account on one date (?1 account, ?2 date): for a first balance. */
export const DAY_MOVED_SQL = `SELECT COALESCE(sum(amount_minor), 0) AS minor FROM money_txns
  WHERE account = ?1 AND local_date = ?2 AND deleted_at IS NULL`;

/** The balance, or null until you have typed one. */
export function balanceOf(account: AccountRow): Santim | null {
  return account.opening_date === null ? null : account.opening_minor + account.moved_minor;
}

/**
 * What you have in the accounts whose balance is known, and how many are
 * unknown. A birr savings account with no balance yet still counts what
 * moved into it: money put aside must not drop out of the total (F55).
 */
export function totalBalance(accounts: AccountRow[]): { total: Santim; unknown: number } {
  let total = 0;
  let unknown = 0;
  for (const account of accounts) {
    const balance = balanceOf(account);
    if (balance !== null) total += balance;
    else {
      unknown++;
      if (isSavings(account) && currencyOf(account) === "ETB") total += account.moved_minor;
    }
  }
  return { total, unknown };
}

/**
 * What an account's row shows (F55): its balance; for a birr savings
 * account with no balance yet, the money moved into it, which the total
 * counts, marked as not the whole balance; otherwise null ("not set").
 * More moved out than in says nothing about what it holds: "not set".
 */
export function shownBalance(account: AccountRow): { minor: Santim; partial: boolean } | null {
  const balance = balanceOf(account);
  if (balance !== null) return { minor: balance, partial: false };
  if (isSavings(account) && currencyOf(account) === "ETB" && account.moved_minor > 0)
    return { minor: account.moved_minor, partial: true };
  return null;
}

/** The account's currency (ETB unless set). */
export const currencyOf = (account: Pick<AccountRow, "currency"> | undefined) =>
  account?.currency ?? "ETB";

export const isSavings = (account: Pick<AccountRow, "is_savings">) => account.is_savings === 1;

/** Accounts you spend from: everything but savings accounts. */
export const spending = <T extends Pick<AccountRow, "is_savings">>(accounts: T[]) =>
  accounts.filter((account) => !isSavings(account));

/**
 * The accounts in ETB for totals: a foreign balance converted at its rate,
 * one with no rate left out (and noted in `conversion`). Accounts without a
 * balance stay, so they still count as unknown.
 */
export function inEtb(accounts: AccountRow[], rates: Rates, conversion: Conversion): AccountRow[] {
  return accounts.flatMap((account) => {
    const balance = balanceOf(account);
    const currency = currencyOf(account);
    if (balance === null || currency === "ETB") return [account];
    const etb = convert(conversion, rates, balance, currency);
    if (etb === null) return [];
    return [{ ...account, opening_minor: etb, moved_minor: 0, currency: "ETB" }];
  });
}

export const payAccount = (accounts: Pick<AccountRow, "id" | "pays_in">[]) =>
  accounts.find((account) => account.pays_in === 1)?.id ?? accounts[0]?.id ?? "cash";

export const spendAccount = (accounts: Pick<AccountRow, "id" | "kind">[]) =>
  accounts.find((account) => account.kind === "cash")?.id ?? accounts[0]?.id ?? "cash";

/**
 * Makes the account show the balance you typed. The first time it sets the
 * opening balance at the start of today (today's entries already counted);
 * after that it books the gap as an entry you can see and undo.
 */
export function reconcileOps(
  account: AccountRow,
  typed: Santim,
  today: string,
  todayMoved: Santim,
  nowMs: number,
  newId: string,
): Op[] {
  const balance = balanceOf(account);
  if (balance === null)
    return [
      {
        op: "update",
        table: "money_accounts",
        id: account.id,
        values: { opening_minor: typed - todayMoved, opening_date: today, checked_at: nowMs },
      },
    ];
  // Every check is noted, a matching one too: undoing a capture from before
  // it would move the balance off the number you typed (F65).
  const checked: Op = {
    op: "update",
    table: "money_accounts",
    id: account.id,
    values: { checked_at: nowMs },
  };
  const gap = typed - balance;
  if (gap === 0) return [checked];
  return [
    checked,
    {
      op: "insert",
      table: "money_txns",
      id: newId,
      values: {
        account: account.id,
        occurred_at: nowMs,
        local_date: today,
        amount_minor: gap,
        currency: currencyOf(account),
        description: gap < 0 ? "Unrecorded spending" : "Unrecorded income",
        category_id: null,
        origin: "reconcile",
      },
    },
  ];
}

export function reconcileText(account: AccountRow, typed: Santim): string {
  const balance = balanceOf(account);
  const show = (minor: Santim) => formatAmount(minor, currencyOf(account));
  if (balance === null) return `${account.name} starts at ${show(typed)}.`;
  const gap = typed - balance;
  if (gap === 0) return `${account.name} matches: ${show(typed)}.`;
  return gap < 0
    ? `${show(-gap)} spent from ${account.name} wasn't recorded; booked as unrecorded spending.`
    : `${show(gap)} more in ${account.name} than recorded; booked as unrecorded income.`;
}

/**
 * Two linked entries: out of one account, into the other. Between two
 * currencies, `received` is what arrived (in the other account's currency);
 * without it the same number lands. Each half carries its account's
 * currency when the account says which.
 */
export function transferOps(input: {
  from: Pick<AccountRow, "id" | "name" | "currency">;
  to: Pick<AccountRow, "id" | "name" | "currency">;
  amount: Santim;
  /** What arrived, when the accounts' currencies differ. */
  received?: Santim;
  date: string;
  nowMs: number;
  ids: [string, string];
  transferId: string;
  origin?: string;
}): Op[] {
  const { from, to, amount, date, nowMs, ids, transferId, origin = "transfer" } = input;
  const half = (
    id: string,
    account: Pick<AccountRow, "id" | "currency">,
    minor: Santim,
    description: string,
  ): Op => ({
    op: "insert",
    table: "money_txns",
    id,
    values: {
      account: account.id,
      occurred_at: nowMs,
      local_date: date,
      amount_minor: minor,
      ...(account.currency ? { currency: account.currency } : {}),
      description,
      category_id: null,
      origin,
      transfer_id: transferId,
    },
  });
  return [
    half(ids[0], from, -amount, `Moved to ${to.name}`),
    half(ids[1], to, input.received ?? amount, `Moved from ${from.name}`),
  ];
}

/**
 * A transfer's two halves (time-first §3): the amount is in `typed` (either
 * account's currency; the sending account's when not given), and the other
 * half is worth the same at the saved rate, rounded to the minor unit. With
 * no rate, or a currency neither account is in, it says why instead.
 */
export function transferAmounts(input: {
  from: Pick<AccountRow, "name" | "currency">;
  to: Pick<AccountRow, "name" | "currency">;
  amount: Santim;
  rates: Rates;
  /** The currency typed with the amount (`$200`), if any. */
  typed?: string | undefined;
  /** How it was typed (`$`, `usd`), for "drop the usd". */
  word?: string | undefined;
}): { sent: Santim; received: Santim } | { problem: string } {
  const { from, to, amount, rates } = input;
  const fromCode = currencyOf(from);
  const toCode = currencyOf(to);
  const typed = input.typed ?? fromCode;
  if (typed !== fromCode && typed !== toCode) {
    const word = input.word ?? typed.toLowerCase();
    return {
      problem:
        fromCode === toCode
          ? `${from.name} and ${to.name} are in ${fromCode}; drop the ${word}`
          : `${from.name} is in ${fromCode} and ${to.name} in ${toCode}; drop the ${word}`,
    };
  }
  const other = typed === fromCode ? toCode : fromCode;
  const result = exchangeAt(amount, typed, other, rates);
  if ("missing" in result)
    return { problem: `Set a ${result.missing} rate in Money → Accounts first` };
  if (result.minor <= 0) return { problem: "Too small to move at that rate" };
  return typed === fromCode
    ? { sent: amount, received: result.minor }
    : { sent: result.minor, received: amount };
}

/** `received` is checked when given (between two currencies `transferAmounts` works it out). */
export function checkTransfer(
  fromId: string,
  toId: string,
  amount: Santim,
  received?: Santim | null,
): string | null {
  if (!fromId || !toId) return "Pick both accounts.";
  if (fromId === toId) return "Pick two different accounts.";
  if (!Number.isSafeInteger(amount) || amount <= 0) return "An amount above zero.";
  if (
    received !== undefined &&
    (received === null || !Number.isSafeInteger(received) || received <= 0)
  )
    return "What arrived in the other account, above zero.";
  return null;
}

/** Both halves of a transfer go together. */
export const TRANSFER_HALVES_SQL = `SELECT id FROM money_txns
  WHERE transfer_id = ? AND deleted_at IS NULL`;

// --- Managing accounts ----------------------------------------------------------

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function checkAccountName(
  name: string,
  accounts: AccountRow[],
  selfId?: string,
): string | null {
  if (!name.trim()) return "A name, like Awash or Equb.";
  if (accounts.some((account) => account.id !== selfId && same(account.name, name)))
    return `There is already an account called ${name.trim()}.`;
  return null;
}

/** A short id from the name, so `@awash` works in the capture box. */
export function accountId(name: string, taken: string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "")
      .slice(0, 20) || "account";
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}${n}`;
  return id;
}

export function addAccountOps(
  name: string,
  kind: AccountRow["kind"],
  accounts: AccountRow[],
  currency = "ETB",
  savings = false,
): Op[] {
  const id = accountId(
    name,
    accounts.map((account) => account.id),
  );
  const last = Math.max(0, ...accounts.map((account) => account.sort_order));
  return [
    {
      op: "insert",
      table: "money_accounts",
      id,
      values: {
        name: name.trim(),
        kind,
        sort_order: last + 1,
        currency,
        is_savings: savings ? 1 : 0,
      },
    },
  ];
}

export function renameAccountOps(id: string, name: string): Op[] {
  return [{ op: "update", table: "money_accounts", id, values: { name: name.trim() } }];
}

/**
 * Why an account can't be hidden yet: hiding drops it from every total, so
 * it must be empty, not where pay lands, and not used by a bill or pay day.
 */
export function checkHide(
  account: AccountRow,
  regulars: { account: string; name: string; active: number }[],
): string | null {
  const balance = balanceOf(account);
  if (balance !== null && balance !== 0)
    return `${account.name} still holds ${formatAmount(balance, currencyOf(account))}: move it out first.`;
  if (account.pays_in === 1) return "Pay lands here: pick another account for pay first.";
  const used = regulars.find((regular) => regular.active === 1 && regular.account === account.id);
  if (used) return `${used.name} uses ${account.name}: change it first.`;
  return null;
}

export function hideAccountOps(id: string): Op[] {
  return [{ op: "delete", table: "money_accounts", id }];
}

/** Pay can't land in a savings account: it is money to spend. */
export function checkPayAccount(account: AccountRow): string | null {
  return isSavings(account) ? `${account.name} is a savings account: pay can't land there.` : null;
}

/** Income lands in this account unless the capture says otherwise. */
export function setPayAccountOps(id: string, accounts: AccountRow[]): Op[] {
  return accounts
    .filter((account) => (account.id === id) !== (account.pays_in === 1))
    .map((account) => ({
      op: "update",
      table: "money_accounts",
      id: account.id,
      values: { pays_in: account.id === id ? 1 : 0 },
    }));
}

// --- Savings accounts and currency ------------------------------------------------

/** When each account became a savings account (epoch ms by id). */
export const SAVINGS_SINCE_KEY = "money.savings_since";
export const SAVINGS_SINCE_SQL = `SELECT value_json FROM core_settings WHERE key = '${SAVINGS_SINCE_KEY}'`;

export function readSavingsSince(json: string | null | undefined): Record<string, number> {
  try {
    const value = JSON.parse(json ?? "null") as unknown;
    if (!value || typeof value !== "object") return {};
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).filter(
        (entry): entry is [string, number] => typeof entry[1] === "number",
      ),
    );
  } catch {
    return {};
  }
}

export function checkSavings(account: AccountRow, on: boolean): string | null {
  if (on && account.pays_in === 1) return "Pay lands here: pick another account for pay first.";
  return null;
}

/**
 * Marks an account as savings, or back to spending. The moment is kept, so
 * only transfers from then on count as saving; older ones stay as they were.
 */
export function savingsOps(
  account: Pick<AccountRow, "id">,
  on: boolean,
  sinceJson: string | null | undefined,
  nowMs: number,
): Op[] {
  const since = Object.fromEntries(
    Object.entries(readSavingsSince(sinceJson)).filter(([id]) => id !== account.id),
  );
  if (on) since[account.id] = nowMs;
  return [
    { op: "update", table: "money_accounts", id: account.id, values: { is_savings: on ? 1 : 0 } },
    {
      op: "upsert",
      table: "core_settings",
      id: SAVINGS_SINCE_KEY,
      values: { value_json: JSON.stringify(since) },
    },
  ];
}

/** Entries recorded in an account (any date), for checkCurrency. */
export const ACCOUNT_TXN_COUNT_SQL = `SELECT count(*) AS n FROM money_txns
  WHERE account = ? AND deleted_at IS NULL`;

/** An account's currency can change only while nothing is recorded in it. */
export function checkCurrency(account: AccountRow, entries: number): string | null {
  const balance = balanceOf(account);
  if ((balance !== null && balance !== 0) || entries > 0)
    return `${account.name} already has money recorded: its currency stays.`;
  return null;
}

export function currencyOps(id: string, currency: string): Op[] {
  return [{ op: "update", table: "money_accounts", id, values: { currency } }];
}
