# 0005 — A small date reader instead of chrono-node

Status: accepted · 2026-11-11

## Context

The plan named chrono-node (`en.GB`) for dates in captures (plan §3.5). The capture box must stay small (plan §4.3: under 50 KB of JS) because it loads on every hotkey press, and the live chip parses on every keystroke. chrono-node is several hundred KB with all its locales, far more than the box itself. Captures use a small set of date words.

## Decision

`src/capture/when.ts` reads only what a capture needs: `today`, `tonight`, `tomorrow`, `yesterday`, weekdays (with `on`/`next`/`this`/`by`, or as the last word, so "the sun is out" stays text), `in 3 days`, `in 2 weeks`, `20 dec`, `dec 20`, day-first `12/11` and `31/12/2026`, `10am`, `10:30`, `15:00`, `at 3`, `noon`. "at 3" without am/pm follows the `capture.clock_style` setting: western (15:00) or the Ethiopian clock (09:00). A time with no day means today, or tomorrow if it has passed.

## Consequences

- The capture box is 11.8 KB of JS with the parser included.
- Every supported form is pinned by a fixture (`src/capture/fixtures/capture.json`, 69 cases); a misread reported with `fb:` becomes a new fixture.
- Phrases outside the list ("the first Monday of next month") stay in the text and land in the inbox, to be sorted in the review or by the AI fallback (M4).
