import { useSyncExternalStore } from "react";

import { THEME_EVENT, type Theme, transactTheme } from "../theme/themeStore";

export { transactTheme };

const read = (): Theme =>
  document.documentElement.dataset.theme === "forest" ? "forest" : "night";

function subscribe(onChange: () => void) {
  window.addEventListener(THEME_EVENT, onChange);
  return () => window.removeEventListener(THEME_EVENT, onChange);
}

/** The theme on screen now: one source of truth for the rail switch and Settings. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, read, read);
}
