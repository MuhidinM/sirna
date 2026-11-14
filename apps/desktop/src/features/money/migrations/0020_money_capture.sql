-- Capture learns money (T-056).
-- Income names the job it came from (an area); the Money page groups by it.
ALTER TABLE money_txns ADD COLUMN area_id TEXT REFERENCES area_items (id);

-- A category you corrected in the ledger, remembered for that description
-- (id = the description in lowercase), so the next capture gets it right.
CREATE TABLE money_learned (
  id          TEXT PRIMARY KEY,
  category_id TEXT    NOT NULL REFERENCES money_categories (id),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER
);
