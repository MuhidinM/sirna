-- Repeating tasks (T-068). repeat_json holds the same rule as bills
-- ({"every":"week","days":[5]}); repeat_of links a copy to the one before,
-- so each finished task gets exactly one next copy.
ALTER TABLE task_items ADD COLUMN repeat_json TEXT;
ALTER TABLE task_items ADD COLUMN repeat_of TEXT;
CREATE INDEX task_items_repeat_of ON task_items (repeat_of);
