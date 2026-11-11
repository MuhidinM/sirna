/**
 * Provider adapters (plan §7.2): Gemini through the Rust gate, and a mock
 * that plays back recorded replies for tests and evals without a network.
 */
import { invoke } from "@tauri-apps/api/core";

import { type LlmProvider, type LlmRequest, type LlmResult } from "./task";

/** Google's `generateContent` body for a request (no key; Rust adds it). */
export function geminiBody(request: LlmRequest, withSchema: boolean): Record<string, unknown> {
  return {
    systemInstruction: { parts: [{ text: request.system }] },
    contents: [{ role: "user", parts: [{ text: request.prompt }] }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: "application/json",
      ...(withSchema ? { responseJsonSchema: request.schema } : {}),
    },
  };
}

/** A 400 that says the schema field isn't known: send the schema in the prompt only. */
export function schemaFieldRejected(code: string): boolean {
  return (
    /^http:400:/.test(code) && /responseJsonSchema|unknown name|invalid json payload/i.test(code)
  );
}

type Send = (args: {
  task: string;
  promptVersion: string;
  body: Record<string, unknown>;
}) => Promise<{ text: string }>;

const sendThroughGate: Send = ({ task, promptVersion, body }) =>
  invoke<{ text: string }>("ai_send", { task, promptVersion, body });

/**
 * Gemini through `ai_send`. If Google rejects `responseJsonSchema`, it is
 * left out from then on (the prompt still carries the schema, and every
 * reply is checked locally anyway).
 */
export function gemini(send: Send = sendThroughGate): LlmProvider {
  let withSchema = true;
  const once = async (request: LlmRequest): Promise<LlmResult> => {
    try {
      const reply = await send({
        task: request.task,
        promptVersion: request.promptVersion,
        body: geminiBody(request, withSchema),
      });
      return { ok: true, text: reply.text };
    } catch (error) {
      return { ok: false, code: error instanceof Error ? error.message : String(error) };
    }
  };
  return {
    id: "gemini",
    privacyTier: "free-may-train",
    async generate(request) {
      const result = await once(request);
      if (!result.ok && withSchema && schemaFieldRejected(result.code)) {
        withSchema = false;
        return once(request);
      }
      return result;
    },
  };
}

/** Plays back replies by task; records what it was asked. */
export function mock(
  replies: Partial<Record<LlmRequest["task"], string | ((request: LlmRequest) => LlmResult)>>,
): LlmProvider & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  return {
    id: "mock",
    privacyTier: "local",
    requests,
    generate(request) {
      requests.push(request);
      const reply = replies[request.task];
      if (reply === undefined) return Promise.resolve({ ok: false, code: "no-key" });
      return Promise.resolve(
        typeof reply === "string" ? { ok: true, text: reply } : reply(request),
      );
    },
  };
}
