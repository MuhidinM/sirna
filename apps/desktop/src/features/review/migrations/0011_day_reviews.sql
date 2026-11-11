-- One row per night review (plan §3.9). Skipping counts against nothing: a
-- skipped night is only remembered so the prompt doesn't come back.
CREATE TABLE day_reviews (
  logical_date TEXT PRIMARY KEY,                -- the day being reviewed
  status       TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'skipped')),
  energy       INTEGER CHECK (energy BETWEEN 1 AND 3),
  spent_none   INTEGER NOT NULL DEFAULT 0,      -- "Nothing" tapped in the spending step
  mind         TEXT,                            -- "Anything on your mind?"
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
