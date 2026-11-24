/**
 * The rail on every page after setup (docs/design.md; T-071): six places as
 * icons, the capture +, and the Night/Forest switch. Planning pages sit
 * together under Plan, with a segmented control, so every page is still one
 * or two clicks away.
 */
import { invoke } from "@tauri-apps/api/core";
import { type KeyboardEvent } from "react";

import { nextTab } from "./keys";
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
import { transactTheme, useTheme } from "./useTheme";
export type Page =
  | "today"
  | "tasks"
  | "projects"
  | "money"
  | "weekcard"
  | "day"
  | "dashboard"
  | "notes"
  | "kits"
  | "review"
  | "week"
  | "settings";

/** The pages that open under Plan, in tab order. */
export const PLAN_TABS: { page: Page; label: string }[] = [
  { page: "weekcard", label: "This week" },
  { page: "day", label: "Day" },
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
  const theme = useTheme();
  const toggle = () =>
    void transactTheme(theme === "night" ? "forest" : "night").catch(() => undefined);
  return (
    <button
      type="button"
      className="theme-switch"
      data-on={theme}
      role="switch"
      aria-checked={theme === "forest"}
      aria-label="Forest theme"
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
  // One Tab stop (the selected tab); arrow keys, Home and End move and select.
  const hasValue = options.some((option) => option.value === value);
  const onKey = (index: number, event: KeyboardEvent<HTMLButtonElement>) => {
    const to = nextTab(index, options.length, event.key);
    const next = to === null ? undefined : options[to];
    if (!next) return;
    event.preventDefault();
    onChange(next.value);
    const tabs = event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]');
    tabs?.[to ?? 0]?.focus();
  };
  return (
    <div className="seg" role="tablist" aria-label={label}>
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          tabIndex={option.value === value || (!hasValue && index === 0) ? 0 : -1}
          className="seg-item"
          onKeyDown={(event) => onKey(index, event)}
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
