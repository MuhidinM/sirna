import { describe, expect, it } from "vitest";

import { openTestDb } from "../../test/sqlite";
import { AI_LOG_SQL, type AiCall, callSummary, checkDailyCap, pretty } from "./log";

const NOW = Date.parse("2026-11-11T09:00:00Z");

const call = (change: Partial<AiCall> = {}): AiCall => ({
  id: 1,
  task: "timing",
  model: "gemini-3.5-flash-lite",
  prompt_version: "timing@1",
  started_at: Date.parse("2026-11-11T06:41:00Z"),
  latency_ms: 1200,
  tokens_in: 120,
  tokens_out: 30,
  status: "ok",
  http_status: 200,
  error: null,
  request_redacted: '{"contents":[]}',
  response_text: null,
  ...change,
});

describe("what was sent", () => {
  it("summarises a call in Addis time", () => {
    expect(callSummary(call(), NOW)).toBe("09:41 · timing · ok · 120 → 30 tokens · 1.2 s");
    expect(
      callSummary(
        call({
          started_at: Date.parse("2026-11-09T06:41:00Z"),
          status: "rate_limited",
          http_status: 429,
          tokens_in: null,
          tokens_out: null,
        }),
        NOW,
      ),
    ).toBe("11-09 09:41 · timing · rate_limited 429 · 1.2 s");
  });

  it("shows bodies readably", () => {
    expect(pretty('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(pretty("GET models")).toBe("GET models");
    expect(pretty(null)).toBe("");
  });

  it("reads the log table", () => {
    const db = openTestDb();
    db.exec(`INSERT INTO core_ai_calls (task, model, started_at, quota_day, status, request_redacted)
      VALUES ('brief', 'm', 1, '2026-11-10', 'ok', '{}'), ('timing', 'm', 2, '2026-11-10', 'error', '{}')`);
    expect((db.prepare(AI_LOG_SQL).all() as unknown as AiCall[]).map((c) => c.task)).toEqual([
      "timing",
      "brief",
    ]);
  });

  it("checks the daily cap", () => {
    expect(checkDailyCap(" 40 ")).toEqual({ cap: 40 });
    expect(checkDailyCap("0")).toEqual({ cap: 0 });
    for (const bad of ["", "-1", "2.5", "x", "1001"])
      expect(checkDailyCap(bad)).toHaveProperty("error");
  });
});
