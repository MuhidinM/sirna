-- Focus sessions and breaks, written by the Rust timer on every change of
-- state, so a crash or sleep never loses one (plan §4.2, §5.2).
CREATE TABLE focus_sessions (
  id            TEXT PRIMARY KEY,               -- ULID-like, made in Rust
  block_id      TEXT REFERENCES day_blocks (id),
  area_id       TEXT REFERENCES area_items (id),
  task_id       TEXT REFERENCES task_items (id),
  kind          TEXT    NOT NULL CHECK (kind IN ('focus', 'break', 'long_break')),
  started_at    INTEGER NOT NULL,
  planned_min   INTEGER NOT NULL,
  paused_at     INTEGER,                        -- set while paused
  paused_ms     INTEGER NOT NULL DEFAULT 0,     -- total time spent paused
  ended_at      INTEGER,
  outcome       TEXT CHECK (outcome IN ('completed', 'stopped', 'interrupted')),
  distractions  INTEGER NOT NULL DEFAULT 0,
  extended      INTEGER NOT NULL DEFAULT 0,     -- "+5 min, once" used
  overrun       INTEGER NOT NULL DEFAULT 0,     -- past the daily cap (T-027)
  intent_text   TEXT,
  intent_done   TEXT CHECK (intent_done IN ('yes', 'partly', 'no'))
);
CREATE INDEX focus_sessions_started ON focus_sessions (started_at);
CREATE INDEX focus_sessions_open ON focus_sessions (ended_at) WHERE ended_at IS NULL;
