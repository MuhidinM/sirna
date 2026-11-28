# 0012 — Time left on an open task never reads 0

Status: accepted · 2026-11-28

## Context

Time left on a task is its estimate minus focus time on it. A task that ran over read 0 left, so the planner treated it as having no estimate and the forecast chain marked it finished: it dropped out of the plan while still open (T-082, #184).

## Decision

- **Floor:** while a task is open, time left is never under `MIN_LEFT_MIN` = 10 minutes (`features/plan/left.ts`). Ten minutes is enough to wrap up or decide the task needs a new estimate, and short enough not to crowd a day.
- **Short estimates:** the floor is `min(estimate, 10)`, not a flat 10. A 5-minute task never needs more than its own estimate, so running over must not double it.
- **No estimate:** stays no estimate (null); the floor only applies to estimated tasks.
- **One place:** the floor is applied once, where a task row becomes plan input (`taskOnDay`). The SQL still returns the raw `MAX(0, estimate − focus)`, and the planner, the chain and the preview read the floored value.

## Consequences

- An overrun open task is planned again and, when its due day has no room, is reported late by 10 minutes.
- Marking the task done is the only way its time left reaches 0.
- Changing the number means changing this ADR and `left.test.ts`.
