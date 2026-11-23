/** Pure helpers for the focus set-up sheet, so they can be tested. */
import { HOME_TIME_ZONE } from "../kernel/dates";

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
  /** The area's cheat sheet lines (T-031). */
  notes: string[];
  /** The block the sheet was opened for, if any. */
  block_id: string | null;
  /** Today's blocks and the active areas: what else the session can be for. */
  blocks: SheetBlock[];
  areas: SheetArea[];
}

export interface SheetBlock {
  id: string;
  title: string;
  start_at: number;
  end_at: number;
  kind: string;
  area_id: string | null;
}

export interface SheetArea {
  id: string;
  name: string;
}

/** What the session is for, as Rust's `SetupTarget` takes it. */
export interface Target {
  blockId?: string;
  areaId?: string;
  other?: string;
}

/** One option in the "For" list. `value` is "block:<id>", "area:<id>", "plain" or "other". */
export interface Choice {
  value: string;
  label: string;
  group: "Today" | "Areas" | "";
}

export const OTHER = "other";
export const PLAIN = "plain";

const clockTime = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: HOME_TIME_ZONE,
});

/** "09:00–10:30 · Job hunt", with "now" on the running block. */
export function blockLabel(block: SheetBlock, nowMs: number): string {
  const when = `${clockTime.format(block.start_at)}–${clockTime.format(block.end_at)}`;
  const running = block.start_at <= nowMs && nowMs < block.end_at;
  return `${running ? "Now" : when} · ${block.title}`;
}

/**
 * The "For" list (spec §1 rule 7): today's blocks, the areas, "Just focus"
 * (a plain session) and "Other…". The block the sheet was opened for stays
 * in the list even when it isn't today's.
 */
export function choices(info: SetupInfo, nowMs: number): Choice[] {
  const list: Choice[] = [];
  if (info.block_id && !info.blocks.some((block) => block.id === info.block_id)) {
    list.push({ value: `block:${info.block_id}`, label: info.title, group: "Today" });
  }
  for (const block of info.blocks) {
    list.push({ value: `block:${block.id}`, label: blockLabel(block, nowMs), group: "Today" });
  }
  for (const area of info.areas) {
    list.push({ value: `area:${area.id}`, label: area.name, group: "Areas" });
  }
  list.push({ value: PLAIN, label: "Just focus", group: "" });
  list.push({ value: OTHER, label: "Other…", group: "" });
  return list;
}

/** The block running at `nowMs` (the latest-starting one when they overlap). */
export function runningBlock(blocks: SheetBlock[], nowMs: number): SheetBlock | undefined {
  return blocks
    .filter((block) => block.start_at <= nowMs && nowMs < block.end_at)
    .sort((a, b) => b.start_at - a.start_at)[0];
}

/** The default choice: the block asked for, else the block now, else "Just focus". */
export function defaultChoice(info: SetupInfo, nowMs: number): string {
  if (info.block_id) return `block:${info.block_id}`;
  const now = runningBlock(info.blocks, nowMs);
  return now ? `block:${now.id}` : PLAIN;
}

/** The target to send for a choice; `other` is the typed name for "Other…". */
export function targetOf(value: string, other = ""): Target {
  if (value === OTHER) return { other: other.trim() };
  if (value.startsWith("block:")) return { blockId: value.slice("block:".length) };
  if (value.startsWith("area:")) return { areaId: value.slice("area:".length) };
  return {};
}

/** Why the sheet can't start yet, or undefined when it can. */
export function startProblem(value: string, other: string): string | undefined {
  return value === OTHER && other.trim() === "" ? "Type what this session is for." : undefined;
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
