/**
 * Smart capture in your own words (plan v3 "Smart capture", T-090, ADR-0014).
 * The rules stay the instant path. When they are unsure, the line is first
 * saved as an inbox note; then one COMMAND call proposes up to 6 rows from a
 * closed list of intents, and this file turns each row into ops. The model
 * decides nothing: every write, date and amount below is the app's.
 */
import { type Op } from "../kernel/db";
import { localDate, logicalDate } from "../kernel/dates";
import { formatEstimate } from "../features/plan/now";
import { maskAmounts, unmask } from "../features/ai/mask";
import {
  type CommandFacts,
  type CommandItem,
  SIZE_MIN,
} from "../features/ai/touchpoints";
import { dayLabel, echo, toOps } from "./ops";
import { type ParseOptions, type Parsed, parseCapture } from "./parse";
import { localToEpoch, readWhen, weekdayName, type When } from "./when";

export const COMMAND_PARSER_ID = "command@1";

/** Over this many characters a line is read by the AI. */
export const LONG_LINE = 60;
/** More clauses than this and the line probably holds several things. */
export const MAX_CLAUSES = 2;

const PREFIXED = /^\s*(?:\?|(?:t|n|note|idea|pin|wait|fb)\s*:)/i;
const ETHIOPIC = /\p{Script=Ethiopic}/u;
const CLAUSE_SPLIT = /\s*(?:[,;]|\band then\b|\balso\b|\band\b)\s*/i;
/** Commands the rules don't handle yet. */
const COMMAND_VERB =
  /^(?:(?:move|push|reschedule)\b|finish\b.*\bby\b|(?:off|light)\b|(?:i'?m|i am) in\b|(?:i'?m |i am )?back in\b|working from\b)/i;

/** Commands the rules read for sure: never sent, whatever the words. */
const RULES_SURE: ReadonlySet<Parsed["kind"]> = new Set([
  "afford",
  "away",
  "back",
  "block",
  "search",
  "focus",
]);
/** Clean money: never sent, unless it is in Amharic (the rules don't read Amharic words). */
const CLEAN_MONEY: ReadonlySet<Parsed["kind"]> = new Set([
  "expense",
  "income",
  "money",
  "loan",
  "transfer",
  "saving",
]);

export interface AiMode {
  /** Strict mode keeps capture rules-only (ADR-0014). */
  strict?: boolean;
  /** Plain mode after bad replies, or no AI for now. */
  plain?: boolean;
}

export function clauses(text: string): number {
  return text.split(CLAUSE_SPLIT).filter((piece) => piece.trim()).length;
}

/**
 * Whether a line should be read by the AI. Pure: the rules' reading and the
 * text decide it. Shift+Enter forces it in the capture box, outside this.
 */
export function needsAi(parsed: Parsed, text: string, mode: AiMode = {}): boolean {
  if (mode.strict || mode.plain) return false;
  const line = text.trim();
  if (!line || PREFIXED.test(line)) return false;
  // A loose end with nothing in it ("tomorrow" alone) waits for the what.
  if (parsed.kind === "inbox" && parsed.body === "") return false;
  // `away till mon`, `gym done`, `afford 4500 shoes`: read on the spot, never sent.
  if (RULES_SURE.has(parsed.kind)) return false;
  // Amharic: the rules can't read its words (`ሰኞ ዶክተር ቀጠሮ ከጠዋቱ 3` is not
  // an expense of 3 birr), so even a money reading goes to the AI, masked.
  if (ETHIOPIC.test(line)) return true;
  // `lunch 120`, `lunch 120, taxi 40`: clean money stays local.
  if (CLEAN_MONEY.has(parsed.kind)) return false;
  if (parsed.kind === "inbox") return true;
  if (line.length > LONG_LINE || clauses(line) > MAX_CLAUSES) return true;
  return COMMAND_VERB.test(line);
}

export interface OpenItem {
  id: string;
  title: string;
  kind: "task" | "project";
  /** A timed task's due and reminder instants, moved with its day. Never sent. */
  dueAt?: number | null;
  remindAt?: number | null;
}

/** Open tasks first, then projects: about 30, newest first. */
export const OPEN_ITEMS_SQL = `SELECT id, title, kind, due_at, remind_at FROM (
    SELECT id, title, 'task' AS kind, due_at, remind_at, updated_at FROM task_items
    WHERE deleted_at IS NULL AND parent_id IS NULL
      AND status NOT IN ('done', 'dropped', 'archived')
    ORDER BY updated_at DESC LIMIT 22)
  UNION ALL SELECT id, title, kind, NULL, NULL FROM (
    SELECT id, title, 'project' AS kind, updated_at FROM project_items
    WHERE deleted_at IS NULL AND status NOT IN ('done', 'dropped')
    ORDER BY updated_at DESC LIMIT 8)`;

/** The fact sheet for one line: amounts masked, everything else as the app knows it. */
export function commandFacts(
  text: string,
  nowMs: number,
  areas: { id: string; name: string }[],
  open: OpenItem[],
): CommandFacts {
  const masked = maskAmounts(text.trim());
  const today = logicalDate(nowMs);
  return {
    text: masked.text,
    amounts: masked.amounts,
    today,
    weekday: weekdayName(today),
    nowMs,
    areas,
    // A title like "Pay rent 12000" keeps its words, not its amount ("Pay rent <a>").
    open: open.map(({ id, kind, title }) => ({
      id,
      kind,
      title: maskAmounts(title).text.replace(/<a\d+>/g, "<a>"),
    })),
  };
}

/** The reply read back: amounts put back into titles, steps, spans and date words. */
export function restore(item: CommandItem, amounts: Record<string, string>): CommandItem {
  const back = (text: string | undefined) =>
    text === undefined ? undefined : unmask(text, amounts);
  const restored: CommandItem = { ...item, title: unmask(item.title, amounts) };
  for (const key of ["span", "when_text", "by_text", "area_phrase"] as const) {
    const value = back(item[key]);
    if (value !== undefined) restored[key] = value;
  }
  if (item.steps) restored.steps = item.steps.map((step) => unmask(step, amounts));
  return restored;
}

export interface SmartContext {
  nowMs: number;
  newId: () => string;
  areas: { id: string; name: string }[];
  open: OpenItem[];
  /** What the rules know (categories, accounts…), for a money span. */
  parse?: Omit<ParseOptions, "nowMs">;
}

/** What has to happen outside the ops, after the capture is saved. */
export type Effect = { kind: "away"; until: string } | { kind: "search"; query: string };

export interface Proposal {
  /** The row as shown: `Send invoice · Tue · Job B · ~1h`. */
  label: string;
  ops: Op[];
  effect?: Effect;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function when(text: string | undefined, item: CommandItem, nowMs: number): When {
  return text
    ? readWhen(text, nowMs, item.ethiopian_clock ? "ethiopian" : "western")
    : { rest: "" };
}

/**
 * A task's new day as columns. A timed task (`call bank fri 10am`) keeps its
 * time of day, and its reminder keeps its lead, so they don't fire on the old
 * day; a time in the words (`to mon 3pm`) sets both.
 */
export function dayValues(
  target: OpenItem,
  date: string,
  minutes: number | undefined,
  columns: ("due_date" | "planned_date")[],
): Record<string, string | number | null> {
  const values: Record<string, string | number | null> = {};
  for (const column of columns) values[column] = date;
  if (minutes !== undefined) {
    const at = localToEpoch(date, minutes);
    values.due_at = at;
    values.remind_at = at;
    return values;
  }
  const anchor = target.dueAt ?? target.remindAt;
  if (anchor == null) return values;
  const shift = Date.parse(date) - Date.parse(localDate(anchor));
  if (target.dueAt != null) values.due_at = target.dueAt + shift;
  if (target.remindAt != null) values.remind_at = target.remindAt + shift;
  return values;
}

const join = (...parts: (string | undefined | false)[]) =>
  parts.filter((part): part is string => Boolean(part)).join(" · ");

function areaName(id: string | undefined, areas: SmartContext["areas"]): string | undefined {
  return id ? (areas.find((area) => area.id === id)?.name ?? id) : undefined;
}

function noteProposal(item: CommandItem, context: SmartContext, body = item.title): Proposal {
  const ops = toOps(
    { kind: "note", body, ...(item.area ? { area: item.area } : {}) },
    { nowMs: context.nowMs, newId: context.newId },
  );
  return { label: join(`Note: ${body}`, areaName(item.area, context.areas)), ops };
}

function taskProposal(item: CommandItem, context: SmartContext, dateText?: string): Proposal {
  const { nowMs, newId } = context;
  const read = when(dateText, item, nowMs);
  const task: Extract<Parsed, { kind: "task" }> = { kind: "task", title: item.title };
  if (item.size) task.estimateMin = SIZE_MIN[item.size];
  if (read.date) task.dueDate = read.date;
  if (read.date && read.minutes !== undefined) task.dueAt = localToEpoch(read.date, read.minutes);
  if (read.window) task.plannedWindow = read.window;
  if (item.area) {
    task.area = item.area;
    task.areaKnown = true;
  }
  const ops = toOps(task, { nowMs, newId });
  const parent = ops[0];
  if (parent && parent.op === "insert") {
    for (const [index, step] of (item.steps ?? []).entries())
      ops.push({
        op: "insert",
        table: "task_items",
        id: newId(),
        values: {
          title: step,
          parent_id: parent.id,
          step_no: index + 1,
          status: parent.values.status ?? "todo",
          area_id: item.area ?? null,
          origin: "capture",
        },
      });
  }
  const steps = item.steps?.length ? `${item.steps.length} steps` : undefined;
  return {
    label: join(
      item.title,
      task.dueDate ? dayLabel(task.dueDate, nowMs) : undefined,
      areaName(item.area, context.areas),
      task.estimateMin ? formatEstimate(task.estimateMin) : undefined,
      steps,
    ),
    ops,
  };
}

/**
 * One row of the reply as ops. Null when it can't be done here (a project to
 * move, a money span the rules don't read): the row is left out.
 */
export function proposal(item: CommandItem, context: SmartContext): Proposal | null {
  const { nowMs } = context;
  const target = item.target ? context.open.find((open) => open.id === item.target) : undefined;
  switch (item.intent) {
    case "task":
      return taskProposal(item, context, item.when_text);
    case "note":
      return noteProposal(item, context);
    case "money": {
      if (!item.span) return null;
      const parsed = parseCapture(item.span, { ...context.parse, nowMs });
      if (!["expense", "income", "money", "loan", "transfer"].includes(parsed.kind)) return null;
      try {
        const ops = toOps(parsed, { nowMs, newId: context.newId });
        return ops.length ? { label: echo(parsed, nowMs), ops } : null;
      } catch {
        return null;
      }
    }
    case "move": {
      const read = when(item.when_text, item, nowMs);
      const date = read.date;
      if (!target || target.kind !== "task" || !date) return null;
      return {
        label: join(`Move: ${target.title}`, dayLabel(date, nowMs)),
        ops: [
          {
            op: "update",
            table: "task_items",
            id: target.id,
            values: dayValues(target, date, read.minutes, ["due_date", "planned_date"]),
          },
        ],
      };
    }
    case "finish_by": {
      const read = when(item.by_text, item, nowMs);
      const date = read.date;
      if (!date) return null;
      // Make room for it comes with the packer (#198); for now the deadline is set.
      if (target?.kind === "task")
        return {
          label: join(`Finish by ${dayLabel(date, nowMs)}: ${target.title}`),
          ops: [
            {
              op: "update",
              table: "task_items",
              id: target.id,
              values: dayValues(target, date, read.minutes, ["due_date"]),
            },
          ],
        };
      if (target) return null;
      const made = taskProposal(item, context, item.by_text);
      return { ...made, label: `Finish by ${dayLabel(date, nowMs)}: ${made.label}` };
    }
    case "day_mode": {
      const date = item.when_text ? when(item.when_text, item, nowMs).date : logicalDate(nowMs);
      // Away starts now, so only a day off today is set here; the rest wait as a note.
      if (item.mode === "off" && date === logicalDate(nowMs))
        return {
          label: "Day off · Today",
          ops: [],
          effect: { kind: "away", until: logicalDate(nowMs + DAY_MS) },
        };
      return noteProposal(item, context);
    }
    case "place": {
      // The same row and op as the rules' `I'm in Adama` (T-092).
      if (!item.place) return null;
      const parsed: Parsed = { kind: "city", city: item.place };
      return { label: echo(parsed, nowMs), ops: toOps(parsed, { nowMs, newId: context.newId }) };
    }
    case "question":
      if (!item.span) return null;
      return {
        label: `Search: ${item.span}`,
        ops: [],
        effect: { kind: "search", query: item.span },
      };
  }
}

// --- The rows in the capture box ---------------------------------------------------

export interface Row {
  item: CommandItem;
  on: boolean;
}

export interface RowsState {
  rows: Row[];
  cursor: number;
}

export type RowAction =
  { kind: "state"; state: RowsState } | { kind: "accept" } | { kind: "keep" } | { kind: "ignore" };

/** Rows whose area Tab can change: something new that lands on an area's list. */
const HAS_AREA = (item: CommandItem) =>
  item.intent === "task" || item.intent === "note" || (item.intent === "finish_by" && !item.target);

/**
 * The capture box's keys while rows show: Enter accepts the rows that are
 * on, Up/Down moves, Space turns a row on or off, Tab (Shift+Tab back)
 * cycles the row's area, Esc keeps the line as a note.
 */
export function rowKey(
  state: RowsState,
  key: string,
  shift: boolean,
  areaIds: readonly string[],
): RowAction {
  const count = state.rows.length;
  switch (key) {
    case "Enter":
      return { kind: "accept" };
    case "Escape":
      return { kind: "keep" };
    case "ArrowDown":
    case "ArrowUp": {
      if (!count) return { kind: "ignore" };
      const step = key === "ArrowDown" ? 1 : count - 1;
      return { kind: "state", state: { ...state, cursor: (state.cursor + step) % count } };
    }
    case " ": {
      const rows = state.rows.map((row, index) =>
        index === state.cursor ? { ...row, on: !row.on } : row,
      );
      return { kind: "state", state: { ...state, rows } };
    }
    case "Tab": {
      const row = state.rows[state.cursor];
      if (!row || !HAS_AREA(row.item) || !areaIds.length) return { kind: "ignore" };
      const choices: (string | undefined)[] = [undefined, ...areaIds];
      const at = Math.max(0, choices.indexOf(row.item.area));
      const next = choices[(at + (shift ? choices.length - 1 : 1)) % choices.length];
      const item: CommandItem = { ...row.item };
      if (next) item.area = next;
      else delete item.area;
      const rows = state.rows.map((each, index) =>
        index === state.cursor ? { ...each, item } : each,
      );
      return { kind: "state", state: { ...state, rows } };
    }
    default:
      return { kind: "ignore" };
  }
}

/** `✓ Send invoice · Tue · Job B · ~1h`, or `✗ …` for a row turned off. */
export function rowText(row: Row, context: SmartContext): string {
  const made = proposal(row.item, context);
  return `${row.on ? "✓" : "✗"} ${made?.label ?? row.item.title}`;
}

/** The rows a reply gives: only the ones the app can do. */
export function rowsFor(items: CommandItem[], context: SmartContext): Row[] {
  return items
    .filter((item) => proposal(item, context) !== null)
    .slice(0, 6)
    .map((item) => ({ item, on: true }));
}

/** What accepting the rows that are on writes, and what runs after. */
export function accepted(
  rows: Row[],
  context: SmartContext,
): { ops: Op[]; effects: Effect[]; count: number } {
  const ops: Op[] = [];
  const effects: Effect[] = [];
  let count = 0;
  for (const row of rows) {
    if (!row.on) continue;
    const made = proposal(row.item, context);
    if (!made) continue;
    count += 1;
    ops.push(...made.ops);
    if (made.effect) effects.push(made.effect);
  }
  return { ops, effects, count };
}
