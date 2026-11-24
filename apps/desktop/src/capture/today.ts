/**
 * "Add for today" (Today §5): a line read as a capture, always a task, dated
 * today. Here, not in features/plan, so the capture bar can read a line it
 * is fixing the same way (reg2-5) without loading the planner.
 */
import { type ParseOptions, type Parsed, parseCapture } from "./parse";

/**
 * Saved with this parser id, so Up in the capture bar knows the line came
 * from Add for today and keeps it a task for that day.
 */
export const TODAY_PARSER_ID = "today@1";

/** The parser_id core_raw_items keeps for TODAY_PARSER_ID (the part before "@"). */
export const TODAY_PARSER = "today";

/**
 * The line read as a capture, always a task, dated today unless it names a
 * day itself ("call bank 3pm" keeps its time).
 */
export function todayTask(
  text: string,
  today: string,
  nowMs: number,
  /** Your areas and clock, so `for job a` and `at 9` read as in the capture bar (F83). */
  context: Pick<ParseOptions, "areas" | "clockStyle"> = {},
): Parsed | null {
  const raw = text.trim();
  if (!raw) return null;
  const options = { nowMs, ...context };
  let parsed = parseCapture(raw, options);
  // An idea, note or money line is still a task here: read it as one, without its prefix.
  if (parsed.kind !== "task") {
    parsed = parseCapture(
      `t: ${raw.replace(/^(?:t|n|note|idea|pin|wait|fb)\s*:\s*/i, "")}`,
      options,
    );
  }
  if (parsed.kind !== "task") return { kind: "task", title: raw, dueDate: today };
  return { ...parsed, dueDate: parsed.dueDate ?? today };
}
