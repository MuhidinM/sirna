# 0014 — AI in the capture box

Status: accepted · 2026-11-28

## Context

Plan §7.1 says AI runs only while `main` is open, and R-AI-02 lists what may be sent: titles, area names, minutes, dates and energy. The capture rules read short English lines well, but not Amharic, long lines with several tasks, or commands such as "move the report to fri" or "I'm in Adama". Those lines end up as inbox notes for the night review (T-090, #192).

## Decision

- **The capture box may call the AI.** It is the one exception to "only while `main` is open": the box is a window the user just opened, and the call is one request for the line just typed.
- **Rules first, store first.** The rule parser stays the instant path. `needsAi()` (`src/capture/smart.ts`, pure and tested) sends a line only when the rules are unsure: they gave an inbox note, the line has Ethiopic characters, it is over 60 characters or has more than two clauses, or it starts with a command the rules don't read (move, push, reschedule, finish … by, off, light, I'm in, back in, working from). Prefixes (`t:`, `n:`, `idea:`, `?`), `afford`, `away`/`back`, block done/skip and clean English money never go. Shift+Enter sends any line. Before the call the line is saved as an inbox note (`capture_commit`), so a slow, failed or refused call loses nothing.
- **One call, a closed list.** The `COMMAND` touchpoint returns up to 6 items from a fixed intent list: task, note, money, move, finish_by, day_mode, place, question. The model names intents, area and task ids from the facts, and copies date words and spans. App code turns each into ops; accepting replaces the note through `capture_replace` with parser `command@1`, so Ctrl+Z and the Up-arrow fix work as for any capture.
- **What may be sent (R-AI-02, extended).** The raw capture line with every money amount masked (`lunch <a1>`), area ids and names, up to 30 open task and project titles with their ids, the two places, and today's date and weekday. Amounts are put back in code; numbers that are clearly a time, a date or a length stay so date words can be read.
- **Strict mode keeps capture rules-only.** In strict mode, and in plain mode after bad replies, nothing is sent from the box.
- **Grounding.** Area and target ids must exist, `readWhen` must read every `when_text` and `by_text`, spans must be substrings of the line, and titles may hold no number that is not in the facts. Otherwise the reply is thrown away and the line stays a note.
- **No waiting behind the pace.** The gate (ai.rs) lets a `command` call wait at most 1 s for its turn behind the 7 s pace; later than that it is refused at once as `busy`, and it never retries. The box gives up after 4 s and says "Kept for tonight's review".
- **Budget.** The default daily cap moves from 15 to 200 requests (about $0.01–0.04 a day at 40 smart captures).

## Consequences

- A capture that needs the AI shows "Reading…" for 1–3 s before its rows; the line is already safe as a note.
- Money still never leaves the machine as a number; a money intent is read again by the local rules from the restored span.
- `capture_ops_allowed` now also allows a task's `due_date`/`planned_date` update and the `prayer.city` setting (addis or adama), and nothing else new.
- "Finish by" only sets the due date until the make-room packer lands (#198); "off" for a day other than today is kept as a note until day marks land.
