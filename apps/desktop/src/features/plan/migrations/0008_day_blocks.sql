-- The plan for each day, generated from the routine (plan §3.3, §5.2).
CREATE TABLE day_blocks (
  id             TEXT PRIMARY KEY,              -- ULID
  logical_date   TEXT    NOT NULL,
  start_at       INTEGER NOT NULL,              -- UTC epoch ms
  end_at         INTEGER NOT NULL,
  kind           TEXT    NOT NULL CHECK (kind IN ('fixed', 'routine', 'area', 'rest')),
  area_id        TEXT REFERENCES area_items (id),
  task_id        TEXT REFERENCES task_items (id),
  project_id     TEXT,
  title          TEXT    NOT NULL,
  source         TEXT    NOT NULL DEFAULT 'generator' CHECK (source IN ('template', 'generator', 'user', 'ai')),
  status         TEXT    NOT NULL DEFAULT 'planned'
                 CHECK (status IN ('planned', 'started', 'done', 'skipped', 'moved')),
  light_day      INTEGER NOT NULL DEFAULT 0,
  user_edited_at INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  deleted_at     INTEGER
);
CREATE INDEX day_blocks_date ON day_blocks (logical_date, start_at);
-- A day can't hold the same block twice, so two plan runs racing can't
-- both save (the second transaction fails and rolls back).
CREATE UNIQUE INDEX day_blocks_once ON day_blocks (logical_date, start_at, title)
  WHERE deleted_at IS NULL;

-- The top 3 gets a single id ("2026-11-11:1") so it can be written through
-- the same allowlisted path as everything else. The table was empty.
DROP TABLE task_daily_top;
CREATE TABLE task_daily_top (
  id           TEXT PRIMARY KEY,                -- logical_date:position
  logical_date TEXT    NOT NULL,
  position     INTEGER NOT NULL CHECK (position BETWEEN 1 AND 3),
  task_id      TEXT    NOT NULL REFERENCES task_items (id),
  chosen_by    TEXT    NOT NULL DEFAULT 'default' CHECK (chosen_by IN ('user', 'default')),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (logical_date, position)
);
