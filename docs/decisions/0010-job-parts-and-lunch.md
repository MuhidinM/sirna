# 0010 — Job parts, and lunch stays outside job hours

Status: accepted · 2026-11-25

## Context

Setup gave each job one From/To a day. A split shift (08:00-10:00 and 13:00-15:00) could only be entered as 08:00-15:00. That counts lunch and the gap as job time, so the week looks fuller than it is and birr per hour (T-073, `features/money/rate.ts`) comes out too low, since it divides pay by the minutes of the job's blocks.

Everything after setup already handles several fixed blocks of one job on one day: the day generator pairs same-named blocks by nearest start, the job task list moves to the next block that hasn't ended, and rates, capacity and the brief add up every block.

## Decision

- A job day has 1 to 3 **parts**. Each part is a fixed routine block with the job's name. Setup answers store `parts`; old saves with one `start` and `end` read as one part (`jobParts`), and setup writes parts only.
- **Lunch is not job time.** You leave it out by entering a second part after it. Only the hours inside parts count as work.
- An optional **lunch time** adds a 1-hour routine block with no area on workdays. Without it, the gap between parts is free time and the routine may place a focus block there.
- Setup refuses parts that end before they start (no part crosses midnight), parts that overlap within a job or with another job on a shared day, and a lunch inside job hours.

## Consequences

- Birr per hour and weekly hours follow the time you actually work, with no change downstream and no migration.
- You enter a split day as parts instead of ticking "lunch included"; the help text says so.
- Parts are the same on every day of a job. A job with different hours on different days is set up in My week; setup reads back its first day's parts.
