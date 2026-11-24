/** Capture lines the user-test campaign found misread (F-numbers from that run). */
import { describe, expect, it } from "vitest";

import { parseAmount } from "../kernel/money";
import { readings } from "./alternatives";
import { balanceNote, echo } from "./ops";
import { type ParseOptions, parseCapture } from "./parse";
import { readWhen } from "./when";

const at = (local: string) => Date.parse(`${local}+03:00`);
/** Tuesday 24 Nov 2026, 09:30 in Addis Ababa. */
const nowMs = at("2026-11-24T09:30:00");

const areas = [
  { id: "joba", name: "Job A" },
  { id: "jobb", name: "Job B" },
  { id: "jobhunt", name: "Job hunt" },
  { id: "coding", name: "Coding skills" },
];
const accounts = [
  { id: "cash", name: "Cash", kind: "cash", pays_in: 0 },
  { id: "cbo", name: "CBO", kind: "bank", pays_in: 1 },
  { id: "cbo-savings", name: "CBO savings", kind: "bank", pays_in: 0, is_savings: 1 },
  { id: "wise", name: "Wise", kind: "other", pays_in: 0, currency: "USD" },
];
const options: ParseOptions = {
  nowMs,
  areas,
  accounts,
  goals: ["laptop"],
  rates: { USD: { rate: "132.50", set_on: "2026-11-20" } },
};
const read = (text: string, extra: Partial<ParseOptions> = {}) =>
  parseCapture(text, { ...options, ...extra });

describe("a length is a task's length, never money (F1, F16)", () => {
  it.each([
    ["buy bread for 15 min", "buy bread", 15],
    ["call mom for 20 minutes", "call mom", 20],
    ["read for 1 hour", "read", 60],
    ["fix the sink for 20 minutes", "fix the sink", 20],
    ["buy milk ~30 min", "buy milk", 30],
    ["clean desk ~45m", "clean desk", 45],
    ["buy milk 15 min", "buy milk", 15],
    ["buy bread 15 min", "buy bread", 15],
    ["buy eggs 15m", "buy eggs", 15],
    ["call mom ~1h", "call mom", 60],
    ["read report about 2 hours", "read report", 120],
  ])("%j", (text, title, estimateMin) => {
    expect(read(text)).toEqual({ kind: "task", title, estimateMin });
  });

  it("keeps 'tonight' with a length", () => {
    expect(read("walk for 30 min tonight")).toMatchObject({
      kind: "task",
      title: "walk",
      estimateMin: 30,
      dueDate: "2026-11-24",
      plannedWindow: "evening",
    });
  });

  it("still reads money and a timed length", () => {
    expect(read("lunch 120")).toMatchObject({ kind: "expense", amount: 12000 });
    expect(read("call bank at 15:00 for 45 min")).toMatchObject({
      kind: "task",
      estimateMin: 45,
      dueAt: at("2026-11-24T15:00:00"),
    });
  });

  it("shows a length under an hour in minutes", () => {
    expect(echo(read("buy milk ~45 min"), nowMs)).toBe("Task · planned into free time · ~45 min");
    expect(echo(read("call mom ~1.5h"), nowMs)).toBe("Task · planned into free time · ~1.5 h");
  });
});

describe("money in is never booked as spending (F5, F6)", () => {
  it("reads a repayment from someone who owes nothing as income", () => {
    for (const loanPeople of [undefined, [{ name: "abel", owedToMe: 0, iOwe: 0 }]]) {
      expect(read("abel paid back 1000", loanPeople ? { loanPeople } : {})).toMatchObject({
        kind: "income",
        amount: 100000,
        categoryId: "cat_income",
        account: "cbo",
      });
    }
    expect(read("sara paid back 200")).toMatchObject({ kind: "income", amount: 20000 });
  });

  it("still reads an open loan as a repayment", () => {
    expect(
      read("abel paid back 400", { loanPeople: [{ name: "abel", owedToMe: 100000, iOwe: 0 }] }),
    ).toMatchObject({ kind: "loan", loanKind: "paid_me" });
  });

  it.each([
    ["income 5000", 500000, "cbo"],
    ["client paid 5000", 500000, "cbo"],
    ["income $200 @wise", 20000, "wise"],
    ["client paid $200 @wise", 20000, "wise"],
    ["refund 300 shoes", 30000, "cbo"],
    ["refund 300", 30000, "cbo"],
  ])("%j is income", (text, amount, account) => {
    expect(read(text)).toMatchObject({ kind: "income", amount, account });
  });

  it.each(["rent paid 5000", "paid salary 3000", "lunch 120"])("%j stays spending", (text) => {
    expect(read(text)).toMatchObject({ kind: "expense" });
  });
});

describe("transfers between multi-word accounts (F23)", () => {
  it.each([
    ["moved 2000 from cbo to cbo savings", "cbo", "cbo-savings"],
    ["moved 500 cbo to cbo savings", "cbo", "cbo-savings"],
    ["moved 500 from cbo savings to cash", "cbo-savings", "cash"],
  ])("%j", (text, from, to) => {
    expect(read(text)).toMatchObject({ kind: "transfer", from, to });
  });

  it("leaves things that aren't accounts alone", () => {
    expect(read("moved 2000 boxes to the store").kind).not.toBe("transfer");
  });
});

describe("a comma line with money and something else (F25)", () => {
  it.each(["lunch 120, call mom tomorrow", "lunch 120, taxi forty"])("%j", (text) => {
    expect(read(text)).toMatchObject({ kind: "inbox", why: expect.any(String) });
  });

  it("still splits a line that is all money", () => {
    const parsed = read("lunch 120, taxi 40");
    expect(parsed.kind === "money" && parsed.items.length).toBe(2);
    expect(read("rent 1,200")).toMatchObject({ kind: "expense", amount: 120000 });
  });
});

describe("taking money out of a goal (F26)", () => {
  it.each(["took 200 laptop", "withdrew 200 laptop", "took out 200 from laptop"])("%j", (text) => {
    expect(read(text)).toMatchObject({ kind: "saving", amount: -20000, goal: "laptop" });
  });

  it("leaves 'took 200 taxi' as spending", () => {
    expect(read("took 200 taxi").kind).not.toBe("saving");
  });
});

describe("a weekday before 'for <area>' (F39)", () => {
  it.each([
    ["call bank mon 9am for job a ~1h", "call bank", "joba", "2026-11-30", "09:00", 60],
    ["fix bug fri 3pm for job b", "fix bug", "jobb", "2026-11-27", "15:00", undefined],
    ["fix bug fri for job b", "fix bug", "jobb", "2026-11-27", undefined, undefined],
    ["meet tomorrow 3pm for 45 min for job a", "meet", "joba", "2026-11-25", "15:00", 45],
  ])("%j", (text, title, area, dueDate, time, estimateMin) => {
    const parsed = read(text);
    expect(parsed).toMatchObject({ kind: "task", title, area, dueDate });
    if (parsed.kind !== "task") return;
    expect(parsed.dueAt).toBe(time ? at(`${dueDate}T${time}:00`) : undefined);
    expect(parsed.estimateMin).toBe(estimateMin);
  });

  it("keeps 'pay for gym fri' and 'update CV for job a' as before", () => {
    expect(read("update CV for job a")).toMatchObject({ title: "update CV", area: "joba" });
    expect(read("pay for gym fri")).toMatchObject({ title: "pay for gym", dueDate: "2026-11-27" });
  });
});

describe("tomorrow misspelt (F40)", () => {
  it.each(["tommorow", "tomorow", "tommorrow", "2moro", "2morrow", "tmrw"])("%j", (word) => {
    expect(read(`dentist ${word} 4pm`)).toMatchObject({
      kind: "task",
      title: "dentist",
      dueDate: "2026-11-25",
      dueAt: at("2026-11-25T16:00:00"),
    });
    expect(read(`call bank ${word}`)).toMatchObject({ title: "call bank", dueDate: "2026-11-25" });
  });
});

describe("a year on a date (F42)", () => {
  it.each([
    ["call bank 25 dec 2027", "2027-12-25"],
    ["pay rent dec 25 2027", "2027-12-25"],
    ["pay rent dec 25, 2027", "2027-12-25"],
    ["renew id 2026-12-03", "2026-12-03"],
    ["call bank 25 dec", "2026-12-25"],
  ])("%j", (text, dueDate) => {
    const parsed = read(text);
    expect(parsed).toMatchObject({ kind: "task", dueDate });
    expect(parsed.kind === "task" && parsed.title).not.toMatch(/\d/);
  });
});

describe("24-hour times after midnight (F44)", () => {
  it.each([
    ["call bank 23:00-01:00", "2026-11-24T23:00", 120],
    ["call sis 21:00-02:00", "2026-11-24T21:00", 300],
    ["call sis 23:00-1:00", "2026-11-24T23:00", 120],
    ["call bank 3:00-4:30", "2026-11-24T15:00", 90],
  ])("%j", (text, start, length) => {
    expect(read(text)).toMatchObject({ dueAt: at(`${start}:00`), estimateMin: length });
  });

  it("reads 'at 01:00' as one at night", () => {
    expect(read("call dad at 01:00")).toMatchObject({ dueAt: at("2026-11-25T01:00:00") });
  });
});

describe("a named day with a time before 03:00 is that day's night (F46)", () => {
  it.each([
    ["2026-11-24T23:00:00", "call aunt tomorrow 2am", "2026-11-26T02:00:00"],
    ["2026-11-25T02:30:00", "call mom tomorrow 2am", "2026-11-26T02:00:00"],
    ["2026-11-24T23:00:00", "call dad today 1am", "2026-11-25T01:00:00"],
    ["2026-11-24T09:30:00", "call dad fri 1am", "2026-11-28T01:00:00"],
  ])("at %s, %j", (now, text, due) => {
    expect(read(text, { nowMs: at(now) })).toMatchObject({ dueAt: at(due) });
  });

  it("keeps a bare time as before", () => {
    expect(readWhen("x at 1am", at("2026-11-25T00:30:00"))).toMatchObject({
      date: "2026-11-24",
      minutes: 25 * 60,
    });
  });
});

describe("a learned category by word (F67)", () => {
  const learned = { learned: { kitfo: "cat_food" } };
  it.each(["special kitfo 400", "kitfo with friends 500"])("%j", (text) => {
    expect(read(text, learned)).toMatchObject({ kind: "expense", categoryId: "cat_food" });
  });

  it("leaves a confident keyword guess alone", () => {
    expect(read("taxi kitfo 50", learned)).toMatchObject({ categoryId: "cat_transport" });
  });
});

describe("a currency marks an amount-first line as money (F68)", () => {
  it.each(["$15 netflix", "15 usd netflix"])("%j", (text) => {
    expect(read(text)).toMatchObject({
      kind: "expense",
      amount: 1500,
      currency: "USD",
      account: "wise",
    });
  });

  it("reads '$200 from client @wise' as money in", () => {
    expect(read("$200 from client @wise")).toMatchObject({
      kind: "income",
      amount: 20000,
      description: "client",
      account: "wise",
    });
  });

  it.each(["200 from client", "get 3 eggs"])("%j is still not money", (text) => {
    const kind = read(text).kind;
    expect(kind === "expense" || kind === "income").toBe(false);
  });
});

describe("an unknown #tag (F77)", () => {
  it("keeps the tag in the text and sets no area", () => {
    const parsed = read("zzz phantom task #jobhnt today");
    expect(parsed).toMatchObject({ kind: "task", title: "zzz phantom task #jobhnt" });
    expect("area" in parsed && parsed.area).toBeFalsy();
  });

  it("still takes a known tag", () => {
    expect(read("fix bug #jobhunt today")).toMatchObject({ title: "fix bug", area: "jobhunt" });
  });

  it("keeps the tag on pin: lines, which name a sheet", () => {
    expect(read("pin: git stash pop #newsheet")).toMatchObject({ kind: "cheat", area: "newsheet" });
  });
});

describe("amounts (F80)", () => {
  it.each(["45,50", "1,2,3", "12,00"])("%j is not an amount", (text) => {
    expect(parseAmount(text)).toBeNull();
  });

  it("still reads thousands", () => {
    expect(parseAmount("1,200")).toBe(120000);
    expect(parseAmount("12,000.50")).toBe(1200050);
    expect(parseAmount("1,234,567")).toBe(123456700);
  });

  it.each(["coffee 45,50", "lunch 99999999999"])("%j is not saved as money", (text) => {
    const kind = read(text).kind;
    expect(kind === "expense" || kind === "income").toBe(false);
  });
});

describe("empty captures (F81)", () => {
  it.each(["idea:", "pin:", "n:", "fb:", "wait:", "t:", "#jobhunt", "idea: #coding"])(
    "%j asks for text",
    (text) => {
      expect(read(text)).toMatchObject({ kind: "inbox", body: "", why: expect.any(String) });
    },
  );
});

describe("more ways to say when (F82)", () => {
  it.each([
    ["call bank in 30 min", "call bank", "2026-11-24", "10:00"],
    ["call bank in an hour", "call bank", "2026-11-24", "10:30"],
    ["call bank in 2 hours", "call bank", "2026-11-24", "11:30"],
    ["call abel at 1530", "call abel", "2026-11-24", "15:30"],
    ["call bank tomorrow 9", "call bank", "2026-11-25", "09:00"],
    ["pay rent on the 28th", "pay rent", "2026-11-28", undefined],
    ["call bank this weekend", "call bank", "2026-11-28", undefined],
    ["submit report next week", "submit report", "2026-11-30", undefined],
  ])("%j", (text, title, dueDate, time) => {
    const parsed = read(text);
    expect(parsed).toMatchObject({ kind: "task", title, dueDate });
    if (parsed.kind === "task")
      expect(parsed.dueAt).toBe(time ? at(`${dueDate}T${time}:00`) : undefined);
  });

  it("keeps a 4-digit number without 'at' as money", () => {
    expect(read("rent 1530")).toMatchObject({ kind: "expense", amount: 153000 });
  });

  it("reads 'the 28th' only as a date, not 'the 5th chapter'", () => {
    expect(read("pay rent by the 28th")).toMatchObject({ dueDate: "2026-11-28" });
    expect(read("pay rent the 28th")).toMatchObject({ dueDate: "2026-11-28" });
    expect(read("read the 5th chapter")).toEqual({ kind: "task", title: "read the 5th chapter" });
  });

  it("says why when a time phrase can't be read, instead of a silent Someday", () => {
    expect(read("call abel at 2590")).toMatchObject({
      kind: "inbox",
      body: "call abel at 2590",
      why: expect.stringContaining("at 2590"),
    });
    expect(read("pay rent on the 32nd")).toMatchObject({ kind: "inbox", why: expect.any(String) });
  });

  it("reads a count before the words as part of the label", () => {
    expect(read("2 coffees 90")).toMatchObject({
      kind: "expense",
      description: "2 coffees",
      amount: 9000,
    });
    expect(read("get 3 eggs").kind).not.toBe("expense");
  });
});

describe("Tab readings (F112)", () => {
  it("offers one task for an expense", () => {
    const list = readings(read("buy charger 600"), "buy charger 600", nowMs).map((r) => r.kind);
    expect(new Set(list).size).toBe(list.length);
  });
});

describe("'tonight' after midnight (F86)", () => {
  it("says Tonight", () => {
    const late = at("2026-11-25T00:30:00");
    expect(echo(read("read quran tonight", { nowMs: late }), late)).toBe("Task · Tonight");
    expect(echo(read("pray tomorrow morning", { nowMs: late }), late)).toBe(
      "Task · Tomorrow morning",
    );
  });
});

describe("an amount past the account's balance (F69)", () => {
  const balances = { wise: 30000, cbo: 500000 };
  const rates = options.rates ?? {};

  it("says the account holds less, and what the number in birr would be", () => {
    const parsed = read("groceries 1200 @wise");
    expect(parsed).toMatchObject({ kind: "expense", amount: 120000, currency: "USD", bare: true });
    expect(echo(parsed, nowMs) + balanceNote(parsed, balances, rates)).toBe(
      "$1,200 · Food · Wise · only $300 there; 1,200 birr would be ≈ $9.06",
    );
  });

  it("stays quiet when the amount fits, a currency was typed or the balance is unknown", () => {
    expect(balanceNote(read("groceries 12 @wise"), balances, rates)).toBe("");
    expect(balanceNote(read("groceries $1200 @wise"), balances, rates)).toBe("");
    expect(balanceNote(read("groceries 1200 @wise"), {}, rates)).toBe("");
    expect(balanceNote(read("groceries 50000 @cbo"), balances, rates)).toBe("");
  });
});
