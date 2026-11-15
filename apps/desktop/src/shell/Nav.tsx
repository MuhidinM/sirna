/**
 * The rail on every page after setup (docs/design.md; T-071): six places as
 * icons, the capture +, and the Night/Forest switch. Planning pages sit
 * together under Plan, with a segmented control, so every page is still one
 * or two clicks away.
 */
import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";

import { transact } from "../kernel/db";
import { applyTheme, cachedTheme, type Theme } from "../theme/theme";
import {
  IconDashboard,
  IconMoney,
  IconMoon,
  IconPlan,
  IconPlus,
  IconProjects,
  IconSettings,
  IconSun,
  IconToday,
  Logo,
} from "./icons";
export type Page =
  | "today"
  | "tasks"
  | "projects"
  | "money"
  | "weekcard"
  | "dashboard"
  | "notes"
  | "kits"
  | "review"
  | "week"
  | "settings";

/** The pages that open under Plan, in tab order. */
export const PLAN_TABS: { page: Page; label: string }[] = [
  { page: "weekcard", label: "This week" },
  { page: "tasks", label: "Tasks" },
  { page: "week", label: "Routine" },
  { page: "review", label: "Night review" },
  { page: "notes", label: "Cheat sheets" },
  { page: "kits", label: "Focus kits" },
];

export const isPlanPage = (page: Page) => PLAN_TABS.some((tab) => tab.page === page);

/** The rail: a Plan entry stands for all of its tabs. */
export const PAGES: { page: Page; label: string }[] = [
  { page: "today", label: "Today" },
  { page: "weekcard", label: "Plan" },
  { page: "projects", label: "Projects" },
  { page: "money", label: "Money" },
  { page: "dashboard", label: "Dashboard" },
  { page: "settings", label: "Settings" },
];

const ICONS: Partial<Record<Page, typeof IconToday>> = {
  today: IconToday,
  weekcard: IconPlan,
  projects: IconProjects,
  money: IconMoney,
  dashboard: IconDashboard,
  settings: IconSettings,
};

/** The rail entry a page belongs to. */
export const navPageOf = (page: Page): Page => (isPlanPage(page) ? "weekcard" : page);

export function Nav({ current, onGo }: { current: Page; onGo: (page: Page) => void }) {
  const active = navPageOf(current);
  return (
    <nav className="rail" aria-label="Pages">
      <span className="rail-logo" title="Sirna">
        <Logo />
      </span>
      <ul className="rail-pages">
        {PAGES.map(({ page, label }) => {
          const Icon = ICONS[page] ?? IconToday;
          return (
            <li key={page}>
              <button
                type="button"
                className="rail-item"
                aria-current={page === active ? "page" : undefined}
                aria-label={label}
                title={label}
                onClick={() => onGo(page)}
              >
                <Icon size={21} />
              </button>
            </li>
          );
        })}
      </ul>
      <div className="rail-foot">
        <button
          type="button"
          className="rail-add"
          aria-label="Capture something"
          title="Capture (Ctrl+Alt+J)"
          onClick={() => void invoke("open_capture").catch(() => undefined)}
        >
          <IconPlus size={22} />
        </button>
        <ThemeSwitch />
      </div>
    </nav>
  );
}

/** Night or Forest, saved at once. */
function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(cachedTheme);
  const toggle = () => {
    const next: Theme = theme === "night" ? "forest" : "night";
    setTheme(next);
    applyTheme(next);
    void transact(
      "user",
      [
        {
          op: "upsert",
          table: "core_settings",
          id: "ui.theme",
          values: { value_json: JSON.stringify(next) },
        },
      ],
      "settings",
    ).catch(() => undefined);
  };
  return (
    <button
      type="button"
      className="theme-switch"
      data-on={theme}
      role="switch"
      aria-checked={theme === "forest"}
      aria-label={theme === "night" ? "Switch to Forest" : "Switch to Night"}
      title={theme === "night" ? "Night · switch to Forest" : "Forest · switch to Night"}
      onClick={toggle}
    >
      <span className="theme-switch-knob">
        {theme === "night" ? <IconMoon size={14} /> : <IconSun size={14} />}
      </span>
    </button>
  );
}

/** A segmented control: one choice out of a few, as pills on a track. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="seg" role="tablist" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          className="seg-item"
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** The tabs across the top of a Plan page. */
export function PlanTabs({ current, onGo }: { current: Page; onGo: (page: Page) => void }) {
  return (
    <div className="plan-tabs">
      <Segmented
        label="Plan"
        options={PLAN_TABS.map(({ page, label }) => ({ value: page, label }))}
        value={current}
        onChange={onGo}
      />
    </div>
  );
}
