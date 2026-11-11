// The capture box runs without React so it opens fast and stays small (plan §4.3).
//
// Keys: Enter saves · Tab changes what it is saved as · Up arrow (empty box)
// brings back the last capture to fix · Ctrl+Z (empty box) undoes it · Escape closes.
import { invoke } from "@tauri-apps/api/core";

import { systemClock } from "../kernel/clock";
import { commitCapture, query, undoCapture } from "../kernel/db";
import { ulid } from "../kernel/ulid";
import { readings } from "./alternatives";
import { echo as echoLine, toOps } from "./ops";
import { type Parsed, parseCapture, PARSER_ID } from "./parse";
import { type ClockStyle } from "./when";

import "./capture.css";

const ECHO_MS = 1500;
const LAST_CAPTURE_SQL =
  "SELECT id, body FROM core_raw_items WHERE source = 'capture' AND parse_status != 'ignored' ORDER BY id DESC LIMIT 1";

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

function showChip() {
  const current = options[picked];
  if (!current) {
    output.textContent = editing ? "Fixing your last capture" : "";
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
  const ops = toOps(parsed, { nowMs, newId: () => ulid() });
  const parser = picked === 0 ? PARSER_ID : `${PARSER_ID}+tab`;
  input.disabled = true;
  const replaced = editing ? undoCapture(editing.id) : Promise.resolve(0);
  replaced
    .then(() => commitCapture(rawText, ops, parser))
    .then(() => finish((editing ? "Fixed · " : "") + echoLine(parsed, nowMs)))
    .catch((error: unknown) => {
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
  if (event.key === "ArrowUp") {
    event.preventDefault();
    void query<{ id: number; body: string }>(LAST_CAPTURE_SQL).then(([last]) => {
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
    void query<{ id: number; body: string }>(LAST_CAPTURE_SQL).then(([last]) => {
      if (!last) {
        output.textContent = "Nothing to undo";
        return;
      }
      void undoCapture(last.id).then(() => finish(`Undone: ${last.body}`));
    });
  }
});
