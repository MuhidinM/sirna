import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;
const page = (name: string) => fileURLToPath(new URL(`./${name}.html`, import.meta.url));

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react()],

  // Four pages: the main window (React), and the capture box, focus set-up sheet and
  // desktop widget (plain TypeScript, kept small).
  build: {
    rollupOptions: {
      input: {
        main: page("index"),
        capture: page("capture"),
        setup: page("setup"),
        widget: page("widget"),
      },
    },
  },

  // Vite options for Tauri, only applied in `tauri dev` or `tauri build`:
  // 1. don't hide Rust errors
  clearScreen: false,
  // 2. Tauri expects a fixed port; fail if it isn't available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    // 3. don't watch src-tauri
    watch: { ignored: ["**/src-tauri/**"] },
  },
}));
