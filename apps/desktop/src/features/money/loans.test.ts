import { describe, expect, it } from "vitest";

import { echo, toOps } from "../../capture/ops";
import { type ParseOptions, parseCapture } from "../../capture/parse";
import { openTestDb } from "../../test/sqlite";
import { ACCOUNTS_SQL, type AccountRow } from "./accounts";
import {
  balances,
  checkLoan,
  followUpLines,
  type LoanEvent,
  loanEchoText,
  loanOps,
  LOANS_SQL,
} from "./loans";
import { monthSummary, type TxnRow, TXNS_SQL } from "./money";

let n = 0;
const event = (over: Partial<LoanEvent>): LoanEvent => ({
  id: `e${++n}`,
  person: "Abel",
  kind: "lent",
  amount_minor: 100_000,
  local_date: "2026-11-01",
  account: "cash",
  note: null,
  follow_up_date: null,
  ...over,
});

describe("who owes what (T-061)", () => {
  it("adds up per person, with partial repayments, oldest first", () => {
    const people = balances([
      event({ amount_minor: 100_000, local_date: "2026-10-01" }),
      event({ amount_minor: 50_000, local_date: "2026-11-01" }),
      event({ kind: "paid_me", amount_minor: 120_000, local_date: "2026-11-05", person: "abel" }),
      event({ person: "Sara", kind: "borrowed", amount_minor: 200_000, local_date: "2026-11-03" }),
      event({ person: "Sara", kind: "i_paid", amount_minor: 50_000, local_date: "2026-11-10" }),
    ]);
    expect(people.map((p) => [p.person, p.owedToMe, p.iOwe, p.since])).toEqual([
      // 1,000 from Oct is cleared first, then 200 of Nov's 500: 300 left since Nov 1.
      ["Abel", 30_000, 0, "2026-11-01"],
      ["Sara", 0, 150_000, "2026-11-03"],
    ]);
  });

  it("turns an overpayment the other way and clears a settled person", () => {
    const people = balances([
      event({ amount_minor: 50_000 }),
      event({ kind: "paid_me", amount_minor: 70_000, local_date: "2026-11-02" }),
      event({ person: "Kebede", amount_minor: 10_000 }),
      event({ person: "Kebede", kind: "paid_me", amount_minor: 10_000 }),
    ]);
    expect(people.find((p) => p.person === "Abel")).toMatchObject({ owedToMe: 0, iOwe: 20_000 });
    expect(people.find((p) => p.person === "Kebede")).toMatchObject({
      owedToMe: 0,
      iOwe: 0,
      since: null,
    });
  });

  it("asks about it in the brief once the follow-up date comes", () => {
    const people = balances([
      event({ follow_up_date: "2026-11-15" }),
      event({ person: "Sara", kind: "borrowed", follow_up_date: "2026-11-14" }),
    ]);
    expect(followUpLines(people, "2026-11-14")).toEqual([
      "You owe Sara 1,000 ETB since 2026-11-01",
    ]);
    expect(followUpLines(people, "2026-11-15")).toEqual([
      "Abel owes you 1,000 ETB since 2026-11-01",
      "You owe Sara 1,000 ETB since 2026-11-01",
    ]);
  });

  it("checks and describes", () => {
    expect(checkLoan(" ", 100)).toMatch(/Who/);
    expect(checkLoan("Abel", 0)).toMatch(/above zero/);
    expect(loanEchoText("paid_me", "Abel", 40_000, 20_000)).toBe(
      "Abel paid back · 400 ETB · 200 ETB still open",
    );
    expect(loanEchoText("i_paid", "Sara", 50_000, 0)).toBe("Paid back Sara · 500 ETB · settled");
  });
});

describe("loans in your accounts (T-061)", () => {
  it("moves the money without counting it as in or out", () => {
    const db = openTestDb();
    db.prepare("UPDATE money_accounts SET opening_date = '2026-11-01' WHERE id = 'cash'").run();
    for (const op of loanOps({
      person: "Abel",
      kind: "lent",
      amount: 100_000,
      date: "2026-11-14",
      account: "cash",
      nowMs: 0,
      id: "loan1",
      txnId: "t1",
    })) {
      if (op.op !== "insert") throw new Error("insert only");
      const cols = Object.keys(op.values);
      db.prepare(
        `INSERT INTO ${op.table} (id, ${cols.join(", ")}, created_at, updated_at) VALUES (?, ${cols.map(() => "?").join(", ")}, 0, 0)`,
      ).run(op.id, ...(Object.values(op.values) as (string | number | null)[]));
    }
    const cash = (db.prepare(ACCOUNTS_SQL).all() as unknown as AccountRow[]).find(
      (a) => a.id === "cash",
    );
    expect(cash?.moved_minor).toBe(-100_000);
    const txns = db.prepare(TXNS_SQL).all("2026-11-01", "2026-11-30") as unknown as TxnRow[];
    expect(txns[0]).toMatchObject({ description: "Lent to Abel", transfer_id: "loan:loan1" });
    expect(monthSummary({ txns, saved: 0, history: [], today: "2026-11-14" })).toMatchObject({
      in: 0,
      out: 0,
    });
    expect(balances(db.prepare(LOANS_SQL).all() as unknown as LoanEvent[])[0]).toMatchObject({
      person: "Abel",
      owedToMe: 100_000,
    });
  });
});

describe("loans in the capture box (T-061)", () => {
  const db = openTestDb();
  const options: ParseOptions = {
    nowMs: Date.parse("2026-11-14T12:00:00+03:00"),
    accounts: db.prepare(ACCOUNTS_SQL).all() as unknown as AccountRow[],
  };
  const read = (text: string) => parseCapture(text, options);

  it("reads lending, borrowing and paying back both ways", () => {
    expect(read("lent 1000 abel")).toMatchObject({
      kind: "loan",
      loanKind: "lent",
      person: "abel",
      amount: 100_000,
      account: "cash",
    });
    expect(read("lent Abel 1k")).toMatchObject({
      loanKind: "lent",
      person: "Abel",
      amount: 100_000,
    });
    expect(read("lent 2000 to Sara Tesfaye")).toMatchObject({ person: "Sara Tesfaye" });
    expect(read("borrowed 500 from sara")).toMatchObject({
      loanKind: "borrowed",
      person: "sara",
      amount: 50_000,
    });
    expect(read("abel paid back 400")).toMatchObject({
      loanKind: "paid_me",
      person: "abel",
      amount: 40_000,
    });
    expect(read("got 400 back from abel")).toMatchObject({ loanKind: "paid_me", person: "abel" });
    expect(read("paid back sara 500")).toMatchObject({ loanKind: "i_paid", person: "sara" });
    expect(read("paid sara back 500")).toMatchObject({ loanKind: "i_paid", person: "sara" });
    expect(read("lent 1000 abel @telebirr")).toMatchObject({ account: "telebirr" });
  });

  it("leaves ordinary spending and pay alone", () => {
    expect(read("paid rent 6000").kind).toBe("expense");
    expect(read("got 18k job a").kind).toBe("income");
    expect(read("lunch 120").kind).toBe("expense");
  });

  it("writes the event and the money, and echoes it", () => {
    const parsed = read("lent 1000 abel @cbe");
    expect(echo(parsed, options.nowMs)).toBe("Lent to abel · 1,000 ETB · CBE");
    let k = 0;
    const ops = toOps(parsed, { nowMs: options.nowMs, newId: () => `o${++k}` });
    expect(ops.map((op) => op.table)).toEqual(["money_loans", "money_txns"]);
    expect(ops[1]).toMatchObject({
      values: { account: "cbe", amount_minor: -100_000, transfer_id: "loan:o1" },
    });
  });
});
