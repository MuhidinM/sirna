-- Currencies and savings accounts (docs/proposals/time-first.md §6).
-- Amounts stay in their own currency (minor units: cents for USD); totals
-- convert at a rate you set. A savings account backs the savings goals.
ALTER TABLE money_accounts ADD COLUMN currency TEXT NOT NULL DEFAULT 'ETB';
ALTER TABLE money_accounts ADD COLUMN is_savings INTEGER NOT NULL DEFAULT 0;
ALTER TABLE money_loans ADD COLUMN currency TEXT NOT NULL DEFAULT 'ETB';
ALTER TABLE money_regulars ADD COLUMN currency TEXT NOT NULL DEFAULT 'ETB';

-- A saving made by moving money into a savings account: which account, and
-- the transfer it belongs to (both halves share the transfer_id).
ALTER TABLE savings_entries ADD COLUMN account TEXT;
ALTER TABLE savings_entries ADD COLUMN transfer_id TEXT;

-- Your accounts (2026-11-23): a CBO savings account, and Wise in dollars.
INSERT OR IGNORE INTO money_accounts
  (id, name, kind, pays_in, sort_order, currency, is_savings, created_at, updated_at)
VALUES
  ('cbo-savings', 'CBO savings', 'bank',  0, 6, 'ETB', 1, 0, 0),
  ('wise',        'Wise',        'other', 0, 7, 'USD', 0, 0, 0);
