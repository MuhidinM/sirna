// The capture box runs without React so it opens fast and stays small (plan §4.3).
//
// Keys: Enter saves · Tab changes what it is saved as · Up arrow (empty box)
// brings back the last capture to fix · Ctrl+Z (empty box) undoes it · Escape closes.
import { invoke } from "@tauri-apps/api/core";

import { systemClock } from "../kernel/clock";
import { commitCapture, query, replaceCapture, undoCapture } from "../kernel/db";
import { ulid } from "../kernel/ulid";
import { type Card, CHEAT_SQL, type CheatRow, groupCards, search } from "../features/notes/cheat";
import { readings } from "./alternatives";
import { loadWeek, type Query } from "../features/projects/capacity";
import { placeIdea, type Placement, REPLACED_PROJECTS_SQL } from "../features/projects/idea";
import { logicalDate } from "../kernel/dates";
import { echo as echoLine, ideaInput, toOps } from "./ops";
import { type Parsed, parseCapture, PARSER_ID } from "./parse";
import { type ClockStyle } from "./when";

import { applyTheme, cachedTheme } from "../theme/theme";

import "../theme/tokens.css";
import "./capture.css";

applyTheme(cachedTheme());

const ECHO_MS = 1500;
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
/** The other readings of the current text, and which one Tab has picked. */
let options: Parsed[] = [];
let picked = 0;
/** Set while fixing the last capture with Up arrow: saving replaces it. */
let editing: { id: number; body: string } | undefined;
/** True while a save, fix or undo is in flight. */
let busy = false;

const close = () => invoke("close_window");

const ready = () => {
  void invoke("capture_ready").then(() => input.focus());
};

ready();

// "at 3" follows a one-time setting (plan §3.5); western until it is set.
void query<{ value_json: string }>("SELECT value_json FROM core_settings WHERE key = ?", [
  "capture.clock_style",
])
  .then(([row]) => {
    if (row && JSON.parse(row.value_json) === "ethiopian") clockStyle = "ethiopian";
  })
  .catch(() => undefined);

function refresh() {
  const text = input.value.trim();
  const nowMs = systemClock.now();
  options = text ? readings(parseCapture(text, { nowMs, clockStyle }), text, nowMs) : [];
  picked = 0;
  showChip();
}

/** Cheat lines, loaded once per capture box, for `? query` (plan §3.15). */
let cheatCards: Promise<Card[]> | undefined;

function showSearch(text: string) {
  cheatCards ??= query<CheatRow & Record<string, string | null>>(CHEAT_SQL)
    .then(groupCards)
    .catch(() => []);
  void cheatCards.then((cards) => {
    // Typed on meanwhile: a newer refresh owns the chip.
    if (input.value.trim().slice(1).trim() !== text) return;
    const hits = search(cards, text);
    const first = hits[0];
    output.textContent = first
      ? `${first.line.body} · ${first.card.title}${hits.length > 1 ? ` (+${hits.length - 1})` : ""}  ·  Enter: open Notes`
      : "No cheat line matches  ·  Enter: open Notes";
  });
}

function showChip() {
  const current = options[picked];
  if (!current) {
    output.textContent = editing ? "Fixing your last capture" : "";
    return;
  }
  // While fixing, Enter replaces the capture, so the chip keeps saying "Fix →".
  if (current.kind === "search" && current.query !== "" && !editing) {
    showSearch(current.query);
    return;
  }
  const hint = options.length > 1 ? "  ·  Tab: change" : "";
  output.textContent = `${editing ? "Fix → " : ""}${echoLine(current, systemClock.now())}${hint}`;
}

function finish(message: string) {
  output.textContent = message;
  setTimeout(() => void close(), ECHO_MS);
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
  const parsed = options[picked] ?? parseCapture(rawText, { nowMs, clockStyle });
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
  // A fix undoes the old capture and saves the new one in one transaction.
  const saved = placed.then((placement) => {
    idea = placement;
    const ops = toOps(parsed, {
      nowMs,
      newId: () => ulid(),
      ...(placement ? { idea: placement } : {}),
    });
    return fixing
      ? replaceCapture(fixing.id, rawText, ops, parser)
      : commitCapture(rawText, ops, parser);
  });
  const fixed = editing ? "Fixed · " : "";
  saved
    .then((rawId) => {
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
      finish(fixed + echoLine(parsed, nowMs, idea));
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
      editing = last;
      input.value = last.body;
      refresh();
      input.setSelectionRange(input.value.length, input.value.length);
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
