import { describe, expect, it } from "vitest";

import { readings } from "./alternatives";
import { parseCapture } from "./parse";

const nowMs = Date.parse("2026-11-11T12:00:00+03:00");
const kinds = (text: string) =>
  readings(parseCapture(text, { nowMs }), text, nowMs).map((reading) => reading.kind);

describe("readings", () => {
  it("starts with the parser's guess", () => {
    expect(kinds("lunch 120")[0]).toBe("expense");
    expect(kinds("dentist maybe sometime")[0]).toBe("inbox");
  });

  it("offers a task for an expense, keeping the amount in the title", () => {
    const options = readings(parseCapture("buy charger 600", { nowMs }), "buy charger 600", nowMs);
    expect(options[1]).toMatchObject({ kind: "task", title: "buy charger 600" });
  });

  it("offers today for a someday task", () => {
    const options = readings(parseCapture("buy charger", { nowMs }), "buy charger", nowMs);
    expect(options[1]).toMatchObject({ kind: "task", title: "buy charger", dueDate: "2026-11-11" });
  });

  it("offers task, idea, note and cheat sheet for an inbox line", () => {
    expect(kinds("dentist maybe sometime")).toEqual(["inbox", "task", "idea", "note", "cheat"]);
  });

  it("never repeats a kind except the dated task", () => {
    const list = kinds("idea: sell old monitor");
    expect(new Set(list).size).toBe(list.length);
  });

  it("keeps the area tag on every reading", () => {
    const options = readings(parseCapture("fix bug #jobA", { nowMs }), "fix bug #jobA", nowMs);
    for (const option of options) expect(option).toMatchObject({ area: "joba" });
  });

  it("has nothing to flip for search, away and focus", () => {
    expect(kinds("? git")).toEqual(["search"]);
    expect(kinds("focus")).toEqual(["focus"]);
  });
});
