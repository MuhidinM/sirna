/**
 * Editing the weekly routine and the life areas by hand (plan §3.2). Setup
 * builds a first routine from a few answers; from then on every block and
 * area is yours to add, change or remove. Pure and tested; the page only
 * writes the ops these functions return.
 */
import { type Op } from "../../kernel/db";
import { toHhmm, toMinutes, type Weekday } from "./routine";

export type BlockKind = "fixed" | "routine" | "area" | "rest";

export const BLOCK_KINDS: { kind: BlockKind; label: string; help: string }[] = [
  { kind: "fixed", label: "Fixed", help: "A job, a class: happens no matter what" },
  { kind: "routine", label: "Habit", help: "Gym, Quran, a walk: kept, never dropped for work" },
  {
    kind: "area",
    label: "Free slot",
    help: "Sirna fills it with the area most behind and its tasks",
  },
  { kind: "rest", label: "Rest", help: "A rest day or time off: nothing gets planned" },
];

export interface RoutineRow {
  id: string;
  weekday: number;
  start_min: number;
  duration_min: number;
  kind: BlockKind;
  area_id: string | null;
  title: string;
}

export const ROUTINE_SQL = `SELECT id, weekday, start_min, duration_min, kind, area_id, title
  FROM routine_blocks WHERE deleted_at IS NULL AND active = 1 ORDER BY weekday, start_min`;

export interface BlockDraft {
  title: string;
  kind: BlockKind;
  areaId: string;
  start: string; // "17:30"
  end: string; // "18:15"
  days: Weekday[];
}

export function draftOf(row: RoutineRow, days: Weekday[] = [row.weekday as Weekday]): BlockDraft {
  return {
    title: row.title,
    kind: row.kind,
    areaId: row.area_id ?? "",
    start: toHhmm(row.start_min),
    end: toHhmm(row.start_min + row.duration_min),
    days,
  };
}

const minutesOf = (text: string): number | null => {
  try {
    return toMinutes(text);
  } catch {
    return null;
  }
};

/** An error to show, or null. Blocks end by midnight. */
export function checkBlock(draft: BlockDraft): string | null {
  if (!draft.title.trim() && draft.kind !== "area") return "Give the block a name.";
  if (draft.days.length === 0) return "Pick at least one day.";
  const start = minutesOf(draft.start);
  const end = draft.end === "24:00" || draft.end === "00:00" ? 24 * 60 : minutesOf(draft.end);
  if (start === null || end === null) return "Times look like 07:30.";
  if (end <= start) return "It has to end after it starts (and by midnight).";
  if (end - start < 5) return "At least 5 minutes.";
  if ((draft.kind === "fixed" || draft.kind === "routine") && !draft.areaId)
    return "Pick the area it belongs to.";
  return null;
}

function values(draft: BlockDraft, weekday: Weekday) {
  const start = toMinutes(draft.start);
  const end = draft.end === "24:00" || draft.end === "00:00" ? 24 * 60 : toMinutes(draft.end);
  return {
    weekday,
    start_min: start,
    duration_min: end - start,
    kind: draft.kind,
    area_id: draft.kind === "rest" ? null : draft.areaId || null,
    title: draft.title.trim() || (draft.kind === "area" ? "Focus block" : "Block"),
  };
}

/** The same block on other days: same name, kind, area and times. */
export function seriesOf(rows: RoutineRow[], row: RoutineRow): RoutineRow[] {
  return rows.filter(
    (other) =>
      other.title === row.title &&
      other.kind === row.kind &&
      other.area_id === row.area_id &&
      other.start_min === row.start_min &&
      other.duration_min === row.duration_min,
  );
}

export function addBlockOps(draft: BlockDraft, newId: () => string): Op[] {
  return draft.days.map((day) => ({
    op: "insert" as const,
    table: "routine_blocks" as const,
    id: newId(),
    values: values(draft, day),
  }));
}

/**
 * Saves an edit. "series": every day that had the same block takes the new
 * values, days dropped from the draft lose it and days added gain it.
 * "day": only this row changes (its day can move).
 */
export function updateBlockOps(
  rows: RoutineRow[],
  target: RoutineRow,
  draft: BlockDraft,
  scope: "day" | "series",
  newId: () => string,
): Op[] {
  if (scope === "day") {
    const [day] = draft.days;
    if (day === undefined) return [];
    return [{ op: "update", table: "routine_blocks", id: target.id, values: values(draft, day) }];
  }
  const series = seriesOf(rows, target);
  const ops: Op[] = [];
  for (const row of series) {
    const day = row.weekday as Weekday;
    if (draft.days.includes(day))
      ops.push({ op: "update", table: "routine_blocks", id: row.id, values: values(draft, day) });
    else ops.push({ op: "delete", table: "routine_blocks", id: row.id });
  }
  const had = new Set(series.map((row) => row.weekday));
  for (const day of draft.days)
    if (!had.has(day))
      ops.push({ op: "insert", table: "routine_blocks", id: newId(), values: values(draft, day) });
  return ops;
}

export function removeBlockOps(
  rows: RoutineRow[],
  target: RoutineRow,
  scope: "day" | "series",
): Op[] {
  const gone = scope === "day" ? [target] : seriesOf(rows, target);
  return gone.map((row) => ({ op: "delete", table: "routine_blocks", id: row.id }));
}

/**
 * Another block on the same day with the same name and start: the day plan
 * can't hold both (one block per name and start), so this is refused.
 */
export function duplicateOf(
  rows: RoutineRow[],
  draft: BlockDraft,
  days: number[],
  ignore: Set<string> = new Set(),
): RoutineRow | null {
  if (checkBlock({ ...draft, days: days as Weekday[] })) return null;
  const title = (
    draft.title.trim() || (draft.kind === "area" ? "Focus block" : "Block")
  ).toLowerCase();
  const start = toMinutes(draft.start);
  return (
    rows.find(
      (row) =>
        days.includes(row.weekday) &&
        !ignore.has(row.id) &&
        row.start_min === start &&
        row.title.trim().toLowerCase() === title,
    ) ?? null
  );
}

/** Blocks on a day that would share time with the draft (other than the ones being edited). */
export function clashes(
  rows: RoutineRow[],
  draft: BlockDraft,
  weekday: number,
  ignore: Set<string> = new Set(),
): RoutineRow[] {
  if (checkBlock(draft)) return [];
  const { start_min: start, duration_min: duration } = values(draft, weekday as Weekday);
  return rows.filter(
    (row) =>
      row.weekday === weekday &&
      !ignore.has(row.id) &&
      // A rest day spans the day on purpose; habits like Quran still happen on it.
      row.kind !== "rest" &&
      draft.kind !== "rest" &&
      row.start_min < start + duration &&
      start < row.start_min + row.duration_min,
  );
}

// --- Areas --------------------------------------------------------------------

export type AreaKind = "work" | "growth" | "health" | "faith" | "admin";

export const AREA_KINDS: { kind: AreaKind; label: string; help: string }[] = [
  { kind: "work", label: "Job", help: "Paid work in fixed hours; Sirna plans around it" },
  {
    kind: "growth",
    label: "Grow",
    help: "Skills and side work; fills free slots by its weekly hours",
  },
  {
    kind: "admin",
    label: "Admin",
    help: "Errands and email; fills free slots by its weekly hours",
  },
  { kind: "health", label: "Health", help: "Kept by its habit blocks" },
  { kind: "faith", label: "Faith", help: "Kept by its habit blocks" },
];

export const AREA_COLORS = ["work", "jobhunt", "coding", "experiments", "gym", "quran", "admin"];

export interface AreaRow {
  id: string;
  name: string;
  kind: AreaKind;
  color: string;
  weekly_target_min: number;
  capped: number;
  protected: number;
  priority_rank: number;
  active: number;
}

export const AREAS_SQL = `SELECT id, name, kind, color, weekly_target_min, capped, protected,
  priority_rank, active FROM area_items WHERE deleted_at IS NULL ORDER BY active DESC, priority_rank, name`;

export interface AreaDraft {
  name: string;
  kind: AreaKind;
  color: string;
  weeklyHours: string;
  capped: boolean;
  protected: boolean;
  priority: string;
}

export function areaDraftOf(row: AreaRow): AreaDraft {
  return {
    name: row.name,
    kind: row.kind,
    color: row.color,
    weeklyHours: String(Math.round((row.weekly_target_min / 60) * 100) / 100),
    capped: row.capped === 1,
    protected: row.protected === 1,
    priority: String(row.priority_rank),
  };
}

export const EMPTY_AREA: AreaDraft = {
  name: "",
  kind: "growth",
  color: "coding",
  weeklyHours: "3",
  capped: false,
  protected: false,
  priority: "5",
};

export function checkArea(
  draft: AreaDraft,
  others: AreaRow[],
  selfId: string | null,
): string | null {
  const name = draft.name.trim();
  if (!name) return "Give the area a name.";
  if (
    others.some(
      (area) => area.id !== selfId && area.name.trim().toLowerCase() === name.toLowerCase(),
    )
  )
    return "Another area has that name.";
  const hours = Number(draft.weeklyHours.trim() || "0");
  if (!Number.isFinite(hours) || hours < 0 || hours > 80) return "Hours a week: 0 to 80.";
  const priority = Number(draft.priority);
  if (!Number.isInteger(priority) || priority < 1 || priority > 20)
    return "Priority: 1 (first) to 20.";
  if (!AREA_COLORS.includes(draft.color)) return "Pick a colour.";
  return null;
}

/** A short id from the name ("Job C" → "job-c"), unique among existing ids. */
export function areaId(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "area";
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

function areaValues(draft: AreaDraft) {
  return {
    name: draft.name.trim(),
    kind: draft.kind,
    color: draft.color,
    weekly_target_min: Math.round(Number(draft.weeklyHours.trim() || "0") * 60),
    capped: draft.capped ? 1 : 0,
    protected: draft.protected ? 1 : 0,
    priority_rank: Number(draft.priority),
  };
}

export function addAreaOps(draft: AreaDraft, taken: Iterable<string>): { ops: Op[]; id: string } {
  const id = areaId(draft.name, taken);
  return {
    id,
    ops: [{ op: "insert", table: "area_items", id, values: { ...areaValues(draft), active: 1 } }],
  };
}

export function updateAreaOps(id: string, draft: AreaDraft): Op[] {
  return [{ op: "update", table: "area_items", id, values: areaValues(draft) }];
}

/**
 * Turning an area off keeps its history; its blocks leave the routine (they
 * would plan time for an area you no longer have). Turning it on again
 * doesn't bring them back.
 */
export function setAreaActiveOps(id: string, active: boolean, rows: RoutineRow[]): Op[] {
  const ops: Op[] = [{ op: "update", table: "area_items", id, values: { active: active ? 1 : 0 } }];
  if (!active)
    for (const row of rows.filter((r) => r.area_id === id))
      ops.push({ op: "delete", table: "routine_blocks", id: row.id });
  return ops;
}

// --- After a change -------------------------------------------------------------

export const WEEKDAYS: [Weekday, string][] = [
  [1, "Mon"],
  [2, "Tue"],
  [3, "Wed"],
  [4, "Thu"],
  [5, "Fri"],
  [6, "Sat"],
  [7, "Sun"],
];
