-- Editable categories and goals (T-055). A goal can have a date to reach it
-- by; the Money page shows what that takes a month.
ALTER TABLE savings_goals ADD COLUMN target_date TEXT;
