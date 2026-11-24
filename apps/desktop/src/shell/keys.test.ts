import { describe, expect, it, vi } from "vitest";
import { type KeyboardEvent } from "react";

import { cancelOnEscape, nextDay, nextTab } from "./keys";

const key = (k: string, isComposing = false) => {
  const event = {
    key: k,
    nativeEvent: { isComposing },
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
  return event as unknown as KeyboardEvent & typeof event;
};

describe("Escape cancels an inline form (F93)", () => {
  it("calls cancel on Escape and stops it there", () => {
    const cancel = vi.fn();
    const event = key("Escape");
    cancelOnEscape(cancel)(event);
    expect(cancel).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalled();
  });

  it("ignores other keys and Escape while composing", () => {
    const cancel = vi.fn();
    cancelOnEscape(cancel)(key("Enter"));
    cancelOnEscape(cancel)(key("Escape", true));
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe("arrow keys across tabs (F94)", () => {
  it("moves and wraps", () => {
    expect(nextTab(0, 7, "ArrowRight")).toBe(1);
    expect(nextTab(6, 7, "ArrowRight")).toBe(0);
    expect(nextTab(0, 7, "ArrowLeft")).toBe(6);
    expect(nextTab(3, 7, "Home")).toBe(0);
    expect(nextTab(3, 7, "End")).toBe(6);
    expect(nextTab(3, 7, "a")).toBeNull();
  });
});

describe("arrow keys across the month grid (F94)", () => {
  it("moves by a day and a week, across months", () => {
    expect(nextDay("2026-11-24", "ArrowRight")).toBe("2026-11-25");
    expect(nextDay("2026-11-30", "ArrowRight")).toBe("2026-12-01");
    expect(nextDay("2026-11-03", "ArrowUp")).toBe("2026-10-27");
    expect(nextDay("2026-11-24", "ArrowDown")).toBe("2026-12-01");
  });

  it("goes to the week's ends, Monday first", () => {
    // 24 Nov 2026 is a Tuesday.
    expect(nextDay("2026-11-24", "Home")).toBe("2026-11-23");
    expect(nextDay("2026-11-24", "End")).toBe("2026-11-29");
  });

  it("pages by a month and keeps the day when it can", () => {
    expect(nextDay("2026-11-24", "PageDown")).toBe("2026-12-24");
    expect(nextDay("2026-01-31", "PageDown")).toBe("2026-02-28");
    expect(nextDay("2026-01-15", "PageUp")).toBe("2025-12-15");
    expect(nextDay("2026-11-24", "x")).toBeNull();
  });
});
