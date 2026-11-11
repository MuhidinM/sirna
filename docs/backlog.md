# Backlog

Status: `todo` · `doing` · `review` · `done` · `cut`. Each task has a GitHub issue (the backlog ID is in the issue body) and is closed by a pull request. Progress is tracked on the [project board](https://github.com/users/MuhidinM/projects/4).
Reqs refer to [requirements.md](requirements.md). Size: S < 1 h · M 1–3 h · L > 3 h. Milestone goals and fallbacks: [plan §0 and §13](plan.md#13-build-milestones-for-claude-code).

## M0 — Setup and platform proof

Repo, tooling, CI, and the risky Tauri parts measured: tray-only app, hotkey, capture row, toast, memory. Plan §13.

| ID | Issue | Task | Reqs | Size | Status |
|---|---|---|---|---|---|
| T-001 | [#1](https://github.com/MuhidinM/sirna/issues/1) | Set up docs, templates, labels, milestones, issues and the project board | R-CQ-03 | S | done |
| T-002 | [#2](https://github.com/MuhidinM/sirna/issues/2) | Install the Rust toolchain on D: with the minimal profile | R-PLT-02 | S | done |
| T-003 | [#3](https://github.com/MuhidinM/sirna/issues/3) | Scaffold Tauri v2 + React + TypeScript + Vite with pnpm | R-PLT-05, R-CQ-01 | M | done |
| T-004 | [#4](https://github.com/MuhidinM/sirna/issues/4) | Add lint, format and pre-commit hooks for TypeScript and Rust | R-CQ-01 | M | done |
| T-005 | [#5](https://github.com/MuhidinM/sirna/issues/5) | Set up Vitest with a fake clock and node:sqlite | R-CQ-02 | S | done |
| T-006 | [#6](https://github.com/MuhidinM/sirna/issues/6) | Add CI on GitHub Actions (Windows runner) | R-CQ-02 | M | done |
| T-007 | [#7](https://github.com/MuhidinM/sirna/issues/7) | Run as a tray-only app with no window at startup | R-PLT-05 | M | done |
| T-008 | [#8](https://github.com/MuhidinM/sirna/issues/8) | Open a capture box with a global hotkey and save one row to SQLite | R-CAP-01, R-PLT-04 | L | done |
| T-009 | [#9](https://github.com/MuhidinM/sirna/issues/9) | Show a two-button toast from the installed build (pnpm ship) | R-PLT-02 | M | done |
| T-010 | [#10](https://github.com/MuhidinM/sirna/issues/10) | Measure memory and capture speed, then pick the window modes | R-PLT-01 | M | done |

## M1 — Capture and tasks

Kernel, migrations, IPC, capture parser and window, Today list, tray menu, reminders. Plan §3.5, §5.

| ID | Issue | Task | Reqs | Size | Status |
|---|---|---|---|---|---|
| T-011 | [#11](https://github.com/MuhidinM/sirna/issues/11) | Add the kernel: clock, logicalDate, ULIDs and money | R-CAP-03 | M | done |
| T-012 | [#12](https://github.com/MuhidinM/sirna/issues/12) | Run forward-only migrations with checksums and a backup first | R-PLT-03 | M | done |
| T-013 | [#13](https://github.com/MuhidinM/sirna/issues/13) | Add db_query, db_tx with an allowlist and audit, and capture undo | R-CAP-02, R-CAP-05 | L | done |
| T-014 | [#14](https://github.com/MuhidinM/sirna/issues/14) | Parse captures into tasks, expenses, ideas and notes (60 fixtures) | R-CAP-03, R-CAP-04 | L | done |
| T-015 | [#15](https://github.com/MuhidinM/sirna/issues/15) | Finish the capture window: chip, Tab, echo, Up-arrow edit | R-CAP-01, R-CAP-02, R-CAP-05 | M | done |
| T-016 | [#16](https://github.com/MuhidinM/sirna/issues/16) | Show Today's tasks and the native tray menu | R-CAP-05, R-PLAN-04 | M | done |
| T-017 | [#17](https://github.com/MuhidinM/sirna/issues/17) | Fire reminders with no window, with quiet hours and catch-up | R-NOT-01, R-NOT-02, R-NOT-03 | L | done |

## M2 — Routine, day plan and focus timer

Areas, weekly routine, day-plan generator, timeline, block toasts, Rust focus timer, themes. Daily use starts. Plan §3.2-3.6.

| ID | Issue | Task | Reqs | Size | Status |
|---|---|---|---|---|---|
| T-018 | [#18](https://github.com/MuhidinM/sirna/issues/18) | Add life areas, the weekly routine and the setup steps | R-PLAN-01, R-PLAN-02 | M | done |
| T-019 | [#19](https://github.com/MuhidinM/sirna/issues/19) | Generate each day's plan from the routine (pure TypeScript) | R-PLAN-03, R-PLAN-05 | L | done |
| T-020 | [#20](https://github.com/MuhidinM/sirna/issues/20) | Show Today as a timeline with Now, a countdown and area colours | R-PLAN-04 | M | done |
| T-021 | [#21](https://github.com/MuhidinM/sirna/issues/21) | Toast block starts, one start nudge, and email-check blocks | R-FOC-03 | M | todo |
| T-022 | [#22](https://github.com/MuhidinM/sirna/issues/22) | Run the focus timer in Rust and survive sleep and restart | R-FOC-01, R-BRN-03 | L | done |
| T-023 | [#23](https://github.com/MuhidinM/sirna/issues/23) | Control focus from the tray with a live countdown | R-FOC-02 | M | todo |
| T-024 | [#24](https://github.com/MuhidinM/sirna/issues/24) | Add the design tokens: dark and light themes, area colours | R-PLAN-04 | M | done |

## M3 — Check-ins, guard rails, focus set-up, cheat sheets

Morning brief, night review, burnout rules, focus kits, DND, waiting-on, cheat sheets, backups. Plan §3.4, §3.6a, §3.7, §3.9, §3.15.

| ID | Issue | Task | Reqs | Size | Status |
|---|---|---|---|---|---|
| T-025 | [#25](https://github.com/MuhidinM/sirna/issues/25) | Open the morning brief at first unlock | R-CHK-01, R-NOT-03 | L | todo |
| T-026 | [#26](https://github.com/MuhidinM/sirna/issues/26) | Run the night review: today, spending, energy, tomorrow | R-CHK-02, R-CHK-03, R-BRN-04 | L | todo |
| T-027 | [#27](https://github.com/MuhidinM/sirna/issues/27) | Enforce the burnout rules: cap, hard stop, light and rest days | R-BRN-01, R-BRN-02, R-BRN-04, R-BRN-05 | M | todo |
| T-028 | [#28](https://github.com/MuhidinM/sirna/issues/28) | Add the focus set-up sheet and per-area focus kits | R-FOC-04 | L | todo |
| T-029 | [#29](https://github.com/MuhidinM/sirna/issues/29) | Spike: switch Do Not Disturb on during focus | R-FOC-05 | M | todo |
| T-030 | [#30](https://github.com/MuhidinM/sirna/issues/30) | Track waiting-on items and show what changed since yesterday | R-PRJ-04, R-CHK-05 | M | todo |
| T-031 | [#31](https://github.com/MuhidinM/sirna/issues/31) | Keep cheat sheets: pin from capture, Notes page, show in focus | R-NOTE-01, R-NOTE-02, R-NOTE-03 | M | todo |
| T-032 | [#32](https://github.com/MuhidinM/sirna/issues/32) | Back up daily, document restore, away mode and usage numbers | R-PLT-03 | M | todo |
| T-046 | [#33](https://github.com/MuhidinM/sirna/issues/33) | Release v0.1.0 (daily use) | — | S | todo |

## M4 — Projects and AI timing check

Projects board, capacity and slot finder, timing card, Gemini gate and touchpoints. Plan §3.8, §7.

| ID | Issue | Task | Reqs | Size | Status |
|---|---|---|---|---|---|
| T-033 | [#34](https://github.com/MuhidinM/sirna/issues/34) | Add projects with a board and list view | R-PRJ-03 | M | todo |
| T-034 | [#35](https://github.com/MuhidinM/sirna/issues/35) | Calculate capacity and load, and find a slot for new work | R-PRJ-01, R-PRJ-02, R-BRN-05 | L | todo |
| T-035 | [#36](https://github.com/MuhidinM/sirna/issues/36) | Show the timing card, auto-place undated ideas, flag at-risk work | R-PRJ-01, R-PRJ-02, R-PRJ-05 | M | todo |
| T-036 | [#37](https://github.com/MuhidinM/sirna/issues/37) | Add the Rust AI gate: key, allowlist, pacing, budget, log | R-AI-02, R-AI-05, R-PLT-04 | M | todo |
| T-037 | [#38](https://github.com/MuhidinM/sirna/issues/38) | Add Gemini and mock providers with schemas and grounding | R-AI-01, R-AI-03, R-AI-04 | L | todo |
| T-038 | [#39](https://github.com/MuhidinM/sirna/issues/39) | Wire the AI touchpoints and the eval set | R-PRJ-01, R-AI-02 | L | todo |

## M5 — Week card and dashboard

Sunday week card, dashboard tiles, forgiving streak, year chart, savings plant, in-app widgets. Plan §3.10, §3.13-3.14.

| ID | Issue | Task | Reqs | Size | Status |
|---|---|---|---|---|---|
| T-039 | [#40](https://github.com/MuhidinM/sirna/issues/40) | Build the Sunday week card | R-CHK-04 | L | todo |
| T-040 | [#41](https://github.com/MuhidinM/sirna/issues/41) | Add dashboard tiles, the forgiving streak and the year chart | R-PRG-01, R-PRG-02, R-PRG-04 | M | todo |
| T-041 | [#42](https://github.com/MuhidinM/sirna/issues/42) | Track savings goals with the growing plant | R-PRG-03 | M | todo |
| T-042 | [#43](https://github.com/MuhidinM/sirna/issues/43) | Compute focus insights and the week paragraph | R-PRG-04 | M | todo |
| T-043 | [#44](https://github.com/MuhidinM/sirna/issues/44) | Make dashboard cards rearrangeable and add a theme picker | R-PRG-05 | M | todo |

## M6 — Calendar (optional)

Google Calendar secret iCal as fixed blocks. Plan Appendix A.

| ID | Issue | Task | Reqs | Size | Status |
|---|---|---|---|---|---|
| T-044 | [#45](https://github.com/MuhidinM/sirna/issues/45) | Show Google Calendar events as fixed blocks | R-CAL-01 | L | todo |

## M7 — Desktop widget

Optional desktop mini widget, off by default. Plan §3.16.

| ID | Issue | Task | Reqs | Size | Status |
|---|---|---|---|---|---|
| T-045 | [#46](https://github.com/MuhidinM/sirna/issues/46) | Add the optional desktop mini widget | R-WID-01 | L | todo |
