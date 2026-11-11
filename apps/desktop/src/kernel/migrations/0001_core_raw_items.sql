-- Every input lands here unchanged before it is parsed (plan §5.1 rule 1).
CREATE TABLE IF NOT EXISTS core_raw_items (
  id             INTEGER PRIMARY KEY,
  source         TEXT    NOT NULL,              -- capture | ics_event
  source_uid     TEXT,
  content_hash   TEXT,
  received_at    INTEGER NOT NULL,              -- UTC epoch ms
  body           TEXT    NOT NULL,
  meta_json      TEXT,
  parse_status   TEXT    NOT NULL DEFAULT 'new', -- new | parsed | unmatched | ignored | needs_review | failed
  parser_id      TEXT,
  parser_version INTEGER,
  parsed_at      INTEGER,
  error          TEXT,
  UNIQUE (source, source_uid)
);
