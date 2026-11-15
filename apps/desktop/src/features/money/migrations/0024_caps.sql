-- A monthly spending cap per category (T-063). NULL = no cap.
ALTER TABLE money_categories ADD COLUMN cap_minor INTEGER CHECK (cap_minor IS NULL OR cap_minor > 0);
