# Testing

What is tested, how, and how to run it. Sized for one developer: fast unit tests on everything that decides something, a short manual smoke test for what only the installed app can show.

## Layers

| Layer           | Tool                                                                                           | Where                              | Runs                                      |
| --------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------- |
| TypeScript unit | Vitest, fake clock, in-memory `node:sqlite` with the real migrations                           | `apps/desktop/src/**/*.test.ts`    | `pnpm test`, pre-push, CI                 |
| Fixtures        | JSON/JSONL cases for the capture parser, day planner, slot finder                              | `fixtures/` next to each feature   | with `pnpm test`                          |
| Rust unit       | `cargo test` (timer state machine, migrations, db_tx allowlist, reminder query)                | `src-tauri/src/**`                 | pre-push, CI                              |
| AI evals        | Recorded mock outputs offline; real model on demand                                            | `evals/*.jsonl`                    | `pnpm test` (mock), `pnpm eval:ai` (live) |
| Static checks   | TypeScript strict, ESLint, Prettier, clippy, rustfmt                                           | everything                         | pre-commit, pre-push, CI                  |
| Measurements    | `scripts/measure.ps1` (private bytes over the process tree)                                    | [measurements.md](measurements.md) | after each milestone, by hand             |
| Smoke test      | 5-minute checklist in the installed build: hotkey, toast buttons, tray, sleep, reboot, restore | [smoke.md](smoke.md)               | after each `pnpm ship`                    |

Dev scripts: `scripts/hotkey-check.ps1` presses the capture key and reads the app's "capture ready in N ms" log line; `scripts/read-captures.mjs` prints the newest captures from the local database; `scripts/toast-check.ps1` shows the check toast (`sirna.exe --test-toast`) and clicks a button through UI Automation; `scripts/measure.ps1` sums private bytes; `scripts/window-shot.ps1` saves a PNG of a Sirna window even when it is behind others. UI checks need an unlocked screen. Set `SIRNA_DATA_DIR` to a throwaway folder before starting a dev build so checks never touch your real data.

No end-to-end browser framework: the risky parts (tray, toasts, hotkey, sleep) only behave correctly in the installed Windows build, so the smoke test and measurements cover them.

## Rules

- **Time is injected.** Nothing reads the system clock directly; tests set the clock, including across 03:00 (the logical-day boundary) and sleep gaps.
- **One schema.** Tests run the same migration files as the app.
- **Parsers and planners are fixture-driven.** A wrong parse reported with `fb:` becomes a fixture before the fix.
- **AI never in the default test run.** The mock adapter replays recorded outputs; `pnpm eval:ai` is the only live call.
- **Deterministic numbers.** Every number the AI may phrase is computed and tested in code first.

## Running

```bash
pnpm test
```

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```
