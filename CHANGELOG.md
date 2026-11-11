# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
