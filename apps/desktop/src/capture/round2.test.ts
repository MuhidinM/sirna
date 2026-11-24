/** Capture lines the second recheck found still misread (round 2, "words"). */
import { describe, expect, it } from "vitest";

import { readings } from "./alternatives";
import { echo } from "./ops";
import { type ParseOptions, parseCapture } from "./parse";

const at = (local: string) => Date.parse(`${local}+03:00`);
/** Tuesday 24 Nov 2026, 09:30 in Addis Ababa. */
const nowMs = at("2026-11-24T09:30:00");

const areas = [
  { id: "joba", name: "Job A" },
  { id: "jobhunt", name: "Job hunt" },
];
const accounts = [
  { id: "cash", name: "Cash", kind: "cash", pays_in: 0 },
  { id: "cbo", name: "CBO", kind: "bank", pays_in: 1 },
];
const options: ParseOptions = { nowMs, areas, accounts };
const read = (text: string, extra: Partial<ParseOptions> = {}) =>
  parseCapture(text, { ...options, ...extra });

describe("paying back someone you owe nothing is never spending (F5)", () => {
  it.each(["paid back dawit 300", "repaid dawit 300", "paid dawit back 300"])("%j", (text) => {
    expect(read(text)).toEqual({
      kind: "inbox",
      body: text,
      why: "You owe Dawit nothing · will ask tonight",
    });
  });

  it.each(["i paid back tigist 150", "I paid back Tigist 150", "i repaid tigist 150"])(
    "%j with no loan is held like dawit's (#174)",
    (text) => {
      expect(read(text)).toEqual({
        kind: "inbox",
        body: text,
        why: "You owe Tigist nothing · will ask tonight",
      });
    },
  );

  it("'i paid back' still pays back a loan you have (#174)", () => {
    const loanPeople = [{ name: "tigist", owedToMe: 0, iOwe: 50000 }];
    expect(read("i paid back tigist 150", { loanPeople })).toMatchObject({
      kind: "loan",
      loanKind: "i_paid",
      person: "tigist",
      amount: 15000,
    });
  });

  it("repaying a card is spending, not a loan (F5)", () => {
    expect(read("repaid credit card 3000")).toMatchObject({ kind: "expense", amount: 300000 });
  });

  it("still pays back a loan you have", () => {
    const loanPeople = [{ name: "dawit", owedToMe: 0, iOwe: 50000 }];
    expect(read("paid back dawit 300", { loanPeople })).toMatchObject({
      kind: "loan",
      loanKind: "i_paid",
      person: "dawit",
      amount: 30000,
    });
  });

  it("'returned shoes 500' is not about a loan", () => {
    expect(read("returned shoes 500").kind).not.toBe("inbox");
  });
});

describe("'owes me' and 'i owe' are loans, never spending (reg2-3)", () => {
  it.each([
    ["abel owes me 1000", "lent abel 1,000"],
    ["i owe kebede 200", "borrowed 200 from kebede"],
    ["i owe 200 to kebede", "borrowed 200 from kebede"],
  ])("%j", (text, line) => {
    expect(read(text)).toEqual({
      kind: "inbox",
      body: text,
      why: `Kept for tonight · for a loan, write “${line}”`,
    });
  });

  it("no Tab reading books it as money", () => {
    const options = readings(read("abel owes me 1000"), "abel owes me 1000", nowMs);
    expect(options.some((option) => option.kind === "expense")).toBe(false);
  });
});

describe("'note:' works like 'n:' (reg2-8)", () => {
  it("makes a note without the prefix", () => {
    expect(read("note: the api key rotates monthly")).toEqual({
      kind: "note",
      body: "the api key rotates monthly",
    });
    expect(read("note: remember the wifi password")).toEqual({
      kind: "note",
      body: "remember the wifi password",
    });
    expect(read("note:")).toMatchObject({ body: "", why: "Type something after note:" });
  });
});

describe("a money half followed by a task (reg2-4)", () => {
  it.each(["lunch 120 and call mom", "taxi 40 and buy milk tomorrow"])("%j is kept", (text) => {
    expect(read(text)).toEqual({
      kind: "inbox",
      body: text,
      why: "Part of this line isn't money: put each thing on its own line",
    });
  });

  it.each([
    ["salt and pepper 50", "salt and pepper"],
    ["buy bread and milk 60", "buy bread and milk"],
  ])("%j stays one entry", (text, description) => {
    expect(read(text)).toMatchObject({ kind: "expense", description });
  });

  it("two money halves still split", () => {
    expect(read("lunch 120 and taxi 40")).toMatchObject({ kind: "money" });
  });
});

describe("'pay rent 5000 @cbo' (reg2-10)", () => {
  it("titles the task without the account", () => {
    expect(read("pay rent 5000 @cbo")).toEqual({ kind: "task", title: "pay rent 5000" });
  });

  it("keeps an account named mid-line", () => {
    expect(read("call @cbo about the card")).toMatchObject({
      kind: "task",
      title: "call @cbo about the card",
    });
  });
});

describe("a year that isn't this one shows in the echo (F42)", () => {
  it("says 2027", () => {
    expect(echo(read("call bank 25 dec 2027"), nowMs)).toBe("Task · Sat 25 Dec 2027");
    expect(echo(read("call bank 25 dec"), nowMs)).toBe("Task · Fri 25 Dec");
  });
});

describe("common phrasings (F82)", () => {
  it("'pay iddir every month 200' asks for the day instead of a silent Someday", () => {
    expect(read("pay iddir every month 200")).toEqual({
      kind: "inbox",
      body: "pay iddir every month 200",
      why: "Say which day, as in “monthly 24” · will ask tonight",
    });
  });

  it.each([
    ["write monthly report", { kind: "task", title: "write monthly report" }],
    ["prepare monthly report friday", { kind: "task", dueDate: "2026-11-27" }],
    ["pay rent every month friday", { kind: "task", dueDate: "2026-11-27" }],
  ])("%j: 'monthly' that isn't the repeat stays a task", (text, want) => {
    expect(read(text)).toMatchObject(want);
  });

  it("'pay iddir monthly' with no day asks for the day", () => {
    expect(read("pay iddir monthly")).toMatchObject({ kind: "inbox" });
  });

  it("'pay iddir monthly 5 200' repeats with its amount in the title", () => {
    expect(read("pay iddir monthly 5 200")).toEqual({
      kind: "task",
      title: "pay iddir 200",
      repeat: { every: "month", day: 5 },
      dueDate: "2026-12-05",
    });
  });

  it("'next friday' said on a Tuesday offers the Friday after on Tab", () => {
    const parsed = read("call bank next friday");
    expect(parsed).toMatchObject({ kind: "task", dueDate: "2026-11-27" });
    const options = readings(parsed, "call bank next friday", nowMs);
    expect(options[1]).toMatchObject({ kind: "task", title: "call bank", dueDate: "2026-12-04" });
    // Plain "fri" has no such doubt.
    const plain = readings(read("call bank fri"), "call bank fri", nowMs);
    expect(
      plain.filter((option) => option.kind === "task" && option.dueDate === "2026-12-04"),
    ).toEqual([]);
  });
});

describe("'tonight' with a time, after midnight (F86)", () => {
  it("echoes Tonight, as typed", () => {
    const late = at("2026-11-25T00:30:00");
    const parsed = parseCapture("call dad tonight 9pm", { nowMs: late });
    expect(parsed).toMatchObject({ kind: "task", dueDate: "2026-11-25" });
    expect(echo(parsed, late)).toBe("Task · Tonight 21:00");
    expect(echo(parseCapture("read quran tonight", { nowMs: late }), late)).toBe("Task · Tonight");
    // "tomorrow 9pm" at the same hour stays tomorrow.
    expect(echo(parseCapture("call dad tomorrow 9pm", { nowMs: late }), late)).toBe(
      "Task · Tomorrow 21:00",
    );
  });
});

describe("away and back (F41)", () => {
  it.each(["back", "i'm back", "im back", "I am back"])("%j ends away", (text) => {
    expect(read(text)).toEqual({ kind: "back" });
    expect(echo({ kind: "back" }, nowMs)).toBe("Back · away is off");
  });

  it("'back to work' is not that", () => {
    expect(read("back to work").kind).not.toBe("back");
  });
});

describe("echo names the area, not its id (F78)", () => {
  it("says Job A", () => {
    expect(echo(read("update cv for job a"), nowMs, undefined, undefined, { areas })).toBe(
      "Task · in its area's blocks · Job A",
    );
    expect(echo(read("update cv for job a"), nowMs)).toBe("Task · in its area's blocks · #joba");
  });
});

describe("a several-item line says which piece is on another day (reg2-9)", () => {
  it("shows yesterday on taxi", () => {
    expect(echo(read("lunch 120, taxi 40 yesterday"), nowMs)).toBe(
      "2 entries · lunch 120, taxi 40 yesterday · 160 ETB out",
    );
  });
});
