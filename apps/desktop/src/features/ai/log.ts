/** The "What was sent" viewer (plan §7.4; R-AI-02): every AI request, 30 days. */

export const AI_LOG_SQL = `SELECT id, task, model, prompt_version, started_at, latency_ms,
  tokens_in, tokens_out, status, http_status, error, request_redacted, response_text
  FROM core_ai_calls ORDER BY started_at DESC LIMIT 200`;

export interface AiCall {
  id: number;
  task: string;
  model: string;
  prompt_version: string | null;
  started_at: number;
  latency_ms: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  status: string;
  http_status: number | null;
  error: string | null;
  request_redacted: string;
  response_text: string | null;
}

export const DEFAULT_DAILY_CAP = 15;
export const MAX_DAILY_CAP = 1000;

/** A request body shown readably; anything that isn't JSON as it is. */
export function pretty(text: string | null): string {
  if (!text) return "";
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** "09:41 · timing · ok · 120 → 30 tokens · 1.2 s" */
export function callSummary(call: AiCall, nowMs: number): string {
  const at = new Date(call.started_at + 3 * 3_600_000); // Addis time
  const sameDay =
    Math.floor((call.started_at + 3 * 3_600_000) / 86_400_000) ===
    Math.floor((nowMs + 3 * 3_600_000) / 86_400_000);
  const time = `${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")}`;
  const day = sameDay ? time : `${at.toISOString().slice(5, 10)} ${time}`;
  const tokens =
    call.tokens_in != null || call.tokens_out != null
      ? ` · ${call.tokens_in ?? "?"} → ${call.tokens_out ?? "?"} tokens`
      : "";
  const latency = call.latency_ms != null ? ` · ${(call.latency_ms / 1000).toFixed(1)} s` : "";
  const status =
    call.status === "ok" ? "ok" : `${call.status}${call.http_status ? ` ${call.http_status}` : ""}`;
  return `${day} · ${call.task} · ${status}${tokens}${latency}`;
}

/** Whole requests a day from 0 to MAX_DAILY_CAP, or an error to show. */
export function checkDailyCap(text: string): { cap: number } | { error: string } {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed) || Number(trimmed) > MAX_DAILY_CAP)
    return { error: `Use a whole number from 0 to ${MAX_DAILY_CAP}.` };
  return { cap: Number(trimmed) };
}
