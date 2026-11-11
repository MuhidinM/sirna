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
  dark: block('[data-theme="dark"]'),
  light: block('[data-theme="light"]'),
};
const areas = block(":root {\n  /* Area");

describe.each(Object.entries(themes))("%s theme", (_, t) => {
  it.each(["surface-0", "surface-1", "surface-2"])("body text is readable on %s", (surface) => {
    expect(ratio(t["text-primary"] ?? "", t[surface] ?? "")).toBeGreaterThanOrEqual(4.5);
    expect(ratio(t["text-secondary"] ?? "", t[surface] ?? "")).toBeGreaterThanOrEqual(4.5);
  });

  it("muted text and the accent are visible as large text or marks", () => {
    expect(ratio(t["text-muted"] ?? "", t["surface-0"] ?? "")).toBeGreaterThanOrEqual(3);
    expect(ratio(t["accent"] ?? "", t["surface-0"] ?? "")).toBeGreaterThanOrEqual(3);
  });

  it("text on the accent button is readable", () => {
    expect(ratio(t["on-accent"] ?? "", t["accent"] ?? "")).toBeGreaterThanOrEqual(4.5);
  });
});

describe("area colours", () => {
  it.each(
    Object.keys(areas).filter(
      (name) => name.startsWith("area-") && name !== "area-ink" && name !== "area-rest",
    ),
  )("%s carries readable dark text", (name) => {
    expect(ratio(areas["area-ink"] ?? "", areas[name] ?? "")).toBeGreaterThanOrEqual(4.5);
  });
});

describe("themeFromSetting", () => {
  it("defaults to dark", () => {
    expect(themeFromSetting(undefined)).toBe("dark");
    expect(themeFromSetting("not json")).toBe("dark");
    expect(themeFromSetting('"light"')).toBe("light");
  });
});
