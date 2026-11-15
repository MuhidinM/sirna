// Dev-only scratch page for the savings tree (tree-preview.html). Not shipped.
import { createRoot } from "react-dom/client";

import "@fontsource-variable/bricolage-grotesque";
import "../theme/tokens.css";
import "../theme/components.css";
import "../theme/shell.css";
import "../theme/kit.css";
import "../theme/pages.css";
import { applyTheme, cachedTheme } from "../theme/theme";

applyTheme(cachedTheme());
void import("./tauriPreview")
  .then((preview) => preview.install())
  .then(() => import("../shell/Savings"))
  .then(({ Savings }) => {
    const root = document.getElementById("root");
    if (root)
      createRoot(root).render(
        <div style={{ padding: 14, maxWidth: 1200 }}>
          <Savings />
        </div>,
      );
  });

// Other pages may be mid-edit; their error overlay doesn't concern this page.
new MutationObserver(() =>
  document.querySelectorAll("vite-error-overlay").forEach((overlay) => overlay.remove()),
).observe(document.documentElement, { childList: true, subtree: true });
