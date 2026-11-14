-- Accounts (T-058; proposal 2.1). A balance is never stored: it is the
-- opening balance plus every entry from the opening date on. Until you type
-- a balance once (opening_date), an account only counts what you record.
CREATE TABLE money_accounts (
  id            TEXT PRIMARY KEY,
  name          TEXT    NOT NULL,
  kind          TEXT    NOT NULL CHECK (kind IN ('cash', 'bank', 'mobile', 'other')),
  opening_minor INTEGER NOT NULL DEFAULT 0,   -- santim at the start of opening_date
  opening_date  TEXT,                         -- logical date; NULL = balance not set yet
  pays_in       INTEGER NOT NULL DEFAULT 0,   -- 1 = income lands here unless you say
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER
);

-- Your accounts (2026-11-14): both jobs pay into CBO.
INSERT INTO money_accounts (id, name, kind, pays_in, sort_order, created_at, updated_at) VALUES
  ('cash',     'Cash',     'cash',   0, 1, 0, 0),
  ('cbo',      'CBO',      'bank',   1, 2, 0, 0),
  ('cbe',      'CBE',      'bank',   0, 3, 0, 0),
  ('ebirr',    'E-birr',   'mobile', 0, 4, 0, 0),
  ('telebirr', 'telebirr', 'mobile', 0, 5, 0, 0);

-- The two halves of a transfer share an id, and are kept out of in and out.
ALTER TABLE money_txns ADD COLUMN transfer_id TEXT;
CREATE INDEX money_txns_account ON money_txns (account, local_date);
