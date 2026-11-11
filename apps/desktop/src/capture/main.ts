// The capture box runs without React so it opens fast and stays under 50 KB of JS (plan §4.3).
import { invoke } from "@tauri-apps/api/core";

import "./capture.css";

const ECHO_MS = 1500;

const form = document.querySelector<HTMLFormElement>("#capture");
const input = document.querySelector<HTMLInputElement>("#capture-input");
const echo = document.querySelector<HTMLOutputElement>("#capture-echo");

if (!form || !input || !echo) throw new Error("Capture markup is missing");

const close = () => invoke("close_window");

const ready = () => {
  void invoke("capture_ready").then(() => input.focus());
};

ready();

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const rawText = input.value;
  if (rawText.trim() === "") {
    void close();
    return;
  }
  input.disabled = true;
  invoke<number>("capture_commit", { rawText })
    .then(() => {
      echo.textContent = "Saved";
      setTimeout(() => void close(), ECHO_MS);
    })
    .catch((error: unknown) => {
      input.disabled = false;
      echo.textContent = typeof error === "string" ? error : "Couldn't save. Try again.";
      input.focus();
    });
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") void close();
});
