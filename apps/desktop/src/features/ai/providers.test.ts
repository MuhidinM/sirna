import { describe, expect, it } from "vitest";

import { gemini, geminiBody, schemaFieldRejected } from "./providers";
import { type LlmRequest } from "./task";

const REQUEST: LlmRequest = {
  task: "brief",
  promptVersion: "brief@1",
  system: "Be brief.",
  prompt: "FACTS\n…",
  schema: { type: "object", properties: { line: { type: "string" } }, required: ["line"] },
};

describe("gemini", () => {
  it("builds a generateContent body with JSON output and no key", () => {
    const body = geminiBody(REQUEST, true);
    expect(body).toEqual({
      systemInstruction: { parts: [{ text: "Be brief." }] },
      contents: [{ role: "user", parts: [{ text: "FACTS\n…" }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json",
        responseJsonSchema: REQUEST.schema,
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/api.?key/i);
  });

  it("sends through the gate and returns its codes", async () => {
    const sent: unknown[] = [];
    const ok = gemini((args) => {
      sent.push(args);
      return Promise.resolve({ text: '{"line":"hi"}' });
    });
    expect(await ok.generate(REQUEST)).toEqual({ ok: true, text: '{"line":"hi"}' });
    expect(sent[0]).toMatchObject({ task: "brief", promptVersion: "brief@1" });
    const refused = gemini(() => Promise.reject(new Error("rate-limited:30")));
    expect(await refused.generate(REQUEST)).toEqual({ ok: false, code: "rate-limited:30" });
  });

  it("drops the schema field once if Google doesn't know it", async () => {
    const bodies: Record<string, unknown>[] = [];
    const provider = gemini(({ body }) => {
      bodies.push(body);
      const config = body.generationConfig as Record<string, unknown>;
      return "responseJsonSchema" in config
        ? Promise.reject(
            new Error('http:400:Invalid JSON payload received. Unknown name "responseJsonSchema"'),
          )
        : Promise.resolve({ text: "{}" });
    });
    expect(await provider.generate(REQUEST)).toEqual({ ok: true, text: "{}" });
    expect(await provider.generate(REQUEST)).toEqual({ ok: true, text: "{}" });
    expect(bodies).toHaveLength(3);
    expect(schemaFieldRejected("http:400:API key not valid")).toBe(false);
  });
});
