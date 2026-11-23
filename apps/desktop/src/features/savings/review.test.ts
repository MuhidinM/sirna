import { type DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { type Op } from "../../kernel/db";
import { migrations, openTestDb } from "../../test/sqlite";
import {
  type AccountRow,
  ACCOUNTS_SQL,
  readSavingsSince,
  SAVINGS_SINCE_SQL,
  savingsOps,
} from "../money/accounts";
import { safeToSpend } from "../money/safe";
import {
  addGoalOps,
  type GoalRow,
  GOALS_SQL,
  moveOps,
  ORPHAN_SAVINGS_SQL,
  SAVINGS_TRANSFERS_SQL,
  type SavingsTransfer,
  savingsSyncOps,
  takeOutOps,
  UNASSIGNED_SQL,
} from "./savings";

type Input = string | number | null;
const NOW = Date.parse("2026-11-23T09:00:00Z");
const TODAY = "2026-11-23";

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
      const columns = [...names, ...stamps];
      db.prepare(
        `INSERT INTO ${op.table} (${key}, ${columns.join(", ")}) VALUES (?, ${columns.map(() => "?").join(", ")})`,
      ).run(op.id, ...values, ...stamps.map(() => NOW));
    } else {
      db.prepare(
        `UPDATE ${op.table} SET ${names.map((n) => `${n} = ?`).join(", ")} WHERE ${key} = ?`,
      ).run(...values, op.id);
    }
  }
}

const accounts = (db: DatabaseSync) => db.prepare(ACCOUNTS_SQL).all() as unknown as AccountRow[];
const goals = (db: DatabaseSync) => db.prepare(GOALS_SQL).all() as unknown as GoalRow[];
const find = (db: DatabaseSync, id: string) => {
  const row = accounts(db).find((account) => account.id === id);
  if (!row) throw new Error(id);
  return row;
};
const setBalance = (db: DatabaseSync, id: string, minor: number) =>
  db
    .prepare(
      "UPDATE money_accounts SET opening_minor = ?, opening_date = '2026-11-01' WHERE id = ?",
    )
    .run(minor, id);
const safe = (db: DatabaseSync) => {
  const waiting = db.prepare(UNASSIGNED_SQL).get() as { minor: number; held: number };
  return safeToSpend({
    accounts: accounts(db),
    goals: goals(db),
    savedThisMonth: {},
    due: [],
    today: TODAY,
    daysInMonth: 30,
    unassigned: waiting.minor,
    unassignedHeld: waiting.held,
  }).total;
};

/** Runs every migration before 0028, then `before`, then 0028 and the rest. */
function migrateAround(before: (db: DatabaseSync) => void): DatabaseSync {
  const db = openTestDb({ migrate: false });
  const all = migrations();
  for (const m of all.filter((m) => m.name < "0028")) db.exec(m.sql);
  before(db);
  for (const m of all.filter((m) => m.name >= "0028")) db.exec(m.sql);
  return db;
}

const move = (db: DatabaseSync, goal: string | null, minor: number, n: number) =>
  apply(
    db,
    moveOps({
      goal: goal ? { id: goal } : null,
      sign: 1,
      amount: minor,
      spend: find(db, "cbo"),
      savings: find(db, "cbo-savings"),
      nowMs: NOW,
      date: TODAY,
      ids: { entry: `e${n}`, halves: [`h${n}a`, `h${n}b`], transfer: `t${n}` },
    }),
  );

describe("time-first money review", () => {
  it("back to spending stops counting the goal's money as held (no double count)", () => {
    const db = openTestDb();
    setBalance(db, "cbo", 1_000_000);
    setBalance(db, "cbo-savings", 0);
    apply(db, addGoalOps({ title: "Laptop", target: "100k" }, TODAY, "g1"));
    move(db, "g1", 300_000, 1);
    move(db, null, 100_000, 2);
    expect(safe(db)).toBe(600_000);
    // CBO savings goes back to spending: its 4,000 is spendable again but still put aside.
    apply(db, savingsOps(find(db, "cbo-savings"), false, null, NOW));
    expect(goals(db)[0]).toMatchObject({ saved_minor: 300_000, held_minor: 0 });
    expect(db.prepare(UNASSIGNED_SQL).get()).toMatchObject({ minor: 100_000, held: 0 });
    expect(safe(db)).toBe(600_000);
  });

  it("take out moves through the savings account only what the goal holds there", () => {
    const db = openTestDb();
    setBalance(db, "cbo", 1_000_000);
    setBalance(db, "cbo-savings", 0);
    apply(db, addGoalOps({ title: "Laptop", target: "100k" }, TODAY, "g1"));
    // An old saving with no account: money put aside inside CBO.
    db.prepare(
      "INSERT INTO savings_entries (id, goal_id, occurred_at, local_date, amount_minor, origin, created_at, updated_at) VALUES ('old', 'g1', 0, ?, 200000, 'dashboard', 0, 0)",
    ).run(TODAY);
    move(db, "g1", 100_000, 1);
    const goal = goals(db)[0];
    if (!goal) throw new Error("goal");
    expect(goal).toMatchObject({ saved_minor: 300_000, held_minor: 100_000 });
    const out = takeOutOps({
      goal,
      amount: 250_000,
      spend: find(db, "cbo"),
      savings: find(db, "cbo-savings"),
      nowMs: NOW,
      date: TODAY,
      ids: { entry: "e2", halves: ["h3", "h4"], transfer: "t2", plain: "e3" },
    });
    expect(out).toMatchObject({ moved: 100_000, plain: 150_000 });
    apply(db, out.ops);
    expect(find(db, "cbo-savings").moved_minor).toBe(0);
    expect(find(db, "cbo").moved_minor).toBe(0);
    expect(goals(db)[0]).toMatchObject({ saved_minor: 50_000, held_minor: 0 });
    const plain = db
      .prepare("SELECT account, transfer_id, amount_minor FROM savings_entries WHERE id = 'e3'")
      .get();
    expect(plain).toEqual({ account: null, transfer_id: null, amount_minor: -150_000 });

    // Nothing held: no transfer at all.
    const none = takeOutOps({
      goal: { id: "g1", held_minor: 0 },
      amount: 10_000,
      spend: find(db, "cbo"),
      savings: find(db, "cbo-savings"),
      nowMs: NOW,
      date: TODAY,
      ids: { entry: "e4", halves: ["h5", "h6"], transfer: "t3", plain: "e5" },
    });
    expect(none.moved).toBe(0);
    expect(none.ops.every((op) => op.table === "savings_entries")).toBe(true);

    // All of it held: one transfer, no plain entry.
    const all = takeOutOps({
      goal: { id: "g1", held_minor: 100_000 },
      amount: 100_000,
      spend: find(db, "cbo"),
      savings: find(db, "cbo-savings"),
      nowMs: NOW,
      date: TODAY,
      ids: { entry: "e6", halves: ["h7", "h8"], transfer: "t4", plain: "e7" },
    });
    expect(all).toMatchObject({ moved: 100_000, plain: 0 });
    expect(all.ops.some((op) => op.id === "e7")).toBe(false);
  });

  it("0028 leaves an existing Wise with birr in it in ETB", () => {
    const opening = migrateAround((db) => {
      db.exec(
        "INSERT INTO money_accounts (id, name, kind, pays_in, sort_order, opening_minor, opening_date, created_at, updated_at) VALUES ('w1', 'Wise', 'other', 0, 9, 500000, '2026-11-01', 0, 0)",
      );
    });
    expect(find(opening, "w1").currency).toBe("ETB");
    const entries = migrateAround((db) => {
      db.exec(
        "INSERT INTO money_accounts (id, name, kind, pays_in, sort_order, created_at, updated_at) VALUES ('w2', 'wise', 'other', 0, 9, 0, 0)",
      );
      db.exec(
        "INSERT INTO money_txns (id, account, occurred_at, local_date, amount_minor, description, created_at, updated_at) VALUES ('x', 'w2', 0, '2026-11-02', 1000, 'in', 0, 0)",
      );
    });
    expect(find(entries, "w2").currency).toBe("ETB");
    const empty = migrateAround((db) => {
      db.exec(
        "INSERT INTO money_accounts (id, name, kind, pays_in, sort_order, created_at, updated_at) VALUES ('w3', 'Wise', 'other', 0, 9, 0, 0)",
      );
    });
    expect(find(empty, "w3").currency).toBe("USD");
  });

  it("0028 dates an existing CBO savings account so its past transfers stay as they were", () => {
    const db = migrateAround((db) => {
      db.exec(
        "INSERT INTO money_accounts (id, name, kind, pays_in, sort_order, created_at, updated_at) VALUES ('mine', 'CBO Savings', 'bank', 0, 9, 0, 0)",
      );
      db.exec(
        "INSERT INTO money_txns (id, account, occurred_at, local_date, amount_minor, description, transfer_id, created_at, updated_at) VALUES ('a', 'cbo', 0, '2026-10-01', -300000, 'out', 'tx', 1000, 0), ('b', 'mine', 0, '2026-10-01', 300000, 'in', 'tx', 1000, 0)",
      );
    });
    expect(find(db, "mine").is_savings).toBe(1);
    const since = readSavingsSince(
      (db.prepare(SAVINGS_SINCE_SQL).get() as { value_json: string } | undefined)?.value_json,
    );
    expect(since.mine).toBeGreaterThan(1000);
    apply(db, addGoalOps({ title: "Laptop", target: "100k" }, TODAY, "g1"));
    let n = 0;
    apply(
      db,
      savingsSyncOps({
        transfers: db.prepare(SAVINGS_TRANSFERS_SQL).all() as unknown as SavingsTransfer[],
        orphans: db.prepare(ORPHAN_SAVINGS_SQL).all() as unknown as { id: string }[],
        goals: goals(db),
        since,
        rates: {},
        newId: () => `n${++n}`,
      }),
    );
    expect(goals(db)[0]?.saved_minor).toBe(0);
  });
});
