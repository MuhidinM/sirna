// The capture box runs without React so it opens fast and stays small (plan §4.3).
//
// Keys: Enter saves · Tab changes what it is saved as · Up arrow (empty box)
// brings back the last capture to fix · Ctrl+Z (empty box) undoes it · Escape closes.
import { invoke } from "@tauri-apps/api/core";

import { systemClock } from "../kernel/clock";
import { commitCapture, query, replaceCapture, undoCapture } from "../kernel/db";
import { ulid } from "../kernel/ulid";
import { find, FIND_SQL, type Found, type FoundRow } from "../features/notes/cheat";
import { readings } from "./alternatives";
import { CAPTURE_MADE_SQL, fixBlocked, fixReading, madeKind, type MadeRow } from "./fix";
import { loadWeek, type Query } from "../features/projects/capacity";
import { placeIdea, type Placement, REPLACED_PROJECTS_SQL } from "../features/projects/idea";
import { matchGoal } from "../features/savings/savings";
import { logicalDate } from "../kernel/dates";
import { affordState, echo as echoLine, ideaInput, toOps } from "./ops";
import { balances, type LoanEvent, loanPeople, LOANS_SQL } from "../features/money/loans";
import { RATES_SQL, readRates } from "../features/money/currency";
import { affordAnswer } from "../features/money/affordLoad";
import { CATEGORIES_SQL, LEARNED_SQL } from "../features/money/money";
import { type ParseOptions, type Parsed, parseCapture, PARSER_ID } from "./parse";
import { type ClockStyle } from "./when";

import { applyTheme, cachedTheme } from "../theme/theme";

import "@fontsource-variable/bricolage-grotesque";
import "../theme/tokens.css";
import "./capture.css";

// In a plain browser during development, stand in for Tauri before this page
// calls it (src/dev/tauriPreview.ts). Removed from production builds.
if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window))
  await import("../dev/tauriPreview").then((preview) => preview.install());

applyTheme(cachedTheme());

const ECHO_MS = 1500;
const ANSWER_MS = 6000;
// Same rule as the tray: lines that made no records (search, away) can't be undone.
const LAST_CAPTURE_SQL =
  "SELECT id, body FROM core_raw_items WHERE source = 'capture' AND parse_status NOT IN ('ignored', 'new') ORDER BY id DESC LIMIT 1";

function element<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Capture markup is missing ${selector}`);
  return found;
}

const form = element<HTMLFormElement>("#capture");
const input = element<HTMLInputElement>("#capture-input");
const output = element<HTMLOutputElement>("#capture-echo");

let clockStyle: ClockStyle = "western";
/** Savings goal names, so `saved 500 laptop` reads as saving only when a goal fits. */
let goalNames: string[] = [];
/** Categories, corrections and jobs, so money lines land right (T-056). */
let moneyContext: Pick<
  ParseOptions,
  "categories" | "learned" | "jobs" | "accounts" | "loanPeople" | "areas" | "rates"
> = {};
/** Today's blocks, so `gym done` and `skipped gym` record one (plan §3.5). */
let todayBlocks: NonNullable<ParseOptions["blocks"]> = [];
const TODAY_BLOCKS_SQL = `SELECT id, title FROM day_blocks
  WHERE logical_date = ? AND deleted_at IS NULL AND kind != 'rest' ORDER BY start_at`;
/** The other readings of the current text, and which one Tab has picked. */
let options: Parsed[] = [];
let picked = 0;
/** Set while fixing the last capture with Up arrow: saving replaces it. */
let editing: { id: number; body: string } | undefined;
/** What the capture being fixed made: the box keeps to that reading. */
let fixKind: Parsed["kind"] | undefined;
/** True while a save, fix or undo is in flight. */
let busy = false;

const close = () => invoke("close_window");

const ready = () => {
  void invoke("capture_ready").then(() => input.focus());
};

ready();

// The input has focus whenever the bar opens or comes back, so Ctrl+Z and Up
// arrow work at once (time-first §2). The bar is hidden and shown, not rebuilt.
const focusInput = () => {
  if (!input.disabled) input.focus();
  loadContext();
};
window.addEventListener("focus", focusInput);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") focusInput();
});

/**
 * What the parser needs from your data: clock style, goals, categories,
 * accounts, loans, areas and rates. Read again each time the bar opens, so a
 * goal or account added since is known (the bar is hidden, not rebuilt).
 */
function loadContext() {
  // "at 3" follows a one-time setting (plan §3.5); western until it is set.
  void query<{ value_json: string }>("SELECT value_json FROM core_settings WHERE key = ?", [
    "capture.clock_style",
  ])
    .then(([row]) => {
      if (row && JSON.parse(row.value_json) === "ethiopian") clockStyle = "ethiopian";
    })
    .catch(() => undefined);

  void query<{ id: string; title: string }>(TODAY_BLOCKS_SQL, [logicalDate(systemClock.now())])
    .then((rows) => {
      todayBlocks = rows;
    })
    .catch(() => undefined);

  void query<{ title: string }>(
    "SELECT title FROM savings_goals WHERE deleted_at IS NULL AND status = 'active'",
  )
    .then((rows) => {
      goalNames = rows.map((row) => row.title.toLowerCase());
    })
    .catch(() => undefined);

  void Promise.allSettled([
    query<{ id: string; name: string; kind: "expense" | "income" }>(CATEGORIES_SQL),
    query<{ id: string; category_id: string }>(LEARNED_SQL),
    query<{ id: string; name: string }>(
      "SELECT id, name FROM area_items WHERE kind = 'work' AND active = 1 AND deleted_at IS NULL",
    ),
    query<{
      id: string;
      name: string;
      kind: string;
      pays_in: number;
      currency: string;
      is_savings: number;
    }>(
      "SELECT id, name, kind, pays_in, currency, is_savings FROM money_accounts WHERE deleted_at IS NULL ORDER BY sort_order",
    ),
    query<LoanEvent & Record<string, string | number | null>>(LOANS_SQL),
    // Areas and jobs, so `for job a` and `#joba` name one (time-first §1 rule 3).
    query<{ id: string; name: string }>(
      "SELECT id, name FROM area_items WHERE active = 1 AND deleted_at IS NULL",
    ),
    // Rates, so transfers and savings across currencies are worked out here.
    query<{ value_json: string }>(RATES_SQL),
  ]).then((results) => {
    // One failed read leaves that part empty; it never drops the accounts
    // (r2-5: a line once saved with no accounts and moved no balance).
    const [categories, learned, jobs, accounts, loans, areas, rates] = results.map((result) =>
      result.status === "fulfilled" ? result.value : [],
    ) as [
      { id: string; name: string; kind: "expense" | "income" }[],
      { id: string; category_id: string }[],
      { id: string; name: string }[],
      {
        id: string;
        name: string;
        kind: string;
        pays_in: number;
        currency: string;
        is_savings: number;
      }[],
      (LoanEvent & Record<string, string | number | null>)[],
      { id: string; name: string }[],
      { value_json: string }[],
    ];
    moneyContext = {
      areas,
      categories,
      learned: Object.fromEntries(learned.map((row) => [row.id, row.category_id])),
      jobs,
      accounts,
      // One name per person, even with loans in two currencies.
      loanPeople: loanPeople(balances(loans)),
      rates: readRates(rates[0]?.value_json),
    };
  });
}

loadContext();

function refresh() {
  const text = input.value.trim();
  const nowMs = systemClock.now();
  options = text
    ? readings(
        parseCapture(text, {
          nowMs,
          clockStyle,
          goals: goalNames,
          blocks: todayBlocks,
          ...moneyContext,
        }),
        text,
        nowMs,
      )
    : [];
  // While fixing, keep to the kind the capture made as you change the text.
  picked = editing ? fixReading(options, fixKind) : 0;
  showChip();
}

/** Cheat lines, notes and open tasks, loaded once per capture box, for `? query` (plan §3.5). */
let searchable: Promise<FoundRow[]> | undefined;

function showSearch(text: string) {
  searchable ??= query<FoundRow & Record<string, string | null>>(FIND_SQL).catch(() => []);
  void searchable.then((rows) => {
    // Typed on meanwhile: a newer refresh owns the chip.
    if (input.value.trim().slice(1).trim() !== text) return;
    const hits: Found[] = find(rows, text);
    const first = hits[0];
    output.textContent = first
      ? `${first.body} · ${first.label}${hits.length > 1 ? ` (+${hits.length - 1})` : ""}  ·  Enter: open Notes`
      : "Nothing matches  ·  Enter: open Notes";
  });
}

function showChip() {
  delete output.dataset.state;
  const current = options[picked];
  if (!current) {
    output.textContent = editing ? "Fixing your last capture" : "";
    return;
  }
  // While fixing, Enter replaces the capture, so the chip keeps saying "Fix ·".
  if (current.kind === "search" && current.query !== "" && !editing) {
    showSearch(current.query);
    return;
  }
  const hint = options.length > 1 ? "  ·  Tab: change" : "";
  output.textContent = `${editing ? "Fix · " : ""}${echoLine(current, systemClock.now())}${hint}`;
}

function finish(message: string, ms = ECHO_MS) {
  output.textContent = message;
  setTimeout(() => void close(), ms);
}

input.addEventListener("input", refresh);

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const rawText = input.value;
  if (rawText.trim() === "") {
    void close();
    return;
  }
  const nowMs = systemClock.now();
  const parsed =
    options[picked] ??
    parseCapture(rawText, {
      nowMs,
      clockStyle,
      goals: goalNames,
      blocks: todayBlocks,
      ...moneyContext,
    });
  const parser = picked === 0 ? PARSER_ID : `${PARSER_ID}+tab`;
  input.disabled = true;
  busy = true;
  // An idea is placed in the week before it is saved, so the project and its
  // dates go in the capture's one transaction (plan §3.8).
  const fixing = editing;
  const placed: Promise<Placement | undefined> =
    parsed.kind === "idea"
      ? Promise.all([
          loadWeek(query as Query),
          query<{ id: string }>("SELECT id FROM area_items WHERE deleted_at IS NULL"),
          // A fix replaces the old capture: its project mustn't count against the new one.
          fixing
            ? query<{ entity_id: string }>(REPLACED_PROJECTS_SQL, [`capture:${fixing.id}`])
            : Promise.resolve([]),
        ])
          .then(([week, areas, replaced]) => {
            const gone = new Set(replaced.map((row) => row.entity_id));
            return placeIdea(ideaInput(parsed), {
              week: week.week,
              projects: week.projects.filter((project) => !gone.has(project.id)),
              today: logicalDate(nowMs),
              areaIds: areas.map((area) => area.id),
            });
          })
          .catch(() => placeIdea(ideaInput(parsed), null))
      : Promise.resolve(undefined);
  let idea: Placement | undefined;
  // A saving goes to the goal it names, or the only one (plan §3.13).
  let savingGoal: { id: string; title: string } | null | undefined;
  type Goal = { id: string; title: string; status: "active" | "done" | "paused" };
  // A transfer into or out of a savings account is saving too (time-first §4).
  const savesSomething = (item: Parsed) =>
    item.kind === "saving" || (item.kind === "transfer" && item.saving !== undefined);
  const hasSaving =
    savesSomething(parsed) || (parsed.kind === "money" && parsed.items.some(savesSomething));
  const goalRows: Promise<Goal[]> = hasSaving
    ? query<Goal>("SELECT id, title, status FROM savings_goals WHERE deleted_at IS NULL").catch(
        () => [],
      )
    : Promise.resolve([]);
  const goalOf = (goals: Goal[]) => (words: string | undefined) => {
    const id = matchGoal(goals, words);
    const goal = goals.find((row) => row.id === id);
    return goal ? { id: goal.id, title: goal.title } : null;
  };
  const goalFor: Promise<{ id: string; title: string } | null | undefined> =
    parsed.kind === "saving"
      ? goalRows.then((goals) => goalOf(goals)(parsed.goal))
      : Promise.resolve(undefined);
  // A fix undoes the old capture and saves the new one in one transaction.
  const saved = Promise.all([placed, goalFor, goalRows]).then(([placement, goal, goals]) => {
    idea = placement;
    savingGoal = goal;
    const ops = toOps(parsed, {
      nowMs,
      newId: () => ulid(),
      goalOf: goalOf(goals),
      ...(placement ? { idea: placement } : {}),
      ...(goal !== undefined ? { savingGoal: goal } : {}),
    });
    return fixing
      ? replaceCapture(fixing.id, rawText, ops, parser)
      : commitCapture(rawText, ops, parser);
  });
  const fixed = editing ? "Fixed · " : "";
  saved
    .then((rawId) => {
      // `afford 4500 shoes` (T-074): the answer from your real numbers.
      if (parsed.kind === "afford") {
        void affordAnswer(query, nowMs, parsed.amount, parsed.what, parsed.currency)
          // A sentence to read, not an echo: it stays a little longer, in the
          // verdict's colour (Fine green, Tight yellow, Not now pink).
          .then((answer) => {
            const state = affordState(answer);
            if (state) output.dataset.state = state;
            finish(answer, ANSWER_MS);
          })
          .catch(() => finish("Couldn't work it out. Open Money → Can I afford it?"));
        return;
      }
      // `? query`: the search is stored like any capture, then Notes opens on it.
      if (parsed.kind === "search" && !editing) {
        void invoke("open_notes", { query: parsed.query }).finally(() => void close());
        return;
      }
      // `away till mon` (plan §3.11): Rust stores the return day, logged under
      // this capture, so undoing or fixing the capture undoes away too.
      if (parsed.kind === "away") {
        void invoke<string>("set_away", { until: parsed.until ?? null, rawId })
          .then((date) => finish(fixed + echoLine({ kind: "away", until: date }, nowMs)))
          .catch(() => finish("Couldn't set away. Try again."));
        return;
      }
      finish(fixed + echoLine(parsed, nowMs, idea, savingGoal));
    })
    .catch((error: unknown) => {
      busy = false;
      input.disabled = false;
      output.textContent = typeof error === "string" ? error : "Couldn't save. Try again.";
      input.focus();
    });
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    void close();
    return;
  }
  if (event.key === "Tab") {
    event.preventDefault();
    if (options.length > 1) {
      picked = (picked + (event.shiftKey ? options.length - 1 : 1)) % options.length;
      showChip();
    }
    return;
  }
  if (input.value !== "") return;
  // One action at a time: a held key or a second press doesn't run it again.
  if (event.repeat || busy) {
    if (event.key === "ArrowUp" || (event.key.toLowerCase() === "z" && event.ctrlKey))
      event.preventDefault();
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    busy = true;
    void query<{ id: number; body: string }>(LAST_CAPTURE_SQL).then(([last]) => {
      busy = false;
      // Typed something while we were looking it up: keep what was typed.
      if (input.value !== "") return;
      if (!last) {
        output.textContent = "Nothing to fix yet";
        return;
      }
      // Start on what the capture made (an idea stays an idea), and leave a
      // project you have changed since alone (r2-7).
      void query<MadeRow>(CAPTURE_MADE_SQL, [`capture:${last.id}`])
        .catch(() => [] as MadeRow[])
        .then((made) => {
          if (input.value !== "") return;
          const blocked = fixBlocked(made);
          if (blocked) {
            output.textContent = blocked;
            return;
          }
          editing = last;
          fixKind = madeKind(made);
          input.value = last.body;
          refresh();
          input.setSelectionRange(input.value.length, input.value.length);
        });
    });
    return;
  }
  if (event.key.toLowerCase() === "z" && event.ctrlKey) {
    event.preventDefault();
    busy = true;
    input.disabled = true;
    const release = () => {
      busy = false;
      input.disabled = false;
      input.focus();
    };
    void query<{ id: number; body: string }>(LAST_CAPTURE_SQL)
      .then(([last]) => {
        if (!last) {
          output.textContent = "Nothing to undo";
          release();
          return;
        }
        // Stays busy after a successful undo, until the box closes.
        return undoCapture(last.id).then(() => finish(`Undone: ${last.body}`));
      })
      .catch(() => {
        output.textContent = "Couldn't undo. Try again.";
        release();
      });
  }
});
