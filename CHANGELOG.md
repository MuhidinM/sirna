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
