-- Tasks and the daily top 3 (plan §5.2). area_id and project_id point at
-- tables added in M2/M4; they stay plain columns until then.

CREATE TABLE task_items (
  id              TEXT PRIMARY KEY,           -- ULID
  title           TEXT    NOT NULL,
  notes           TEXT,
  first_step      TEXT,
  status          TEXT    NOT NULL DEFAULT 'todo'
                  CHECK (status IN ('todo', 'waiting', 'done', 'dropped', 'someday', 'archived')),
  due_date        TEXT,                       -- local YYYY-MM-DD
  due_at          INTEGER,                    -- UTC epoch ms, when timed
  remind_at       INTEGER,
  estimate_min    INTEGER,
  area_id         TEXT,
  project_id      TEXT,
  waiting_on      TEXT,
  follow_up_date  TEXT,
  carries         INTEGER NOT NULL DEFAULT 0,
  origin          TEXT,                       -- capture:42, review, setup …
  completed_at    INTEGER,
  user_edited_at  INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER
);
CREATE INDEX task_items_status_due ON task_items (status, due_date);
CREATE INDEX task_items_area ON task_items (area_id, status);
CREATE INDEX task_items_remind ON task_items (remind_at) WHERE remind_at IS NOT NULL;

CREATE TABLE task_daily_top (
  logical_date TEXT    NOT NULL,
  position     INTEGER NOT NULL CHECK (position BETWEEN 1 AND 3),
  task_id      TEXT    NOT NULL REFERENCES task_items (id),
  chosen_by    TEXT    NOT NULL DEFAULT 'default' CHECK (chosen_by IN ('user', 'default')),
  PRIMARY KEY (logical_date, position)
);
