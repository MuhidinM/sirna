import { describe, expect, it } from "vitest";

import {
  actionsLine,
  blockLabel,
  choices,
  confirmText,
  defaultChoice,
  enterStarts,
  OTHER,
  PLAIN,
  runningBlock,
  type SetupInfo,
  type SheetBlock,
  shortName,
  startProblem,
  targetOf,
  visibleChecklist,
} from "./sheet";

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

// 2026-11-23 10:00 Addis (07:00 UTC).
const NOW = Date.UTC(2026, 10, 23, 7, 0);
const MIN = 60_000;

function block(id: string, startMin: number, endMin: number, title: string): SheetBlock {
  return {
    id,
    title,
    start_at: NOW + startMin * MIN,
    end_at: NOW + endMin * MIN,
    kind: "area",
    area_id: null,
  };
}

function info(over: Partial<SetupInfo> = {}): SetupInfo {
  return {
    title: "Focus",
    minutes: 25,
    kit: { open: [], minimize: [], checklist: [] },
    dnd: false,
    notes: [],
    block_id: null,
    blocks: [block("lunch", -30, 30, "Lunch"), block("code", 60, 150, "Coding skills")],
    areas: [
      { id: "jobhunt", name: "Job hunt" },
      { id: "quran", name: "Quran" },
    ],
    ...over,
  };
}

describe("what the session is for (spec §1 rule 7)", () => {
  it("defaults to the block asked for, else the block now, else Just focus", () => {
    expect(defaultChoice(info({ block_id: "code" }), NOW)).toBe("block:code");
    // Any block counts, a fixed one too.
    expect(defaultChoice(info(), NOW)).toBe("block:lunch");
    expect(defaultChoice(info({ blocks: [] }), NOW)).toBe(PLAIN);
  });

  it("offers today's blocks, the areas, Just focus and Other…", () => {
    const list = choices(info(), NOW);
    expect(list.map((choice) => choice.value)).toEqual([
      "block:lunch",
      "block:code",
      "area:jobhunt",
      "area:quran",
      PLAIN,
      OTHER,
    ]);
    expect(list[0]?.label).toBe("Now · Lunch");
    expect(list[1]?.label).toBe("11:00–12:30 · Coding skills");
    expect(list[2]?.group).toBe("Areas");
  });

  it("keeps the block asked for when it isn't today's", () => {
    const list = choices(info({ block_id: "old", title: "Job hunt" }), NOW);
    expect(list[0]).toEqual({ value: "block:old", label: "Job hunt", group: "Today" });
  });

  it("picks the latest-starting block when two run now", () => {
    const blocks = [block("a", -60, 60, "Job A"), block("b", -10, 20, "Call")];
    expect(runningBlock(blocks, NOW)?.id).toBe("b");
    expect(runningBlock(blocks, NOW + 90 * MIN)).toBeUndefined();
    expect(blockLabel(blocks[1] as SheetBlock, NOW + 30 * MIN)).toBe("09:50–10:20 · Call");
  });

  it("turns a choice into the target Rust takes", () => {
    expect(targetOf("block:b1")).toEqual({ blockId: "b1" });
    expect(targetOf("area:quran")).toEqual({ areaId: "quran" });
    expect(targetOf(PLAIN)).toEqual({});
    expect(targetOf(OTHER, "  Read a book ")).toEqual({ other: "Read a book" });
  });

  it("asks for a name before starting Other…", () => {
    expect(startProblem(OTHER, "  ")).toMatch(/what this session is for/);
    expect(startProblem(OTHER, "Read")).toBeUndefined();
    expect(startProblem("area:quran", "")).toBeUndefined();
  });
});

describe("enterStarts", () => {
  const key = (over: Partial<Parameters<typeof enterStarts>[0]> = {}) => ({
    key: "Enter",
    repeat: false,
    isComposing: false,
    altKey: false,
    ctrlKey: false,
    shiftKey: false,
    metaKey: false,
    ...over,
  });

  it("starts on a plain Enter on the closed For list", () => {
    expect(enterStarts(key())).toBe(true);
  });

  it("ignores held, composed, modified and other keys", () => {
    expect(enterStarts(key({ repeat: true }))).toBe(false);
    expect(enterStarts(key({ isComposing: true }))).toBe(false);
    expect(enterStarts(key({ altKey: true }))).toBe(false);
    expect(enterStarts(key({ ctrlKey: true }))).toBe(false);
    expect(enterStarts(key({ shiftKey: true }))).toBe(false);
    expect(enterStarts(key({ key: " " }))).toBe(false);
    expect(enterStarts(key({ key: "ArrowDown" }))).toBe(false);
  });
});
