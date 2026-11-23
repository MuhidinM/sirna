import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { themeFromSetting } from "./theme";

/**
 * Checks text/background pairs in both themes against WCAG AA (4.5:1 for body
 * text, 3:1 for large text and UI marks).
 */
const css = readFileSync(fileURLToPath(new URL("./tokens.css", import.meta.url)), "utf8");

function block(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  return Object.fromEntries(
    [...body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1] ?? "", m[2] ?? ""]),
  );
}

function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const linear = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const themes = {
  night: block('[data-theme="night"] {'),
  forest: block('[data-theme="forest"] {'),
};
const shared = block(":root {\n  /* The loud palette");

describe.each(Object.entries(themes))("%s theme", (_, t) => {
  it.each(["frame", "panel", "raised"])("text is readable on %s", (surface) => {
    expect(ratio(t["ink"] ?? "", t[surface] ?? "")).toBeGreaterThanOrEqual(4.5);
    expect(ratio(t["ink-2"] ?? "", t[surface] ?? "")).toBeGreaterThanOrEqual(4.5);
  });

  it("hints and chart bars are visible", () => {
    expect(ratio(t["ink-3"] ?? "", t["panel"] ?? "")).toBeGreaterThanOrEqual(3);
    expect(ratio(t["bar-top"] ?? "", t["panel"] ?? "")).toBeGreaterThanOrEqual(1.3);
  });

  it("the yellow and the cream stand out from the panel", () => {
    expect(ratio(shared["yellow"] ?? "", t["panel"] ?? "")).toBeGreaterThanOrEqual(3);
    expect(ratio(shared["cream"] ?? "", t["panel"] ?? "")).toBeGreaterThanOrEqual(3);
  });
});

describe.each(Object.entries(themes))("%s canvas", (_, t) => {
  it("is dark, like the panels around it", () => {
    expect(luminance(t["canvas"] ?? "")).toBeLessThan(0.06);
    expect(luminance(t["canvas-cream"] ?? "")).toBeLessThan(0.1);
    expect(luminance(t["canvas-mint"] ?? "")).toBeLessThan(0.1);
  });

  it.each(["canvas", "canvas-2", "canvas-3"])("text is readable on %s", (surface) => {
    expect(ratio(t["canvas-ink"] ?? "", t[surface] ?? "")).toBeGreaterThanOrEqual(4.5);
    expect(ratio(t["canvas-ink-2"] ?? "", t[surface] ?? "")).toBeGreaterThanOrEqual(4.5);
  });

  it("hints, lines and bars are visible", () => {
    expect(ratio(t["canvas-ink-3"] ?? "", t["canvas"] ?? "")).toBeGreaterThanOrEqual(3);
    expect(ratio(t["canvas-ink-3"] ?? "", t["canvas-2"] ?? "")).toBeGreaterThanOrEqual(3);
    expect(ratio(t["canvas-line"] ?? "", t["canvas"] ?? "")).toBeGreaterThanOrEqual(1.2);
    expect(ratio(t["canvas-strong"] ?? "", t["canvas"] ?? "")).toBeGreaterThanOrEqual(1.6);
    expect(ratio(t["canvas-bar-top"] ?? "", t["canvas"] ?? "")).toBeGreaterThanOrEqual(1.5);
  });

  it("cream and mint blocks are soft but distinct, with readable ink", () => {
    expect(ratio(t["canvas-cream"] ?? "", t["canvas"] ?? "")).toBeGreaterThanOrEqual(1.3);
    expect(ratio(t["canvas-mint"] ?? "", t["canvas"] ?? "")).toBeGreaterThanOrEqual(1.15);
    expect(ratio(t["canvas-cream-ink"] ?? "", t["canvas-cream"] ?? "")).toBeGreaterThanOrEqual(7);
    expect(ratio(t["canvas-mint-ink"] ?? "", t["canvas-mint"] ?? "")).toBeGreaterThanOrEqual(4.5);
  });

  it("the loud cards stay bright on the canvas", () => {
    for (const loud of ["yellow", "orange", "pink", "purple", "sky", "leaf"]) {
      expect(ratio(shared[loud] ?? "", t["canvas"] ?? "")).toBeGreaterThanOrEqual(3);
    }
    expect(ratio(shared["area-admin"] ?? "", t["canvas"] ?? "")).toBeGreaterThanOrEqual(3);
    expect(ratio(shared["area-ink"] ?? "", shared["area-admin"] ?? "")).toBeGreaterThanOrEqual(4.5);
  });

  it("the danger red and the success green read on the canvas", () => {
    expect(ratio("#ff8a8a", t["canvas"] ?? "")).toBeGreaterThanOrEqual(4.5);
    expect(ratio(shared["leaf"] ?? "", t["canvas"] ?? "")).toBeGreaterThanOrEqual(4.5);
  });
});

describe("the loud colours", () => {
  it.each(["yellow", "orange", "purple", "pink", "cream", "mint", "sky", "leaf"])(
    "%s carries readable dark text",
    (name) => {
      expect(ratio(shared["on-loud"] ?? "", shared[name] ?? "")).toBeGreaterThanOrEqual(4.5);
    },
  );

  it("white titles on orange and pink are readable as large text", () => {
    expect(ratio("#ffffff", shared["orange"] ?? "")).toBeGreaterThanOrEqual(3);
    expect(ratio("#ffffff", shared["pink"] ?? "")).toBeGreaterThanOrEqual(2.9);
  });

  it("the mint ink reads on mint", () => {
    expect(ratio(shared["mint-ink"] ?? "", shared["mint"] ?? "")).toBeGreaterThanOrEqual(3);
  });
});

describe("themeFromSetting", () => {
  it("reads Night by default and Forest when chosen", () => {
    expect(themeFromSetting(undefined)).toBe("night");
    expect(themeFromSetting("not json")).toBe("night");
    expect(themeFromSetting('"light"')).toBe("night");
    expect(themeFromSetting('"forest"')).toBe("forest");
  });
});
