# Working on Sirna

Sirna is a Windows tray app (Tauri v2 + React + TypeScript + SQLite) that plans the week across life areas, runs focus sessions and guards against burnout. One user, local-first.

Read before writing code:

- [docs/plan.md](docs/plan.md) — the full design. §0 is the summary; §13 lists the milestones and which sections each one needs.
- [docs/workflow.md](docs/workflow.md) — issues, branches, commits, pull requests and the Definition of Done.
- [docs/backlog.md](docs/backlog.md) — the next task, in milestone order.

Rules that hold everywhere:

1. **The app calculates, the AI explains.** Capacity, load, money and verdicts are deterministic code with tests. Gemini only phrases and suggests; every AI change is undoable.
2. **Rust only for what must run with no window open** (tray, timer, toasts, hotkey, DB, network, secrets). Product logic is TypeScript.
3. **Store first, parse second.** Every capture lands unchanged in `core_raw_items` before parsing.
4. **Money is integer santim; durations are minutes; dates use `logicalDate()` (day starts 03:00, Africa/Addis_Ababa).**
5. **No secrets in SQLite, logs, the webview or the repo.** They live in Windows Credential Manager.
6. **Small on the machine.** No webview without a window. Check `docs/measurements.md` targets when touching startup, the tray or windows.
7. Toasts and the tray only behave correctly in the installed build: test them after `pnpm ship`.
