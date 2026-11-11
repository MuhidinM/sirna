-- Settings, the audit log and local usage events (plan §5.2).

CREATE TABLE core_settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Every change has an actor (plan §5.1 rule 2). Rows are never updated.
CREATE TABLE core_activity (
  id          INTEGER PRIMARY KEY,
  at          INTEGER NOT NULL,             -- UTC epoch ms
  actor       TEXT    NOT NULL,             -- user | system | rule:12 | parser:capture@1 | ai:55
  context     TEXT,                         -- e.g. capture:42 (the raw item that caused it)
  entity_type TEXT    NOT NULL,             -- table name
  entity_id   TEXT    NOT NULL,
  action      TEXT    NOT NULL,             -- insert | update | delete | undo
  before_json TEXT,
  after_json  TEXT
);
CREATE INDEX core_activity_entity ON core_activity (entity_type, entity_id, at);
CREATE INDEX core_activity_context ON core_activity (context);

-- Usage events never leave the machine; they steer what to build next (plan §1).
CREATE TABLE core_usage (
  id           INTEGER PRIMARY KEY,
  at           INTEGER NOT NULL,
  logical_date TEXT    NOT NULL,
  event        TEXT    NOT NULL,
  props_json   TEXT
);
CREATE INDEX core_usage_date ON core_usage (logical_date, event);
