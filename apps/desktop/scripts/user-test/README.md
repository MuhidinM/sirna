# User tests in a browser

Use Sirna like a user in plain Edge: the main window, the capture bar (`capture.html`), the focus sheet (`setup.html`) and the widget (`widget.html`) open as pages of one browser context and share one database. Dev only: `src/dev/` stands in for Rust and is never in a build.

## Set up once

1. Build the preview database (git-ignored). From `apps/desktop`:
   - in a worktree, copy the main checkout's: `node scripts/preview-db.mjs D:\Projects\Personal\sirna\apps\desktop\dev-data\sirna.db`
   - otherwise copy the newest backup: `node scripts/preview-db.mjs D:\Sirna\backups\sirna-YYYY-MM-DD.db`

   Never point it at `%APPDATA%\dev.sirna.app`. The script copies the file, applies pending migrations and adds demo data dated today.

2. Start the dev server and leave it running: `pnpm --dir apps/desktop dev` serves http://localhost:1420. If 1420 is taken, run `pnpm --dir apps/desktop exec vite --port 1431 --strictPort` and set `SIRNA_URL=http://localhost:1431` for the scripts.

Edge must be installed (it is on Windows). playwright-core drives it with `channel: "msedge"`; no browser download. Do not use the Claude browser pane: it can't share one context across several pages.

## Run the example

```sh
node apps/desktop/scripts/user-test/example.mjs            # today's date, headless
node apps/desktop/scripts/user-test/example.mjs 2026-11-24 --headed
```

It captures `update the abc ui for job a at 10am` and `lunch 120`, opens Today at 09:30, screenshots it, starts focus on the current block from Today's Start focus, moves the clock 30 minutes and prints the `focus_sessions` rows. Screenshots land in `apps/desktop/user-test-out/` (git-ignored).

## Write a test

```js
import { launch } from "./sirna.mjs";

const app = await launch({ headless: true });
const main = await app.openMain({ now: "2026-11-24T09:30", fresh: true });
await app.capture("call bank tomorrow 10am"); // types, Enter, waits for the bar to close
const sheet = await app.openFocusSheet(); // clicks Start focus on Today, opens setup.html
await app.startFocus(sheet, { intent: "draft the email" });
await app.advance(25); // the timer completes the session and starts the break
console.log(await app.query("SELECT * FROM focus_sessions ORDER BY started_at DESC LIMIT 2"));
await app.screenshot(main, "after-focus");
console.log(app.consoleErrors());
await app.close();
```

| Helper                             | Does                                                                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `launch({ headless, baseUrl })`    | Starts Edge with one context. `baseUrl` defaults to `SIRNA_URL` or http://localhost:1420.                                                                    |
| `openMain({ now, fresh, screen })` | Opens `index.html`. `now` is Addis time; `fresh` restarts from `dev-data/sirna.db`; `screen` is what `take_screen` returns (`review`).                       |
| `open(file, params)`               | Any page (`widget.html`…), once the harness is ready.                                                                                                        |
| `capture(text)`                    | Opens the capture bar, types, presses Enter, waits for it to close; returns `{ chip, echo }`.                                                                |
| `openFocusSheet({ fromToday })`    | Clicks Start focus on Today (unless `fromToday: false`) and opens the sheet for that block.                                                                  |
| `startFocus(sheet, { intent })`    | Enter on the sheet; `{ started, message }` (message holds "confirm" texts past the hard stop or in a long break).                                            |
| `advance(minutes, { reload })`     | Moves the shared clock; the timer ticks at every deadline on the way. Reloads open pages so they show the new time (they redraw each real minute otherwise). |
| `now()`, `query(sql, params)`      | The Addis time as `YYYY-MM-DDTHH:MM`; any SELECT against the shared database.                                                                                |
| `windowLog()`                      | Window events: `open_capture`, `open_main`, `open_notes`, `focus_setup_open`, `widget_apply`, `close_window`, each with the page to open.                    |
| `screenshot(page, name)`           | `user-test-out/<name>.png`.                                                                                                                                  |
| `consoleErrors()`                  | Console errors and uncaught exceptions from every page (the favicon 404 is left out).                                                                        |

Nothing opens a window by itself. When the app asks for one (the rail's +, Today's Start focus, `? query` in the capture bar), the request is logged; follow it by opening that page, as `openFocusSheet` does.

## `window.__sirna` (in every page)

- `query(sql, params)` – read the shared database.
- `advance(minutes)` – move the clock and tick the timer; resolves to the new epoch ms.
- `now()` / `nowText()` – the harness time.
- `reset()` – back to `dev-data/sirna.db` in every page (the clock stays).
- `openedWindows` / `windowLog` – window requests, oldest first.
- `toasts` – toasts Rust would have shown (break started, break over, daily cap); `pressToast("extend" | "start" | "done:yes" …)` presses a button on the newest one that has it.
- `focus()` – what `focus_status` returns.

## How it works

- `?now=YYYY-MM-DDTHH:MM` sets an Addis time that stays still until `advance`; it is stored, so every page of the context shares it. `?now`, `?fresh=1` and `?screen=` are read once and removed from the address, so a reload keeps the clock and the data.
- Every page has its own sql.js copy. A write takes a Web Lock, catches up, runs the ported Rust command, stores a snapshot in IndexedDB and tells the other pages on a BroadcastChannel; they reload it and get the same `data-changed` / `focus-changed` events Rust would emit.
- The writes are TypeScript ports of `tx.rs` (allowlist, stamps, soft deletes, `core_activity` with before/after JSON, undo), the capture, Notes undo and away commands in `commands.rs`, and the focus timer (`focus.rs`, `guard.rs`, the sheet commands). Their Rust unit tests are ported in `src/dev/*.test.ts`.

Not emulated: toasts on screen (only logged), Do not disturb, the kit opening and minimizing programs, the tray, the hotkey, the morning brief, night review and bill/reminder ticks, the hard-stop toast, AI and calendar calls (they fail as offline), and secrets.
