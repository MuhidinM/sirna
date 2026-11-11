/**
 * Running an AI task (plan §7.2): features call `runTask(task, input)`, never
 * a vendor. The task builds the prompt from a fact sheet, the provider sends
 * it, and the reply is used only if it parses, fits the schema and is
 * grounded in the facts. Anything else is a code the caller answers with its
 * template text (R-AI-01). Three bad replies in a row → no AI for 10 minutes.
 */
import { type JsonSchema, parseReply, type Schema, toJsonSchema } from "./schema";

export type AiTaskId = "timing" | "estimate" | "brief" | "week" | "review" | "capture";

export interface AiTask<I, O> {
  id: AiTaskId;
  /** Bumped with every prompt change; logged with each call (§7.6). */
  version: string;
  schema: Schema;
  system: string;
  /** The fact sheet as text: everything the model may use, and nothing else. */
  facts(input: I): string;
  /** The question, after the facts. */
  ask(input: I): string;
  /** Null when the checked reply is grounded in the input; else why not. */
  ground(output: O, input: I): string | null;
}

export interface LlmRequest {
  task: AiTaskId;
  promptVersion: string;
  system: string;
  prompt: string;
  schema: JsonSchema;
}

export type LlmResult = { ok: true; text: string } | { ok: false; code: string };

export interface LlmProvider {
  id: "gemini" | "mock" | "openai-compat";
  privacyTier: "free-may-train" | "paid-no-train" | "local";
  generate(request: LlmRequest): Promise<LlmResult>;
}

export type TaskResult<O> = { ok: true; value: O } | { ok: false; code: string };

const BAD_REPLIES_FOR_PLAIN = 3;
const PLAIN_MS = 10 * 60 * 1000;

/** Bad replies in a row, and until when AI is off. Per window, like the gate. */
export const plain = { bad: 0, until: 0 };

export function prompt<I>(task: AiTask<I, unknown>, input: I): string {
  return `FACTS\n${task.facts(input)}\n\nTASK\n${task.ask(input)}\n\nReply with JSON only, matching this schema:\n${JSON.stringify(toJsonSchema(task.schema))}`;
}

export async function runTask<I, O>(
  task: AiTask<I, O>,
  input: I,
  provider: LlmProvider,
  nowMs: () => number = Date.now,
): Promise<TaskResult<O>> {
  if (nowMs() < plain.until) return { ok: false, code: "plain-mode:local" };
  const result = await provider.generate({
    task: task.id,
    promptVersion: `${task.id}@${task.version}`,
    system: task.system,
    prompt: prompt(task, input),
    schema: toJsonSchema(task.schema),
  });
  if (!result.ok) return result;
  const bad = (code: string): TaskResult<O> => {
    plain.bad += 1;
    if (plain.bad >= BAD_REPLIES_FOR_PLAIN) {
      plain.bad = 0;
      plain.until = nowMs() + PLAIN_MS;
    }
    return { ok: false, code };
  };
  const checked = parseReply(task.schema, result.text);
  if (!checked.ok) return bad(`invalid:${checked.error}`);
  const value = checked.value as O;
  const problem = task.ground(value, input);
  if (problem) return bad(`ungrounded:${problem}`);
  plain.bad = 0;
  return { ok: true, value };
}
