# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Sidebar** on every page: Today, Cheat sheets, Focus kits, Night review, My week, Settings.
- **Settings:** save, replace or remove the Gemini API key and the Google Calendar secret address (kept in Windows Credential Manager, never shown again); change the capture key without restarting; focus cap, Do not disturb during focus, theme and start with Windows.
- **Projects:** a page per project with a board (To do / Doing / Waiting / Done; drag a card or pick its column) and a list, a next step that goes on the board, weekly hours, deadline and status.
- **Timing check (numbers only):** Projects shows this week's load; a project with an estimate gets Good / Tight / Too much against its deadline, or the first weeks that keep load at or under 85%. A third active project waits in Next up.
- **Ideas become projects:** `idea: learn Go ~10h` is placed in your weeks by itself (Ctrl+Z undoes); `idea: CLI tool ~18h by 20 dec` gets a verdict and a card with Keep the date / Use suggested dates / Drop; an idea without hours asks for one (5 / 10 / 20 / 40 h).
- **At risk:** the morning brief and Projects flag a deadline the planned hours won't reach.
- **AI gate:** Settings → AI picks the Gemini model your key can use and sets a daily limit; What was sent shows every request and reply for 30 days. The key stays in Credential Manager and travels only in a request header.
- **AI touchpoints (Gemini, optional):** an idea's card adds the AI's reasons under the numbers and can ask for an estimate; the morning brief gets one AI line a day; the night review answers what is on your mind; loose ends get "Suggest with AI". Every reply is checked against the facts it was sent, and everything works without it. **Strict mode** in Settings sends area names instead of titles. `pnpm eval:ai` scores prompts against a 20-idea and 60-capture eval set.
- **My week is a real editor:** add, change or remove any block on any days (one day or the whole series), with a warning when blocks share time; add areas (a third job, Music, anything), rename them, set their hours, colour, priority, cap or protection, or turn them off; set wake, review and hard-stop times. Today plans again after each change. "Start over" still offers the setup questions.
- **Planning tasks:** a free slot can be tied to an area; tasks with no area still get scheduled; `t: write the report ~3h` carries an estimate, gets planned even without a date, and continues across slots and days until its time is done. **Split** (AI) breaks a task of 90 min or more into steps the planner spreads over the coming days.
- **Tasks page:** every task in one place (To do, Waiting, Someday, Done, Dropped) with search and an area filter; edit title, status, area, project, due date, hours, waiting on and notes; Done, Someday, Plan it, Drop and Restore; Split for big tasks; quick add that reads `~3h fri #area` like the capture box.
- **My week:** choose the "Check email" reminder times (or none) instead of the fixed 10:00 and 15:00.

## [0.1.0] - 2026-11-11

First build for daily use (milestones M0–M3). Windows only, one user, local data.

### Added

- **Capture:** a global hotkey opens a capture box; every line is stored unchanged, then parsed into a task, expense, income, idea, note, reminder, follow-up, cheat-sheet line or away period. Undo and edit from the box.
- **Today:** the day's plan from your weekly routine as a timeline with Now and a countdown, area colours, tasks and the top 3, in dark and light themes.
- **Reminders and toasts** with no window open: quiet hours, catch-up after sleep, block starts with one nudge, follow-ups ("Any reply yet?").
- **Focus timer** in the tray: pause, distracted, stop, survives sleep and restart; a set-up sheet with an intent, per-area focus kits (open and minimize apps, checklist) and Do not disturb switched on for the session.
- **Morning brief** at the first unlock, with what changed since yesterday.
- **Night review:** today, spending typed in one line, energy, and tomorrow.
- **Burnout guard:** daily focus cap, hard stop, light days after low-energy nights.
- **Cheat sheets:** `pin:` lines grouped into cards, searchable from the capture box (`? query`) and shown in the focus sheet.
- **Platform:** forward-only migrations with a backup first, audited and undoable writes, daily checked backups (14 kept), away mode, `pnpm usage`, autostart, single instance.

### Changed

- `pnpm ship` installs through the desktop shell, so a run from a packaged app (such as the Claude desktop app) no longer installs into that app's private AppData.

### Docs

- Plan, requirements, backlog, workflow, testing strategy, decision records, and issue and pull request templates.

[Unreleased]: https://github.com/MuhidinM/sirna/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/MuhidinM/sirna/releases/tag/v0.1.0
