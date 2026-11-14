// The desktop mini widget (plan §3.16). Plain TypeScript, like the capture
// box, to keep the one webview it costs small. Read-only: it shows today's
// plan and the timer, and Open brings up the main window.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import "../theme/tokens.css";
import "./widget.css";
import { systemClock } from "../kernel/clock";
import { query } from "../kernel/db";
import { type BlockRow, TODAY_BLOCKS_SQL } from "../features/plan/now";
import { todayParams, todayTopSql } from "../features/tasks/today";
import { applyAccent, applyTheme, cachedAccent, cachedTheme } from "../theme/theme";
import { NOTE_SQL, timerSummary, type WidgetFocus, widgetView } from "./view";

applyTheme(cachedTheme());
applyAccent(cachedAccent());

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;
const now = $("widget-now");
const timer = $("widget-timer");
const ring = document.getElementById("widget-ring") as SVGCircleElement | null;
const clockText = $("widget-clock");
const label = $("widget-label");
const top = $<HTMLOListElement>("widget-top");
const note = $("widget-note");
const noteTitle = $("widget-note-title");
const noteLines = $<HTMLUListElement>("widget-note-lines");
const RING = 2 * Math.PI * 19;

let blocks: BlockRow[] = [];
let tasks: { title: string; status: string }[] = [];
let pinned: { title: string | null; body: string } | null = null;
let focus: WidgetFocus | null = null;
let focusAt = 0;

function draw(): void {
  const nowMs = systemClock.now();
  const counting = focus && focus.kind !== null && !focus.paused;
  const shown =
    focus && counting
      ? { ...focus, remaining_ms: Math.max(0, focus.remaining_ms - (performance.now() - focusAt)) }
      : focus;
  const view = widgetView({ blocks, top: tasks, focus: shown, note: pinned, nowMs });
  if (now) now.textContent = view.now;
  if (timer) {
    timer.hidden = view.timer === null;
    timer.classList.toggle("paused", view.timer?.paused === true);
    timer.setAttribute("aria-label", timerSummary(view));
  }
  if (view.timer) {
    if (clockText) clockText.textContent = view.timer.clock;
    if (label)
      label.textContent = view.timer.paused ? `${view.timer.label} · paused` : view.timer.label;
    if (ring) {
      ring.style.strokeDasharray = String(RING);
      ring.style.strokeDashoffset = String(RING * (1 - view.timer.fraction));
    }
  }
  drawLists(view);
}

/** Lists are rebuilt only when they change, so a screen reader keeps its place. */
let lastLists = "";
function drawLists(view: ReturnType<typeof widgetView>): void {
  const key = JSON.stringify([view.top, view.note]);
  if (key === lastLists) return;
  lastLists = key;
  if (top) {
    top.replaceChildren(
      ...(view.top.length
        ? view.top.map((task) => {
            const item = document.createElement("li");
            item.textContent = task.title;
            if (task.done) {
              item.className = "done";
              const done = document.createElement("span");
              done.className = "visually-hidden";
              done.textContent = ", done";
              item.append(done);
            }
            return item;
          })
        : [
            Object.assign(document.createElement("li"), {
              className: "empty",
              textContent: "No top 3 yet",
            }),
          ]),
    );
  }
  if (note) note.hidden = view.note === null;
  if (view.note) {
    if (noteTitle) noteTitle.textContent = view.note.title;
    noteLines?.replaceChildren(
      ...view.note.lines.map((line) =>
        Object.assign(document.createElement("li"), { textContent: line }),
      ),
    );
  }
}

async function loadData(): Promise<void> {
  const [date, dayStart] = todayParams(systemClock.now());
  const [rows, top3, notes] = await Promise.all([
    query<BlockRow & Record<string, string | number | null>>(TODAY_BLOCKS_SQL, [date]),
    query<{ title: string; status: string }>(todayTopSql, [date, dayStart]),
    query<{ title: string | null; body: string }>(NOTE_SQL),
  ]);
  blocks = rows;
  tasks = top3;
  pinned = notes[0] ?? null;
  draw();
}

async function loadFocus(): Promise<void> {
  focus = await invoke<WidgetFocus>("focus_status");
  focusAt = performance.now();
  draw();
}

const quietly = (work: () => Promise<void>) => () => void work().catch(() => undefined);

$("widget-open")?.addEventListener("click", () => void invoke("open_main"));
void listen("data-changed", quietly(loadData));
void listen("focus-changed", quietly(loadFocus));
void listen("focus-tick", quietly(loadFocus));
// The theme or accent changed in the main window.
window.addEventListener("storage", () => {
  applyTheme(cachedTheme());
  applyAccent(cachedAccent());
});
quietly(loadData)();
quietly(loadFocus)();
// The clock each second; Now and the day (after 03:00) each minute.
setInterval(draw, 1000);
setInterval(quietly(loadData), 60_000);
