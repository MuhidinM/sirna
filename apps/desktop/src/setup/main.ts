// The focus set-up sheet (plan §3.6a). Plain TypeScript, like the capture box,
// so it opens fast. Everything is pre-filled from the area's kit: a normal
// start is one key (Enter). Ticks never block the start.
import { invoke } from "@tauri-apps/api/core";

import "@fontsource-variable/bricolage-grotesque";
import { systemClock } from "../kernel/clock";
import "../theme/tokens.css";
import "./setup.css";
import {
  actionsLine,
  choices,
  confirmText,
  defaultChoice,
  enterStarts,
  OTHER,
  type SetupInfo,
  startProblem,
  type Target,
  targetOf,
  visibleChecklist,
} from "./sheet";

// In a plain browser during development, stand in for Tauri before this page
// calls it (src/dev/tauriPreview.ts). Removed from production builds.
if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window))
  await import("../dev/tauriPreview").then((preview) => preview.install());

const form = document.querySelector<HTMLFormElement>("#setup");
const title = document.querySelector<HTMLElement>("#setup-title");
const minutes = document.querySelector<HTMLElement>("#setup-minutes");
const intent = document.querySelector<HTMLInputElement>("#setup-intent");
const forWhat = document.querySelector<HTMLSelectElement>("#setup-for");
const other = document.querySelector<HTMLInputElement>("#setup-other");
const checklist = document.querySelector<HTMLUListElement>("#setup-checklist");
const actions = document.querySelector<HTMLElement>("#setup-actions");
const notes = document.querySelector<HTMLUListElement>("#setup-notes");
const message = document.querySelector<HTMLElement>("#setup-message");

const close = () => invoke("close_window");
let force = false;
let busy = false;
/** The "For" choice; undefined until the list is filled (then Rust uses the block it opened for). */
let chosen: string | undefined;

const loadInfo = (target?: Target) => invoke<SetupInfo>("setup_info", { target: target ?? null });

/** Fills the "For" list once and picks the default: the block asked for, the block now, or Just focus. */
function fillChoices(info: SetupInfo): string {
  const now = systemClock.now();
  const value = defaultChoice(info, now);
  if (!forWhat) return value;
  const groups = new Map<string, HTMLOptGroupElement>();
  forWhat.replaceChildren();
  for (const choice of choices(info, now)) {
    const option = new Option(choice.label, choice.value);
    if (choice.group) {
      let group = groups.get(choice.group);
      if (!group) {
        group = document.createElement("optgroup");
        group.label = choice.group;
        groups.set(choice.group, group);
        forWhat.append(group);
      }
      group.append(option);
    } else {
      forWhat.append(option);
    }
  }
  forWhat.value = value;
  return value;
}

/** A new "For" choice: the title, minutes, kit and notes follow it. */
async function choose(value: string) {
  chosen = value;
  force = false;
  if (message) message.textContent = "";
  const isOther = value === OTHER;
  if (other) other.hidden = !isOther;
  try {
    const info = await loadInfo(targetOf(value, other?.value));
    if (chosen !== value) return; // a newer choice won
    render(info);
    if (isOther && title) title.textContent = other?.value.trim() || "Other";
  } catch (error) {
    if (message) message.textContent = `Couldn't load the kit: ${String(error)}`;
  }
  if (isOther) other?.focus();
}

function render(info: SetupInfo) {
  if (title) title.textContent = info.title;
  if (minutes) minutes.textContent = `${info.minutes} min`;
  if (checklist) {
    checklist.replaceChildren(
      ...visibleChecklist(info.kit, info.dnd).map((text, index) => {
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
  if (notes) {
    // Plain text on purpose: the sheet stays small (the Notes page renders Markdown).
    notes.replaceChildren(
      ...info.notes.map((line) => {
        const item = document.createElement("li");
        item.textContent = line;
        return item;
      }),
    );
  }
  if (actions) actions.textContent = actionsLine(info.kit, info.dnd);
}

async function start() {
  if (busy) return;
  const problem = chosen ? startProblem(chosen, other?.value ?? "") : undefined;
  if (problem) {
    if (message) message.textContent = problem;
    other?.focus();
    return;
  }
  busy = true;
  try {
    const result = await invoke<string>("setup_start", {
      intent: intent?.value ?? "",
      force,
      target: chosen ? targetOf(chosen, other?.value) : null,
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

forWhat?.addEventListener("change", () => void choose(forWhat.value));

// Enter on the closed For list starts too (a select never submits the form).
forWhat?.addEventListener("keydown", (event) => {
  if (!enterStarts(event)) return;
  event.preventDefault();
  void start();
});

other?.addEventListener("input", () => {
  if (title) title.textContent = other.value.trim() || "Other";
  if (message) message.textContent = "";
});

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

void loadInfo()
  .then(async (info) => {
    render(info);
    const value = fillChoices(info);
    // Opened with no block while one runs now: that block is the default.
    if (value !== (info.block_id ? `block:${info.block_id}` : undefined)) await choose(value);
    else chosen = value;
  })
  .catch((error: unknown) => {
    if (message) message.textContent = `Couldn't load the kit: ${String(error)}`;
  })
  .finally(() => {
    // Moves keyboard focus into the page (see capture_ready in commands.rs).
    void invoke("capture_ready").then(() => intent?.focus());
  });
