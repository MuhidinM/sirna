# Smoke test

Five minutes in the **installed** build after every `pnpm ship` (tray, toasts and the hotkey only behave correctly there). Note failures as bug issues.

## Every ship

1. **Tray:** the Sirna icon is in the tray (or the ^ overflow). Its tooltip names the capture key, e.g. "Sirna · Ctrl+Alt+J to capture".
2. **Capture:** press the capture key from another app. The box appears and you can type straight away. Enter shows "Saved" and closes it; Escape closes it; clicking elsewhere closes it.
3. **Saved unchanged:** `node scripts/read-captures.mjs` shows the line exactly as typed.
4. **Toast:** tray → Test notification. The toast says "Sirna" (not PowerShell) and has two buttons. "Open Sirna" opens the main window; "Got it" just closes. Both appear in the log as `toast action: …`.
5. **Focus from the tray:** tray → Start focus. The tooltip reads "Focus · … · 25 min left" and counts down; Pause, Resume, Distracted and Stop work from the menu with no window open.
6. **Window:** close the main window; Sirna stays in the tray. Tray → Open Sirna brings it back.
7. **Second launch:** start Sirna from the Start menu while it runs: no second tray icon; the main window opens.
8. **Quit:** tray → Quit. The tray icon and all `sirna.exe` / `msedgewebview2.exe` children are gone.
9. **Memory:** start it again with `--autostart`, wait a minute, run `scripts/measure.ps1`, and add a line to [measurements.md](measurements.md) if it moved.

## After milestones that touch time

- **Sleep:** with a reminder due in 5 minutes, sleep the laptop for 10. On wake, one summary toast (T-017).
- **Block start:** with Do not disturb off, a focus block on Today toasts at its start with "First step" and Start focus / Skip. Start focus begins a session tied to that block. Ignore one for 10 minutes: one "Just one session on …?" nudge (T-021).
- **Morning brief:** lock the PC after wake time and before 13:00, then unlock: Sirna opens with the brief on top once that day; "Start my day" folds it. The log shows `brief ready in N ms` (under 1000). Turn Sirna's notifications off in Settings: the brief shows a CHECK line (T-025).
- **Night review:** at review time a toast offers Start / In 30 min / Skip tonight, and the tray shows "Night review" until 03:00. Run it with Wi-Fi off: type `lunch 120, taxi 40`, pick an energy, accept tomorrow. Today shows the two expenses (T-026).
- **Focus set-up:** in Focus kits, give Coding `notepad` under Open and `Telegram.exe` under Minimize. Tray → Start focus during a coding block: the sheet shows the checklist and "Opens notepad · Minimizes Telegram". Type an intent, press Enter once: the timer starts, Telegram is minimized (not closed), Notepad opens, and the tray tooltip shows the intent. At the break toast, "Done with: …?" Yes writes `intent_done = yes` (T-028).
- **Do not disturb:** with it off, start focus: the sheet says "Do not disturb on", and Win+N shows the bell on. Stop the session: it is off again. Turn it on yourself first: Sirna leaves it on after the session (T-029, ADR-0007).
- **Cheat sheets:** capture `pin: undo = git reset --soft HEAD~1 #coding`; type `? reset` in the capture box: the chip shows that line, Enter opens Cheat sheets on it. Start focus on a Coding block: the sheet shows the card. Edit the card, Save, Undo (T-031).
- **Away:** capture `away till mon`: the echo says "Away until …", Today shows the banner, and no brief, review or block toast comes until then; a timed reminder still fires. "I'm back" ends it (T-032).
- **Daily backup:** after the first minute of a new day, `D:\Sirna\backups` has `sirna-<today>.db` and the log says `daily backup:` (T-032).
- **Settings:** the sidebar reaches every page. In Settings, save a Gemini key: it shows "Saved in Windows Credential Manager" and the box stays empty; Replace and Remove work, and Credential Manager → Windows Credentials lists `gemini_api_key` under `dev.sirna.app`. Set the capture key to `Ctrl+Alt+K`: it works at once and the tray tooltip names it. In My week, set email checks to `11:00`: tomorrow's plan has one check at 11:00.
- **Projects:** New project with a next step: it shows on the board under To do. Drag it to Doing: Today still lists it. Move it to Done: the project asks for the next step. The List tab shows every card with its column (T-033).
- **Timing check:** Projects shows "This week: load …". In New project type an estimate of 18 h: the card shows a start and finish; add a deadline 3 weeks out: it shows a verdict with the hours a week and the load before → after. With two active projects, saving a third as Active puts it in Next up with a note (T-034).
- **Ideas:** capture `idea: learn Go ~10h`: the echo says when it starts and how many hours a week; Projects lists it as Active or Next up. Ctrl+Z in the capture box removes it. Capture `idea: CLI tool ~18h by 20 dec`: the echo gives Good / Tight / Too much; in Projects its card offers Keep the date, Use suggested dates and Drop (T-035).
- **At risk:** a project with a deadline 2 weeks out, 10 h estimate and 2 h a week: the brief shows `AT RISK  … 6 h short before …` and Projects marks it (T-035).
- **AI gate:** with a Gemini key saved, Settings → AI → Pick a model lists models; pick a Flash-Lite one. "Today: 0 of 15 requests" shows. What was sent lists the models request. Remove the key: Pick a model is greyed out (T-036, ADR-0008).
- **AI touchpoints:** with a key and model set, open an idea with an estimate and a date: the reasons from the AI appear in italics under the numbers, and What was sent lists the request. In the night review write something under "Anything on your mind?": a short reply shows before it closes (or "Noted. Sleep well." after 4 s). With loose ends, "Suggest with AI" offers one button per note. Turn on Strict mode: the next request in What was sent has area names, not titles. Remove the key: everything still works with plain text (T-038).
- **My week editor:** Routine → Mon → Change on Gym → move it to 06:30–07:15 on every day it's on: Today replans with Gym in the morning. Add a block "Quran" 13:00–13:20 Habit on all days; remove the morning Quran. Areas → Add an area "Job C" (Job), then Routine → Add a block "Job C" Fixed Tue/Thu 18:00–20:00. Turn off an area: its blocks leave the routine. Day times → change the hard stop.
- **Planning tasks:** capture `t: write the report ~3h`: it shows in tomorrow's plan in free slots and, if not finished, the day after. On a task of 90 min or more, Split shows AI steps; Use these steps replaces it with them.
- **Tasks page:** add `write the report ~3h fri #jobhunt`: it shows under To do with Job hunt, ~3 h and Friday. Edit it to Someday: it moves to Someday and leaves tomorrow's plan. Drop it, then Restore it from Dropped.
- **Week card:** after a few focus sessions and expenses, This week shows the minutes per area, next week's load and spending against the usual; on Friday or later with an area under half its target, One change offers a target it can meet; No hides it for the week (T-039).
- **Dashboard:** after two focus sessions today the flame is lit and the streak counts today; the year chart's last column has today shaded; pick an area: the chart shows only its time (T-040).
- **Savings:** Dashboard → New goal "Laptop" 100,000. Capture `saved 45k laptop`: the echo says "Saved 45,000 ETB · Laptop" and the plant is a small plant (45%). Capture `took 2k from laptop`: 43%, the plant doesn't shrink below its stage's start. On Saturday the week card asks "Put anything aside this week?" (T-041).
- **Insights:** after two weeks of sessions, the Dashboard's Insights card names your best focus window; the brief shows one INSIGHT line; with no AI key the week card still shows a plain summary (T-042).
- **Arrange and accent:** Dashboard → Arrange: drag Savings above the streak, set Insights to S, hide The year; Done arranging; quit and start Sirna: the layout is the same. Settings → Accent Teal → Save: buttons and bars turn teal, in both themes (T-043).
- **Calendar:** Settings → paste the Google Calendar secret iCal address → Sync now: "Synced: N events". Add an event in Google Calendar today, Sync now: it shows on Today as a fixed block and focus blocks move around it. Paste a wrong address: Settings says why in words and the brief shows a CHECK line (T-044).
- **Desktop widget:** Settings → Windows → tick Desktop widget: it appears top right at once with Now, the timer and the top 3. Drag it by its top edge; quit and start Sirna: it comes back in the same place. Pick a cheat sheet: it shows under the list. Start a focus session: the ring counts down. Open a full-screen video: the widget hides, and returns after. Untick: it closes with no restart (T-045).
- **Deadline kept:** add `t: send CV by 30 nov`; in the night review press All the rest to tomorrow: on Tasks it shows "on <tomorrow> · due 30 nov", and it is gone from today's list. Old carried tasks show "check deadline" until you open and save them (T-050).
- **Steps in order:** split a 3-hour task with AI on Today: only "1/N" shows on Today and in the plan; tick it done and "2/N" appears (T-051).
- **Reboot:** after a restart Sirna is in the tray without opening a window (autostart, T-018).

## Restore a backup (T-032)

Sirna makes a checked copy once a day (`VACUUM INTO`, then `quick_check`) and before every migration. It keeps the newest 14 daily copies (`sirna-YYYY-MM-DD.db`) and 5 pre-migration copies in `D:\Sirna\backups` (next to the data when there is no D:).

1. Tray → Quit (it folds recent changes into `sirna.db` first). Check no `sirna.exe` is left in Task Manager.
2. In `%APPDATA%\dev.sirna.app`, rename the database files, keeping their endings together:
   - `sirna.db` → `sirna-before-restore.db`
   - `sirna.db-wal` → `sirna-before-restore.db-wal` (if it exists)
   - `sirna.db-shm` → `sirna-before-restore.db-shm` (if it exists)
3. Copy the backup you want, for example `D:\Sirna\backups\sirna-2026-11-10.db`, to `%APPDATA%\dev.sirna.app\sirna.db`. A backup is a single file; there is no `-wal` to copy.
4. Start Sirna. An older copy is migrated forward on start (with its own pre-migration copy first). Today shows that day's data.
5. To go back: Tray → Quit, check no `sirna.exe` is left, delete the restored `sirna.db`, `sirna.db-wal` and `sirna.db-shm`, then rename the three `sirna-before-restore.db*` files back to `sirna.db`, `sirna.db-wal` and `sirna.db-shm`. Never leave a `-wal` next to a database it didn't come from.

Tested at file level on 2026-11-11: a pre-migration copy restored into an empty folder passed `quick_check` and read back (areas, blocks, schema at 0010). Repeat steps 1–4 on the installed build after `pnpm ship`.

Usage numbers: `pnpm usage` (last 7 days) or `pnpm usage 30`. Read-only, local only.

## Where things are

| What    | Path                                                    |
| ------- | ------------------------------------------------------- |
| App     | `%LOCALAPPDATA%\Sirna\sirna.exe`                        |
| Data    | `%APPDATA%\dev.sirna.app\sirna.db`                      |
| Log     | `%LOCALAPPDATA%\dev.sirna.app\logs\Sirna.log`           |
| Secrets | Windows Credential Manager, entries for `dev.sirna.app` |

An app installed or started from inside a packaged app (the Claude desktop app is one) writes to that app's private copy of `%LOCALAPPDATA%` and the registry, so the Start menu and autostart never see it. `pnpm ship` avoids this by installing through the desktop shell. Check with Task Manager that the running `sirna.exe` is `%LOCALAPPDATA%\Sirna\sirna.exe`, not a path under `Packages\`.
