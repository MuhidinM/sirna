-- When you last checked an account's balance (epoch ms; NULL = never). A
-- check that matches books nothing, so undoing an earlier capture needs this
-- to know the balance was confirmed since (capture/queries/undo_blocked.sql).
ALTER TABLE money_accounts ADD COLUMN checked_at INTEGER;
