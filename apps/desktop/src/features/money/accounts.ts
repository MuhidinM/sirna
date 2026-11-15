/**
 * Accounts (T-058; proposal 2.1): CBO, CBE, E-birr, telebirr, cash and any
 * you add. A balance is computed, never stored: the opening balance plus every
 * entry from the opening date on. Reconcile books the gap; a transfer is two
 * linked entries kept out of in and out. Pure and tested, integer santim.
 */
import { type Op } from "../../kernel/db";
import { formatAmount, type Santim } from "../../kernel/money";

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
}

export const ACCOUNTS_SQL = `
  SELECT a.id, a.name, a.kind, a.opening_minor, a.opening_date, a.pays_in, a.sort_order,
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

/** What you have in the accounts whose balance is known, and how many are unknown. */
export function totalBalance(accounts: AccountRow[]): { total: Santim; unknown: number } {
  let total = 0;
  let unknown = 0;
  for (const account of accounts) {
    const balance = balanceOf(account);
    if (balance === null) unknown++;
    else total += balance;
  }
  return { total, unknown };
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
        values: { opening_minor: typed - todayMoved, opening_date: today },
      },
    ];
  const gap = typed - balance;
  if (gap === 0) return [];
  return [
    {
      op: "insert",
      table: "money_txns",
      id: newId,
      values: {
        account: account.id,
        occurred_at: nowMs,
        local_date: today,
        amount_minor: gap,
        description: gap < 0 ? "Unrecorded spending" : "Unrecorded income",
        category_id: null,
        origin: "reconcile",
      },
    },
  ];
}

export function reconcileText(account: AccountRow, typed: Santim): string {
  const balance = balanceOf(account);
  if (balance === null) return `${account.name} starts at ${formatAmount(typed)}.`;
  const gap = typed - balance;
  if (gap === 0) return `${account.name} matches: ${formatAmount(typed)}.`;
  return gap < 0
    ? `${formatAmount(-gap)} spent from ${account.name} wasn't recorded; booked as unrecorded spending.`
    : `${formatAmount(gap)} more in ${account.name} than recorded; booked as unrecorded income.`;
}

/** Two linked entries: out of one account, into the other. */
export function transferOps(input: {
  from: Pick<AccountRow, "id" | "name">;
  to: Pick<AccountRow, "id" | "name">;
  amount: Santim;
  date: string;
  nowMs: number;
  ids: [string, string];
  transferId: string;
  origin?: string;
}): Op[] {
  const { from, to, amount, date, nowMs, ids, transferId, origin = "transfer" } = input;
  const half = (id: string, account: string, minor: Santim, description: string): Op => ({
    op: "insert",
    table: "money_txns",
    id,
    values: {
      account,
      occurred_at: nowMs,
      local_date: date,
      amount_minor: minor,
      description,
      category_id: null,
      origin,
      transfer_id: transferId,
    },
  });
  return [
    half(ids[0], from.id, -amount, `Moved to ${to.name}`),
    half(ids[1], to.id, amount, `Moved from ${from.name}`),
  ];
}

export function checkTransfer(fromId: string, toId: string, amount: Santim): string | null {
  if (!fromId || !toId) return "Pick both accounts.";
  if (fromId === toId) return "Pick two different accounts.";
  if (!Number.isSafeInteger(amount) || amount <= 0) return "An amount above zero.";
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
      values: { name: name.trim(), kind, sort_order: last + 1 },
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
    return `${account.name} still holds ${formatAmount(balance)}: move it out first.`;
  if (account.pays_in === 1) return "Pay lands here: pick another account for pay first.";
  const used = regulars.find((regular) => regular.active === 1 && regular.account === account.id);
  if (used) return `${used.name} uses ${account.name}: change it first.`;
  return null;
}

export function hideAccountOps(id: string): Op[] {
  return [{ op: "delete", table: "money_accounts", id }];
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
