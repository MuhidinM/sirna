# Workflow

How work moves from the backlog to `main`.

## Where work is tracked

- **Issues** — one per backlog task. The title says what changes in plain language; the body has context, scope, acceptance criteria and the requirement IDs it covers. The backlog ID (`T-021`) is in the body so [backlog.md](backlog.md) and GitHub stay linked.
- **Milestones** — one per stage of the build (M0–M7), in the order they're built ([plan §13](plan.md#13-build-milestones-for-claude-code)).
- **Project board** — "Sirna": _Todo → In progress → Done_.
- **Labels** — a type (`feature`, `chore`, `test`, `documentation`, `bug`, `security`, `performance`), an area (`area: platform`, `area: capture`, …) and a size (`size: small` < 1 h, `size: medium` 1–3 h, `size: large` > 3 h).

## Flow per task

1. Take the next open issue in milestone order; move it to _In progress_.
2. Create a branch from `main` named `<type>/<issue-number>-<what-it-does>`, e.g. `feature/12-capture-window`, `fix/31-timer-after-sleep`, `chore/4-lint-and-format`.
3. Build to the Definition of Done below, committing in small steps.
4. Push and open a pull request using the template. The description links the issue with `Closes #<number>`.
5. On the branch, mark the task `done` in [backlog.md](backlog.md) and tick the [requirements.md](requirements.md) rows it covers, with evidence.
6. Tick every item in the issue's _What to do_ and _Done when_ lists that was delivered. A closed issue or merged PR never keeps an empty checkbox — see _Work that is not done_ below.
7. CI must be green. Review the diff as if someone else wrote it.
8. Merge with a **merge commit** so every detailed commit stays visible on `main`. Delete the branch.
9. Open questions go into [open-questions.md](open-questions.md). Any choice someone could reasonably question gets an ADR in [decisions/](decisions/README.md).

Milestones also follow the plan's hard rules ([plan §0](plan.md#0-one-page-summary)): a "can't use it" bug is fixed before new work; every milestone ends with `pnpm ship` and at least one day of real use; a milestone that hits 1.5 × its estimate takes its written fallback.

## Work that is not done

An empty checkbox on something closed reads as forgotten work, so deferred items are rewritten instead:

- **In an issue:** strike the item through and say which issue owns it now — `~~Idle detection~~ **Moved to #48**`. If no issue owns it yet, open one first.
- **In a pull request:** list it as a plain bullet — `**Not in this PR:** Rust tests for the timer — added in #58` — not as an unticked box.

## Protected `main`

`main` only changes through pull requests once CI exists (T-006). Branch protection then requires the CI checks to pass, the branch to be up to date with `main`, and review conversations resolved. Force-pushes to `main` and deleting it are blocked.

## Commits

[Conventional Commits](https://www.conventionalcommits.org). One logical change per commit. The subject says _what_ changed; the body says _why_ and anything non-obvious. The footer references the issue.

```
feat(focus): persist the timer state on every transition

A crash or sleep in the middle of a session now resumes from the
stored state instead of starting over. Sessions older than 30 minutes
close as interrupted.

Refs #22
```

Types: `feat`, `fix`, `test`, `refactor`, `style`, `docs`, `chore`, `perf`, `ci`, `build`.
Scopes match feature folders and Rust modules: `platform`, `db`, `capture`, `tasks`, `money`, `areas`, `plan`, `focus`, `brief`, `review`, `notes`, `projects`, `ai`, `dashboard`, `widget`, `calendar`, `tray`, `notify`, `ui`, `ci`, `deps`.

## Definition of Done

- [ ] TypeScript strict, no `any`, no unneeded casts; Rust passes `cargo clippy -- -D warnings`
- [ ] Logic has unit tests (Vitest with a fake clock; `cargo test` for the Rust core); parsers and planners have fixtures
- [ ] Empty, offline and "AI unavailable" states exist where they apply
- [ ] Works by keyboard; Enter accepts the default on every screen
- [ ] Checked in dark and light
- [ ] Checked in the installed build when it touches the tray, toasts, hotkey or windows
- [ ] Memory measured (`scripts/measure.ps1`) when it touches startup, windows or the tray; `docs/measurements.md` updated
- [ ] No secrets, email/SMS text, amounts or prompts in logs
- [ ] No `console.log`, dead code, or stray TODOs (open an issue instead)
- [ ] Lint, typecheck and tests pass locally and in CI
- [ ] Requirement rows ticked with evidence

## AI usage

Claude Code helps with planning, scaffolding, tests and review. Every line is read, understood and owned by the author, and decisions are recorded in ADRs so they can be explained.
