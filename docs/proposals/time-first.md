# Time first, currencies, savings accounts (2026-11-23)

Decided with you on 2026-11-23 after the hands-on check (52 pass, 18 fail).
Every choice below was the recommended option.

## 1. Tasks and blocks: time first

The bug behind most fails: the day planner filled each focus slot with that
area's task, and when the area had none it took **any task with no area**
(`takeTask` in features/plan/generate.ts). So "call bank" became
"Job hunt: call bank" at 06:30, and times you typed were ignored.

New rules, in order:

1. **A task with a time gets its own block at that time.** "today 3pm",
   "from 3pm to 4pm", "3-4:30pm", "tomorrow 10am", "at 15:00 for 45 min".
   Start = `due_at`; length = the end you gave, else the estimate, else 30 min.
   The block takes its time out of focus slots (like a calendar event) and may
   sit beside a fixed block (lanes). Stored as a `day_blocks` row with
   `kind = 'area'`, `source = 'task'`, `task_id` set, `area_id` = the task's
   area or NULL (a neutral card), title = the task title.
2. **A task with a part of the day** ("tomorrow morning", "this evening",
   "tonight") is placed in the first free gap inside that window, as in rule 1:
   morning 06:00–12:00, afternoon 12:00–17:00, evening/tonight 17:00–22:00.
   Stored in `task_items.planned_window` (migration 0027).
3. **A task names its area or job only when you say so:** `for job a`,
   `for coding`, `#jobhunt`, `#joba`. No guessing from other words.
4. **Area slots are filled only with that area's tasks.** A task with no area
   is never put into an area block.
5. **A task with no time and no area** stays in Top 3 / Also due for its date.
   If it has an estimate and there is free time left after the area slots, it
   gets a neutral "Task" block in that free time (rule 1's shape). Without an
   estimate it is only a list item.
6. **Every block with an area can hold tasks and be focused on.** Job A,
   Quran, Gym and focus blocks all list that area's open tasks inside the card
   (checklist, "+N more"). Job A stays a general block; it is never turned into
   a focus block.
7. **Focus any time:** Start focus is always offered. The focus sheet asks
   _for what_: the block now (default), another of today's blocks, an area, or
   "Other…" (type a name: a block is added at the current time for the session
   length). "Distracted" counts an interruption (shown on the Dashboard); its
   label and tooltip say so.
8. **Every day can be seen and changed:** Plan → Day shows any date's full
   board (the same hour grid as Today). Drag a block to move it, drag its
   bottom edge to resize (15-minute steps), click it to edit title, start, end,
   area or task, or delete it; click an empty hour to add a block. Today's
   board is editable the same way. A day column in Next 7 days opens that day.
   Edits set `user_edited_at`, so the planner never overwrites them.
9. **Review free text** handles plain commands before asking the AI:
   "move tomorrow's check email to 9am", "move gym to 6pm", "skip quran
   tomorrow".

## 2. Capture fixes

- "lets read a book from 3pm to 4pm" on a Sunday must land on that Sunday
  3–4pm (it went to Monday and kept "from 4pm" in the title).
- Several money items in one line, separated by commas or " and ":
  `+25000 salary, saved 500 laptop, lent Abel 1500, moved 2000 from cbo to cash`
  saves four records (it went to Loose ends). The echo lists them.
- The afford answer is colour-coded: Fine green, Tight yellow, Not now pink.
- The input has focus whenever the bar opens (Ctrl+Z, ↑ work at once).
- Fixing a capture with ↑ keeps the record's project, parent and steps (editing
  "read chapter 5" to "read chapter 6" lost its project).
- Currency in amounts: `$200`, `200 usd`, `usd 200`, `€50`, `50 eur`,
  `£20`, `20 gbp`, and `@wise` picks the account and its currency.

## 3. Money: currencies

- Accounts, entries, loans and regulars keep their own currency (minor units
  of that currency: cents for USD). Columns from migration 0028; entries
  already had `currency`.
- A rate per currency in settings `money.rates`:
  `{"USD": {"rate": "132.50", "set_on": "2026-11-23"}}` meaning 1 unit = rate
  ETB. Set on Money → Accounts. Integer math: ETB minor = round(minor × rate).
- Totals, safe to spend, net worth and afford convert foreign amounts at the
  rate and show "≈" with "at 132.50 (23 Nov)". No rate set: that money is left
  out of totals with a line saying so.
- `formatAmount(minor, currency)` shows "$1,200.50" / "1,200.50 USD" style for
  foreign currencies; ETB unchanged.

## 4. Money: savings accounts back the goals

- An account can be a savings account (`is_savings`). CBO savings is seeded as
  one; Wise is seeded in USD.
- Put aside X for a goal = a transfer from a spending account (picked, default
  the pay account) into the savings account + a `savings_entries` row for the
  goal with `account` and the same `transfer_id`. Take out = the reverse.
- Any transfer into a savings account counts as saving: with one active goal
  it goes to that goal; with several it is unassigned and the existing
  "Give it to…" control asks which.
- Safe to spend never counts savings accounts; net worth does.

## 5. Look and small fixes

- Night and Forest: the canvas turns dark too (Night ≈ #1c1c1a, Forest ≈
  #18442a), cream blocks become soft dark tones, only the loud cards stay
  bright. Contrast tests updated.
- Widget: a transparent window like the capture bar, so no second corner.
- Logo: the bite is a straight slot the width of the check, running from near
  the dot out through the top-right corner, with a round inner end.
- Tray: double-click opens the window.
- Settings → What was sent: 10 calls a page with Newer / Older.
- Ledger → Export CSV shows a toast with the file name and where it went.
- Tasks: Split works on any open task: type your own steps, or Suggest with AI.
- Today: an "Add for today" line under Top 3 (a capture with today's date).
- Plan → This week: when nothing is late, a line says so, so the late-task
  check is visible.
