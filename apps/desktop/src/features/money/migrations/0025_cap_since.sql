-- The first day a category's cap applied (T-066 review): a past month is
-- judged only against a cap that existed then. Raising a cap keeps the day.
ALTER TABLE money_categories ADD COLUMN cap_since TEXT;
