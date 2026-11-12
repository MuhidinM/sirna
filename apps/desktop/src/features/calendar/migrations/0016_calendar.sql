-- Google Calendar, read-only (plan Appendix A; R-CAL-01). Each sync replaces
-- the occurrences from yesterday to two weeks ahead; they become fixed
-- blocks in the day plan.
CREATE TABLE cal_occurrences (
  id          TEXT PRIMARY KEY,               -- uid|start, stable across syncs
  ical_uid    TEXT    NOT NULL,
  summary     TEXT    NOT NULL,
  location    TEXT,
  start_at    INTEGER NOT NULL,               -- UTC epoch ms
  end_at      INTEGER NOT NULL,
  local_date  TEXT    NOT NULL,               -- the logical date it starts on
  all_day     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER
);
CREATE INDEX cal_occurrences_day ON cal_occurrences (local_date);
