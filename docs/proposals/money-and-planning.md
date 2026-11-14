<!-- 2026-11-14: six-angle review of money and planning (workflow wf_1c626102-c65). A proposal, not yet approved. -->

# Sirna: money and planning plan (final)

**Recommendation.** Fix three things that are broken today. Then make the money you already record visible and editable. Next, add accounts, pay and bills, so the app can give one honest number: **what is left this month, and about how much a day**. The advisor and the forward planner come after that. All reviewers agree on the base: integer santim, a signed ledger and capture-first entry. Nothing gets rewritten; the new parts are built on top.

Plan §3.12 ("no balances, no accounts beyond cash") and the §12.2 cut list must be replaced by a new decision, **D50**, before Milestone 2 starts. Your request is what triggers that change. D50 also records the definitions at the end of Milestone 2.

## How the disagreements were settled

| Question                                    | Choice                                                                                                                       | Why                                                                                                                                                     |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Headline number                             | **"12,400 left this month · about 740 a day."** Calendar month always.                                                       | With 2–3 jobs on different paydays there is no single "next payday". A per-day figure is something you can act on; the total is what you check against. |
| When the full safe-to-spend formula appears | **Only after your first reconcile.** Before that: In − Out − Saved = Left.                                                   | The number is only as good as the opening balances. A wrong number on day one kills trust.                                                              |
| Budget style                                | **No required budget.** Optional caps on 3–5 categories, suggested from your 3-month median, accepted with one tap.          | Zero-based budgeting needs weekly upkeep that two jobs leave no time for. 50/30/20 doesn't fit Addis costs.                                             |
| How savings join the ledger                 | **Earmarks.** Saved money stays in its account (CBE, say), tagged to a goal, and is subtracted once from what you can spend. | Matches how people save. Runner-up: a separate "Savings" account with transfers, which is more bookkeeping for the same answer.                         |
| Bank and telebirr SMS                       | **Reconcile first.** Type the real balance; the app books the gap.                                                           | A tenth of the build, keeps balances right. SMS formats keep changing.                                                                                  |
| Bank CSV / PDF import                       | **Left out.** CSV _export_ is in.                                                                                            | Unsure what CBE exports; PDF parsing breaks "small on the machine". Export is your way out with your records.                                           |
| Sidebar                                     | **6 items:** Today, Plan, Projects, Money, Dashboard, Settings. Tasks live under Plan.                                       | The problem is finding things. Tasks are daily, so they stay one click away.                                                                            |
| AI and money                                | **Ratios and category names only, never birr.** Hard-coded, no setting.                                                      | Keeps the plan §7 promise. The free tier may train on what it receives.                                                                                 |
| One recurrence format                       | **One rule parser and one `rule_json`** (`every mon`, `monthly 28`) for task repeats, bills and expected pay.                | One set of tests, one dropdown.                                                                                                                         |

## Milestone 0: fix what's broken now (S, do first)

**0.1 Calendar error and sync window (S).**

- _What's wrong:_ the brief line (`features/calendar/sync.ts:70`) uses one message, "address needs replacing", for three different failures: Google refused the link, the link isn't a Google iCal address, or the feed didn't parse (`bad_payload`). Worse, `asCode()` (`sync.ts:99`) turns any unknown error into `offline`, so a parser crash looks like an outage.
- _Diagnose first:_ the last status is saved in `core_settings` under `SYNC_KEY`. Read its `code` on your machine before changing anything. That tells us whether the fix is your link or the parser.
- _Fix:_ show the exact reason from `statusText()` in the brief and in Settings, with a "Sync now" button. Add a `parse_error` code so crashes stop hiding as `offline`. On `bad_payload` or `parse_error`, keep the raw feed for one sync so it can be tested against the parser.
- _Window:_ `WINDOW_AHEAD_DAYS` is 14 today (`ics.ts:27`), so Sirna should not write a year of repeats. Set it to 31 as you asked. `statusText()` hard-codes "in the next two weeks" (`sync.ts:53`); derive that text from the constant. Add a test that a daily rule gives at most 32 events.
- _Deterministic._ No AI.

**0.2 Separate "do on" from "due by" (S–M).**

- _What's wrong:_ every "move to tomorrow" in the night review rewrites the real deadline (`review.ts:56`). A task due in two weeks that slips once becomes "due tomorrow" and pushes the job hunt out.
- _Fix:_ add `planned_date`. `by 20 dec` sets the deadline; "Tomorrow" sets only the planned day. The migration copies `due_date` into `planned_date`.
- _Old damage:_ deadlines already carried forward are wrong, and the migration can't know the originals. Tasks carried at least once get a mark, "deadline may be stale, check", so you fix each once.
- _Simple:_ you still see one date unless you open the edit form.

**0.3 Split steps keep their order (S).** Steps from an AI split get `parent_id` and `step_no`. The plan offers step 2 only after step 1 is done and shows "2/5". When the last step finishes, the parent is done. The split is AI-suggested and undoable; the ordering is code.

**0.4 Table allowlist test (S).** Every new table needs a `TableSpec` in `src-tauri/src/tx.rs`. Add a test that checks every migration table against the allowlist now, before the first new table lands.

## Milestone 1: see and fix your money (M)

**1.1 One Money page (M).** One sidebar item, two tabs.

- **Month:** In / Out / Saved / Left, category bars against your usual spending, and a pace bar.
- **Ledger:** transactions grouped by day, with search and filter (text, category, account, date range). Click a line to change amount, category, account or date, or delete it with undo. **Export CSV** button.
- Goal plants move here from `shell/Savings.tsx`.
- _Simple:_ nothing to configure; the Ledger is the one place you edit money. _Deterministic:_ all totals. _AI:_ none.

**1.2 Income is visible (S).** Today every money query filters out amounts above zero, so salaries you type are stored and never shown. Income appears on Month, split by source (Job A, Job B, Other). The capture echo confirms "Income · 18,000 ETB · Job A".

**1.3 Categories you can manage (S).** Add, rename, merge and hide categories in Money. The Ledger's re-categorise depends on this.

**1.4 Goals you can edit (S).** Rename, change target, add a target date. Each goal shows one line: "Laptop: 1,250 a month to make June, you average 900." Monthly figures use integer division that rounds down for what you can spend and up for what you need to save, so nothing is overstated.

**1.5 Capture learns more phrases (S–M).** Additions to `capture/parse.ts`, each with fixtures:

- `got 18k job a`, `salary 25k`, `+5000 freelance`
- several items on one line (`lunch 120, taxi 40`)
- `#food` overrides the guessed category. **Rule:** on a money line, `#` matches a category first and an area second. On any other line it is an area, as now. The order is tested.
- corrections are remembered: fix "bajaj" to Transport once and it stays Transport.

A line Sirna can't read stays a note, as now.

**1.6 Today's money line (S).** "Spent 340 today · 12,400 left this month · about 740 a day". Links to Money.

## Milestone 2: accounts, pay and bills, which make the number true (M–L)

**2.1 Accounts that start from capture (M).**

- Only Cash is seeded. The first time you type `@cbe` or `@telebirr`, Sirna asks once: "New account CBE, current balance?" You can also add accounts (CBE Birr, equb) in Money.
- A balance is opening balance plus transactions, computed, never stored.
- `moved 2000 cbe to telebirr` writes two linked rows.
- **Reconcile:** type the balance your bank shows. Sirna books the gap in either direction, as "Unrecorded spending" or "Unrecorded income".
- _Simple:_ capture still defaults to Cash.

**2.2 One recurrence shape (S–M).** A single parser and `rule_json` for `every mon`, `every weekday`, `monthly 28`, `monthly 1st`. Used by 2.3, 2.4 and 4.3. One dropdown in every edit form.

**2.3 Expected pay per job (M).**

- One row per job: expected net amount, rule (monthly on day N, or irregular) and the account it lands in. Rows link to the job's area, so a third job is just "add job".
- `got 12k job b` against an expected 18k shows "6,000 outstanding".
- Pay more than 3 days late becomes one line in the brief.
- _Simple:_ after your first salary capture, Sirna asks once: "Monthly, around the 28th?"

**2.4 Regulars: bills, contributions and family support (M).**

- One list: rent, internet, phone packages, gym, family support, iddir, equb. Equb also records its payout date and amount.
- A toast the day before. One tap on "Paid" on Today or in the night review creates the transaction. It asks which account only when more than one exists. Nothing posts without that tap.
- After 2–3 matching entries Sirna offers: "Rent 6,000 on the 1st looks regular. Track it?"

**2.5 Safe to spend (M), the core number.**

- Shown only after your first reconcile. Until then Today and Money show In − Out − Saved = Left.
- Formula, stated once: (liquid balances not earmarked + expected pay before month end − unpaid regulars before month end − this month's planned goal saving still unsaved) ÷ days left in the month, rounded down. Money already earmarked for a goal, the emergency fund included, is excluded from liquid balances once and not subtracted again.
- Tap it to see the subtraction line by line. Pure TypeScript with tests. _AI:_ none.

**2.6 Emergency fund and payday chip (S).**

- Created automatically, measured in months of essential costs ("Covers 1.4 months"). Target 3 months, or 6 if income is irregular.
- After pay arrives, an optional chip: "Put 2,700 aside for Laptop?" `saved 500 laptop` keeps working, now as an earmark in an account.

**2.7 Birr per hour per job (S).** Weekly hours logged in each job's blocks against pay received. With a third job coming, this is the number that tells you whether it is worth it.

**D50 definitions.** Expected pay is net (after income tax and pension). Equb counts toward net worth as paid in minus received. Reconcile books gaps both ways; a positive gap is income, not spending. Month is the calendar month in Addis time, day starting 03:00.

## Milestone 3: the advisor (M)

**3.1 Findings first, then wording (M).** The app produces typed findings, ranks them, and shows at most 2 a day. Launch with four:

- pay overdue
- safe-to-spend below 0
- a bill due when its account is short
- a category more than 30% over its usual

Each is a card on Money and in the Sunday card with at most two buttons, such as "Cap Food at 5,800" or "Move 1,000 from CBE to telebirr". Every press is undoable through `core_activity`.

- _AI:_ a new MONEY touchpoint phrases a finding in 1–2 sentences, about 1 call a day. A test rejects any reply that contains a number not in the facts sent.
- _Without a key:_ template text. _Never:_ investment or product advice.
- After a month of real data, add: emergency fund under 1 month, goal falling behind, forecast surplus, debt past due.

**3.2 "Can I afford it?" (S).** `afford 4500 shoes` gives Fine / Tight / Not now, with the effect on the month and on goal dates. The verdict is computed like the project timing check. The AI adds up to 3 short reasons.

**3.3 Optional category caps (S).** Off by default. Suggested from your median; a quiet bar with a pace marker (day 14 of 30 should be about 47% spent).

**3.4 Money lent and owed (S).** `lent 1000 abel`, `owe 500 sara` go into a list. Repayments can be partial. Follow-ups reuse the waiting/follow-up pattern. No interest maths.

**3.5 Month in the Sunday card (S).** First Sunday of a month: in vs out, top 3 changes, savings rate, caps you went over, net worth (accounts + owed to you − you owe + equb net), and one advisor card.

**3.6 Money privacy (S).** Gemini gets ratios and category names only, hard-coded. The "What was sent" viewer covers money payloads. Logs never record amounts.

## Milestone 4: planning that looks ahead (M–L)

**4.1 Work tasks inside job blocks, for N jobs (M).**

- Tasks tagged `#joba` fill Job A's own blocks and show as a short checklist under the block on Today.
- Removes the hard-coded `"joba" | "jobb"` type in `routine.ts`. Job tasks are never placed today (`FILLABLE_KINDS` in `generate.ts:95`).

**4.2 7-day preview plus "will my list fit?" (M).**

- `generateDay` runs over the next 7 days in memory and shows as a strip on Plan: "Mon: Portfolio 2h · Tue: CV 1h".
- Red rows mark tasks that will finish after their deadline, with [Move earlier] [Push deadline] [Smaller].
- Open tasks with estimates feed the Good / Tight / Too much verdict.
- Read-only until you act. Nothing new to fill in.

**4.3 Repeating tasks (M).** `every mon`, `every weekday`, `monthly 1st` in capture, or the shared dropdown. The next copy is created when you finish one. Good for timesheets, weekly applications and laundry.

**4.4 Missed-block recovery (S–M).** When a block ends with no focus session and no tick, Today offers [Later today] [Tomorrow] [Skip]. "Later today" re-plans the remaining free time.

**4.5 Inbox triage inside existing rituals (S).** Captures with no area, date or estimate are triaged two cards at a time in the night review and in the Sunday step 0, with number keys. The AI may suggest an area and estimate; you accept with one tap. No separate tab.

**4.6 Sunday planning step (M).** The week card gets step 0: triage, pick 3–5 outcomes for the week, place tasks in the 7-day strip, accept. Every step can be skipped.

**4.7 Small items (S each):**

- weekly hours per job, with overruns shown ("Job B ran 6h over; job hunt lost 3h")
- waiting-on follow-ups due today appear in the brief and inside the next email block
- sidebar to 6 items: Plan has tabs This week · Tasks · Routine
- Settings gets a status strip at the top for Calendar, AI and Backups (dot plus a fix button), and the rest grouped into Money, Planning and Look

## What a day will feel like

- **Morning (about 30 s).** The brief shows your top 3, "12,400 left · about 740 a day", and anything due: "Internet 1,200 tomorrow · Job B pay is 2 days late". Work tasks sit under the Job A block. If the calendar failed, the brief says why in one line.
- **Recording money (about 5 s).** Type `lunch 180 @telebirr, taxi 60`. The echo shows two rows and the Today line updates. Fix a wrong category in the Ledger once, and Sirna remembers it.
- **Payday.** Type `got 18k job a`. The expected pay row turns green, then a chip offers "Put 2,700 aside for Laptop?". Bills due before month end are already subtracted.
- **Night review.** Today's spending is pre-filled. Regulars due today are one-tap chips. Two Inbox cards. Missed blocks have already moved, without touching deadlines.
- **Sunday (about 2 min).** Where your time went, where your money went against usual, one advisor card with a button, then the week ahead: triage, outcomes, red rows in the 7-day strip. First Sunday of the month adds the month review.

## Deliberately left out

- Bank or telebirr API sync and reading SMS on the phone. Pasting SMS waits until non-cash spending passes half and reconcile proves too slow.
- Bank CSV or PDF import, and receipt OCR.
- Payday-to-payday periods.
- Live exchange rates and multi-currency. ETB-only until the first non-ETB pay arrives.
- Investment, stock or credit-score tracking, and any investment advice.
- An "Ask AI" money chat. Cards with buttons are cheaper and calculated.
- A money privacy setting; ratios only is fixed.
- Zero-based or 50/30/20 budgeting as a requirement.
- AI that computes totals or categorizes without your review.
- Shared wallets, extra gamification beyond the plant, and a chart library (the existing SVG is reused).
- Linking project budgets to goals, and inflation-adjusted goals: parked until after Milestone 3.

## Questions only you can answer

1. **Accounts.** Which do you use: cash, CBE, telebirr, CBE Birr, Awash, another bank? Which does each job pay into?
2. **Pay.** For each job: monthly or irregular, about which day, and is the net amount fixed?
3. **Regulars.** Do you pay rent, equb, iddir, or send family support on a schedule? Equb amounts and payout dates?
4. **Lending.** Do you lend or borrow often enough to want a list?
5. **Budget style.** Is "left this month, about X a day" enough, or do you also want caps on a few categories (which)?
6. **Calendar.** Where do you see repeats a year ahead: on Today, in the plan, or in Google itself? (The stored sync code answers the error side; this answers the window side.)

---

_Declined:_ the `budget_minor` on projects and `project_id` on goals from point 14, because it adds a cross-link with no daily use before Milestone 3; birr per hour from the same point is kept. Every other critique point was applied.

---

## Your answers (2026-11-14) and what they change

1. **Accounts:** CBO (Cooperative Bank of Oromia), CBE, E-birr, telebirr and cash. Both jobs pay into CBO.
   → Milestone 2.1 offers these five on first use (`@cbo`, `@cbe`, `@ebirr`, `@telebirr`, cash) instead of only Cash. CBO is the default account for pay.
2. **Pay:** fixed amounts, on the 10th and the 21st.
   → 2.3 needs no "irregular" path for now: each job gets a fixed net amount and a day (10 and 21), landing in CBO. The app asks once which job is paid on which day. The emergency-fund target is 3 months (fixed income).
3. **Regulars:** rent and other payments.
   → 2.4 as planned; rent is the first suggested regular.
4. **Lending:** yes, you often lose track.
   → Money lent and owed (3.4) moves up into Milestone 2, next to accounts, because it is a daily need, not advice.
5. **Caps:** a cap on every category, to build the habit; Sirna suggests the amounts.
   → 3.3 changes: caps are **on** for every category. Until there are 3 months of history, Sirna suggests starting caps from your first month (or asks once for a rough figure per category). Then it suggests changes from your median each month, accepted with one tap. The pace bar shows on every category.

---

# Appendix A. The critique this plan answered

Verdict: the base and the order are right. Before anything is built, fix two things: the plan leans on payday-to-payday periods, and its capture syntax clashes with itself. Below are 16 changes.

**Bugs and facts the plan gets wrong**

1. **0.1, diagnose before you ask.** The last sync status is stored locally in `core_settings` (`SYNC_KEY`, see `features/calendar/sync.ts:89`). Read its `code` on the user's machine instead of asking question 6. Two more fixes:
   - `statusText()` hard-codes "in the next two weeks" (`sync.ts:53`). Change it along with `WINDOW_AHEAD_DAYS` (`ics.ts:27`), or derive it from that constant.
   - `asCode()` (`sync.ts:96`) turns any unknown error into "offline", so a parser crash hides as an outage. Add a `parse_error` code.
2. **0.2 cannot repair old deadlines.** Due dates already carried forward are corrupted. The migration should copy `due_date` into `planned_date`, and the Tasks list should mark tasks carried at least once ("deadline may be stale, check") so the user can fix them once.
3. **`#` collides.** `#joba` means an area (4.1, and the existing area tags), but 1.3 makes `#food` a category. Pick one rule: on a money line, `#` matches a category first and an area second, and that order is tested in fixtures. Or drop `#category` and rely on learned corrections alone.

**Simplicity: cut or merge**

4. **Drop payday-to-payday periods.** With 2–3 jobs on different paydays there is no single "next payday". Always use the calendar month, and show "about X a day until month end". That also removes the 2.2 setup question about which payday defines the period.
5. **Hide safe-to-spend until balances exist.** The number is only as good as the opening balances. Until accounts have one, show "In − Out − Saved = Left this month" (already possible in M1). Show the full formula only after the first reconcile. State the formula once, so earmarked goal money and the emergency top-up are not subtracted twice.
6. **Accounts start silent.** Seed Cash only, and add CBE or telebirr the first time `@cbe` is typed: "New account CBE, current balance?" Seeding three accounts with zero balances makes the number wrong from day one.
7. **One recurrence shape, three uses.** Task repeats (4.3), money regulars (2.3) and expected pay (2.2) should share one rule parser and one `rule_json` format (`every mon`, `monthly 28`). That means one set of tests and one dropdown.
8. **Fewer advisor findings at launch.** Ship 3.1 with four: pay overdue, safe-to-spend below 0, bill due with its account short, and a category over its usual. Add the rest after a month of real data.
9. **Cut the 3.6 three-way setting.** Hard-code "ratios only", which keeps the plan §7 promise, and keep the "What was sent" viewer. Add the setting only if the user asks.
10. **Do not hide Tasks under Projects.** Tasks are used every day. Put the task list under **Plan** (tabs: This week · Tasks · Routine) and keep Projects separate.
11. **Fold 4.5 Inbox into existing rituals.** Triage inside the night review (2 cards) and the Sunday step 0. Do not add a separate tab.

**Completeness: what is still missing**

12. **Category management in M1.** Add, rename and merge categories, and hide unused ones. The audit found no screen for this, and the Ledger's re-categorise depends on it.
13. **Move 2.5's goal edit (rename, target, date) into M1.** It is S, has no dependency, and "can't rename a goal" is part of the "half-baked" complaint.
14. **Restore the cross-links the plan dropped:**
    - Birr per hour per job: weekly job hours from 4.7 against received pay. With one more job coming, this is the number that decides whether it is worth it.
    - An optional `budget_minor` on projects and `project_id` on goals (a course or laptop is both time and money). The timing check can then report cost.
15. **Ledger search and filter, plus CSV export.** Export is S, local and has no dependency. It is the user's way out of the app and gives them records. Import stays cut.
16. **Clear definitions, recorded in D50:**
    - Expected pay is net (after income tax and pension).
    - Equb counts toward net worth as paid in minus received.
    - The "Paid" chip on a regular asks which account only when more than one exists.
    - Reconcile books the gap in both directions. A positive gap is "Unrecorded income", not spending.

**Rules check**

- **App calculates, AI explains.** Holds: verdicts, afford and findings are pure TypeScript and the AI only phrases them. Add a test that rejects any AI reply containing a number not in the facts sent.
- **Integer santim.** Make "1,250 a month" and "340 a day" use integer division that rounds down, so safe-to-spend never overstates.
- **Rust.** Every new table needs a `TableSpec` in `src-tauri/src/tx.rs`. Add the test that checks every migration table against the allowlist in M1, before the first new table lands.
- **Small.** No chart library and no PDF parsing, as planned.

**Revised order:**

- **M0:** 0.1, 0.2, 0.3.
- **M1:** Ledger + Month, income, category management, goal edit, capture phrases, Today line.
- **M2:** accounts started from capture, plus reconcile; one recurrence shape for pay and regulars; safe-to-spend.
- **M3:** advisor with four findings, afford, debts.
- **M4:** planning (4.1 → 4.2 → 4.3 → 4.4).

---

# Appendix B. The six reviews

## Review 1

## Personal finance advisor review

**Verdict.** The user is right that money is half-built, and the plan made it that way on purpose. §3.12 of `docs/plan.md` says "No balances, no accounts beyond cash", and §12.2 moves bills, budgets, telebirr and multi-currency to the cut list. Here is what exists:

- A signed `money_txns` ledger (`features/money/migrations/0005_money.sql`). It has an `account` column that no screen uses.
- A parser that reads `spent`/`paid` and income lines (`capture/parse.ts:118, 308`).
- "Spent today" on Today (`shell/Today.tsx:316`), spending by category in the night review (`features/review/review.ts`), and one week-vs-4-week-average bar block (`features/week/card.ts:133`, `shell/WeekCard.tsx:428`).
- Savings goals kept in a separate table that never meets the ledger (`features/savings/migrations/0015_savings.sql`).

There is no screen to see, edit or fix a transaction. There are no balances, no income view, no month and no forecast. The base is sound: integer santim, a signed ledger and capture-first entry. So the fix is to build on what is there, not rewrite it. The one question an advisor answers every day is **"how much can I safely spend until next pay, and am I on track?"** Every item below serves that question. The app computes every number. Gemini only puts a computed finding into words. Keep in mind that plan §7 currently sends **no money amounts** to Gemini, so the AI gets ratios and category names, never birr figures.

### Suggestions

1. **Accounts and balances (Cash, CBE, telebirr, CBE Birr).**
   - **What:** a `money_accounts` table holding name, kind (cash/bank/mobile) and an opening balance. Each account's balance is the opening balance plus the sum of its txns. A transfer is two linked rows (`moved 2000 cbe to telebirr`). A "Reconcile" button takes the real balance and books the gap as "Unrecorded" spending.
   - **Why:** Addis salaries go to a bank, and daily spending is telebirr plus cash. Spending only from cash misses most of the money. Reconciling fixes this without any SMS parsing.
   - **Simple:** 3 to 4 accounts set up once. Capture uses the default account unless you type `@telebirr`.
   - **Size:** M

2. **Income with expected pay per job.**
   - **What:** an `income_sources` table (Job A, Job B, a future Job C) with the expected amount, payday rule (monthly day N, or "irregular") and default account. When pay arrives, `got 18k job a` matches the expected row. A row can be **partial** (paid 12k of 18k, 6k outstanding) or **late** (past due with nothing received).
   - **Why:** with two jobs and a third coming, late or partial pay is the main risk. The app should notice it before the user does.
   - **Simple:** one row per job. The brief shows one line only when pay is overdue.
   - **Size:** M

3. **Bills and subscriptions (recurring outflows).**
   - **What:** a `money_recurring` table holding rent, utilities, internet, phone packages, gym, iddir dues and equb contributions, each with an amount, a rule and an account. When a bill falls due, one tap marks it paid and creates the txn.
   - **Why:** these are the fixed costs a forecast needs, and plan §12.2 already admits a missed bill is the likely failure.
   - **Simple:** a reminder fires the day before through the existing toast system. No auto-posting.
   - **Size:** M

4. **Safe-to-spend until next pay (the core number).**
   - **What:** a deterministic formula. Liquid balances, plus expected income before the next payday, minus unpaid bills before then, minus this period's goal contributions, minus an emergency-fund top-up, all divided by the days left. That gives **"You can spend about 640 ETB a day until 30 Nov."**
   - **Why:** this is the advice a person can act on, and it replaces a budget the user would never fill in.
   - **Simple:** one number, shown on Today in place of "Spent today", with "spent X today" underneath.
   - **Size:** M

5. **Budget method: light envelopes on top of safe-to-spend. Not zero-based, not 50/30/20.**
   - **What:** optional monthly caps on 3 to 5 categories only, such as Food, Transport and Shopping. Each gets a pace bar: day 14 of 30 should mean about 47% spent.
   - **Why:** zero-based budgeting needs monthly planning this user will drop. 50/30/20 assumes stable pay and Western cost shares; in Addis, housing plus food often goes past 60%. The runner-up is to show the 50/30/20 split as a read-only check on the month report.
   - **Simple:** caps are suggested from the 3-month median, accepted with one tap, and no category is required.
   - **Size:** S

6. **Emergency fund as a special goal.**
   - **What:** a goal measured in **months of essential costs** (housing, utilities, food, transport, bills), calculated from the trailing 3-month average. The target is 3 months, or 6 if income is irregular. It feeds the plant in `features/savings/savings.ts` like any other goal.
   - **Why:** with irregular second-job income, this is the first goal before a laptop or anything else.
   - **Simple:** created automatically, with one line: "Covers 1.4 months."
   - **Size:** S

7. **Link savings to accounts.**
   - **What:** keep `savings_entries` as earmarks, but tag each with the account the money sits in. `saved 500 laptop` then lowers safe-to-spend without being counted as spending.
   - **Why:** today saving and spending never meet, so the app can call you fine while your goal money is being spent.
   - **Simple:** the capture syntax stays the same.
   - **Size:** S

8. **Debts and loans with people (owed to and by).**
   - **What:** a `money_debts` table holding person, direction, amount, date and an optional due date. `lent 1000 abel` and `owe 500 sara` create rows. Repayments are partial txns. The brief gives a follow-up nudge, reusing the existing `waiting` and follow-up pattern from plan §3.14.
   - **Why:** informal lending is common, and it is exactly the money people forget.
   - **Simple:** this is a list with no interest maths. Formal loans get an optional monthly payment that becomes a recurring outflow (item 3).
   - **Size:** S

9. **Equb and iddir.**
   - **What:** equb is a recurring contribution (item 3) plus one expected payout date and amount, which counts toward forecasts and net worth. Iddir is a recurring due with a "Community" category.
   - **Why:** both are real, regular flows in Addis, and a generic app gets them wrong. An equb payout is often the user's biggest single inflow.
   - **Simple:** a template in the recurring form, not a separate module.
   - **Size:** S

10. **Month view and month-end forecast.**
    - **What:** one Money screen with tabs for **This month** (income, spending, saved, net, category bars and envelope pace) and **Ledger** (an editable, searchable list of txns, which is missing today). The forecast is current balances plus expected income minus remaining bills, minus spending at the current daily rate, giving "Month ends about +4,200 ETB."
    - **Why:** the user cannot trust or fix data they cannot see. And "where did it go" is the question behind "half-baked".
    - **Simple:** one screen with two tabs, using the bento cards that already exist.
    - **Size:** L

11. **Net worth (monthly snapshot).**
    - **What:** accounts, plus money owed to you, minus money you owe, plus the equb balance. A snapshot is stored on the first day of each month, giving a line with 12 points.
    - **Why:** it shows progress even in months when spending felt bad.
    - **Simple:** one number on the Dashboard next to the plant.
    - **Size:** S

12. **Inflation-aware goals, without FX.**
    - **What:** an optional yearly inflation figure in Settings, about 20 to 30%, typed in by the user. Goals with a date show the target adjusted for that inflation. The month report compares category spending in real terms year over year.
    - **Why:** fast birr depreciation makes a laptop goal fixed in birr out of date within months.
    - **Simple:** one setting, off by default.
    - **Size:** S

13. **Rule-based advice. The app decides; Gemini phrases.**
    - **Deterministic findings:**
      - pay overdue by more than 3 days
      - safe-to-spend below 0
      - an envelope over pace by more than 15%
      - a bill due with the account short
      - emergency fund under 1 month
      - a debt past due
      - a category up more than 30% on its 3-month median
      - an unused subscription (no matching txn note in 60 days, user-confirmed)
      - a surplus in the forecast, with a suggested split to goals
    - **Rules:** each finding is a typed record with the numbers, ranked, and at most 2 a day. Gemini receives the finding type, category names and **percentages only**, never amounts, which keeps the rule in plan §7. It phrases one or two sentences and may suggest an action ("move 20% of the surplus to the emergency fund"). The app then shows that action as a button, and pressing it is undoable.
    - **Without a key:** template text, as `R-AI-01` already requires.
    - **Size:** M

14. **Capture vocabulary.**
    - **What:** extend `capture/parse.ts` with `got`/`received`/`salary` → income, `@account`, `moved X a to b`, `lent`/`owe`/`repaid`, and `paid rent` → match a bill. Each new phrase gets parse fixtures.
    - **Simple:** if a line cannot be read, it stays a note, as now.
    - **Size:** M

### Leave out

- Bank and telebirr SMS import. Reconcile (item 1) covers it for much less work. Revisit this when the cut-list trigger fires.
- Live FX rates and multi-currency until the first non-ETB income arrives. Remittances are just an income row tagged with its source.
- Investment or stock tracking.
- An "Ask AI" chat about money.
- Credit scores.
- A full zero-based monthly plan.
- Receipt OCR.

These cost a lot to build and keep up, and add little for one ETB earner who enters money by capture. Note that plan §3.12 and §12.2 ("Bills and budgets", "balances") must be changed through an ADR before items 1, 3 and 5 can land.

## Review 2

## UX and simplicity review: money and planning

**Verdict.** Money capture works. Money visibility doesn't. You can type `lunch 120` or `+25000 salary` (capture/parse.ts:305), but no screen lists those transactions. No screen lets you fix or delete an old one, and nothing shows income at all. Money is spread over four places that never add up to one answer. Today shows "Spent today" (shell/Today.tsx:317), the Sunday card shows weekly spend by category (shell/WeekCard.tsx:429), the night review has a spending step, and savings goals sit inside the Dashboard (shell/Savings.tsx). That answer would be "where do I stand this month?" Planning has the opposite problem: ten sidebar items (shell/Nav.tsx), with "This week" and "My week" next to each other, and the night review and focus kits listed as pages. The fix is fewer pages, one Money page, and the capture box as the main way to enter things.

### Suggestions

**1. One Money page that answers three questions on one screen.** Show "Left this month", "In vs out", and goals, with transactions below grouped by day. The top row has three numbers: income this month, spending this month, and what is left after planned goals. A bar shows spending pace against last month (planned in plan §3.14, but missing from the code). Below that come goal plants, moved from shell/Savings.tsx. The bottom is a day-grouped list where you can click any line to change its amount, category or date, or delete it (soft delete plus undo). _Why:_ he says it "just allows me to insert saving goal and … daily expense". Right now money goes in and he never sees it again. _Simple:_ one page, nothing to configure, and the list is the only place he edits. _Size:_ M.

**2. Income as a first-class capture with sources.** Teach the capture box `got 18000 job a`, `salary 25k`, `paid by X 5000` and `+5000 freelance`. Today's parser only treats the words salary, payroll and wage as income, plus the `+` prefix (capture/parse.ts:140). Add income sources: Job A, Job B and Other. They come from the setup answers and are auto-tagged by the job name, the same way areas are. _Why:_ he has two jobs, possibly three. "Which job pays what and when" is his core money fact. _Simple:_ still one line in the capture box, and the echo confirms "Income · 18,000 ETB · Job A". _Size:_ S.

**3. Payday as the money calendar.** Ask once, after his first income capture: "Is this monthly? Around the 28th?" Then expected income shows as "due" on the Money page. A missing payday becomes one brief line ("Job B pay not logged yet"). _Why:_ "Left this month" is meaningless without expected income. A payday-to-payday month fits a salaried worker better than calendar months. _Simple:_ he answers yes or no once and never opens a setup screen. _Size:_ M.

**4. Bills and budgets as opt-in rows, not a module.** Plan §12.2 cut these, but his complaint is the trigger for bringing them back. Use one table of "regulars": rent, airtime, gym fee, family support. Each has an amount and a day. Regulars become one-tap "Paid" chips on the Money page and in the night review, alongside the money_templates from 0005_money.sql. Budgets are optional per category, and the default is "usually" (the existing average in WeekCard), not a number he has to set. _Why:_ "anything in between" means rent and sending money to family, not charts. _Simple:_ nothing to set up. The app suggests "Rent 6,000 on the 1st looks regular, track it?" after two repeats, like templates. _Size:_ M.

**5. Savings joins the money flow.** Today, `saved 500` writes to savings_entries and spending writes to money_txns, so they never meet (0015_savings.sql vs 0005_money.sql). On the Money page, show savings as money moved out of "left this month". Add an optional "save X% of each income" rule that pops one confirm chip when income is logged ("Put 2,700 aside for Laptop?"). _Why:_ goals only grow if saving is tied to payday. _Simple:_ one chip, he can say no, and it is undoable. _Size:_ S.

**6. The advisor as cards, not a chat.** The app computes facts: spending pace, a category 40% over usual, a payday missed, a goal date at the current rate ("Laptop by March at 2,000/week"). Gemini only phrases them (plan §7). Each card has at most two buttons that do something, such as "Raise Laptop to 3,000/week" or "Set a 3,000 Food cap". The change is undoable through core_activity. Show at most two cards: one on the Money page and one in the Sunday card, reusing the "One change" pattern (shell/WeekCard.tsx:467). _Why:_ he wants a "flexible financial advisor". A chat would cost AI calls and setup. Actionable cards match "the app calculates, the AI explains". _Simple:_ he reads a card and taps a button, with no prompts. _Size:_ M.

**7. Today gets one money line, not a figure.** Replace "Spent today" (shell/Today.tsx:317) with "Spent 340 today · 12,400 left this month". It links to Money. _Why:_ the daily glance should say whether he is OK, not just give a total. _Simple:_ the same space, but more meaning. _Size:_ S.

**8. Cut the sidebar from 10 to 6 items.** The six are Today, Plan, Projects, Money, Dashboard and Settings.

- Merge "This week" (WeekCard) and "My week" (routine editor, shell/Week.tsx) into **Plan**, with two tabs: "This week" and "Routine".
- Move "Night review" off the sidebar. It is a timed ritual opened by toast or tray, plus a button on Today after 20:00.
- Move "Focus kits" into the focus start sheet. Move "Cheat sheets" to a tab on Projects, or keep it only behind `pin:` and `?` search.
- Tasks becomes a filter on Projects ("All tasks").

_Why:_ the user already called routine and focus "good enough". The confusion is in finding things, not in the features. _Simple:_ he learns six places, and each one answers a single question. _Size:_ S.

**9. Split Settings by how often each part is used.** Settings (shell/Settings.tsx:481) opens with secret keys and the iCal link. The "Calendar sync stopped" error points there, but the fix sits beside AI keys and a widget toggle. Put a status strip at the top: Calendar, AI and Backups, each with a green or red dot and a fix button right there. Group the rest under "Money" (categories, sources, regulars, payday, save rule), "Planning" (priority order, light days, how far ahead the calendar fills, default 1 month) and "Look and Windows". _Why:_ the user hit the iCal error today and could not tell what was wrong. _Simple:_ problems sit at the top, and preferences stay folded below. _Size:_ S.

**10. The Dashboard stops being the savings home.** The Dashboard has show, hide and arrange controls (shell/Dashboard.tsx:289). That is extra complexity for one user. Keep streak, year chart and area bars, and replace the savings card with one goal summary that links to Money. Drop "Arrange" unless he asks for it. _Why:_ there should be one place per question. _Size:_ S.

**11. Three rituals, each under 2 minutes.**

- **Morning (brief):** the top 3, one money line, and any due bill or payday.
- **Night review:** today's spending appears pre-filled from captures, with regulars as chips and a confirm button. Tomorrow's plan is accepted the same way. Add "Anything earned today?" only on paydays.
- **Sunday card:** where time went, where money went (in vs out, top category against usual), one advisor card, one planning change, and the savings question.

_Why:_ he works two jobs. The rituals do the bookkeeping, so he never has to go and "do finances". _Simple:_ each step can be skipped, has a default, and asks nothing on normal days. _Size:_ M (mostly reuse of shell/Review.tsx and shell/WeekCard.tsx).

**12. Setup-free defaults.** Seed categories (already in 0005_money.sql) and income sources from the setup job names. Use payday-to-payday months once payday is known, calendar months until then. Use averages instead of budget numbers, and fill 1 month ahead for repeating calendar events. Every extra field should show up only after the data says it is needed. _Size:_ S.

**Order to build:** 1, 2, 7 and 8 first (they make the existing data visible), then 3 and 4, then 5, 6 and 11.

## Review 3

## Planning and productivity review

**Verdict.** The day engine is good. `features/plan/generate.ts` fills free slots by weekly deficit, respects calendar events and edited blocks, and keeps 20% buffer. The trouble is that planning stops at the day: the app knows today and tomorrow, not the week ahead. Tasks have one date field that does two jobs, so the night review damages real deadlines. Job work, the user's largest block of time, never receives tasks. Split steps have no order. Nothing repeats. Nothing warns that the open task list will not fit before its deadlines. Motion, Sunsama and Reclaim all start from a forward view ("will this fit, and where does it go"), and Sirna has that only for projects (`features/projects/capacity.ts`). The suggestions below close that gap without adding new screens where an existing one can do the job.

### 1. Separate "do on" from "due by" (fix first)

**What:** Add `planned_date` to `task_items`. Keep `due_date` as the hard deadline. The generator reads `planned_date` to decide when a task is worked on and `due_date` to decide urgency.
**Why:** `carryOps` in `features/review/review.ts:56` writes `due_date: tomorrow` on every carry. A task due in two weeks that slips once becomes "due tomorrow", gets pulled into the 48-hour urgent path (`urgent()` in `generate.ts`), and pushes out the job hunt. After a few carries, every deadline in the app is fake.
**Simple because:** Users never see two fields unless they want to. Capture's `by 20 dec` sets the deadline. "Tomorrow" and "All the rest to tomorrow" set only `planned_date`.
**Size:** S–M (migration, generator SQL, review ops, Tasks editor).

### 2. Work tasks inside job blocks, for N jobs

**What:** Let tasks tagged `#joba`, `#jobb` or a third job fill that job's own fixed blocks. Show them as a short checklist under the block on Today, not as separate blocks. Add a "work" kind area per job, so a third job is just "add area + add blocks".
**Why:** `FILLABLE_KINDS = new Set(["growth","admin"])` in `generate.ts:95` means a task tagged with a job area is never placed and never reaches the top 3 unless it is urgent. Job duties rank #2 in the priority order in plan §3.3, yet they have no planning path. `features/plan/routine.ts:9` hard-types `areaId: "joba" | "jobb"`, so setup cannot model a third job.
**Simple because:** No new screen, just a checklist under a block that already exists.
**Size:** M.

### 3. Rolling multi-day placement: a 7-day plan preview

**What:** Run `generateDay` over the next 7 days in memory, carrying `left`/`remainingMin` and the weekly deficit forward. Do not write rows until a day arrives. Show it as a compact strip on Week or Today: "Mon: Portfolio 2h · Tue: CV 1h…". Flag any task whose deadline falls before its forecast finish.
**Why:** The user asked for big tasks to be "spread over several workdays". Today a split task (`splitOps`, `features/ai/facts.ts:151`) only spreads because it stays open. The user cannot see in advance that step 4 lands after the deadline.
**Simple because:** It is read-only and generated. The user only acts on the red rows: [Move earlier] [Push deadline] [Smaller].
**Size:** M (the pure function already exists; this adds a loop and a view).

### 4. Ordered steps after a split

**What:** Give split steps `parent_id` and `step_no`. The generator only offers step N+1 once step N is done, or at least sorts by `step_no`. Show "2/5" next to the title.
**Why:** `splitOps` inserts all steps with the same `due_date` and near-identical `created_at`, and the generator sorts by deadline then age. Step 3 can be planned before step 1. It also marks the parent `dropped`, so finished steps never roll up into "done", and the week card cannot report progress on the original task.
**Simple because:** Nothing new to enter. The AI split already produces the order.
**Size:** S.

### 5. Recurring tasks

**What:** A `repeat` rule on tasks (`every mon`, `every 2 weeks`, `monthly 1st`, `every weekday`). On completion the next copy is created. Capture parses `every …`.
**Why:** The user has repeating chores that are not time blocks: rent, sending timesheets for two employers, weekly job applications, gym-bag laundry. Routine blocks (`routine_blocks`) cover time, not to-dos. Nothing in `task_items` (0003_tasks.sql) repeats.
**Simple because:** One phrase in capture. No recurrence editor beyond a small dropdown in the Tasks edit form.
**Size:** M.

### 6. Missed-block recovery during the day

**What:** When an area block ends with no focus session and no tick (the `nudge` view in `0010_block_reminders.sql` already detects it), offer one inline choice on Today: [Later today] [Tomorrow] [Skip]. "Later today" re-runs `replanDay` for the remaining free slots.
**Why:** Only the night review handles slippage. A lost afternoon stays wrong on Today until 21:00, which is exactly when Motion and Reclaim earn their keep.
**Simple because:** One tap. The app picks the new slot.
**Size:** S–M.

### 7. Task-level load forecast ("will my list fit?")

**What:** Extend `capacity.ts` to count open tasks with estimates and deadlines, not just projects: minutes due per week against free capacity, using the same Good/Tight/Too much verdicts. Show the result in the Sunday card's "Load next week" and as one line in the brief.
**Why:** Today `weekLoad` only sums projects and area targets. Twenty estimated job-hunt and coding tasks due Friday are invisible to the verdict.
**Simple because:** It reuses the existing verdict words and card. No new input.
**Size:** M.

### 8. Weekly planning ritual on the Sunday card

**What:** Add a step 0 to the week card (`shell/WeekCard.tsx`): (a) triage the Inbox and Someday list, (b) pick 3–5 "this week" outcomes, (c) drag tasks onto days in the 7-day preview from #3, (d) accept. Sunsama's daily and weekly rituals are its core value.
**Why:** Plan §3.10 reviews last week but does not plan the next one. Load numbers are shown with no lever to act on them.
**Simple because:** It is the card the user already opens. Each step is skippable, with defaults that leave the plan as generated.
**Size:** M.

### 9. A real Inbox view

**What:** Captures without area, date or estimate land in an "Inbox" tab in `features/tasks/list.ts` VIEWS, triaged one item at a time: [area chips] [today/this week/someday] [~30m/1h/2h]. Optionally, the AI suggests area and estimate, and the user accepts with one tap.
**Why:** VIEWS has To do, Waiting, Someday, Done and Dropped, but no Inbox. The night review shows only 2 inbox notes (plan §3.9). Untagged tasks fall through to the generator's `areaId === null` fallback and fill random slots.
**Simple because:** Card-at-a-time triage, with the keyboard and number keys.
**Size:** S–M.

### 10. Weekly time budget per job, with overtime visibility

**What:** Give each work area a weekly hours budget (contracted hours) and count actual hours from blocks and focus. Show overruns on the dashboard and week card: "Job B ran 6h over this week; job hunt lost 3h."
**Why:** With 2–3 jobs, the risk is one employer quietly eating the growth hours. The burnout guard should see it. `weekly_target_min` is 0 for `joba`/`jobb` in `0007_areas_routine.sql`, so work time is untracked against any budget.
**Simple because:** One number per job, set once in My week.
**Size:** S.

### 11. Waiting-on follow-ups surfaced in the plan

**What:** Tasks in `waiting` with `follow_up_date` today appear in the brief and as a 10-minute item in the next email-check block.
**Why:** The columns already exist (`waiting_on`, `follow_up_date` in 0003_tasks.sql), but nothing schedules them, and job-hunt follow-ups are where this pays off.
**Simple because:** Fully automatic.
**Size:** S.

### Suggested order

1, 4, 2, then 3 and 7 (they share code), then 6, 9, 5, 8, 10, 11. Items 1 and 4 are correctness fixes to features that already ship. The rest builds the forward view that makes planning feel complete.

## Review 4

## Code gap audit: money and planning

**Verdict.** Money is a write-mostly log. Spending can be captured, and the Sunday card sums it by category. Income can be captured but no screen ever shows it. Nothing written to `money_txns` can be edited, deleted or re-categorised from any screen. Savings live in a separate ledger that never touches cash. A "track income, expense, goals and anything in between" product needs a few schema foundations first; more screens on top of the current tables won't get there. Planning is much further along: routine, day blocks, top 3, AI split and the project timing check all work end to end. Its gaps are recurring tasks and the links between money, goals and time.

### What exists today

| Piece                                         | State                                                                                                                     | Evidence                                                                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Expense capture (`lunch 120`, `paid taxi 40`) | Works                                                                                                                     | `capture/parse.ts:300-340` → `capture/ops.ts:71-86` inserts `money_txns`                                                       |
| Income capture (`+ salary 30000`)             | **Write-only.** Stored with a positive amount, but every read filters `amount_minor < 0`                                  | `features/tasks/today.ts` `SPENT_TODAY_SQL`, `features/week/card.ts` `SPEND_SQL`, `features/review/review.ts` `SPENT_LIST_SQL` |
| Today "Spent today" figure                    | Works                                                                                                                     | `shell/Today.tsx:316`                                                                                                          |
| Night review spending list + chips            | Read-only list; chips re-insert                                                                                           | `shell/Review.tsx:404-421`, `review.ts` `chipOps`                                                                              |
| Sunday card by category vs 4-week average     | Works                                                                                                                     | `features/week/card.ts:146-175`, `shell/WeekCard.tsx:428`                                                                      |
| Categories                                    | Table exists (`money_categories`, 12 seeded); no screen to add, rename or reassign. Category is guessed from keywords     | `0005_money.sql`, `parse.ts:121-145`                                                                                           |
| `money_templates`                             | **Dead table.** Allowlisted in `src-tauri/src/tx.rs:147`, but no TypeScript uses it; chips are computed from `money_txns` | grep                                                                                                                           |
| Accounts                                      | `money_txns.account TEXT DEFAULT 'cash'`, free text, no table, never set or read                                          | `0005_money.sql`                                                                                                               |
| Edit/delete a transaction                     | **None.** `user_edited_at` column exists; the only route is undoing the _last_ capture                                    | `review.ts`, `Today.tsx`                                                                                                       |
| Savings goals                                 | Add, pause, done, assign loose entries, plant stages. No title/target edit, no target date, no monthly-needed calculation | `features/savings/savings.ts` (only `addGoalOps`, `entryOps`, `assignOps`, `goalStatusOps`)                                    |
| Savings vs cash                               | Separate ledgers: `saved 500` writes `savings_entries` and never lowers any balance                                       | `ops.ts:113-128`, `0015_savings.sql`                                                                                           |
| Balances, budgets, bills, recurring income    | Absent by design (plan §3.12: "No balances, no accounts"; §12.2 cut list)                                                 | `docs/plan.md`                                                                                                                 |
| AI on money                                   | None. `features/ai/touchpoints.ts` has TIMING, ESTIMATE, BRIEF, REVIEW, CAPTURE, SPLIT, WEEK                              |                                                                                                                                |

**Planning.** `task_items` (`0003_tasks.sql`) has no recurrence column. `features/plan/generate.ts` places tasks into area blocks by deadline. `day_blocks.task_id` works. AI split works (`shell/Tasks.tsx:220-272`, `SPLIT`). Projects (`0013_projects.sql`) have time (`estimate_min`, `weekly_min`, `forecast_finish`) but no cost or budget. Savings goals have no area or project. Tasks have no link to a goal. The project's own §3.12 and §12.2 deliberately cut what the user now wants, so those docs need updating along with the code.

### Suggestions (foundations first)

1. **Edit, delete and re-categorise any transaction (`money_txns`).**
   - **What:** A Money screen listing transactions by day. Tap a row to fix the amount, description, category or date, or to delete it (soft delete through `deleted_at`; set `user_edited_at`).
   - **Why for this user:** Keyword guessing (`parse.ts:142`) will misfile Addis spending ("bajaj", "injera", "telebirr"). Today one typo stays in the totals forever.
   - **Simple:** Same row pattern as Tasks' Edit button (`shell/Tasks.tsx:264`).
   - **Size:** S

2. **Accounts table plus transfers.**
   - **What:**
     - New `money_accounts (id, name, kind cash|bank|mobile, opening_minor, archived)`.
     - Change `money_txns.account` to an FK.
     - Add `transfer_id` so one move writes two linked rows (−from, +to).
   - **Why for this user:** Two salaries land in a bank. Spending goes out as cash, telebirr and CBE Birr. Without accounts there is no "how much do I have", which is the first question an advisor answers.
   - **Simple:** Seed "Cash" as the default so capture stays `lunch 120`. Add an optional `@cbe` suffix, mirroring `#area`.
   - **Size:** M

3. **Show income, and net per month.**
   - **What:** Drop the `< 0`-only views. Add a month query returning income, expense, net and saved, by category and by income source (Job A, Job B, a third job later).
   - **Why for this user:** Two jobs (maybe three) is the core of their money life, and today it is invisible.
   - **Simple:** One month card: In / Out / Saved / Left.
   - **Size:** S

4. **Recurring items (`money_recurring`).**
   - **What:** `id, kind income|expense, amount_minor, category_id, account_id, day_of_month, active`. A daily job proposes due rows as one-tap "confirm" chips, which beats auto-posting for cash. This replaces the dead `money_templates`.
   - **Why for this user:** Salary days, rent, internet, equb or idir contributions and family support repeat monthly. Typing them is friction; forgetting them breaks the balance.
   - **Simple:** "Make this monthly?" after the second identical entry; this reuses the `CHIPS_SQL` logic.
   - **Size:** M

5. **Merge savings into the ledger.**
   - **What:** Treat a saving as a transfer into a savings account (or a goal-tagged envelope). Add `goal_id` to `money_txns` and keep `savings_goals` as the goal definition.
   - **Why for this user:** Today "saved 500" and "spent 500" are unrelated numbers, so Saved never reduces the cash shown.
   - **Simple:** `saved 500 laptop` keeps working; it just writes a transfer.
   - **Size:** M (includes migrating existing `savings_entries`)

6. **Goal maths: target date and monthly need.**
   - **What:**
     - Add `target_date`, plus title and target editing, to `savings_goals`.
     - Pure functions: required per month, on-track verdict, and projected finish from the last 3 months' net.
   - **Why for this user:** This is the deterministic core of a "financial advisor", and it obeys the rule that the app calculates. Also add editing; a goal can't be renamed today.
   - **Simple:** One line per goal, e.g. "Laptop: 6,200 ETB a month needed, you average 4,800."
   - **Size:** S

7. **Monthly category budgets (optional per category).**
   - **What:** `money_budgets (category_id, month, limit_minor)`, with "carry last month" as the default.
   - **Why for this user:** Gives the advisor something to compare against. Plan §12.2 already names its return trigger.
   - **Simple:** Off until a category has a limit. Shown as bars on the existing Sunday spend chart (`WeekCard.tsx:437`).
   - **Size:** S

8. **An AI money touchpoint (MONEY in `touchpoints.ts`).**
   - **What:** Facts in: the month totals from #3, goal verdicts from #6, budget overruns from #7. Out: 2-3 phrased suggestions plus at most one proposed change (a budget tweak, or moving N into a goal), applied as undoable ops.
   - **Why for this user:** This is the "flexible advisor" they asked for, inside the project rules: one call a week or on demand fits the Gemini free tier.
   - **Simple:** It shows up in the Sunday card and the Money screen only.
   - **Size:** M (after 2-6)

9. **Recurring tasks (`task_items.repeat_rule`, `next_due`).**
   - **What:** Simple rules (daily, weekdays, weekly on X, monthly on day N). When a task is completed, the next one is spawned.
   - **Why for this user:** Job-hunt follow-ups and life-admin chores repeat. Today they must be re-captured or forced into `routine_blocks`.
   - **Simple:** A `every mon` capture token.
   - **Size:** S

10. **Cross-links: `project_items.budget_minor` and `savings_goals.area_id`/`project_id`.**
    - **What:** Two optional link columns.
    - **Why for this user:** A course, a gym membership or a laptop is both a time and a money commitment. The timing check (`features/projects/capacity.ts`) could then also report the cost.
    - **Simple:** Optional fields in existing forms.
    - **Size:** S

**Order:** #1 and #3 first (S, no migration risk, immediately visible). Then #2 and #5 together, since both reshape the ledger, then #4 and #6. #7, #8 and #10 build on those. #9 is independent.

**Files to touch:** `apps/desktop/src/features/money/migrations/0005_money.sql` (new 0017+ migration), `apps/desktop/src-tauri/src/tx.rs` (allowlist new tables), `apps/desktop/src/capture/parse.ts`, `apps/desktop/src/capture/ops.ts`, `apps/desktop/src/features/savings/savings.ts`, `apps/desktop/src/features/week/card.ts`, `apps/desktop/src/features/ai/touchpoints.ts`, `docs/plan.md` §3.12 and §12.2.

## Review 5

# Money app market research: what Sirna should copy

**Verdict.** Sirna's money data is in good shape, but almost none of it reaches the user. The schema in `features/money/migrations/0005_money.sql` already has signed santim amounts, an `account` column, income categories and a `money_templates` table. `capture/parse.ts` already reads `lunch 120`, `+25000 salary` and `paid ... ` lines. What's missing is everything after capture:

- no money screen at all;
- no list where you can find, edit or delete a transaction;
- income is never shown anywhere;
- `account` is always `'cash'`;
- `money_templates` is declared in `kernel/db.ts:20` but nothing reads or writes it. Chips are rebuilt from history in `features/review/review.ts` (`CHIPS_SQL`).

Today, spending shows up in only two places: one total on Today (`features/tasks/today.ts`, `SPENT_TODAY_SQL`) and the Sunday category table (`features/week/card.ts`, `SPEND_SQL`). Savings (`features/savings/savings.ts`, `0015_savings.sql`) is a separate ledger that never touches income or spending.

The plan made this choice on purpose. §3.12 says "No balances", and §12.2 defers budgets, bills and bank/telebirr SMS. The user has now hit those triggers in their own words, so §12.2 should be reopened. The best apps don't win on feature count. They win on one number to look at, near-zero-effort entry, and a plan for upcoming money. Copy that core, not their bank-sync machinery.

## Suggestions

**1. Money screen with a transaction list (the missing basics).**

- _What:_ A `shell/Money.tsx` tab with a month header (In / Out / Saved / Left) and a list grouped by day. Tap a row to edit amount, category, account or date. Delete is undoable. Filter by category. Every app reviewed has this; Money Manager (Realbyte) is the plain model: calendar view plus weekly, monthly and annual stats ([App Store](https://apps.apple.com/app/id560481810)).
- _Why:_ Right now, a wrong parse can only be fixed through capture undo. Income typed with `+25000 salary` is stored and then never seen again.
- _Simple:_ One screen with one list. Editing happens in place.
- _Size:_ M.

**2. Accounts with balances: Cash, CBE, telebirr, plus any the user adds.**

- _What:_ Turn on the existing `account` column, add a `money_accounts` table with an opening balance, and add transfers (`cbe -> cash 2000`, stored as two linked rows). Realbyte's cash/debit/savings accounts with transfers are the reference ([Choice](https://www.choice.com.au/products/money/financial-planning-and-investing/creating-a-budget/realbyte-money-manager)).
- _Why:_ An Addis salary lands in a bank or telebirr, then gets withdrawn as cash. Without accounts, income and spending never reconcile, and "how much do I have" can't be answered.
- _Simple:_ The default stays cash. In capture, an account is just a word (`taxi 40 telebirr`). Show a balance only once the user has set an opening balance.
- _Size:_ M.

**3. "Left this month": one deterministic number.**

- _What:_ PocketGuard's Leftover is income minus bills, budgets, goals and debts ([PocketGuard help](https://pocketguard.com/help/leftover/)). For Sirna: expected income this month − bills still due − planned savings − spent so far. Optionally divide by days left to show "per day".
- _Why:_ This is the "advisor" answer the user wants ("can I afford this?"), computed by the app and not by Gemini.
- _Simple:_ One number on the Money tab and in the Sunday card. Tapping it shows the subtraction line by line.
- _Size:_ S, after items 4 and 5 exist.

**4. Recurring income and bills (schedules).**

- _What:_ Rent, internet, phone, gym fee, and a salary per job (two now, maybe three later), each with an amount, a day of the month and an account. Each one shows as "upcoming", and confirming it with one tap creates the transaction. This copies Actual Budget's schedules, including "Find schedules", which spots repeats in past data ([Actual docs](https://actualbudget.org/docs/schedules)), and Copilot's weekly, bi-weekly and monthly recurrings ([Copilot help](https://help.copilot.money/en/articles/3760068-create-recurrings)). Goodbudget adds a reminder a couple of days before ([NerdWallet](https://www.nerdwallet.com/blog/finance/goodbudget-app-review)).
- _Why:_ Several incomes on different paydays are exactly what this user has. A bill reminder is a toast, and the tray app already does toasts.
- _Simple:_ Suggest schedules from 3 or more repeats, the same rule the chips already use. Never auto-post without a tap.
- _Size:_ M.

**5. Light monthly limits per category, with an envelope option. No zero-based budgeting.**

- _What:_ An optional cap per category ("Food 6,000/month") with a quiet progress bar. Leftover can roll over (Actual's rollover model: [docs](https://actualbudget.org/docs/budgeting/)). Also allow "annual" envelopes such as Eid, school fees or a laptop fund, as Goodbudget does with 10 regular plus 10 annual envelopes ([App Store](https://apps.apple.com/ca/app/id471112395)).
- _Why:_ The user said "track ... anything in between". Caps give the Sunday card something to compare against, besides the 4-week average.
- _Simple:_ Off by default. Set a cap from the Sunday row with one tap ("cap Food at last month's 5,800?"). Do not copy YNAB's "give every birr a job": it needs weekly upkeep, and reviews call it hands-on ([focus-blog](https://focus-blog.pages.dev/budgeting-apps-ranked-reviewed)).
- _Size:_ M.

**6. Link savings goals to the money ledger.**

- _What:_ Keep the plant. Add a target date that gives a "needed per month" figure, and record `saved 500 laptop` as a transfer out of an account, not a separate world. PocketGuard subtracts goal contributions from spendable money for this reason ([PocketGuard](https://pocketguard.com/leftover/)).
- _Why:_ Today, saving 5,000 doesn't reduce what's "left". The two ledgers can tell different stories.
- _Simple:_ Same capture words, same plant. The goal card adds one line: "1,250/month to make June".
- _Size:_ S.

**7. Make capture fast everywhere money appears.**

- _What:_
  - Turn the unused `money_templates` into pinned chips the user can edit and name (`coffee` → 25 Food).
  - Allow multiple items per line everywhere, not only in the night review (`lunch 120, taxi 40`).
  - Let a `#category` override the guess, and learn from corrections: when the user changes a category, remember the word→category pair.
  - Recognize `+` income for each job by name (`+18000 job2`).
- _Why:_ Wallet, Spendee and Realbyte all win on entry in under 5 seconds. Corrections that stick are how `CATEGORY_WORDS` in `capture/parse.ts` stops falling back to "Other".
- _Simple:_ No new syntax beyond `#cat` and an account word. Chips are one tap.
- _Size:_ S–M.

**8. Paste-in for bank and telebirr SMS (not reading the phone).**

- _What:_ The user pastes a CBE or telebirr SMS (or several) into the capture box. A deterministic regex parser pulls out amount, direction, balance and reference, and skips duplicates by reference. Ethiopian apps already parse these formats on Android: Gebeta SMS covers CBE, telebirr, Awash, BOA and others ([Play](https://play.google.com/store/apps/details?id=com.gebeta)). Open-source Cashiro and PennyWise have CBE, telebirr, Zemen and Dashen patterns that can be studied ([F-Droid](https://f-droid.org/en/packages/com.ritesh.cashiro/), [PennyWise](https://newreleases.io/project/github/sarim2000/pennywiseai-tracker/release/v2.15.46)).
- _Why:_ This is the §12.2 trigger ("non-cash spending passes half"), and digital money is common in Addis. It's desktop-only and local, with no SMS permission. The raw text lands in `core_raw_items` first, as the rules require.
- _Simple:_ Paste, then review one card, then save.
- _Size:_ M. Formats drift, so keep the fixtures in tests.

**9. Monthly review and debts/IOUs.**

- _What:_ A month-end card: income vs spending, top 3 movers, savings rate, cap overruns. Add an "owed / I owe" list (`lent Abebe 2000`), which is common with family money in Ethiopia and easy to forget.
- _Why:_ This gives the "advisor" grounded numbers. Gemini then phrases them and suggests one change, which can be undone. Today `features/ai/touchpoints.ts` tells Gemini "No advice about health or money". Loosen that for spending observations only, and keep the line against investment advice.
- _Simple:_ Shown once a month inside the Sunday card, not as a new screen.
- _Size:_ M.

## Do not copy

- **Bank or API sync, and net-worth or investment tracking** (Monarch, Copilot). Nothing local or Ethiopian supports it, and it's heavy.
- **Shared wallets or couples budgets** (Spendee, Monarch). There's one user.
- **Multi-currency.** Keep ETB. At most, add a note field for a USD amount.
- **YNAB's zero-based "age of money" discipline.** Too much upkeep for someone running two jobs.
- **AI-computed totals or AI auto-categorizing without review.** Both break the "app calculates" rule.
- **Gamified scores beyond the existing plant.**

**Build order:** 1 → 2 → 4 → 3 → 7 → 6 → 5 → 8 → 9. Items 1–4 alone turn the current two read-only views (the Today total and the Sunday table) into a real money tracker.

Sources not linked above: [investormint comparison](https://investormint.com/?p=16968), [fincomparelab](https://www.fincomparelab.com/?p=643), [Copilot rollovers](https://intercom.help/copilotmoney/en/articles/6206293-editing-budgets-by-month), [Zufan Personal](https://keri-app-personal-landing.web.app/). The comparison and review sources are mostly affiliate-style blogs. App Store listings and official help pages were preferred where available.

## Review 6

## Architecture and rules fit: finance and planner

**Verdict.** The current money layer is a cash log, not a finance tracker, and it was built that way on purpose. Plan §3.12 says "No balances, no accounts beyond cash", D37 removed SMS and bank data, and the cut list (§12.2) holds back budgets, bills, SMS and multi-currency. The code matches that design:

- `features/money/migrations/0005_money.sql` has only `money_txns` with a free-text `account` column, plus categories and templates.
- There is no Money screen in `shell/`. Transactions show up only in the review (`features/review/review.ts`), the week card (`features/week/card.ts:152`) and a Today total (`features/tasks/today.ts:41`).
- Savings live apart in `features/savings/migrations/0015_savings.sql`.

The user has now asked for the full tracker, so the cut-list triggers are met by request. Record a new decision (D50) that supersedes D37 and §3.12. The existing rules can hold the new design: integer santim, `logicalDate`, `db_tx` allowlist, store-first, deterministic numbers with AI only phrasing. Nothing below needs Rust beyond allowlist entries and one reminder view.

### Suggestions

**1. Accounts and transfers (migration `0017_money_accounts.sql`).**

- New table `money_accounts(id, name, kind cash|bank|wallet|equb, opening_minor, opening_date, archived)`. Seed it with Cash, CBE and telebirr.
- Add `account_id`, `transfer_id`, `raw_item_id` and `import_hash UNIQUE` to `money_txns`.
- Backfill `account_id` from the legacy `account` text. Do not rebuild the table: forward-only SQLite migrations make a rebuild risky.
- A transfer is two signed legs that share a `transfer_id`. A fee is a third leg in category "Fees".
- Balances come from a view, `v_account_balance` = opening + sum of legs. Never store a balance.

Why it matters: he is paid into a bank and spends from both cash and telebirr. Without accounts, "how much do I have" cannot be answered. Simple to use: capture accepts `moved 2000 cbe>telebirr` and `lunch 250 tb`, and Cash stays the default account. **Size M.**

**2. Income sources tied to work areas (`money_income_sources`).**

- Columns: `id, name, area_id, expected_minor, pay_day, cadence monthly|weekly|irregular, account_id`. `area_id` links Job A, Job B and a future Job C to `area_items`.
- `+ 25k salary jobA` then matches by name.
- Pure TypeScript `income.ts` computes expected vs received per month, with tests.

Why it matters: two or three jobs means income arrives on several dates, and a missing salary should show. Simple to use: set up once per job, after which the app sees the salary land. **Size S.**

**3. Recurring bills and contributions (`money_recurring`).**

- Columns: `kind, label, amount_minor, category_id, account_id, rule_json, next_due, auto_post=0`. This covers rent, internet, family support, equb and iddir.
- Due items come out through `v_reminders_money`. This is the D4 pattern, so Rust needs no change.
- Posting is one tap in Today or the review. Nothing posts silently.

**Size M.**

**4. Budgets and "safe to spend today" (pure TypeScript, `features/money/budget.ts`).**

- `money_budgets(category_id, month, limit_minor)`. The month runs payday to payday (setting `money.month_start = payday | 1`), because a calendar month misfits salary timing.
- The advisor core is deterministic and tested:
  - safe-to-spend = (received + expected income − bills due − planned saving − spent) ÷ days left
  - a per-category pace
  - an affordability verdict for "can I buy X for N?": Fine / Tight / Not now, worked out the same way as the timing verdict (D42)

Why it matters: this is the "flexible advisor" he asked for, and it works offline with no AI. Simple to use: one number on Today, and the full breakdown on the Money screen. **Size M.**

**5. Goals and debts in one ledger.**

- Add `account_id` and `target_date` to `savings_goals`. A computed monthly-needed amount and on-pace/behind flag go into `savings.ts`.
- New table `money_debts(id, person, direction owed_to_me|i_owe, principal_minor, due_date, status)`. Repayments are ordinary transactions with `debt_id`.

Why it matters: lending to and borrowing from family is "anything in between" in an Ethiopian household. Keep the plant (D49). **Size S–M.**

**6. Pasted SMS import (`features/money/sms.ts`, pure TypeScript).**

- Paste one or many CBE or telebirr messages into capture or the Money screen.
- Each message lands in `core_raw_items` with `source='sms_paste'` and is deduplicated by `content_hash`.
- Per-sender regexes pull out amount, direction, counterparty, fee and the stated balance. A stated balance becomes a reconcile check against `v_account_balance`, which shows the gap and offers [Adjust].
- Parsed rows show as a confirm list before they are saved. Imported data is not the user's own typing, so D10 instant-save does not apply.
- Build a fixture corpus in `capture/fixtures`; message formats drift. The parser carries an id and a version, as §5.3 requires.

**Size M.**

**7. Bank CSV import.**

- Use `<input type=file>` in the webview and parse in TypeScript. This needs no fs plugin, so the CSP and the "no plugins" rule in §9 stay intact.
- Save the column mapping per bank in `core_settings`, and deduplicate by `import_hash` = date + amount + description.

Why it matters: unsure which formats CBE and telebirr export. If it is PDF only, defer it, because pdf.js adds about 1 MB+ and breaks "small". **Size S** (CSV only).

**8. Calendar sync window.** `features/calendar/ics.ts:27` already sets `WINDOW_AHEAD_DAYS = 14`, so a year of repeats should not be written. If he still sees a year of entries, the expansion path is wrong (check `ics.ts:143-175` and `sync.ts:114`). Set the window to 31 days as he asked and add a test that a FREQ=DAILY rule yields ≤ 32 occurrences. **Size S.**

**9. New AI touchpoints (§7.3 pattern, `features/ai/touchpoints.ts`).**

| Touchpoint                            | Sends                                              | Returns                              | Fallback              | Calls     |
| ------------------------------------- | -------------------------------------------------- | ------------------------------------ | --------------------- | --------- |
| Money note (weekly, in the week card) | percentages and pace flags only                    | `{paragraph ≤ 60 words, one_change}` | template sentence     | 1 a week  |
| Afford reasons                        | the deterministic verdict + category pace          | `{reasons ≤ 3}`                      | numbers only          | 0–2 a day |
| Category guess for imports            | descriptions only, batched 50 per call, no amounts | category per line                    | rules in `core_rules` | 0–1 a day |

- Grounding is unchanged: every number in a reply must appear in the facts.
- The prompt forbids investment or product advice. The advisor covers cash flow and budgeting only.
- Every accepted category becomes a `core_rules` row, so AI use falls over time. The total stays inside the 15/day default cap.

**Size M.**

**10. Privacy setting for money.**

- §7.4 promises "no money amounts" go out, and Gemini's free tier may train on what it receives. Add `ai.money = off | ratios (default) | amounts`.
- Strict mode also strips counterparty names. The "What was sent" viewer covers money payloads.
- SMS text contains account numbers. Mask them to the last 4 digits before `core_raw_items`, and record this as the one documented exception to store-first.
- Logs already never record amounts (§9). Keep it that way in `sms.ts` errors.
- Backups on D: now hold financial data: re-state the Device Encryption advice in Settings.

**Size S.**

**11. One Money screen (`shell/Money.tsx`), three tabs.**

- **Month:** safe-to-spend, income vs spend, budget bars.
- **Transactions:** a list with edit, split, undo and filters. Today nothing can be edited outside the review.
- **Goals & debts:** absorbs `shell/Savings.tsx`.

The night review keeps its single spending step (7-tap budget). It just gains "post due bills". **Size M.**

**12. Planner gaps, minimal.**

- Add `task_recurrence(task_template_id, rule_json, next_date)` for repeating chores.
- Link `money_recurring` due dates into `v_reminders_*` so bills appear in the day plan.
- Keep the job-hunt pipeline on the cut list until he has ≥ 5 applications.

**Size S–M.**

### Risks and rule checks

- **Rust allowlist:** every new table needs a `TableSpec` in `src-tauri/src/tx.rs`. Capture inserts also need a match arm in `commands.rs:42`. This is small but easy to forget; add a test that lists all migration tables against the allowlist.
- **Multi-currency:** keep the `currency` column with ETB enforced. A USD-paid third job is the trigger. Store the rate the user enters, never a fetched one; there is no new network host.
- **Bloat:**
  - No chart library: reuse the existing dashboard SVG.
  - No PDF parsing.
  - No bank APIs.
  - Money logic adds roughly 1.5k lines of TypeScript and no Rust logic.
- **Scope creep:** the advisor must never decide. Verdicts are code, and the AI only explains them (Rule 1).

Ordering: 1 → 2 → 4 → 11 first gives a usable tracker in about two milestones. Then 3, 5, 6, 9, 10. Do 8 now, since it is a "can't use it" bug (hard rule 1).
