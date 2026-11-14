-- Regulars (T-059, T-060): bills you pay and pay you expect, on a repeat rule.
-- Nothing is posted by itself: a tap on Paid or Received records the entry,
-- marked with the regular and the date it was due.
CREATE TABLE money_regulars (
  id           TEXT PRIMARY KEY,
  kind         TEXT    NOT NULL CHECK (kind IN ('bill', 'pay')),
  name         TEXT    NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),  -- santim, expected
  rule_json    TEXT    NOT NULL,     -- {"every":"month","day":10} | {"every":"week","days":[1,4]}
  category_id  TEXT REFERENCES money_categories (id),
  account      TEXT    NOT NULL DEFAULT 'cash',
  area_id      TEXT REFERENCES area_items (id),  -- the job, for pay
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER
);

ALTER TABLE money_txns ADD COLUMN regular_id TEXT;
ALTER TABLE money_txns ADD COLUMN due_date TEXT;  -- the occurrence it pays
CREATE INDEX money_txns_regular ON money_txns (regular_id, due_date);
