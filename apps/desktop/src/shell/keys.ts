/**
 * Keyboard helpers shared by the shell: Escape to cancel an inline form, arrow
 * keys across a tab strip, and arrow keys across the month grid (one Tab stop,
 * not thirty).
 */
import { type KeyboardEvent } from "react";

/**
 * `onKeyDown` for an inline form with a Cancel button: Escape cancels it.
 * Keydown bubbles, so one handler on the form covers every field in it.
 */
export function cancelOnEscape(cancel: () => void) {
  return (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    cancel();
  };
}

/** The tab an arrow key moves to (wrapping), or null for any other key. */
export function nextTab(index: number, count: number, key: string): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return (index + 1) % count;
    case "ArrowLeft":
    case "ArrowUp":
      return (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

const DAY_MS = 86_400_000;
const shift = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const monthEnd = (date: string) => {
  const [y = 1970, m = 1] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

/**
 * The day a key moves to in the month grid: arrows by a day or a week,
 * Home/End to the start/end of the week (Monday first), PageUp/PageDown by a
 * month (the same day, or the month's last). Null for any other key.
 */
export function nextDay(date: string, key: string): string | null {
  const weekday = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7; // 0 = Monday
  switch (key) {
    case "ArrowRight":
      return shift(date, 1);
    case "ArrowLeft":
      return shift(date, -1);
    case "ArrowDown":
      return shift(date, 7);
    case "ArrowUp":
      return shift(date, -7);
    case "Home":
      return shift(date, -weekday);
    case "End":
      return shift(date, 6 - weekday);
    case "PageUp":
    case "PageDown": {
      const [y = 1970, m = 1, d = 1] = date.split("-").map(Number);
      const first = new Date(Date.UTC(y, m - 1 + (key === "PageUp" ? -1 : 1), 1))
        .toISOString()
        .slice(0, 10);
      const last = monthEnd(first);
      const day = `${first.slice(0, 8)}${String(d).padStart(2, "0")}`;
      return day > last ? last : day;
    }
    default:
      return null;
  }
}
