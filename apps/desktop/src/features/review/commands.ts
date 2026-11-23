/**
 * Plain commands in the night review's free text (time-first §1 rule 9),
 * read by rules before anything goes to the AI: "move gym to 6pm", "move
 * tomorrow's check email to 9am", "skip quran tomorrow". Each one says what
 * it did and carries the ops that undo it. Pure.
 */
import { type Op, type SqlValue } from "../../kernel/db";
import { showDate } from "../../kernel/dates";
import { localToEpoch } from "../../capture/when";
import { blockBefore, clockOf, DAY_END_MIN, DAY_START_MIN, minuteOf, undoOps } from "../plan/edit";
import { shiftDate } from "../plan/dayplan";

export type Day = "today" | "tomorrow";

export type Command =
  | { kind: "move"; target: string; day: Day | null; minutes: number }
  | { kind: "skip"; target: string; day: Day | null };

const DAY_WORD = "(today|tomorrow|tonight)";
const OWNER = "(?:(today|tomorrow)'?s\\s+)?";
const TIME = "(noon|midnight|\\d{1,2}(?:[:.]\\d{2})?\\s*(?:am|pm|a\\.m\\.|p\\.m\\.)?)";

const MOVE = new RegExp(
  `^(?:please\\s+)?(?:move|put|shift)\\s+${OWNER}(.+?)\\s+(?:to|at)\\s+(?:${DAY_WORD}\\s+)?(?:at\\s+)?${TIME}(?:\\s+${DAY_WORD})?$`,
  "i",
);
const SKIP = new RegExp(`^(?:please\\s+)?(?:skip|drop)\\s+${OWNER}(.+?)(?:\\s+${DAY_WORD})?$`, "i");

const dayOf = (...words: (string | undefined)[]): Day | null => {
  for (const word of words) {
    const w = word?.toLowerCase();
    if (w === "today" || w === "tonight") return "today";
    if (w === "tomorrow") return "tomorrow";
  }
  return null;
};

/**
 * "9am" / "18:00" / "6" → minutes on the logical day. Without am/pm, 1–6 are
 * afternoon and 7–12 morning (as the capture box reads them); before 03:00 is
 * the night after.
 */
export function readTime(text: string): number | null {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/(\d)\.(\d)/g, "$1:$2")
    .replace(/\./g, "");
  if (t === "noon") return 12 * 60;
  if (t === "midnight") return 24 * 60;
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(t);
  if (!match) return null;
  let hour = Number(match[1]);
  const mins = Number(match[2] ?? 0);
  const ampm = match[3];
  if (mins > 59) return null;
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (ampm === "pm" ? 12 : 0);
  } else if (hour > 23) return null;
  else if (hour >= 1 && hour <= 6 && match[2] === undefined) hour += 12;
  let minutes = hour * 60 + mins;
  if (minutes < DAY_START_MIN) minutes += 1440;
  return minutes;
}

/** One line of free text as a command, or null (it goes to the AI as it was). */
export function readCommand(line: string): Command | null {
  const text = line.trim().replace(/[.!]+$/, "");
  const move = MOVE.exec(text);
  if (move) {
    const minutes = readTime(move[4] ?? "");
    const target = clean(move[2] ?? "");
    if (minutes !== null && target) {
      return { kind: "move", target, day: dayOf(move[1], move[3], move[5]), minutes };
    }
  }
  const skip = SKIP.exec(text);
  if (skip) {
    const target = clean(skip[2] ?? "");
    if (target) return { kind: "skip", target, day: dayOf(skip[1], skip[3]) };
  }
  return null;
}

const clean = (target: string) =>
  target
    .trim()
    .replace(/^(?:the|my)\s+/i, "")
    .replace(/\s+(?:block|task)$/i, "")
    .toLowerCase();

export interface CommandBlock {
  id: string;
  start_at: number;
  end_at: number;
  title: string;
  kind: string;
  area_id: string | null;
  task_id: string | null;
  status: string;
  task_title: string | null;
}

export interface CommandTask {
  id: string;
  title: string;
  area_id: string | null;
  planned_date: string | null;
  estimate_min: number | null;
}

/** Open tasks a command can name. */
export const COMMAND_TASKS_SQL = `
  SELECT id, title, area_id, planned_date, estimate_min FROM task_items
  WHERE deleted_at IS NULL AND status = 'todo' ORDER BY created_at`;

export interface CommandContext {
  today: string;
  tomorrow: string;
  blocks: Record<Day, CommandBlock[]>;
  tasks: CommandTask[];
  newId: () => string;
}

export interface CommandResult {
  ops: Op[];
  undo: Op[];
  /** What it did, in a line: "Moved Gym to 18:00 tomorrow." */
  said: string;
}

/** Exact title first, then one that contains the words (or is contained in them). */
function best<T>(items: T[], names: (item: T) => (string | null)[], target: string): T | undefined {
  const lower = (item: T) => names(item).flatMap((n) => (n ? [n.toLowerCase()] : []));
  return (
    items.find((item) => lower(item).some((n) => n === target)) ??
    items.find((item) => lower(item).some((n) => n.includes(target))) ??
    items.find((item) => lower(item).some((n) => n.length >= 3 && target.includes(n)))
  );
}

const dayWord = (day: Day) => (day === "today" ? "today" : "tomorrow");

/**
 * Turns a command into writes. No day given means tomorrow (the review plans
 * tomorrow), then today. A block is matched before a task; a task with no
 * block gets one at that time. Null when nothing matches: the line goes to
 * the AI unchanged.
 */
export function planCommand(command: Command, context: CommandContext): CommandResult | null {
  const days: Day[] = command.day ? [command.day] : ["tomorrow", "today"];
  for (const day of days) {
    const date = day === "today" ? context.today : context.tomorrow;
    const blocks = context.blocks[day].filter((block) => block.kind !== "rest");
    const block = best(blocks, (b) => [b.title, b.task_title], command.target);
    if (!block) continue;
    if (command.kind === "skip") {
      const ops: Op[] = [
        { op: "update", table: "day_blocks", id: block.id, values: { status: "skipped" } },
      ];
      return {
        ops,
        undo: undoOps(ops, { [block.id]: blockBefore(block) }),
        said: `Skipped ${block.title} ${dayWord(day)}.`,
      };
    }
    const length = Math.round((block.end_at - block.start_at) / 60_000);
    const start = Math.min(command.minutes, DAY_END_MIN - length);
    const ops: Op[] = [
      {
        op: "update",
        table: "day_blocks",
        id: block.id,
        values: {
          start_at: localToEpoch(date, start),
          end_at: localToEpoch(date, start + length),
          ...(block.status === "skipped" ? { status: "planned" } : {}),
        },
      },
    ];
    if (minuteOf(date, block.start_at) === start)
      return { ops: [], undo: [], said: `${block.title} is already at ${clockOf(start)}.` };
    return {
      ops,
      undo: undoOps(ops, { [block.id]: blockBefore(block) }),
      said: `Moved ${block.title} to ${clockOf(start)} ${dayWord(day)}.`,
    };
  }

  const task = best(context.tasks, (t) => [t.title], command.target);
  if (!task) return null;
  const day = command.day ?? "tomorrow";
  const date = day === "today" ? context.today : context.tomorrow;
  const before: Record<string, Record<string, SqlValue>> = {
    [task.id]: { planned_date: task.planned_date },
  };
  if (command.kind === "skip") {
    const later = shiftDate(date, 1);
    const ops: Op[] = [
      { op: "update", table: "task_items", id: task.id, values: { planned_date: later } },
    ];
    return {
      ops,
      undo: undoOps(ops, before),
      said: `Moved “${task.title}” to ${showDate(later, context.today, { weekday: true })}.`,
    };
  }
  // Rule 1: a task with a time gets its own block at that time.
  const length = task.estimate_min ?? 30;
  const start = Math.min(command.minutes, DAY_END_MIN - length);
  const blockId = context.newId();
  const ops: Op[] = [
    { op: "update", table: "task_items", id: task.id, values: { planned_date: date } },
    {
      op: "insert",
      table: "day_blocks",
      id: blockId,
      values: {
        logical_date: date,
        start_at: localToEpoch(date, start),
        end_at: localToEpoch(date, start + length),
        kind: "area",
        area_id: task.area_id,
        task_id: task.id,
        title: task.title,
        source: "user",
        status: "planned",
      },
    },
  ];
  return {
    ops,
    undo: undoOps(ops, before),
    said: `Put “${task.title}” at ${clockOf(start)} ${dayWord(day)}.`,
  };
}

/**
 * Free text split into lines (newlines or ";"): the commands, and the lines
 * that aren't, kept for the AI as they were.
 */
export function readLines(text: string): {
  commands: { line: string; command: Command }[];
  rest: string[];
} {
  const commands: { line: string; command: Command }[] = [];
  const rest: string[] = [];
  for (const raw of text.split(/\n|;/)) {
    const line = raw.trim();
    if (!line) continue;
    const command = readCommand(line);
    if (command) commands.push({ line, command });
    else rest.push(line);
  }
  return { commands, rest };
}
