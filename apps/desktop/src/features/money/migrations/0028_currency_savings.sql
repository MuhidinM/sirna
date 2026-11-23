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
-- If you already made them yourself, those are used, not copied.
UPDATE money_accounts SET is_savings = 1
  WHERE deleted_at IS NULL AND lower(name) LIKE 'cbo saving%';
UPDATE money_accounts SET currency = 'USD'
  WHERE deleted_at IS NULL AND lower(name) = 'wise';

INSERT INTO money_accounts
  (id, name, kind, pays_in, sort_order, currency, is_savings, created_at, updated_at)
SELECT 'cbo-savings', 'CBO savings', 'bank', 0, 6, 'ETB', 1, 0, 0
WHERE NOT EXISTS (
  SELECT 1 FROM money_accounts WHERE deleted_at IS NULL AND lower(name) LIKE 'cbo saving%');

INSERT INTO money_accounts
  (id, name, kind, pays_in, sort_order, currency, is_savings, created_at, updated_at)
SELECT 'wise', 'Wise', 'other', 0, 7, 'USD', 0, 0, 0
WHERE NOT EXISTS (
  SELECT 1 FROM money_accounts WHERE deleted_at IS NULL AND lower(name) = 'wise');
