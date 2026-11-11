/** The sidebar on every page after setup (plan §3.14). */
export type Page = "today" | "projects" | "notes" | "kits" | "review" | "week" | "settings";

export const PAGES: { page: Page; label: string }[] = [
  { page: "today", label: "Today" },
  { page: "projects", label: "Projects" },
  { page: "notes", label: "Cheat sheets" },
  { page: "kits", label: "Focus kits" },
  { page: "review", label: "Night review" },
  { page: "week", label: "My week" },
  { page: "settings", label: "Settings" },
];

export function Nav({ current, onGo }: { current: Page; onGo: (page: Page) => void }) {
  return (
    <nav className="sidebar" aria-label="Pages">
      <p className="sidebar-name">Sirna</p>
      <ul>
        {PAGES.map(({ page, label }) => (
          <li key={page}>
            <button
              type="button"
              className="sidebar-item"
              aria-current={page === current ? "page" : undefined}
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
