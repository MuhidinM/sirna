-- Notes, ideas, the inbox, feedback and cheat sheets (plan §5.2, §3.15).

CREATE TABLE note_items (
  id             TEXT PRIMARY KEY,            -- ULID
  kind           TEXT    NOT NULL
                 CHECK (kind IN ('note', 'idea', 'inbox', 'feedback', 'cheat')),
  status         TEXT    NOT NULL DEFAULT 'kept'
                 CHECK (status IN ('inbox', 'kept', 'converted', 'dropped', 'archived')),
  title          TEXT,                        -- cheat sheets have a title
  body           TEXT    NOT NULL,
  area_id        TEXT,
  project_id     TEXT,
  sort_order     INTEGER,
  origin         TEXT,
  user_edited_at INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  deleted_at     INTEGER
);
CREATE INDEX note_items_kind_status ON note_items (kind, status);
