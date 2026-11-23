import { describe, expect, it } from "vitest";

import { isPlanPage, navPageOf, type Page, PAGES, PLAN_TABS } from "./Nav";

const ALL: Page[] = [
  "today",
  "tasks",
  "projects",
  "money",
  "weekcard",
  "day",
  "dashboard",
  "notes",
  "kits",
  "review",
  "week",
  "settings",
];

describe("the sidebar (T-071)", () => {
  it("has six places", () => {
    expect(PAGES.map((p) => p.label)).toEqual([
      "Today",
      "Plan",
      "Projects",
      "Money",
      "Dashboard",
      "Settings",
    ]);
  });

  it("reaches every page in one or two clicks", () => {
    for (const page of ALL) {
      const direct = PAGES.some((p) => p.page === page);
      expect(direct || isPlanPage(page)).toBe(true);
    }
    expect(PLAN_TABS.map((t) => t.label)).toEqual([
      "This week",
      "Day",
      "Tasks",
      "Routine",
      "Night review",
      "Cheat sheets",
      "Focus kits",
    ]);
  });

  it("lights up Plan for any planning page", () => {
    expect(navPageOf("review")).toBe("weekcard");
    expect(navPageOf("tasks")).toBe("weekcard");
    expect(navPageOf("day")).toBe("weekcard");
    expect(navPageOf("money")).toBe("money");
  });
});
