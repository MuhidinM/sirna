# Requirements — traceability and release checklist

Every requirement has an ID, the task that delivers it, and the evidence that it works. A row is ticked only when it's **verified** (test name, measurement or manual check noted in "Evidence").
Status: ☐ todo · ◐ in progress · ☑ verified. Section references point to [plan.md](plan.md).

## A. Capture (§3.5)

| ID | Requirement | Task | Evidence | ✓ |
|---|---|---|---|---|
| R-CAP-01 | One box, opened by a global hotkey (Ctrl+Alt+Space, configurable) from any app | T-008, T-015 | Hotkey with fallbacks (ADR-0004); a key saved in `capture.hotkey` is tried first (Ctrl+Alt+K: 3/3 opens); 20 scripted opens ready to type, p95 410 ms (#8, #15) | ☑ |
| R-CAP-02 | A capture saves in < 2 s (p95, installed build) and never waits on parsing, network or AI | T-013, T-015 | Parsing is local and synchronous; the raw line and its records commit in one local SQLite transaction (`capture_commit`), no network call; echo appears and the box closes 1.5 s later (#13, #15) | ☑ |
| R-CAP-03 | Parses tasks, timed reminders, cash expenses, ideas, `pin:`, `wait:`, `fb:`, `?` search, `away`, `#area` | T-014 | `parse.test.ts`: 69 fixtures + ops and echo tests; in the real box "lunch 120" → −12,000 santim Food and "call bank tomorrow 10am" → task with a 10:00 reminder (#14) | ☑ |
| R-CAP-04 | Unparsed text becomes an inbox note; nothing is lost | T-014 | No-match lines become `note_items` kind inbox (fixtures: "dentist maybe sometime", "3 eggs", "the sun is out"); the raw line is always stored first (#14) | ☑ |
| R-CAP-05 | The last capture can be edited (Up arrow) or undone (Ctrl+Z, tray) | T-015, T-016 | Up arrow fix and Ctrl+Z checked in the real box (#15); the tray menu shows "Last: … · Undo" for the newest capture, which runs the same undo (#16) | ☑ |

## B. Routine and day plan (§3.2–3.3)

| ID | Requirement | Task | Evidence | ✓ |
|---|---|---|---|---|
| R-PLAN-01 | Life areas with weekly targets, kind, priority, protected and capped flags | T-018 | | ☐ |
| R-PLAN-02 | A weekly routine of fixed, routine, area and rest blocks | T-018 | | ☐ |
| R-PLAN-03 | Each day's plan is generated from the routine, filling area blocks by weekly deficit and priority, with 20% buffer | T-019 | | ☐ |
| R-PLAN-04 | Today shows one "Now" item, a timeline and at most 3 priorities | T-020 | | ☐ |
| R-PLAN-05 | Missed area time drops; it never piles up as debt | T-019 | | ☐ |

## C. Focus (§3.6, §3.6a)

| ID | Requirement | Task | Evidence | ✓ |
|---|---|---|---|---|
| R-FOC-01 | A focus timer (default 25/5, long break after 4) runs with no window open and survives sleep and restart | T-022 | | ☐ |
| R-FOC-02 | Tray shows the timer and offers Pause, Stop, Distracted | T-023 | | ☐ |
| R-FOC-03 | Block start toast names a ≤ 5-minute first step; one start nudge per block | T-021 | | ☐ |
| R-FOC-04 | Focus set-up sheet: intent line, minimize listed apps, open the area's work, checklist; one key to start | T-028 | | ☐ |
| R-FOC-05 | Do Not Disturb switched on automatically if a tested route works, otherwise a one-tick reminder | T-029 | | ☐ |

## D. Burnout guard (§3.7)

| ID | Requirement | Task | Evidence | ✓ |
|---|---|---|---|---|
| R-BRN-01 | Daily focus cap (default 4 h outside job blocks) with a stop toast; overruns allowed but marked | T-027 | | ☐ |
| R-BRN-02 | Hard stop (default 22:30) | T-027 | | ☐ |
| R-BRN-03 | Long break after 4 sessions; starting early needs a second tap | T-022, T-027 | | ☐ |
| R-BRN-04 | Two low-energy nights make the next day light; one rest day a week | T-026, T-027 | | ☐ |
| R-BRN-05 | At most 2 active personal projects; Experiments capped at its target | T-027, T-034 | | ☐ |

## E. Check-ins (§3.4, §3.9, §3.10)

| ID | Requirement | Task | Evidence | ✓ |
|---|---|---|---|---|
| R-CHK-01 | Morning brief opens at first unlock after wake time (toast otherwise), ≤ 12 lines, no questions | T-025 | | ☐ |
| R-CHK-02 | Night review in 4 steps, ≤ 7 taps, works offline, "Skip tonight" counts against nothing | T-026 | | ☐ |
| R-CHK-03 | Review asks what you spent today, with one-tap chips for repeated expenses | T-026 | | ☐ |
| R-CHK-04 | Sunday week card: time per area vs target, next week's load, projects, spending pace, one suggested change | T-039 | | ☐ |
| R-CHK-05 | "What changed since yesterday" line in the brief | T-030 | | ☐ |

## F. Projects (§3.8)

| ID | Requirement | Task | Evidence | ✓ |
|---|---|---|---|---|
| R-PRJ-01 | An idea with a date gets a Good / Tight / Too much verdict from the numbers, with reasons and alternatives | T-034, T-035, T-038 | | ☐ |
| R-PRJ-02 | An idea without a date is placed in the first slot that keeps load ≤ 85%, automatically, with undo | T-034, T-035 | | ☐ |
| R-PRJ-03 | Project board: To do / Doing / Waiting / Done, plus a list view | T-033 | | ☐ |
| R-PRJ-04 | Waiting-on items with a follow-up reminder | T-030 | | ☐ |
| R-PRJ-05 | At-risk deadlines flagged in the brief | T-035 | | ☐ |

## G. Cheat sheets (§3.15)

| ID | Requirement | Task | Evidence | ✓ |
|---|---|---|---|---|
| R-NOTE-01 | Short pinned cards per area, added with `pin:` from the capture box | T-031 | | ☐ |
| R-NOTE-02 | The current area's card shows in the focus set-up sheet | T-031 | | ☐ |
| R-NOTE-03 | Cards are searchable with `?` and edits can be undone | T-031 | | ☐ |

## H. Progress and dashboard (§3.13–3.14, §3.16)

| ID | Requirement | Task | Evidence | ✓ |
|---|---|---|---|---|
| R-PRG-01 | Forgiving focus streak with a flame (rest, away, light days and one miss a week don't break it) | T-040 | | ☐ |
| R-PRG-02 | GitHub-style year chart of focus minutes, filterable by area | T-040 | | ☐ |
| R-PRG-03 | Savings goals with a plant that grows by % and never dies | T-041 | | ☐ |
| R-PRG-04 | Focus, break and distraction tiles; insights computed from sessions | T-040, T-042 | | ☐ |
| R-PRG-05 | Dashboard cards can be reordered, hidden and resized (in-app widgets) | T-043 | | ☐ |
| R-WID-01 | Optional desktop mini widget (Now, timer, top 3, cheat sheet), off by default | T-045 | | ☐ |

## I. Notifications (§8)

| ID | Requirement | Task | Evidence | ✓ |
|---|---|---|---|---|
| R-NOT-01 | Reminders fire within 60 s with no window open; missed ones become one summary | T-017 | | ☐ |
| R-NOT-02 | App toasts capped; quiet hours from hard stop to wake time | T-017 | | ☐ |
| R-NOT-03 | Muted notifications and disabled autostart are detected and shown | T-017, T-025 | | ☐ |

## J. AI (§7)

| ID | Requirement | Task | Evidence | ✓ |
|---|---|---|---|---|
| R-AI-01 | Every flow works with no key, offline or rate-limited | T-037 | | ☐ |
| R-AI-02 | Only titles, area names, minutes, dates and energy are sent; a viewer shows every payload | T-036, T-038 | | ☐ |
| R-AI-03 | Provider is swappable; model chosen at key entry, not in code | T-037 | | ☐ |
| R-AI-04 | Every number in AI output appears in its input; verdicts never come from the model | T-037 | | ☐ |
| R-AI-05 | Free-tier pacing, daily budget and 429 handling | T-036 | | ☐ |

## K. Platform and quality (§4, §5, §9, §10)

| ID | Requirement | Task | Evidence | ✓ |
|---|---|---|---|---|
| R-PLT-01 | Idle in the tray ≤ 30 MB private bytes with no webview | T-010 | | ☐ |
| R-PLT-02 | Installer ≤ 8 MB, installed ≤ 25 MB | T-009 | NSIS installer 2.8 MB, installed 11.4 MB (#9, docs/measurements.md) | ☑ |
| R-PLT-03 | One SQLite file; forward-only migrations with checksums; daily checked backups and a written restore | T-012, T-032 | Migrations embedded by build.rs, one transaction each, checksums, newer-DB refusal, checked `VACUUM INTO` backup before migrating; 8 + 4 Rust tests; on the real DB a pre-migration copy landed in `D:\Sirna\backups` (#12). Daily backups and restore: T-032 | ◐ |
| R-PLT-04 | Secrets only in Windows Credential Manager | T-008, T-036 | `secrets.rs` on keyring-core + the Windows native store; round-trip test passes against Credential Manager; no command returns a secret value (#8). Gemini key use: T-036 | ◐ |
| R-PLT-05 | Single instance, starts with Windows, tray-only at startup | T-007 | single-instance plugin first; `--autostart` stays in the tray with 0 webviews; a second launch opens `main` in the first process; closing `main` keeps the tray (measured, #7). Autostart registration is switched on in setup (T-018) | ◐ |
| R-CQ-01 | TypeScript strict, ESLint, Prettier, clippy, rustfmt; pre-commit hooks | T-003, T-004 | | ☐ |
| R-CQ-02 | Unit tests for every parser, planner and the timer; CI runs them on every pull request | T-005, T-006 | | ☐ |
| R-CQ-03 | Issue → branch → PR → merge-commit flow with templates and a project board | T-001 | Templates in `.github/`; labels, milestones M0–M7, issues and board created from backlog.md | ☑ |

## L. Calendar (§6, Appendix A, optional)

| ID | Requirement | Task | Evidence | ✓ |
|---|---|---|---|---|
| R-CAL-01 | Google Calendar events (secret iCal, read-only) become fixed blocks | T-044 | | ☐ |
