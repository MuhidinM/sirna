import { describe, expect, it } from "vitest";

import { actionsLine, confirmText, shortName } from "./sheet";

describe("actionsLine", () => {
  it("says what Enter will open and minimize", () => {
    expect(
      actionsLine({
        open: ["https://www.linkedin.com/jobs/", "D:\\Docs\\CV\\"],
        minimize: ["Telegram.exe", "Discord"],
        checklist: [],
      }),
    ).toBe("Opens linkedin.com, CV · Minimizes Telegram, Discord");
  });

  it("is empty for an empty kit", () => {
    expect(actionsLine({ open: [], minimize: [], checklist: ["Water"] })).toBe("");
  });
});

describe("shortName", () => {
  it("keeps commands and long names readable", () => {
    expect(shortName("code D:\\Projects\\sirna")).toBe("sirna");
    expect(shortName("a".repeat(40))).toHaveLength(32);
  });
});

describe("confirmText", () => {
  it("asks for the second Enter only when needed", () => {
    expect(confirmText("confirm-stop")).toMatch(/hard stop/);
    expect(confirmText("confirm")).toMatch(/long break/);
    expect(confirmText("started")).toBeUndefined();
    expect(confirmText("already")).toBeUndefined();
  });
});
