import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyTheme, cachedTheme } from "./theme/theme";

import "@fontsource-variable/bricolage-grotesque";
import "./theme/tokens.css";
import "./theme/components.css";
import "./theme/shell.css";
import "./theme/kit.css";
import "./App.css";
import "./theme/pages.css";

// Before the first render, so the window never shows the wrong theme.
applyTheme(cachedTheme());

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

// In a plain browser during development, stand in for Tauri (src/dev/tauriPreview.ts).
const ready =
  import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)
    ? import("./dev/tauriPreview").then((preview) => preview.install())
    : Promise.resolve();

void ready.then(() =>
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  ),
);
