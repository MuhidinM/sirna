// The capture box runs without React so it opens fast and stays small (plan §4.3).
import { invoke } from "@tauri-apps/api/core";

import { systemClock } from "../kernel/clock";
import { commitCapture, query } from "../kernel/db";
import { ulid } from "../kernel/ulid";
import { echo as echoLine, toOps } from "./ops";
import { parseCapture, PARSER_ID } from "./parse";
import { type ClockStyle } from "./when";

import "./capture.css";

const ECHO_MS = 1500;

const form = document.querySelector<HTMLFormElement>("#capture");
const input = document.querySelector<HTMLInputElement>("#capture-input");
const output = document.querySelector<HTMLOutputElement>("#capture-echo");

if (!form || !input || !output) throw new Error("Capture markup is missing");

let clockStyle: ClockStyle = "western";

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

// The live chip: what Enter will save, as you type.
input.addEventListener("input", () => {
  const text = input.value.trim();
  output.textContent = text
    ? echoLine(parseCapture(text, { nowMs: systemClock.now(), clockStyle }), systemClock.now())
    : "";
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const rawText = input.value;
  if (rawText.trim() === "") {
    void close();
    return;
  }
  const nowMs = systemClock.now();
  const parsed = parseCapture(rawText, { nowMs, clockStyle });
  const ops = toOps(parsed, { nowMs, newId: () => ulid() });
  input.disabled = true;
  commitCapture(rawText, ops, PARSER_ID)
    .then(() => {
      output.textContent = echoLine(parsed, nowMs);
      setTimeout(() => void close(), ECHO_MS);
    })
    .catch((error: unknown) => {
      input.disabled = false;
      output.textContent = typeof error === "string" ? error : "Couldn't save. Try again.";
      input.focus();
    });
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") void close();
});
