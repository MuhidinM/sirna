/**
 * Asking the AI from a screen (plan §7.1): only while a window is open, only
 * when the screen needs it, and each question once per session (the free
 * tier is small). Callers show their template text until a reply arrives,
 * and keep it if none does (R-AI-01).
 */
import { useEffect, useState } from "react";

import { gemini } from "./providers";
import { type AiTask, type LlmProvider, runTask, type TaskResult } from "./task";

let current: LlmProvider | null = null;

/** The provider every screen uses; tests swap in a mock. */
export function provider(): LlmProvider {
  current ??= gemini();
  return current;
}

export function setProvider(next: LlmProvider | null): void {
  current = next;
  answers.clear();
}

const answers = new Map<string, Promise<TaskResult<unknown>>>();

/** One request per distinct question; failures are not kept, so a later try can work. */
export function ask<I, O>(task: AiTask<I, O>, input: I): Promise<TaskResult<O>> {
  const key = `${task.id}@${task.version}:${JSON.stringify(input)}`;
  const known = answers.get(key);
  if (known) return known as Promise<TaskResult<O>>;
  const pending = runTask(task, input, provider()).then((result) => {
    if (!result.ok) answers.delete(key);
    return result;
  });
  answers.set(key, pending);
  return pending;
}

/** The AI's answer for `input` once it arrives; null until then, or for no input. */
export function useAsk<I, O>(task: AiTask<I, O>, input: I | null): O | null {
  const [value, setValue] = useState<{ key: string; value: O } | null>(null);
  const key = input === null ? null : JSON.stringify(input);
  useEffect(() => {
    if (key === null) return;
    let live = true;
    void ask(task, JSON.parse(key) as I).then((result) => {
      if (live && result.ok) setValue({ key, value: result.value });
    });
    return () => {
      live = false;
    };
  }, [task, key]);
  return value && value.key === key ? value.value : null;
}
