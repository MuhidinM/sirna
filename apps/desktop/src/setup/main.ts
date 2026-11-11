// The focus set-up sheet (plan §3.6a). Plain TypeScript, like the capture box,
// so it opens fast. Everything is pre-filled from the area's kit: a normal
// start is one key (Enter). Ticks never block the start.
import { invoke } from "@tauri-apps/api/core";

import "../theme/tokens.css";
import "./setup.css";
import { actionsLine, confirmText, type SetupInfo } from "./sheet";

const form = document.querySelector<HTMLFormElement>("#setup");
const title = document.querySelector<HTMLElement>("#setup-title");
const minutes = document.querySelector<HTMLElement>("#setup-minutes");
const intent = document.querySelector<HTMLInputElement>("#setup-intent");
const checklist = document.querySelector<HTMLUListElement>("#setup-checklist");
const actions = document.querySelector<HTMLElement>("#setup-actions");
const message = document.querySelector<HTMLElement>("#setup-message");

const close = () => invoke("close_window");
let force = false;
let busy = false;

function render(info: SetupInfo) {
  if (title) title.textContent = info.title;
  if (minutes) minutes.textContent = `${info.minutes} min`;
  if (checklist) {
    checklist.replaceChildren(
      ...info.kit.checklist.map((text, index) => {
        const item = document.createElement("li");
        const label = document.createElement("label");
        const box = document.createElement("input");
        box.type = "checkbox";
        box.id = `tick-${index}`;
        label.append(box, ` ${text}`);
        item.append(label);
        return item;
      }),
    );
  }
  if (actions) actions.textContent = actionsLine(info.kit);
}

async function start() {
  if (busy) return;
  busy = true;
  try {
    const result = await invoke<string>("setup_start", {
      intent: intent?.value ?? "",
      force,
    });
    const ask = confirmText(result);
    if (ask) {
      // The second Enter is the deliberate second tap.
      force = true;
      if (message) message.textContent = ask;
    } else if (result === "already") {
      if (message) message.textContent = "A session is already running.";
    }
  } catch (error) {
    if (message) message.textContent = `Couldn't start: ${String(error)}`;
  } finally {
    busy = false;
  }
}

form?.addEventListener("submit", (event) => {
  event.preventDefault();
  void start();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") void close();
  // A held Enter must not become the second tap past the hard stop or a long
  // break: auto-repeats never submit.
  if (event.key === "Enter" && event.repeat) event.preventDefault();
});

void invoke<SetupInfo>("setup_info")
  .then(render)
  .catch((error: unknown) => {
    if (message) message.textContent = `Couldn't load the kit: ${String(error)}`;
  })
  .finally(() => {
    // Moves keyboard focus into the page (see capture_ready in commands.rs).
    void invoke("capture_ready").then(() => intent?.focus());
  });
