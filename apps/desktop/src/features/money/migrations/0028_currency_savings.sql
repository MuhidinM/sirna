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
-- From now on: transfers it had before stay as they were (money.savings_since,
-- the moment each account became savings, epoch ms; see savingsOps).
INSERT INTO core_settings (key, value_json, updated_at)
SELECT 'money.savings_since',
       json_group_object(id, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM money_accounts
WHERE deleted_at IS NULL AND is_savings = 1
HAVING count(*) > 0
ON CONFLICT (key) DO UPDATE SET
  value_json = json_patch(core_settings.value_json, excluded.value_json),
  updated_at = excluded.updated_at;
-- Wise turns to dollars only while it holds nothing: birr already typed in
-- (an opening balance or entries) would otherwise read as dollars.
UPDATE money_accounts SET currency = 'USD'
  WHERE deleted_at IS NULL AND lower(name) = 'wise'
    AND COALESCE(opening_minor, 0) = 0
    AND NOT EXISTS (SELECT 1 FROM money_txns m WHERE m.account = money_accounts.id);

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
