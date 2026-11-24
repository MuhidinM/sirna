import { type DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { type Op } from "../../kernel/db";
import { openTestDb } from "../../test/sqlite";
import {
  type AccountRow,
  ACCOUNTS_SQL,
  checkCurrency,
  checkPayAccount,
  checkSavings,
  readSavingsSince,
  SAVINGS_SINCE_KEY,
  savingsOps,
  transferOps,
} from "../money/accounts";
import { safeToSpend } from "../money/safe";
import {
  addGoalOps,
  checkMove,
  type GoalRow,
  GOALS_SQL,
  moveOps,
  ORPHAN_SAVINGS_SQL,
  SAVINGS_TRANSFERS_SQL,
  type SavingsTransfer,
  savingsSyncOps,
  UNASSIGNED_SQL,
  claimOps,
  HELD_BY_ACCOUNT_SQL,
  unclaimed,
} from "./savings";

type Input = string | number | null;
const NOW = Date.parse("2026-11-23T09:00:00Z");
const TODAY = "2026-11-23";

/** Applies ops the way db_tx does: inserts, updates, upserts and soft deletes. */
function apply(db: DatabaseSync, ops: Op[]) {
  for (const op of ops) {
    const key = op.table === "core_settings" ? "key" : "id";
    if (op.op === "delete") {
      db.prepare(`UPDATE ${op.table} SET deleted_at = 1 WHERE ${key} = ?`).run(op.id);
      continue;
    }
    const names = Object.keys(op.values);
    const values = Object.values(op.values) as Input[];
    const exists =
      op.op !== "insert" && db.prepare(`SELECT 1 FROM ${op.table} WHERE ${key} = ?`).get(op.id);
    if (op.op === "insert" || !exists) {
      const stamps = op.table === "core_settings" ? ["updated_at"] : ["created_at", "updated_at"];
      db.prepare(
        `INSERT INTO ${op.table} (${key}, ${[...names, ...stamps].join(", ")}) VALUES (?, ${[...names, ...stamps].map(() => "?").join(", ")})`,
      ).run(op.id, ...values, ...stamps.map(() => NOW));
    } else {
      const revive =
        op.op === "upsert" && op.table !== "core_settings" ? ", deleted_at = NULL" : "";
      db.prepare(
        `UPDATE ${op.table} SET ${names.map((n) => `${n} = ?`).join(", ")}${revive} WHERE ${key} = ?`,
      ).run(...values, op.id);
    }
  }
}

const accounts = (db: DatabaseSync) => db.prepare(ACCOUNTS_SQL).all() as unknown as AccountRow[];
const goals = (db: DatabaseSync) => db.prepare(GOALS_SQL).all() as unknown as GoalRow[];
let n = 0;
const newId = () => `id${++n}`;

/** What the Savings page does on load: turn transfers into savings into savings. */
function sync(db: DatabaseSync, since: Record<string, number> = {}) {
  apply(
    db,
    savingsSyncOps({
      transfers: db.prepare(SAVINGS_TRANSFERS_SQL).all() as unknown as SavingsTransfer[],
      orphans: db.prepare(ORPHAN_SAVINGS_SQL).all() as unknown as { id: string }[],
      goals: goals(db),
      since,
      rates: {},
      newId,
    }),
  );
}

function setBalance(db: DatabaseSync, id: string, minor: number) {
  db.prepare(
    "UPDATE money_accounts SET opening_minor = ?, opening_date = '2026-11-01' WHERE id = ?",
  ).run(minor, id);
}

const find = (db: DatabaseSync, id: string) => {
  const row = accounts(db).find((account) => account.id === id);
  if (!row) throw new Error(id);
  return row;
};

describe("savings accounts back the goals (time-first §4)", () => {
  it("Put aside moves money into the savings account and saves for the goal", () => {
    const db = openTestDb();
    setBalance(db, "cbo", 2_000_000);
    setBalance(db, "cbo-savings", 0);
    apply(db, addGoalOps({ title: "Laptop", target: "100k" }, TODAY, "g1"));
    const ops = moveOps({
      goal: { id: "g1" },
      sign: 1,
      amount: 500_000,
      spend: find(db, "cbo"),
      savings: find(db, "cbo-savings"),
      nowMs: NOW,
      date: TODAY,
      ids: { entry: "e1", halves: ["h1", "h2"], transfer: "t1" },
    });
    apply(db, ops);
    expect(find(db, "cbo").opening_minor + find(db, "cbo").moved_minor).toBe(1_500_000);
    expect(find(db, "cbo-savings").moved_minor).toBe(500_000);
    expect(goals(db)[0]).toMatchObject({ saved_minor: 500_000, held_minor: 500_000 });
    // The sync sees the saving already there and adds nothing.
    sync(db);
    expect(goals(db)[0]?.saved_minor).toBe(500_000);

    // Safe to spend: CBO's 15,000 only; the saving is already out of it.
    const safe = safeToSpend({
      accounts: accounts(db),
      goals: goals(db),
      savedThisMonth: {},
      due: [],
      today: TODAY,
      daysInMonth: 30,
    });
    expect(safe.total).toBe(1_500_000);
    // Cash, CBE, E-birr, telebirr and Wise; CBO savings is not a spending account.
    expect(safe.unknownAccounts).toBe(5);

    // Take out is the reverse.
    apply(
      db,
      moveOps({
        goal: { id: "g1" },
        sign: -1,
        amount: 200_000,
        spend: find(db, "cbo"),
        savings: find(db, "cbo-savings"),
        nowMs: NOW,
        date: TODAY,
        ids: { entry: "e2", halves: ["h3", "h4"], transfer: "t2" },
      }),
    );
    expect(find(db, "cbo-savings").moved_minor).toBe(300_000);
    expect(goals(db)[0]?.saved_minor).toBe(300_000);
  });

  it("refuses a move without a savings account or across currencies", () => {
    const db = openTestDb();
    expect(checkMove(find(db, "cbo"), undefined)).toMatch(/savings/);
    expect(checkMove(find(db, "wise"), find(db, "cbo-savings"))).toMatch(/same currency/);
    expect(checkMove(find(db, "cbo"), find(db, "cbo-savings"))).toBeNull();
  });

  it("a captured transfer into savings counts: one goal gets it, several wait", () => {
    const db = openTestDb();
    apply(db, addGoalOps({ title: "Laptop", target: "100k" }, TODAY, "g1"));
    // The capture box writes a transfer the way capture/ops.ts does: names only.
    const capture = (amount: number, from: string, to: string) =>
      apply(
        db,
        transferOps({
          from: { id: from, name: from },
          to: { id: to, name: to },
          amount,
          date: TODAY,
          nowMs: NOW,
          ids: [newId(), newId()],
          transferId: newId(),
          origin: "capture",
        }),
      );
    capture(200_000, "cbo", "cbo-savings"); // moved 2000 from cbo to cbo savings
    sync(db);
    expect(goals(db)[0]).toMatchObject({ saved_minor: 200_000, held_minor: 200_000 });

    // Two active goals: the next one waits for "Give it to…".
    apply(db, addGoalOps({ title: "Trip", target: "50k" }, TODAY, "g2"));
    capture(100_000, "cbo", "cbo-savings");
    sync(db);
    expect(db.prepare(UNASSIGNED_SQL).get()).toEqual({ minor: 100_000, n: 1, held: 100_000 });
    // Running it again changes nothing.
    sync(db);
    expect(db.prepare(UNASSIGNED_SQL).get()).toMatchObject({ n: 1 });

    // Moving it back out of savings takes it out again.
    capture(50_000, "cbo-savings", "cbo");
    sync(db);
    expect(db.prepare(UNASSIGNED_SQL).get()).toMatchObject({ minor: 50_000, n: 2 });
  });

  it("removes the saving when its transfer is deleted, and brings it back with it", () => {
    const db = openTestDb();
    apply(db, addGoalOps({ title: "Laptop", target: "100k" }, TODAY, "g1"));
    db.prepare(
      "INSERT INTO money_txns (id, account, occurred_at, local_date, amount_minor, description, transfer_id, created_at, updated_at) VALUES ('a', 'cbo', 0, ?1, -300000, 'out', 'tx', 0, 0), ('b', 'cbo-savings', 0, ?1, 300000, 'in', 'tx', 0, 0)",
    ).run(TODAY);
    sync(db);
    expect(goals(db)[0]?.saved_minor).toBe(300_000);
    db.prepare("UPDATE money_txns SET deleted_at = 1 WHERE transfer_id = 'tx'").run();
    sync(db);
    expect(goals(db)[0]?.saved_minor).toBe(0);
    db.prepare("UPDATE money_txns SET deleted_at = NULL WHERE transfer_id = 'tx'").run();
    sync(db);
    expect(goals(db)[0]?.saved_minor).toBe(300_000);
    expect((db.prepare("SELECT count(*) AS n FROM savings_entries").get() as { n: number }).n).toBe(
      1,
    );
  });

  it("brings a saving back with the goal it was given, with several goals", () => {
    const db = openTestDb();
    apply(db, addGoalOps({ title: "Laptop", target: "100k" }, TODAY, "g1"));
    apply(db, addGoalOps({ title: "Trip", target: "50k" }, TODAY, "g2"));
    db.prepare(
      "INSERT INTO money_txns (id, account, occurred_at, local_date, amount_minor, description, transfer_id, created_at, updated_at) VALUES ('a2', 'cbo', 0, ?1, -50000, 'out', 'tx2', 0, 0), ('b2', 'cbo-savings', 0, ?1, 50000, 'in', 'tx2', 0, 0)",
    ).run(TODAY);
    sync(db);
    expect(db.prepare(UNASSIGNED_SQL).get()).toMatchObject({ minor: 50_000, n: 1 });
    db.prepare("UPDATE savings_entries SET goal_id = 'g2' WHERE transfer_id = 'tx2'").run();
    db.prepare("UPDATE money_txns SET deleted_at = 1 WHERE transfer_id = 'tx2'").run();
    sync(db);
    db.prepare("UPDATE money_txns SET deleted_at = NULL WHERE transfer_id = 'tx2'").run();
    sync(db);
    expect(goals(db).find((goal) => goal.id === "g2")?.saved_minor).toBe(50_000);
    expect(db.prepare(UNASSIGNED_SQL).get()).toMatchObject({ minor: 0, n: 0 });
  });

  it("ignores loans, savings-to-savings moves and transfers from before an account was savings", () => {
    const db = openTestDb();
    apply(db, addGoalOps({ title: "Laptop", target: "100k" }, TODAY, "g1"));
    apply(db, savingsOps(find(db, "cbe"), true, null, NOW));
    const insert = db.prepare(
      "INSERT INTO money_txns (id, account, occurred_at, local_date, amount_minor, description, transfer_id, created_at, updated_at) VALUES (?, ?, 0, '2026-11-20', ?, 'x', ?, ?, 0)",
    );
    insert.run("old1", "cash", -1000, "old", NOW - 1);
    insert.run("old2", "cbe", 1000, "old", NOW - 1);
    insert.run("ss1", "cbo-savings", -1000, "ss", NOW);
    insert.run("ss2", "cbe", 1000, "ss", NOW);
    insert.run("loan", "cbe", 1000, "loan:x", NOW);
    const since = readSavingsSince(
      (
        db.prepare("SELECT value_json FROM core_settings WHERE key = ?").get(SAVINGS_SINCE_KEY) as {
          value_json: string;
        }
      ).value_json,
    );
    expect(since).toEqual({ cbe: NOW });
    sync(db, since);
    expect(goals(db)[0]?.saved_minor).toBe(0);
    expect(find(db, "cbe").is_savings).toBe(1);
    apply(db, savingsOps(find(db, "cbe"), false, JSON.stringify(since), NOW));
    expect(find(db, "cbe").is_savings).toBe(0);
  });

  it("guards pay, savings and currency changes", () => {
    const db = openTestDb();
    expect(checkSavings(find(db, "cbo"), true)).toMatch(/Pay lands here/);
    expect(checkSavings(find(db, "cbe"), true)).toBeNull();
    expect(checkPayAccount(find(db, "cbo-savings"))).toMatch(/savings account/);
    expect(checkCurrency(find(db, "cbe"), 0)).toBeNull();
    expect(checkCurrency(find(db, "cbe"), 2)).toMatch(/stays/);
    setBalance(db, "cbe", 100);
    expect(checkCurrency(find(db, "cbe"), 0)).toMatch(/stays/);
  });
});

describe("money already in a savings account (r2-18)", () => {
  const account = (over: Partial<AccountRow>): AccountRow => ({
    id: "cbosaving",
    name: "CBO saving",
    kind: "bank",
    opening_minor: 5_000_000,
    opening_date: "2026-11-23",
    pays_in: 0,
    sort_order: 0,
    moved_minor: 0,
    currency: "ETB",
    is_savings: 1,
    ...over,
  });

  it("is the balance less what goal entries in it hold", () => {
    const held = [{ account: "cbosaving", minor: 1_000_000 }];
    expect(unclaimed([account({})], held, {})).toEqual([
      { account: account({}), minor: 4_000_000 },
    ]);
    // A spending account, a fully held one, or one without a balance: nothing to claim.
    expect(unclaimed([account({ is_savings: 0 })], [], {})).toEqual([]);
    expect(unclaimed([account({})], [{ account: "cbosaving", minor: 5_000_000 }], {})).toEqual([]);
    expect(unclaimed([account({ opening_date: null })], [], {})).toEqual([]);
  });

  it("converts a foreign savings account at its rate, and skips it without one", () => {
    const wise = account({ id: "wise", currency: "USD", opening_minor: 10_000 });
    const rates = { USD: { rate: "132.50", set_on: "2026-11-23" } };
    expect(unclaimed([wise], [], rates)[0]?.minor).toBe(1_325_000);
    expect(unclaimed([wise], [], {})).toEqual([]);
  });

  it("gives it to a goal without moving money", () => {
    const db = openTestDb();
    db.exec(
      "INSERT INTO savings_goals (id, title, target_minor, start_date, status, created_at, updated_at) VALUES ('g', 'Laptop', 100000, '2026-11-01', 'active', 0, 0)",
    );
    apply(db, claimOps("g", "cbosaving", 4_000_000, 1, "2026-11-24", "e1"));
    expect(db.prepare(HELD_BY_ACCOUNT_SQL).all()).toEqual([
      { account: "cbosaving", minor: 4_000_000 },
    ]);
    expect(db.prepare("SELECT count(*) AS n FROM money_txns").get()).toEqual({ n: 0 });
  });
});
