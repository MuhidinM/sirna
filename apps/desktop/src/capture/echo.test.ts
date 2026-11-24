// The echo says what was saved, and only that (user-test campaign).
import { describe, expect, it } from "vitest";

import { echo } from "./ops";
import { type ParseOptions, parseCapture } from "./parse";

const nowMs = Date.parse("2026-11-24T09:30:00+03:00"); // Tuesday
const accounts = [
  { id: "cash", name: "Cash", kind: "cash", pays_in: 0, currency: "ETB", is_savings: 0 },
  { id: "cbo", name: "CBO", kind: "bank", pays_in: 1, currency: "ETB", is_savings: 0 },
  { id: "telebirr", name: "telebirr", kind: "mobile", pays_in: 0, currency: "ETB", is_savings: 0 },
];
const read = (text: string, extra: Partial<ParseOptions> = {}) =>
  parseCapture(text, { nowMs, accounts, ...extra });

describe("away (F41)", () => {
  it("reads `for 3 days` as back on the third day", () => {
    expect(read("away for 3 days")).toEqual({ kind: "away", until: "2026-11-27" });
    expect(read("away for a week")).toEqual({ kind: "away", until: "2026-12-01" });
    expect(read("away for 2 weeks")).toEqual({ kind: "away", until: "2026-12-08" });
    expect(read("away for eight days")).toEqual({ kind: "away", until: "2026-12-02" });
    expect(read("away for twelve days")).toEqual({ kind: "away", until: "2026-12-06" });
  });

  it("refuses a day that is already here, saving nothing", () => {
    const refused = {
      kind: "inbox",
      body: "",
      why: "That day is already here: say the day you're back",
    };
    expect(read("away till today")).toEqual(refused);
    expect(read("away till yesterday")).toEqual(refused);
    expect(read("away till fri")).toEqual({ kind: "away", until: "2026-11-27" });
  });

  it("says the real default, in lower case mid-line", () => {
    expect(echo(read("away"), nowMs)).toBe("Away until tomorrow");
    expect(echo({ kind: "away", until: "2026-11-25" }, nowMs)).toBe("Away until tomorrow");
    expect(echo(read("away till fri"), nowMs)).toBe("Away until Fri 27 Nov");
  });
});

describe("saving echoes (F76)", () => {
  it("tells no goal apart from no goal named", () => {
    const saved = read("saved 700", { accounts: [] });
    expect(echo(saved, nowMs, undefined, null)).toBe(
      "Saved 700 ETB · no goal yet: add one on the Dashboard",
    );
    expect(echo(saved, nowMs, undefined, null, { hasGoals: true })).toBe(
      "Saved 700 ETB · no goal named: give it one on the Dashboard",
    );
  });

  it("an inbox line doesn't say Saved", () => {
    const line = read("saved 300 car", { goals: ["laptop"] });
    expect(line.kind).toBe("inbox");
    expect(echo(line, nowMs)).toBe("Inbox · will ask tonight");
  });
});

describe("money echoes (F78, F79, F109)", () => {
  it("names no area a money line didn't save", () => {
    expect(echo(read("lunch 120 #jobhunt"), nowMs)).toBe("120 ETB · Food");
    expect(echo(read("+5000 bonus #jobhunt"), nowMs)).toBe(
      "Income · 5,000 ETB · Other income · CBO",
    );
  });

  it("shows the day when it isn't today", () => {
    expect(echo(read("lunch 120"), nowMs)).toBe("120 ETB · Food");
    expect(echo(read("lunch 120 yesterday"), nowMs)).toBe("120 ETB · Food · Yesterday");
    expect(echo(read("taxi 80 tomorrow"), nowMs)).toBe("80 ETB · Transport · Tomorrow");
  });

  it("names the account of each entry on a several-item line", () => {
    expect(echo(read("coffee 45, taxi 60 @telebirr"), nowMs)).toBe(
      "2 entries · coffee 45 (telebirr), taxi 60 (telebirr) · 105 ETB out",
    );
    expect(echo(read("coffee 45 @telebirr, taxi 60"), nowMs)).toBe(
      "2 entries · coffee 45 (telebirr), taxi 60 · 105 ETB out",
    );
  });
});
