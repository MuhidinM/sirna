import { describe, expect, it } from "vitest";

import { actionsLine, confirmText, shortName, visibleChecklist } from "./sheet";

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

describe("Do not disturb on the sheet", () => {
  const kit = {
    open: [],
    minimize: [],
    checklist: ["Phone in another room", "Do not disturb on (Win+N)"],
  };

  it("says it and drops the manual tick when Sirna does it", () => {
    expect(actionsLine(kit, true)).toBe("Do not disturb on");
    expect(visibleChecklist(kit, true)).toEqual(["Phone in another room"]);
  });

  it("keeps the tick as the fallback when it can't", () => {
    expect(actionsLine(kit, false)).toBe("");
    expect(visibleChecklist(kit, false)).toEqual(kit.checklist);
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
