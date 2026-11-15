/**
 * The sidebar on every page after setup (plan §3.14; T-071): six places.
 * Planning pages sit together under Plan, with tabs, so every page is still
 * one or two clicks away.
 */
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

/** The sidebar: a Plan entry stands for all of its tabs. */
export const PAGES: { page: Page; label: string }[] = [
  { page: "today", label: "Today" },
  { page: "weekcard", label: "Plan" },
  { page: "projects", label: "Projects" },
  { page: "money", label: "Money" },
  { page: "dashboard", label: "Dashboard" },
  { page: "settings", label: "Settings" },
];

/** The sidebar entry a page belongs to. */
export const navPageOf = (page: Page): Page => (isPlanPage(page) ? "weekcard" : page);

export function Nav({ current, onGo }: { current: Page; onGo: (page: Page) => void }) {
  const active = navPageOf(current);
  return (
    <nav className="sidebar" aria-label="Pages">
      <p className="sidebar-name">Sirna</p>
      <ul>
        {PAGES.map(({ page, label }) => (
          <li key={page}>
            <button
              type="button"
              className="sidebar-item"
              aria-current={page === active ? "page" : undefined}
              onClick={() => onGo(page)}
            >
              {label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** The tabs across the top of a Plan page. */
export function PlanTabs({ current, onGo }: { current: Page; onGo: (page: Page) => void }) {
  return (
    <nav className="row plan-tabs" aria-label="Plan">
      {PLAN_TABS.map(({ page, label }) => (
        <button
          key={page}
          type="button"
          aria-current={page === current ? "page" : undefined}
          className={page === current ? "step current" : "step"}
          onClick={() => onGo(page)}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}
