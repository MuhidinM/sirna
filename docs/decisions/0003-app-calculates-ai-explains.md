# 0003 — The app calculates, the AI explains

Status: accepted · 2026-11-11

## Context

Gemini's free tier is rate-limited, may be unavailable, and can be wrong with numbers. The timing check, load and money must be trustworthy.

## Decision

All numbers and verdicts (capacity, load, slots, Good / Tight / Too much, spending, streaks) are deterministic TypeScript with tests. Gemini receives a fact sheet and returns typed JSON (reasons, alternatives, phrasing). Every number in its output must appear in its input. No function calling for daily tasks. Every AI change is undoable.

## Consequences

- Every flow works with no key or offline.
- Fewer requests on the free quota; outputs are testable with recorded mocks.
- An "Ask" chat with tools waits on the cut list.
