import { describe, expect, it } from "vitest";

import moneyPage from "../../shell/Money.tsx?raw";
import { syncRateBox } from "./currency";

describe("the rate box keeps its row when a rate is set (time-first §3)", () => {
  it("keeps what is typed while the saved rate is the same", () => {
    const box = { saved: "130", text: "131.5" };
    expect(syncRateBox(box, "130")).toBe(box);
  });

  it("shows the new saved rate once it changes", () => {
    expect(syncRateBox({ saved: "130", text: "131.5" }, "131.5")).toEqual({
      saved: "131.5",
      text: "131.5",
    });
    expect(syncRateBox({ saved: "130", text: "130" }, "")).toEqual({ saved: "", text: "" });
  });

  it("keys each rate row by its currency only, so the note and focus stay", () => {
    const row = /<RateRow\s+key=\{([^}]*)\}/.exec(moneyPage);
    expect(row?.[1]).toBe("code");
  });
});
