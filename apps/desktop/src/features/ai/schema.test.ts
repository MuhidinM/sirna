import { describe, expect, it } from "vitest";

import { check, parseReply, s, toJsonSchema } from "./schema";

const REASONS = s.object(
  {
    estimate_h: s.number({ min: 0.5, max: 2000 }),
    reasons: s.array(s.string({ maxLength: 160 }), { maxItems: 3 }),
    confidence: s.enum(["low", "medium", "high"]),
  },
  ["estimate_h"],
);

describe("schemas", () => {
  it("sends only documented keywords", () => {
    expect(toJsonSchema(REASONS)).toEqual({
      type: "object",
      properties: {
        estimate_h: { type: "number" },
        reasons: { type: "array", items: { type: "string" } },
        confidence: { type: "string", enum: ["low", "medium", "high"] },
      },
      required: ["reasons", "confidence"],
    });
    expect(JSON.stringify(toJsonSchema(REASONS))).not.toMatch(/maxItems|maxLength|minimum|pattern/);
  });

  it("accepts a good reply and drops unknown fields", () => {
    const fenced =
      "```json\n" + '{"reasons":[" Two projects run "],"confidence":"low","extra":1}' + "\n```";
    expect(parseReply(REASONS, fenced)).toEqual({
      ok: true,
      value: { reasons: ["Two projects run"], confidence: "low" },
    });
  });

  it("rejects what doesn't fit", () => {
    const bad = [
      "not json",
      '{"confidence":"low"}',
      '{"reasons":["a","b","c","d"],"confidence":"low"}',
      `{"reasons":["${"x".repeat(161)}"],"confidence":"low"}`,
      '{"reasons":[],"confidence":"sure"}',
      '{"reasons":[],"confidence":"low","estimate_h":0}',
      '{"reasons":[3],"confidence":"low"}',
      "[]",
    ];
    for (const text of bad) expect(parseReply(REASONS, text).ok, text).toBe(false);
  });

  it("checks whole numbers and booleans", () => {
    expect(check(s.integer(), 2.5).ok).toBe(false);
    expect(check(s.integer({ max: 3 }), 3)).toEqual({ ok: true, value: 3 });
    expect(check(s.boolean(), "yes").ok).toBe(false);
  });
});
