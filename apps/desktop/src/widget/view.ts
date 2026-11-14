/**
 * The desktop mini widget (plan §3.16; R-WID-01): Now, the timer and the
 * top 3, with one pinned cheat sheet if you chose one. Pure: main.ts feeds
 * it rows and draws what it returns.
 */
import { type BlockRow, firstStep, nowAndNext } from "../features/plan/now";

export interface WidgetFocus {
  kind: "focus" | "break" | "long_break" | null;
  title: string;
  remaining_ms: number;
  planned_min: number;
  paused: boolean;
}

export interface WidgetView {
  /** "Now · Job hunt: CV" or "Next 14:00 · Gym", or nothing planned. */
  now: string;
  timer: { label: string; clock: string; fraction: number; paused: boolean } | null;
  top: { title: string; done: boolean }[];
  note: { title: string; lines: string[] } | null;
}

export const WIDGET_NOTE_KEY = "widget.note";
export const WIDGET_ENABLED_KEY = "widget.enabled";
export const WIDGET_SQL = `SELECT key, value_json FROM core_settings
  WHERE key IN ('${WIDGET_ENABLED_KEY}', '${WIDGET_NOTE_KEY}')`;
export const NOTE_LINES = 6;

/** The pinned cheat sheet, if it still exists. */
export const NOTE_SQL = `SELECT n.title, n.body FROM note_items AS n
  JOIN core_settings AS s ON s.key = '${WIDGET_NOTE_KEY}' AND s.value_json = json_quote(n.id)
  WHERE n.kind = 'cheat' AND n.deleted_at IS NULL`;

/** Cheat sheets to pick from in Settings. */
export const CHEATS_SQL = `SELECT id, title FROM note_items
  WHERE kind = 'cheat' AND deleted_at IS NULL AND status != 'archived' ORDER BY title`;

const clockFmt = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Africa/Addis_Ababa",
});

export function clock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function widgetView(input: {
  blocks: BlockRow[];
  top: { title: string; status: string }[];
  focus: WidgetFocus | null;
  note: { title: string | null; body: string } | null;
  nowMs: number;
}): WidgetView {
  const live = input.blocks.filter((block) => block.status !== "skipped");
  const { now, next } = nowAndNext(live, input.nowMs);
  let line = "Nothing planned right now";
  if (now) line = `Now · ${firstStep(now)}`;
  else if (next) line = `Next ${clockFmt.format(next.start_at)} · ${firstStep(next)}`;

  const focus = input.focus;
  const timer =
    focus && focus.kind !== null
      ? {
          label:
            focus.kind === "focus"
              ? focus.title || "Focus"
              : focus.kind === "long_break"
                ? "Long break"
                : "Break",
          clock: clock(focus.remaining_ms),
          fraction:
            focus.planned_min > 0
              ? Math.min(1, Math.max(0, focus.remaining_ms / (focus.planned_min * 60000)))
              : 0,
          paused: focus.paused,
        }
      : null;

  const note = input.note
    ? {
        title: input.note.title ?? "Cheat sheet",
        lines: input.note.body
          .split(/\r?\n/)
          .map((text) => text.trim())
          .filter(Boolean)
          .slice(0, NOTE_LINES),
      }
    : null;

  return {
    now: line,
    timer,
    top: input.top.slice(0, 3).map((task) => ({ title: task.title, done: task.status === "done" })),
    note,
  };
}

/** The timer in words, for screen readers. */
export function timerSummary(view: WidgetView): string {
  if (!view.timer) return "";
  return `${view.timer.label}, ${view.timer.clock} left${view.timer.paused ? ", paused" : ""}`;
}
