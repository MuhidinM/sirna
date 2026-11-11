import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyTheme, cachedTheme } from "./theme/theme";

import "./theme/tokens.css";
import "./theme/components.css";
import "./App.css";

// Before the first render, so the window never shows the wrong theme.
applyTheme(cachedTheme());

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
