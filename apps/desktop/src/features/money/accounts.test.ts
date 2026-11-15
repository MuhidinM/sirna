import { describe, expect, it } from "vitest";

import { echo, toOps } from "../../capture/ops";
import { type ParseOptions, parseCapture } from "../../capture/parse";
import { type Op } from "../../kernel/db";
import { openTestDb } from "../../test/sqlite";
import {
  accountId,
  type AccountRow,
  ACCOUNTS_SQL,
  addAccountOps,
  balanceOf,
  checkAccountName,
  checkTransfer,
  DAY_MOVED_SQL,
  payAccount,
  reconcileOps,
  reconcileText,
  setPayAccountOps,
  spendAccount,
  totalBalance,
  TRANSFER_HALVES_SQL,
  transferOps,
} from "./accounts";
import { monthSummary, type TxnRow, TXNS_SQL } from "./money";

type Db = ReturnType<typeof openTestDb>;
const TODAY = "2026-11-14";
const nowMs = Date.parse(`${TODAY}T12:00:00+03:00`);

/** Applies ops the way db_tx does (inserts, updates, soft deletes). */
function apply(db: Db, ops: Op[]) {
  for (const op of ops) {
    if (op.op === "delete") {
      db.prepare(`UPDATE ${op.table} SET deleted_at = 1 WHERE id = ?`).run(op.id);
      continue;
    }
    const cols = Object.keys(op.values);
    const vals = Object.values(op.values) as (string | number | null)[];
    if (op.op === "insert")
      db.prepare(
        `INSERT INTO ${op.table} (id, ${cols.join(", ")}, created_at, updated_at) VALUES (?, ${cols.map(() => "?").join(", ")}, 0, 0)`,
      ).run(op.id, ...vals);
    else
      db.prepare(
        `UPDATE ${op.table} SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`,
      ).run(...vals, op.id);
  }
}
const accounts = (db: Db) => db.prepare(ACCOUNTS_SQL).all() as unknown as AccountRow[];
const account = (db: Db, id: string) => {
  const found = accounts(db).find((row) => row.id === id);
  if (!found) throw new Error(`no ${id}`);
  return found;
};
let n = 0;
const id = () => `x${++n}`;
function spend(db: Db, acc: string, date: string, minor: number) {
  db.prepare(
    "INSERT INTO money_txns (id, account, occurred_at, local_date, amount_minor, description, created_at, updated_at) VALUES (?, ?, 0, ?, ?, 'thing', 0, 0)",
  ).run(id(), acc, date, minor);
}

describe("your accounts (T-058)", () => {
  it("starts with CBO, CBE, E-birr, telebirr and cash; pay goes to CBO", () => {
    const db = openTestDb();
    expect(accounts(db).map((row) => row.name)).toEqual([
      "Cash",
      "CBO",
      "CBE",
      "E-birr",
      "telebirr",
    ]);
    expect(payAccount(accounts(db))).toBe("cbo");
    expect(spendAccount(accounts(db))).toBe("cash");
    expect(totalBalance(accounts(db))).toEqual({ total: 0, unknown: 5 });
  });

  it("sets a first balance at the start of today, counting today's entries", () => {
    const db = openTestDb();
    spend(db, "cbe", "2026-11-01", -50_000); // before: not part of the balance
    spend(db, "cbe", TODAY, -10_000);
    const [moved] = db.prepare(DAY_MOVED_SQL).all("cbe", TODAY) as { minor: number }[];
    const ops = reconcileOps(account(db, "cbe"), 2_000_000, TODAY, moved?.minor ?? 0, nowMs, id());
    expect(reconcileText(account(db, "cbe"), 2_000_000)).toBe("CBE starts at 20,000 ETB.");
    apply(db, ops);
    expect(balanceOf(account(db, "cbe"))).toBe(2_000_000);
    spend(db, "cbe", "2026-11-15", -30_000);
    expect(balanceOf(account(db, "cbe"))).toBe(1_970_000);
  });

  it("books the gap when the bank shows a different balance", () => {
    const db = openTestDb();
    apply(db, reconcileOps(account(db, "cbo"), 1_000_000, TODAY, 0, nowMs, id()));
    expect(reconcileText(account(db, "cbo"), 940_000)).toMatch(/600 ETB spent from CBO/);
    apply(db, reconcileOps(account(db, "cbo"), 940_000, TODAY, 0, nowMs, "gap"));
    expect(balanceOf(account(db, "cbo"))).toBe(940_000);
    const [gap] = db.prepare(TXNS_SQL).all("2026-11-01", "2026-11-30") as unknown as TxnRow[];
    expect(gap).toMatchObject({
      amount_minor: -60_000,
      description: "Unrecorded spending",
      account_name: "CBO",
    });
    // It counts as spending in the month.
    expect(monthSummary({ txns: gap ? [gap] : [], saved: 0, history: [], today: TODAY }).out).toBe(
      60_000,
    );
    expect(reconcileOps(account(db, "cbo"), 940_000, TODAY, 0, nowMs, "none")).toEqual([]);
    expect(reconcileText(account(db, "cbo"), 1_000_000)).toMatch(/more in CBO/);
  });

  it("moves money between accounts without counting it as in or out", () => {
    const db = openTestDb();
    apply(db, reconcileOps(account(db, "cbe"), 500_000, TODAY, 0, nowMs, id()));
    apply(db, reconcileOps(account(db, "telebirr"), 0, TODAY, 0, nowMs, id()));
    expect(checkTransfer("cbe", "cbe", 100)).toMatch(/different/);
    apply(
      db,
      transferOps({
        from: account(db, "cbe"),
        to: account(db, "telebirr"),
        amount: 200_000,
        date: TODAY,
        nowMs,
        ids: ["t1", "t2"],
        transferId: "tr",
      }),
    );
    expect(balanceOf(account(db, "cbe"))).toBe(300_000);
    expect(balanceOf(account(db, "telebirr"))).toBe(200_000);
    const txns = db.prepare(TXNS_SQL).all("2026-11-01", "2026-11-30") as unknown as TxnRow[];
    expect(monthSummary({ txns, saved: 0, history: [], today: TODAY })).toMatchObject({
      in: 0,
      out: 0,
    });
    expect(db.prepare(TRANSFER_HALVES_SQL).all("tr")).toHaveLength(2);
  });

  it("adds, names and picks the pay account", () => {
    const db = openTestDb();
    expect(checkAccountName("cbe", accounts(db))).toMatch(/already/);
    expect(accountId("Awash Bank", ["cash"])).toBe("awashbank");
    expect(accountId("Cash", ["cash"])).toBe("cash2");
    apply(db, addAccountOps("Awash", "bank", accounts(db)));
    expect(account(db, "awash").sort_order).toBe(6);
    apply(db, setPayAccountOps("awash", accounts(db)));
    expect(payAccount(accounts(db))).toBe("awash");
    expect(accounts(db).filter((row) => row.pays_in === 1)).toHaveLength(1);
  });
});

describe("accounts in the capture box (T-058)", () => {
  const db = openTestDb();
  const options: ParseOptions = { nowMs, accounts: accounts(db) };

  it("takes @account, and defaults spending to cash and income to CBO", () => {
    expect(parseCapture("lunch 120 @telebirr", options)).toMatchObject({
      kind: "expense",
      description: "lunch",
      account: "telebirr",
    });
    expect(parseCapture("@ebirr taxi 40", options)).toMatchObject({ account: "ebirr" });
    expect(parseCapture("lunch 120", options)).toMatchObject({ account: "cash" });
    expect(parseCapture("+18000 salary", options)).toMatchObject({ account: "cbo" });
    expect(echo(parseCapture("lunch 120 @telebirr", options), nowMs)).toBe(
      "120 ETB · Food · telebirr",
    );
    expect(echo(parseCapture("lunch 120", options), nowMs)).toBe("120 ETB · Food");
    const [op] = toOps(parseCapture("lunch 120 @cbe", options), { nowMs, newId: () => "m" });
    expect(op).toMatchObject({ values: { account: "cbe", amount_minor: -12_000 } });
  });

  it("leaves an unknown @word alone", () => {
    expect(parseCapture("email @abel about rent", options).kind).not.toBe("expense");
    expect(parseCapture("lunch 120, taxi 40 @telebirr", options)).toMatchObject({
      kind: "money",
      items: [{ account: "telebirr" }, { account: "telebirr" }],
    });
  });

  it("keeps the account on income that names only an amount", () => {
    expect(parseCapture("got 5000 @telebirr", options)).toMatchObject({
      kind: "income",
      amount: 500_000,
      account: "telebirr",
    });
    expect(parseCapture("+5000 freelance @cbe", options)).toMatchObject({
      kind: "income",
      description: "freelance",
      account: "cbe",
    });
  });

  it("reads a transfer between two of your accounts", () => {
    const parsed = parseCapture("moved 2000 cbe to telebirr", options);
    expect(parsed).toMatchObject({
      kind: "transfer",
      amount: 200_000,
      from: "cbe",
      to: "telebirr",
    });
    expect(echo(parsed, nowMs)).toBe("Moved 2,000 ETB · CBE → telebirr");
    let k = 0;
    const ops = toOps(parsed, { nowMs, newId: () => `o${++k}` });
    expect(ops).toHaveLength(2);
    expect(ops.map((op) => op.op === "insert" && op.values.amount_minor)).toEqual([
      -200_000, 200_000,
    ]);
    expect(parseCapture("transfer 5k from cbo to cash", options)).toMatchObject({
      kind: "transfer",
      amount: 500_000,
    });
    // Not both accounts: not a transfer.
    expect(parseCapture("moved 2000 boxes to the store", options).kind).not.toBe("transfer");
  });
});
