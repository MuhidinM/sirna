-- Cash-first money (plan §3.12, §5.2). Amounts are integer santim, signed:
-- spending is negative, income positive.

CREATE TABLE money_categories (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  kind       TEXT NOT NULL CHECK (kind IN ('expense', 'income')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE money_txns (
  id             TEXT PRIMARY KEY,            -- ULID
  account        TEXT    NOT NULL DEFAULT 'cash',
  occurred_at    INTEGER NOT NULL,
  local_date     TEXT    NOT NULL,
  amount_minor   INTEGER NOT NULL,            -- santim, signed
  currency       TEXT    NOT NULL DEFAULT 'ETB',
  description    TEXT    NOT NULL,
  category_id    TEXT REFERENCES money_categories (id),
  origin         TEXT,
  user_edited_at INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  deleted_at     INTEGER
);
CREATE INDEX money_txns_date ON money_txns (local_date);
CREATE INDEX money_txns_category ON money_txns (category_id, local_date);

-- One-tap chips for repeated expenses, learned after 3 repeats (plan §3.14).
CREATE TABLE money_templates (
  id           TEXT PRIMARY KEY,
  label        TEXT    NOT NULL,
  amount_minor INTEGER NOT NULL,
  category_id  TEXT REFERENCES money_categories (id),
  uses         INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER
);

-- Starting categories. Fixed ids so parsers and tests can refer to them.
INSERT INTO money_categories (id, name, kind, created_at, updated_at) VALUES
  ('cat_food',       'Food',       'expense', 0, 0),
  ('cat_transport',  'Transport',  'expense', 0, 0),
  ('cat_housing',    'Housing',    'expense', 0, 0),
  ('cat_utilities',  'Utilities',  'expense', 0, 0),
  ('cat_phone',      'Phone and internet', 'expense', 0, 0),
  ('cat_health',     'Health',     'expense', 0, 0),
  ('cat_shopping',   'Shopping',   'expense', 0, 0),
  ('cat_family',     'Family and gifts', 'expense', 0, 0),
  ('cat_learning',   'Learning',   'expense', 0, 0),
  ('cat_other',      'Other',      'expense', 0, 0),
  ('cat_salary',     'Salary',     'income',  0, 0),
  ('cat_income',     'Other income', 'income', 0, 0);
