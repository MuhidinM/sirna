-- Projects (plan §3.8, §5.2) and the project board (§3.14, Taskflow).
-- A project's tasks are task_items with its project_id. The board's columns:
--   To do   status 'todo', started_at NULL
--   Doing   status 'todo', started_at set (still open, so Today and the
--           brief keep showing it)
--   Waiting status 'waiting'
--   Done    status 'done'
CREATE TABLE project_items (
  id                TEXT PRIMARY KEY,          -- ULID
  title             TEXT    NOT NULL,
  area_id           TEXT REFERENCES area_items (id),
  goal              TEXT,
  estimate_min      INTEGER,
  estimate_by       TEXT CHECK (estimate_by IN ('user', 'ai')),
  deadline          TEXT,                      -- local YYYY-MM-DD
  weekly_min        INTEGER,
  start_date        TEXT,
  forecast_finish   TEXT,
  status            TEXT    NOT NULL DEFAULT 'active'
                    CHECK (status IN ('idea', 'next_up', 'active', 'paused', 'done', 'dropped')),
  next_step_task_id TEXT REFERENCES task_items (id),
  last_check_json   TEXT,                      -- verdict, load numbers, reasons (T-035)
  origin            TEXT,
  user_edited_at    INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER
);
CREATE INDEX project_items_status ON project_items (status);

ALTER TABLE task_items ADD COLUMN started_at INTEGER;
CREATE INDEX task_items_project ON task_items (project_id, status);
