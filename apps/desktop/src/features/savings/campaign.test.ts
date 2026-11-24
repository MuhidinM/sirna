/**
 * Savings fixes from the user-test campaign (F8, F9, F31–F37, F55, F73, F110):
 * goals never go below zero, savings accounts never go below zero, and a
 * claim of money already in an account isn't counted as saving.
 */
import { type DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { echo, type OpsContext, toOps } from "../../capture/ops";
import { type ParseOptions, parseCapture } from "../../capture/parse";
import { type Op } from "../../kernel/db";
import { openTestDb } from "../../test/sqlite";
import { type AccountRow, ACCOUNTS_SQL, totalBalance } from "../money/accounts";
import { SAVED_SQL } from "../money/money";
import { GOAL_MONTH_SQL } from "../money/safe";
import { type Query } from "../projects/capacity";
import {
  addGoalOps,
  checkBringBack,
  checkGoal,
  checkTakeOutFrom,
  claimOps,
  entryOps,
  giveOps,
  GOAL_HELD_SQL,
  goalPace,
  type GoalRow,
  GOALS_SQL,
  goalFinder,
  goalStatusOps,
  HELD_BY_ACCOUNT_SQL,
  loadSavingsContext,
  matchGoal,
  moveOps,
  overclaimed,
  putAsideOps,
  savingGoal,
  savingsSyncOps,
  SAVINGS_TRANSFERS_SQL,
  takeOutOps,
  takeOutRoom,
  transferGoal,
  unclaimed,
  unsetFree,
  WAITING_SQL,
  waitingForNewGoal,
  waitingSplit,
  WEEK_SAVED_SQL,
  writeOffOps,
} from "./savings";

type Input = string | number | null;
const NOW = Date.parse("2026-11-24T09:30:00+03:00");
const TODAY = "2026-11-24";
const rates = { USD: { rate: "130", set_on: TODAY } };

function apply(db: DatabaseSync, ops: Op[]) {
  for (const op of ops) {
    if (op.op === "delete") {
      db.prepare(`UPDATE ${op.table} SET deleted_at = 1 WHERE id = ?`).run(op.id);
      continue;
    }
    const exists =
      op.op !== "insert" && db.prepare(`SELECT 1 FROM ${op.table} WHERE id = ?`).get(op.id);
    if (op.op === "insert" || !exists) {
      const values = { id: op.id, ...op.values, created_at: NOW, updated_at: NOW };
      const names = Object.keys(values);
      db.prepare(
        `INSERT INTO ${op.table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
      ).run(...(Object.values(values) as Input[]));
    } else {
      const names = Object.keys(op.values);
      db.prepare(
        `UPDATE ${op.table} SET ${names.map((n) => `${n} = ?`).join(", ")} WHERE id = ?`,
      ).run(...(Object.values(op.values) as Input[]), op.id);
    }
  }
}

const accounts = (db: DatabaseSync) => db.prepare(ACCOUNTS_SQL).all() as unknown as AccountRow[];
const goals = (db: DatabaseSync) => db.prepare(GOALS_SQL).all() as unknown as GoalRow[];
const goal = (db: DatabaseSync, id: string) => {
  const row = goals(db).find((one) => one.id === id);
  if (!row) throw new Error(id);
  return row;
};
const account = (db: DatabaseSync, id: string) => {
  const row = accounts(db).find((one) => one.id === id);
  if (!row) throw new Error(id);
  return row;
};
const balance = (db: DatabaseSync, id: string) => {
  const row = account(db, id);
  return row.opening_minor + row.moved_minor;
};
const setBalance = (db: DatabaseSync, id: string, minor: number) =>
  db
    .prepare("UPDATE money_accounts SET opening_minor = ?, opening_date = ? WHERE id = ?")
    .run(minor, "2026-11-01", id);
const goalHeld = (db: DatabaseSync) =>
  db.prepare(GOAL_HELD_SQL).all() as unknown as {
    goal_id: string;
    account: string;
    minor: number;
  }[];
const heldBy = (db: DatabaseSync) =>
  db.prepare(HELD_BY_ACCOUNT_SQL).all() as unknown as { account: string; minor: number }[];
const read =
  (db: DatabaseSync): Query =>
  (sql, params) =>
    Promise.resolve(db.prepare(sql).all(...(params ?? [])) as never);

let n = 0;
const ids = () => ({
  entry: `e${++n}`,
  halves: [`h${n}a`, `h${n}b`] as [string, string],
  transfer: `t${n}`,
});

/** Put aside `minor` from CBO into CBO savings for a goal. */
const putAside = (db: DatabaseSync, goalId: string | null, minor: number) =>
  apply(
    db,
    moveOps({
      goal: goalId ? { id: goalId } : null,
      sign: 1,
      amount: minor,
      spend: account(db, "cbo"),
      savings: account(db, "cbo-savings"),
      nowMs: NOW,
      date: TODAY,
      ids: ids(),
    }),
  );

function fresh() {
  const db = openTestDb();
  setBalance(db, "cbo", 8_200_000);
  setBalance(db, "cbo-savings", 0);
  apply(db, addGoalOps({ title: "Laptop", target: "90k" }, "2026-11-01", "laptop"));
  apply(db, addGoalOps({ title: "Test", target: "500k" }, "2026-11-01", "test"));
  return db;
}

/** A capture line saved the way the capture box does it, with the goals' real numbers. */
async function capture(db: DatabaseSync, text: string) {
  const options: ParseOptions = {
    nowMs: NOW,
    accounts: db
      .prepare(
        "SELECT id, name, kind, pays_in, currency, is_savings FROM money_accounts WHERE deleted_at IS NULL ORDER BY sort_order",
      )
      .all() as unknown as NonNullable<ParseOptions["accounts"]>,
    goals: goals(db).map((row) => row.title.toLowerCase()),
    rates,
  };
  const parsed = parseCapture(text, options);
  const context = await loadSavingsContext(read(db), rates);
  const goalOf: OpsContext["goalOf"] = goalFinder(context);
  const savingGoalNow = parsed.kind === "saving" ? goalOf(parsed.goal, parsed.amount) : undefined;
  const ops = toOps(parsed, {
    nowMs: NOW,
    newId: () => `c${++n}`,
    goalOf,
    unclaimed: context.unclaimed,
    unset: context.unset,
    ...(context.transferGoal ? { transferGoal: context.transferGoal } : {}),
    ...(context.waiting ? { waiting: context.waiting } : {}),
    ...(savingGoalNow !== undefined ? { savingGoal: savingGoalNow } : {}),
  });
  apply(db, ops);
  return echo(parsed, NOW, undefined, savingGoalNow);
}

describe("F8: took X from a goal in the capture box", () => {
  it("refuses more than the goal holds and never makes up money", async () => {
    const db = fresh();
    await capture(db, "saved 500 laptop");
    await expect(capture(db, "took 200000 from laptop")).rejects.toBe(
      "That's more than this goal holds.",
    );
    await expect(capture(db, "took 100 from test")).rejects.toBe(
      "That's more than this goal holds.",
    );
    expect(goal(db, "laptop").saved_minor).toBe(50_000);
    expect(goal(db, "test").saved_minor).toBe(0);
    expect(balance(db, "cbo-savings")).toBe(50_000);
  });

  it("moves out of savings only what the goal has there; the rest only lowers the number", async () => {
    const db = fresh();
    apply(db, entryOps("laptop", 5_600_000, NOW, "2026-11-01", "old", "dashboard"));
    await capture(db, "saved 500 laptop");
    await capture(db, "took 2000 from laptop");
    expect(balance(db, "cbo-savings")).toBe(0);
    expect(balance(db, "cbo")).toBe(8_200_000);
    expect(goal(db, "laptop")).toMatchObject({ saved_minor: 5_450_000, held_minor: 0 });
  });

  it("asks for the goal when none is matched", async () => {
    const db = fresh();
    // Test is the only active goal: a misspelt name must not take from it.
    apply(db, goalStatusOps("laptop", "paused"));
    apply(db, entryOps("test", 50_000, NOW, "2026-11-01", "old", "dashboard"));
    await expect(capture(db, "took 500 from lapptop")).rejects.toMatch(/Name the goal/);
    expect(goal(db, "test").saved_minor).toBe(50_000);
  });

  it("takes from the paused or planted goal named, not the only active one", async () => {
    const db = fresh();
    apply(db, entryOps("laptop", 100_000, NOW, "2026-11-01", "old1", "dashboard"));
    apply(db, entryOps("test", 100_000, NOW, "2026-11-01", "old2", "dashboard"));
    apply(db, goalStatusOps("laptop", "paused"));
    await capture(db, "took 500 from laptop");
    expect(goal(db, "laptop").saved_minor).toBe(50_000);
    expect(goal(db, "test").saved_minor).toBe(100_000);
    apply(db, goalStatusOps("laptop", "active"));
    apply(db, goalStatusOps("test", "done"));
    await capture(db, "took 1000 from test");
    expect(goal(db, "test").saved_minor).toBe(0);
    expect(goal(db, "laptop").saved_minor).toBe(50_000);
  });

  it("promises no route in the chip, before the goal's holdings are known", () => {
    const db = fresh();
    const parsed = parseCapture("took 300 from laptop", {
      nowMs: NOW,
      accounts: accounts(db),
      goals: ["laptop"],
    });
    expect(echo(parsed, NOW)).toBe("Took out 300 ETB");
  });

  it("says which part of a take-out moved out of savings", async () => {
    const db = fresh();
    apply(db, entryOps("laptop", 5_600_000, NOW, "2026-11-01", "old", "dashboard"));
    await capture(db, "saved 500 laptop");
    expect(await capture(db, "took 2000 from laptop")).toBe(
      "Took out 2,000 ETB · Laptop · 500 ETB CBO savings → CBO; 1,500 ETB was already in your spending accounts",
    );
    expect(await capture(db, "took 1000 from laptop")).toBe(
      "Took out 1,000 ETB · Laptop · it was already in your spending accounts, so only the goal went down",
    );
  });
});

describe("F9: take out never takes a savings account below zero", () => {
  it("caps the move at what the account really holds after a Check", () => {
    const db = fresh();
    putAside(db, "laptop", 2_000_000);
    // A Check found 15,000: 5,000 went unrecorded. The goal still counts 20,000 there.
    apply(db, [
      {
        op: "insert",
        table: "money_txns",
        id: "check",
        values: {
          account: "cbo-savings",
          occurred_at: NOW,
          local_date: TODAY,
          amount_minor: -500_000,
          description: "Unrecorded spending",
          origin: "reconcile",
        },
      },
    ]);
    const laptop = goal(db, "laptop");
    const room = takeOutRoom("laptop", account(db, "cbo-savings"), goalHeld(db), {});
    expect(room).toBe(1_500_000);
    expect(checkTakeOutFrom(laptop, 2_500_000, room, "CBO savings")).toBe(
      "That's more than this goal holds.",
    );
    expect(checkTakeOutFrom(laptop, 2_000_000, room, "CBO savings")).toBe(
      "CBO savings holds only 15,000 ETB of this goal.",
    );
    expect(checkTakeOutFrom(laptop, 1_500_000, room, "CBO savings")).toBeNull();
    const out = takeOutOps({
      goal: laptop,
      amount: 1_500_000,
      spend: account(db, "cbo"),
      savings: account(db, "cbo-savings"),
      nowMs: NOW,
      date: TODAY,
      ids: { ...ids(), plain: "p1" },
      available: room,
    });
    apply(db, out.ops);
    expect(balance(db, "cbo-savings")).toBe(0);
  });

  it("only what the goal holds in the chosen account, not in another one", () => {
    const db = fresh();
    db.exec("UPDATE money_accounts SET is_savings = 1 WHERE id = 'wise'");
    setBalance(db, "wise", 10_000);
    apply(db, claimOps("laptop", "wise", 1_300_000, NOW, TODAY, "w1"));
    const laptop = goal(db, "laptop");
    expect(laptop.held_minor).toBe(1_300_000);
    const room = takeOutRoom("laptop", account(db, "cbo-savings"), goalHeld(db), rates);
    expect(room).toBe(0);
    expect(checkTakeOutFrom(laptop, 500_000, room, "CBO savings")).toMatch(/holds only 0 ETB/);
  });
});

describe("F31: giving money already in a savings account isn't saving", () => {
  it("leaves the month's Saved, the goal's month and the week alone", () => {
    const db = fresh();
    setBalance(db, "cbo-savings", 2_000_000);
    apply(db, claimOps("laptop", "cbo-savings", 500_000, NOW, TODAY, "c1"));
    apply(db, claimOps("test", "cbo-savings", 1_500_000, NOW, TODAY, "c2"));
    expect(db.prepare(SAVED_SQL).get("2026-11-01", "2026-11-30")).toEqual({ minor: 0 });
    expect(db.prepare(GOAL_MONTH_SQL).all("2026-11-01", "2026-11-30")).toEqual([]);
    expect(db.prepare(WEEK_SAVED_SQL).get("2026-11-23", "2026-11-30")).toEqual({ minor: 0 });
    // The goal holds it, but it isn't a month's saving.
    expect(goal(db, "test").saved_minor).toBe(1_500_000);
    expect(goalPace(goal(db, "test"), TODAY).averagePerMonth).toBe(0);
    putAside(db, "test", 100_000);
    expect(db.prepare(SAVED_SQL).get("2026-11-01", "2026-11-30")).toEqual({ minor: 100_000 });
  });
});

describe("F32: money out of savings after a goal is in the garden", () => {
  it("comes from the finished goal that holds it, not the growing one", () => {
    expect(
      savingGoal(
        [
          { id: "laptop", status: "active", saved_minor: 5_600_000 },
          { id: "test", status: "done", saved_minor: 100_000 },
        ],
        -100_000,
      ),
    ).toBe("test");
    // Two finished goals could have it: it waits for "Give it to…".
    expect(
      savingGoal(
        [
          { id: "a", status: "done", saved_minor: 100_000 },
          { id: "b", status: "done", saved_minor: 100_000 },
          { id: "c", status: "active", saved_minor: 0 },
        ],
        -100_000,
      ),
    ).toBeNull();
    // Money going in goes to the only active goal, as before.
    expect(
      savingGoal(
        [
          { id: "laptop", status: "active", saved_minor: 0 },
          { id: "test", status: "done", saved_minor: 100_000 },
        ],
        100_000,
      ),
    ).toBe("laptop");
  });

  it("the repair sync uses the same rule", () => {
    const ops = savingsSyncOps({
      transfers: [
        {
          id: "m1",
          transfer_id: "t",
          amount_minor: -100_000,
          local_date: TODAY,
          occurred_at: NOW,
          account: "cbo-savings",
          created_at: NOW,
          currency: "ETB",
          entry_id: null,
        },
      ],
      orphans: [],
      goals: [
        { id: "laptop", status: "active", saved_minor: 5_600_000 },
        { id: "test", status: "done", saved_minor: 100_000 },
      ],
      since: {},
      rates: {},
      newId: () => "s1",
    });
    expect(ops[0]).toMatchObject({ values: { goal_id: "test", amount_minor: -100_000 } });
  });

  it("in the capture box too", async () => {
    const db = fresh();
    putAside(db, "test", 100_000);
    apply(db, goalStatusOps("test", "done"));
    await capture(db, "moved 1000 from cbo-savings to cbo");
    expect(goal(db, "test").saved_minor).toBe(0);
    expect(goal(db, "laptop").saved_minor).toBe(0);
  });
});

describe("F33: money taken out with several goals", () => {
  it("asks which goal it came from, among goals that hold that much", () => {
    const db = fresh();
    putAside(db, "laptop", 300_000);
    // Moved 1,000 back out of CBO savings with two goals: it waits.
    apply(
      db,
      moveOps({
        goal: null,
        sign: -1,
        amount: 100_000,
        spend: account(db, "cbo"),
        savings: account(db, "cbo-savings"),
        nowMs: NOW,
        date: TODAY,
        ids: ids(),
      }),
    );
    const waiting = db.prepare(WAITING_SQL).all() as unknown as {
      id: string;
      amount_minor: number;
    }[];
    const split = waitingSplit(waiting, goals(db));
    expect(split.saved.ids).toEqual([]);
    expect(split.taken).toMatchObject({ minor: 100_000, goals: ["laptop"] });
  });

  it("gives savings to growing goals only", () => {
    const split = waitingSplit(
      [
        { id: "a", amount_minor: 300_000 },
        { id: "b", amount_minor: -100_000 },
      ],
      [
        { id: "laptop", status: "active", saved_minor: 50_000 },
        { id: "done", status: "done", saved_minor: 200_000 },
      ],
    );
    expect(split.saved).toEqual({ ids: ["a"], minor: 300_000, goals: ["laptop"] });
    expect(split.taken).toEqual({ ids: ["b"], minor: 100_000, goals: ["done"] });
  });
});

describe("F34: a new goal leaves waiting savings alone when goals exist", () => {
  it("takes them only while no goal is growing", () => {
    const waiting = [
      { id: "a", amount_minor: 300_000 },
      { id: "b", amount_minor: -100_000 },
    ];
    expect(waitingForNewGoal([{ status: "active" }, { status: "active" }], waiting)).toEqual([]);
    expect(waitingForNewGoal([{ status: "done" }], waiting)).toEqual([{ id: "a" }]);
    expect(waitingForNewGoal([], waiting)).toEqual([{ id: "a" }]);
  });
});

describe("F35: a removed goal", () => {
  it("leaves its money in the account with no goal", () => {
    const db = fresh();
    putAside(db, "test", 100_000);
    expect(unclaimed(accounts(db), heldBy(db), {})).toEqual([]);
    apply(db, [{ op: "delete", table: "savings_goals", id: "test" }]);
    expect(unclaimed(accounts(db), heldBy(db), {})).toMatchObject([{ minor: 100_000 }]);
  });

  it("shows it even when the account has no balance yet", () => {
    const db = fresh();
    db.exec("UPDATE money_accounts SET opening_date = NULL WHERE id = 'cbo-savings'");
    putAside(db, "test", 100_000);
    putAside(db, null, 30_000);
    const waiting = db.prepare(WAITING_SQL).all() as unknown as {
      amount_minor: number;
      account: string | null;
    }[];
    expect(unsetFree(account(db, "cbo-savings"), heldBy(db), waiting)).toBe(0);
    apply(db, [{ op: "delete", table: "savings_goals", id: "test" }]);
    expect(unsetFree(account(db, "cbo-savings"), heldBy(db), waiting)).toBe(100_000);
  });
});

describe("F36: dollars already in a dollar savings account", () => {
  function wise() {
    const db = fresh();
    db.exec("UPDATE money_accounts SET is_savings = 1 WHERE id = 'wise'");
    setBalance(db, "wise", 10_000);
    return db;
  }

  it("saved $50 laptop gives the goal what Wise holds; nothing is earmarked twice", async () => {
    const db = wise();
    expect(await capture(db, "saved $50 laptop")).toBe(
      "Saved $50 · Laptop · from what Wise already holds",
    );
    expect(goal(db, "laptop")).toMatchObject({ saved_minor: 650_000, held_minor: 650_000 });
    expect(unclaimed(accounts(db), heldBy(db), rates)).toMatchObject([
      { account: { id: "wise" }, minor: 650_000 },
    ]);
    expect(db.prepare("SELECT count(*) AS n FROM money_txns").get()).toEqual({ n: 0 });
  });

  it("asks for Wise's balance when it has none yet, instead of saying it holds 0", async () => {
    const db = fresh();
    db.exec("UPDATE money_accounts SET is_savings = 1 WHERE id = 'wise'");
    await expect(capture(db, "saved $50 laptop")).rejects.toBe(
      "Wise has no balance yet: set it in Money → Accounts first",
    );
  });

  it("refuses more than Wise holds unclaimed", async () => {
    const db = wise();
    await expect(capture(db, "saved $150 laptop")).rejects.toMatch(/Wise holds 13,000 ETB/);
  });
});

describe("F37: a Check finds a savings account short", () => {
  it("shows the gap and takes it off a goal without counting it as saving", () => {
    const db = fresh();
    putAside(db, "laptop", 2_000_000);
    setBalance(db, "cbo-savings", -500_000);
    expect(overclaimed(accounts(db), heldBy(db), {})).toMatchObject([
      { account: { id: "cbo-savings" }, minor: 500_000 },
    ]);
    apply(db, writeOffOps("laptop", "cbo-savings", 500_000, NOW, TODAY, "w1"));
    expect(overclaimed(accounts(db), heldBy(db), {})).toEqual([]);
    expect(goal(db, "laptop").saved_minor).toBe(1_500_000);
    expect(db.prepare(SAVED_SQL).get("2026-11-01", "2026-11-30")).toEqual({ minor: 2_000_000 });
  });
});

describe("F55: a savings account with no balance yet", () => {
  it("keeps money put aside in the total", () => {
    const db = fresh();
    db.exec("UPDATE money_accounts SET opening_date = NULL WHERE id = 'cbo-savings'");
    const before = totalBalance(accounts(db)).total;
    putAside(db, "laptop", 100_000);
    expect(totalBalance(accounts(db))).toMatchObject({ total: before });
  });
});

describe("F73: the week card's Put aside moves the money", () => {
  it("from the pay account into the savings account", () => {
    const db = fresh();
    const put = putAsideOps({
      goalId: "laptop",
      amount: 200_000,
      accounts: accounts(db),
      nowMs: NOW,
      date: TODAY,
      newId: () => `w${++n}`,
      origin: "week",
    });
    expect(put).toMatchObject({ from: "CBO", to: "CBO savings" });
    apply(db, put.ops);
    expect(balance(db, "cbo-savings")).toBe(200_000);
    expect(goal(db, "laptop")).toMatchObject({ saved_minor: 200_000, held_minor: 200_000 });
  });

  it("only marks it with no savings account", () => {
    const put = putAsideOps({
      goalId: "laptop",
      amount: 200_000,
      accounts: [{ id: "cbo", name: "CBO", currency: "ETB", is_savings: 0, pays_in: 1 }],
      nowMs: NOW,
      date: TODAY,
      newId: () => "only",
      origin: "week",
    });
    expect(put.ops).toHaveLength(1);
    expect(put.ops[0]).toMatchObject({ table: "savings_entries", values: { origin: "week" } });
  });
});

describe("F110: two goals with one name", () => {
  it("won't bring a planted goal back next to a growing one with its name", () => {
    const planted = { id: "a", title: "Short", status: "done" as const };
    const bike = { id: "c", title: "Bike", status: "done" as const };
    const goals = [planted, { id: "b", title: "short ", status: "active" as const }, bike];
    expect(checkBringBack(planted, goals)).toMatch(/already have a growing goal called short/);
    expect(checkBringBack(bike, goals)).toBeNull();
  });

  it("refuses a second goal or a rename to a name in use", () => {
    const others: Pick<GoalRow, "title" | "status">[] = [
      { title: "Laptop", status: "active" },
      { title: "Bike", status: "done" },
    ];
    expect(checkGoal({ title: " laptop ", target: "1k" }, others)).toBe(
      "You already have a goal called laptop.",
    );
    // A finished goal's name can be used again.
    expect(checkGoal({ title: "Bike", target: "1k" }, others)).toBeNull();
  });

  it("a capture that fits two goals waits instead of picking the oldest", () => {
    const list = [
      { id: "a", title: "Laptop", status: "active" as const },
      { id: "b", title: "Laptop bag", status: "active" as const },
      { id: "c", title: "Phone", status: "active" as const },
    ];
    expect(matchGoal(list, "laptop")).toBe("a");
    expect(matchGoal(list, "lap")).toBeNull();
    // Words that fit nothing never fall back to the only active goal (F8).
    const one = [
      { id: "a", title: "Laptop", status: "paused" as const },
      { id: "b", title: "Test", status: "active" as const },
      { id: "c", title: "Bike", status: "done" as const },
    ];
    expect(matchGoal(one, "laptop")).toBeNull();
    expect(matchGoal(one, "laptop", true)).toBe("a");
    expect(matchGoal(one, "bike", true)).toBe("c");
    expect(matchGoal(one, "lapptop", true)).toBeNull();
    expect(matchGoal(one, undefined)).toBe("b");
    expect(
      matchGoal(
        [
          { id: "a", title: "Laptop", status: "active" },
          { id: "b", title: "Laptop", status: "active" },
        ],
        "laptop",
      ),
    ).toBeNull();
  });
});

describe("round 2: a goal never holds below zero in an account", () => {
  /** Takes `minor` out of a goal the way the goal card does it. */
  const takeOut = (db: DatabaseSync, goalId: string, minor: number) => {
    const row = goal(db, goalId);
    const savings = account(db, "cbo-savings");
    apply(
      db,
      takeOutOps({
        goal: row,
        amount: minor,
        spend: account(db, "cbo"),
        savings,
        nowMs: NOW,
        date: TODAY,
        ids: { ...ids(), plain: `p${n}` },
        available: takeOutRoom(goalId, savings, goalHeld(db), {}),
      }).ops,
    );
  };

  it("reg0-1: deleting a put-aside after a take-out keeps every figure in step", () => {
    const db = fresh();
    setBalance(db, "cbo-savings", 2_000_000);
    apply(db, entryOps("laptop", 5_600_000, NOW, "2026-11-01", "old", "dashboard"));
    putAside(db, "laptop", 300_000);
    const putAsideTransfer = `t${n}`;
    takeOut(db, "laptop", 100_000);
    // Ledger deletes the put-aside (both halves); the sync drops its saving.
    db.prepare("UPDATE money_txns SET deleted_at = 1 WHERE transfer_id = ?").run(putAsideTransfer);
    db.prepare("UPDATE savings_entries SET deleted_at = 1 WHERE transfer_id = ?").run(
      putAsideTransfer,
    );
    expect(balance(db, "cbo-savings")).toBe(1_900_000);
    expect(goal(db, "laptop")).toMatchObject({ saved_minor: 5_500_000, held_minor: 0 });
    // No more unclaimed than the account holds.
    expect(unclaimed(accounts(db), heldBy(db), {})).toMatchObject([{ minor: 1_900_000 }]);
    expect(overclaimed(accounts(db), heldBy(db), {})).toEqual([]);
  });

  it("F32: money no goal holds there leaves no goal poorer", async () => {
    const db = fresh();
    apply(db, goalStatusOps("test", "paused"));
    await capture(db, "moved 500 from cbo savings to cbo");
    expect(balance(db, "cbo-savings")).toBe(-50_000);
    expect(goal(db, "laptop")).toMatchObject({ saved_minor: 0, held_minor: 0 });
    // Nothing waits for a goal, and goals count nothing more than it holds.
    expect(db.prepare(WAITING_SQL).all()).toEqual([]);
    expect(overclaimed(accounts(db), heldBy(db), {})).toEqual([]);
    // Not saving either way, and the repair sync never charges a goal for it later.
    expect(db.prepare(SAVED_SQL).get("2026-11-01", "2026-11-30")).toEqual({ minor: 0 });
    putAside(db, "laptop", 100_000);
    expect(db.prepare(SAVINGS_TRANSFERS_SQL).all()).toEqual([]);
    expect(goal(db, "laptop")).toMatchObject({ saved_minor: 100_000, held_minor: 100_000 });
  });

  it("F33: a take-out bigger than a goal holds there charges only what it holds", () => {
    const db = fresh();
    db.exec("UPDATE money_accounts SET opening_date = NULL WHERE id = 'cbo-savings'");
    apply(db, entryOps("laptop", 5_600_000, NOW, "2026-11-01", "old", "dashboard"));
    putAside(db, "laptop", 200_000);
    const goalsNow = goals(db);
    expect(
      transferGoal(goalsNow, { account: "cbo-savings", minor: -500_000 }, goalHeld(db)),
    ).toEqual([
      { goalId: "laptop", minor: -200_000, unheld: false },
      { goalId: null, minor: -300_000, unheld: true },
    ]);
    expect(
      transferGoal(goalsNow, { account: "cbo-savings", minor: -100_000 }, goalHeld(db)),
    ).toEqual([{ goalId: "laptop", minor: -100_000, unheld: false }]);
    // A waiting take-out offers only goals that hold that much in its account.
    const split = waitingSplit(
      [{ id: "w", amount_minor: -500_000, account: "cbo-savings" }],
      goalsNow,
      { held: goalHeld(db), savings: ["cbo-savings"] },
    );
    expect(split.taken.goals).toEqual([]);
  });

  it("reg0-2: savings with no goal in an account with a balance are one line", () => {
    const db = fresh();
    setBalance(db, "cbo-savings", 2_000_000);
    apply(db, claimOps("test", "cbo-savings", 500_000, NOW, TODAY, "c-test"));
    putAside(db, null, 200_000);
    const waiting = db.prepare(WAITING_SQL).all() as unknown as {
      id: string;
      amount_minor: number;
      account: string | null;
    }[];
    expect(unclaimed(accounts(db), heldBy(db), {})).toMatchObject([{ minor: 1_700_000 }]);
    const split = waitingSplit(waiting, goals(db), { folded: ["cbo-savings"] });
    expect(split.saved.ids).toEqual([]);
    // Giving it all hands over the saving as it was, and claims the rest.
    apply(
      db,
      giveOps("laptop", "cbo-savings", 1_700_000, waiting, NOW, TODAY, () => "g1"),
    );
    expect(unclaimed(accounts(db), heldBy(db), {})).toEqual([]);
    expect(goal(db, "laptop")).toMatchObject({ saved_minor: 1_700_000, flow_minor: 200_000 });
    expect(db.prepare(WAITING_SQL).all()).toEqual([]);
  });

  it("moving out more than the goal holds there charges the goal what it holds", async () => {
    const db = fresh();
    setBalance(db, "cbo-savings", 300_000);
    putAside(db, "laptop", 500_000);
    expect(balance(db, "cbo-savings")).toBe(800_000);
    await capture(db, "moved 8000 from cbo savings to cbo");
    expect(balance(db, "cbo-savings")).toBe(0);
    // Laptop gave its 5,000; the 3,000 no goal had is unheld. No false warning.
    expect(goal(db, "laptop")).toMatchObject({ saved_minor: 0, held_minor: 0 });
    expect(overclaimed(accounts(db), heldBy(db), {})).toEqual([]);
    expect(unclaimed(accounts(db), heldBy(db), {})).toEqual([]);
    expect(db.prepare(WAITING_SQL).all()).toEqual([]);
  });

  it("a dollar take-out after the rate rose charges what the goal holds, not nothing", () => {
    // $100 put aside at 130: Laptop holds 13,000 ETB worth in Wise. At 140 it is 14,000.
    const parts = transferGoal(
      [{ id: "laptop", status: "active", saved_minor: 1_300_000 }],
      { account: "wise", minor: -1_400_000 },
      [{ goal_id: "laptop", account: "wise", minor: 1_300_000 }],
    );
    expect(parts).toEqual([
      { goalId: "laptop", minor: -1_300_000, unheld: false },
      { goalId: null, minor: -100_000, unheld: true },
    ]);
  });

  it("the repair sync splits a take-out the same way", () => {
    const ops = savingsSyncOps({
      transfers: [
        {
          id: "m1",
          transfer_id: "t-out",
          amount_minor: -800_000,
          local_date: TODAY,
          occurred_at: NOW,
          account: "cbo-savings",
          created_at: NOW,
          currency: "ETB",
          entry_id: null,
        },
      ],
      orphans: [],
      goals: [{ id: "laptop", status: "active", saved_minor: 500_000 }],
      since: {},
      rates: {},
      newId: () => `s${++n}`,
      held: [{ goal_id: "laptop", account: "cbo-savings", minor: 500_000 }],
    });
    expect(
      ops.map((op) =>
        op.op === "delete" ? null : [op.values.goal_id, op.values.amount_minor, op.values.origin],
      ),
    ).toEqual([
      ["laptop", -500_000, "transfer"],
      [null, -300_000, "unheld"],
    ]);
  });

  it("reg0-2: Give in parts splits a waiting saving and never strands it", () => {
    const db = fresh();
    setBalance(db, "cbo-savings", 0);
    putAside(db, null, 1_700_000);
    const waitingNow = () =>
      db.prepare(WAITING_SQL).all() as unknown as {
        id: string;
        amount_minor: number;
        account: string | null;
      }[];
    expect(unclaimed(accounts(db), heldBy(db), {})).toMatchObject([{ minor: 1_700_000 }]);
    apply(
      db,
      giveOps("laptop", "cbo-savings", 1_000_000, waitingNow(), NOW, TODAY, () => "g1"),
    );
    expect(waitingNow()).toMatchObject([{ amount_minor: 700_000, account: "cbo-savings" }]);
    apply(
      db,
      giveOps("test", "cbo-savings", 700_000, waitingNow(), NOW, TODAY, () => "g2"),
    );
    // Nothing left waiting, both count as real saving, and no claim was written.
    expect(waitingNow()).toEqual([]);
    expect(unclaimed(accounts(db), heldBy(db), {})).toEqual([]);
    expect(goal(db, "laptop")).toMatchObject({ saved_minor: 1_000_000, flow_minor: 1_000_000 });
    expect(goal(db, "test")).toMatchObject({ saved_minor: 700_000, flow_minor: 700_000 });
    expect(
      db.prepare("SELECT count(*) AS n FROM savings_entries WHERE origin = 'claim'").get(),
    ).toEqual({ n: 0 });
    // A goal added later takes nothing: the money is not given twice.
    apply(db, goalStatusOps("laptop", "done"));
    apply(db, goalStatusOps("test", "done"));
    expect(waitingForNewGoal(goals(db), waitingNow())).toEqual([]);
    expect(overclaimed(accounts(db), heldBy(db), {})).toEqual([]);
  });

  it("reg0-2: a capture saving money already there takes the waiting saving first", async () => {
    const db = fresh();
    db.exec("UPDATE money_accounts SET is_savings = 1 WHERE id = 'wise'");
    setBalance(db, "wise", 0);
    // $50 arrived in Wise as a saving with no goal (two goals growing).
    apply(db, [
      {
        op: "insert",
        table: "savings_entries",
        id: "w-in",
        values: {
          goal_id: null,
          occurred_at: NOW,
          local_date: TODAY,
          amount_minor: 650_000,
          note: null,
          origin: "transfer",
          account: "wise",
        },
      },
    ]);
    db.prepare("UPDATE money_accounts SET opening_minor = 5_000 WHERE id = 'wise'").run();
    await capture(db, "saved $50 laptop");
    // The waiting saving is Laptop's, counted as this month's saving; nothing waits.
    expect(db.prepare(WAITING_SQL).all()).toEqual([]);
    expect(goal(db, "laptop")).toMatchObject({ saved_minor: 650_000, flow_minor: 650_000 });
    expect(unclaimed(accounts(db), heldBy(db), rates)).toEqual([]);
    expect(overclaimed(accounts(db), heldBy(db), rates)).toEqual([]);
  });
});
