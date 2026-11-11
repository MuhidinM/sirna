/** Pure helpers for the focus set-up sheet, so they can be tested. */

export interface Kit {
  open: string[];
  minimize: string[];
  checklist: string[];
}

export interface SetupInfo {
  title: string;
  minutes: number;
  kit: Kit;
  /** Do not disturb is switched on automatically (T-029). */
  dnd: boolean;
}

/** "Opens VS Code folder · Minimizes Telegram" — what Enter will do. */
export function actionsLine(kit: Kit, dnd = false): string {
  const parts: string[] = [];
  if (dnd) parts.push("Do not disturb on");
  if (kit.open.length > 0) parts.push(`Opens ${kit.open.map(shortName).join(", ")}`);
  if (kit.minimize.length > 0)
    parts.push(`Minimizes ${kit.minimize.map((name) => name.replace(/\.exe$/i, "")).join(", ")}`);
  return parts.join(" · ");
}

/** The last part of a path or URL, kept short. */
export function shortName(entry: string): string {
  const trimmed = entry.trim().replace(/[\\/]+$/, "");
  const url = /^https?:\/\/([^/]+)/i.exec(trimmed);
  if (url?.[1]) return url[1].replace(/^www\./, "");
  const last = trimmed.split(/[\\/]/).pop() ?? trimmed;
  return last.length > 32 ? `${last.slice(0, 31)}…` : last;
}

/** The checklist to show: the manual Do not disturb tick goes when Sirna does it. */
export function visibleChecklist(kit: Kit, dnd: boolean): string[] {
  return dnd ? kit.checklist.filter((item) => !/do not disturb/i.test(item)) : kit.checklist;
}

/** The second-tap question for a start that needs one; undefined otherwise. */
export function confirmText(result: string): string | undefined {
  if (result === "confirm") return "You're on a long break. Enter again to start anyway.";
  if (result === "confirm-stop") return "It's past your hard stop. Enter again to start anyway.";
  return undefined;
}
