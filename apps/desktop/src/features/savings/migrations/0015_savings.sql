-- Savings goals and the plant (plan §3.13; R-PRG-03). Saving is tracked apart
-- from spending. An entry with no goal waits until you give it one.
CREATE TABLE savings_goals (
  id           TEXT PRIMARY KEY,               -- ULID
  title        TEXT    NOT NULL,
  target_minor INTEGER NOT NULL CHECK (target_minor > 0),  -- santim
  start_date   TEXT    NOT NULL,               -- local YYYY-MM-DD
  status       TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done', 'paused')),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER
);

CREATE TABLE savings_entries (
  id           TEXT PRIMARY KEY,               -- ULID
  goal_id      TEXT REFERENCES savings_goals (id),
  occurred_at  INTEGER NOT NULL,               -- UTC epoch ms
  local_date   TEXT    NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor != 0),  -- + saved, − taken out
  note         TEXT,
  origin       TEXT,                           -- capture | dashboard | week
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER
);
CREATE INDEX savings_entries_goal ON savings_entries (goal_id, local_date);
