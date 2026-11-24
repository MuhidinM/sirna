/**
 * Keyboard helpers shared by the shell: Escape to cancel an inline form, arrow
 * keys across a tab strip, and arrow keys across the month grid (one Tab stop,
 * not thirty).
 */
import { type KeyboardEvent, useState } from "react";

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

/**
 * Mark a button that opens an inline form and is replaced while the form is
 * open (or unmounted with it): `<Button {...returnsFocus("task-edit:" + id)}>`.
 * After Escape, focus goes to the new button with the same mark.
 */
export const returnsFocus = (key: string) => ({ "data-return-focus": key });

/** What `returnFocus` needs from an element; an `HTMLElement` fits. */
export type FocusTarget = {
  isConnected: boolean;
  focus: () => void;
  getAttribute: (name: string) => string | null;
};

/**
 * Give focus back to the button that opened a form: the same element while it
 * is still on the page, else the one now carrying its `returnsFocus` mark.
 * True when something took focus.
 */
export function returnFocus(
  opener: FocusTarget | null,
  find: (key: string) => FocusTarget | null,
): boolean {
  if (!opener) return false;
  const target = opener.isConnected
    ? opener
    : (() => {
        const key = opener.getAttribute("data-return-focus");
        return key ? find(key) : null;
      })();
  if (!target) return false;
  target.focus();
  return true;
}

function findMarked(key: string): HTMLElement | null {
  for (const element of document.querySelectorAll<HTMLElement>("[data-return-focus]"))
    if (element.getAttribute("data-return-focus") === key) return element;
  return null;
}

/** For a form closed without the hook: focus its `returnsFocus` button once it is back. */
export function refocusSoon(key: string) {
  setTimeout(() => findMarked(key)?.focus(), 0);
}

/**
 * `cancelOnEscape` for a form that opens from a button: after Escape, focus
 * goes back to the button that opened it, not to the top of the page. When
 * that button is replaced while the form is open, give it `returnsFocus`.
 */
export function useEscapeToCancel(cancel: () => void) {
  // Read once, on the form's first render: before any field in it takes focus.
  const [opener] = useState(() =>
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  return cancelOnEscape(() => {
    cancel();
    // After React has put the opener (or its replacement) back on the page.
    setTimeout(() => returnFocus(opener, findMarked), 0);
  });
}

/** The tablist whose arrow key just changed the tab, until a tablist takes it. */
let keyedTablist: string | null = null;

/** An arrow key in this tablist changed the tab. */
export function markKeyedTablist(label: string) {
  keyedTablist = label;
}

/**
 * True once, for the tablist named in the last `markKeyedTablist`: it should
 * focus its selected tab. A tab strip that is part of each page (Plan's) is
 * replaced when the tab changes, so the new strip takes the focus (F94).
 */
export function takeKeyedTablist(label: string): boolean {
  if (keyedTablist !== label) return false;
  keyedTablist = null;
  return true;
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
