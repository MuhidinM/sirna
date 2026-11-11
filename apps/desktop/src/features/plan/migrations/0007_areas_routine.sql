-- Life areas and the weekly routine (plan §3.2, §5.2).

-- Area ids are short slugs so `#coding` in a capture is the area id.
CREATE TABLE area_items (
  id                TEXT PRIMARY KEY,
  name              TEXT    NOT NULL,
  kind              TEXT    NOT NULL CHECK (kind IN ('work', 'growth', 'health', 'faith', 'admin')),
  color             TEXT    NOT NULL,          -- a theme area colour: work, jobhunt, coding, …
  weekly_target_min INTEGER NOT NULL DEFAULT 0,
  capped            INTEGER NOT NULL DEFAULT 0, -- the target is also a ceiling (Experiments)
  protected         INTEGER NOT NULL DEFAULT 0, -- never dropped for work (Gym, Quran)
  priority_rank     INTEGER NOT NULL,           -- 1 = first when filling free blocks
  focus_min         INTEGER NOT NULL DEFAULT 25,
  break_min         INTEGER NOT NULL DEFAULT 5,
  active            INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER
);

INSERT INTO area_items
  (id, name, kind, color, weekly_target_min, capped, protected, priority_rank, focus_min, break_min, created_at, updated_at)
VALUES
  ('joba',        'Job A',         'work',   'work',        0,    0, 0, 2, 25, 5, 0, 0),
  ('jobb',        'Job B',         'work',   'work',        0,    0, 0, 2, 25, 5, 0, 0),
  ('jobhunt',     'Job hunt',      'growth', 'jobhunt',     240,  0, 0, 3, 25, 5, 0, 0),
  ('coding',      'Coding skills', 'growth', 'coding',      240,  0, 0, 5, 50, 10, 0, 0),
  ('experiments', 'Experiments',   'growth', 'experiments', 180,  1, 0, 6, 50, 10, 0, 0),
  ('gym',         'Gym',           'health', 'gym',         135,  0, 1, 4, 45, 0, 0, 0),
  ('quran',       'Quran',         'faith',  'quran',       140,  0, 1, 4, 20, 0, 0, 0),
  ('admin',       'Life admin',    'admin',  'admin',       140,  0, 0, 7, 15, 0, 0, 0);

-- One row per block in the template week. weekday: 1 = Monday … 7 = Sunday.
CREATE TABLE routine_blocks (
  id           TEXT PRIMARY KEY,               -- ULID
  weekday      INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_min    INTEGER NOT NULL CHECK (start_min BETWEEN 0 AND 1439),
  duration_min INTEGER NOT NULL CHECK (duration_min > 0),
  kind         TEXT    NOT NULL CHECK (kind IN ('fixed', 'routine', 'area', 'rest')),
  area_id      TEXT REFERENCES area_items (id),
  title        TEXT    NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER
);
CREATE INDEX routine_blocks_day ON routine_blocks (weekday, start_min);
