# Architecture Decision Records

Format: Context → Decision → Consequences. One decision per file. Status: proposed · accepted · superseded.

The planning-stage decisions (D1–D49) are logged in [plan §15](../plan.md#15-decision-log). New decisions from M0 onward get a file here.

| ADR                                        | Title                                      | Status   |
| ------------------------------------------ | ------------------------------------------ | -------- |
| [0001](0001-tauri-v2.md)                   | Tauri v2 with a Rust tray core             | accepted |
| [0002](0002-local-sqlite-owned-by-rust.md) | One local SQLite file, owned by Rust       | accepted |
| [0003](0003-app-calculates-ai-explains.md) | The app calculates, the AI explains        | accepted |
| [0004](0004-capture-hotkey-fallback.md)    | Capture hotkey with fallbacks              | accepted |
| [0005](0005-own-date-reader.md)            | A small date reader instead of chrono-node | accepted |
