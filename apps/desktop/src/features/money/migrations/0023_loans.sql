-- Money lent and owed (T-061). Each event is one row; what is open per
-- person is the sum. Every event also moves money in an account (a
-- money_txns row with transfer_id 'loan:<event id>'), which keeps it out of
-- in and out: lending isn't spending, and being paid back isn't income.
CREATE TABLE money_loans (
  id             TEXT PRIMARY KEY,
  person         TEXT    NOT NULL,   -- as you type it; matched without case
  kind           TEXT    NOT NULL CHECK (kind IN ('lent', 'borrowed', 'paid_me', 'i_paid')),
  amount_minor   INTEGER NOT NULL CHECK (amount_minor > 0),
  local_date     TEXT    NOT NULL,
  account        TEXT    NOT NULL DEFAULT 'cash',
  note           TEXT,
  follow_up_date TEXT,               -- ask about it from this day
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  deleted_at     INTEGER
);
CREATE INDEX money_loans_person ON money_loans (person, local_date);
