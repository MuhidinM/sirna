# Sirna

_Sirna_ (Oromo: order, system) is a small Windows tray app that keeps your day in order:

- **One capture box** (Ctrl+Alt+Space) for tasks, ideas, spending and cheat-sheet notes.
- **A weekly routine** across life areas (jobs, job hunt, coding, gym, Quran…) that becomes each day's plan.
- **Focus sessions** with breaks, a set-up sheet (Do not disturb, distracting apps minimized, your work opened) and a daily cap, so you start easily and stop before you burn out.
- **Morning brief and night review**, a Sunday week card, and a dashboard with a forgiving streak, a year chart and a savings plant.
- **A timing check for new projects:** it tells you whether a date fits your real free time, or finds a slot for you.

Local-first: one SQLite file on your machine. Gemini is optional and only sees task titles, area names and minutes.

> Status: v0.1.0 in daily use (milestones M0–M3). Next: M4, projects and the AI timing check. See [docs/backlog.md](docs/backlog.md) and [CHANGELOG.md](CHANGELOG.md).

## Documentation

| Doc                                              | What's in it                                 |
| ------------------------------------------------ | -------------------------------------------- |
| [docs/plan.md](docs/plan.md)                     | Flows, architecture, data model, AI, roadmap |
| [docs/requirements.md](docs/requirements.md)     | Every requirement with an ID and evidence    |
| [docs/backlog.md](docs/backlog.md)               | Tasks per milestone, linked to issues        |
| [docs/workflow.md](docs/workflow.md)             | How work moves from issue to `main`          |
| [docs/testing.md](docs/testing.md)               | Test layers and how to run them              |
| [docs/decisions/](docs/decisions/README.md)      | Architecture decision records                |
| [docs/open-questions.md](docs/open-questions.md) | Questions still to answer                    |
| [CHANGELOG.md](CHANGELOG.md)                     | Releases                                     |

## Stack

Tauri v2 (Rust core + WebView2) · React · TypeScript · Vite · SQLite (rusqlite) · Vitest · pnpm.

## Run it

Needs Node 24, pnpm 12, Rust (see [dev machine setup](docs/workflow.md#dev-machine-setup)) and WebView2.

```bash
pnpm install
```

```bash
pnpm dev
```
