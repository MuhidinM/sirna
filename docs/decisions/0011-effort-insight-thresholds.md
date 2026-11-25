# 0011 — When an effort insight is worth saying

Status: accepted · 2026-11-25

## Context

T-080 adds effort-against-return lines to the Dashboard and Money (`features/insights/effort.ts`). Each line needs a rule for when it is worth saying. Too loose and the Dashboard nags about noise; too strict and it never speaks. The numbers below are judgement calls, so they are written down here.

## Decision

- **Pay compared:** last full month only (a running month may miss a pay day); each job needs pay and 20+ worked hours; the best must pay 1.2× the lowest or more. The Dashboard shows the ratio only, Money adds birr per hour.
- **Rate trend:** a change of 10% or more against the average of the 3 full months before, each with pay.
- **Skipped days:** a job needs 10+ planned days in the month. A day counts as skipped only when every part was skipped. Overrun (blocks run past the routine) is left out for now: day blocks don't record how far a job ran over, only whether a block was kept.
- **Under target:** under 80% of the weekly target, so a few minutes short is not a pattern; 3+ full weeks running. A week counts only once Sirna was in use from its Monday and the area existed by then, so weeks with no data are never "under". A week with 4+ away days is skipped, and a partly away week is judged on the days you were here, as on the week card. The target is today's: there is no target history.
- **Use the gap:** a gap of 60+ minutes between job blocks, measured from the latest job end so overlapping blocks never make one; a 15-minute buffer after the job; a short session is 20 minutes, so the line says one or two fit. It must have gone unused on the same weekday two weeks running, exactly 7 days apart, so a gap seen on two random days is not a habit.
- **AI:** only the compare line is reworded, from the two job names and the ratio. The reply is saved with actor `ai:insight` (undoable); without it, the template text shows.

## Consequences

- Every threshold has a test one below and at the limit (`effort.test.ts`).
- A new user sees the empty state until real data is there, never a false "4 weeks running".
- Changing a number means changing this ADR and its test.
