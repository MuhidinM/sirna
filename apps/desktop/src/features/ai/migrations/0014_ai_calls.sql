-- Every request the AI gate sends (plan §7.1, §7.4–7.5; R-AI-02, R-AI-05).
-- Kept 30 days for the "What was sent" viewer. The key is never stored: it
-- goes in a request header, and request_redacted is the body as sent.
CREATE TABLE core_ai_calls (
  id               INTEGER PRIMARY KEY,
  task             TEXT    NOT NULL,           -- timing | estimate | brief | review | capture | models
  model            TEXT    NOT NULL,
  prompt_version   TEXT,
  started_at       INTEGER NOT NULL,           -- UTC epoch ms
  latency_ms       INTEGER,
  quota_day        TEXT    NOT NULL,           -- the Pacific date the free tier counts by
  tokens_in        INTEGER,
  tokens_out       INTEGER,
  status           TEXT    NOT NULL,           -- ok | rate_limited | error
  http_status      INTEGER,
  error            TEXT,
  request_redacted TEXT    NOT NULL,
  response_text    TEXT
);
CREATE INDEX core_ai_calls_day ON core_ai_calls (quota_day);
CREATE INDEX core_ai_calls_started ON core_ai_calls (started_at);
