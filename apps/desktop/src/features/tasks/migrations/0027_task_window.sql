-- Time first (docs/proposals/time-first.md): a task can ask for a part of the
-- day ("tomorrow morning") instead of an exact time (due_at).
ALTER TABLE task_items ADD COLUMN planned_window TEXT
  CHECK (planned_window IN ('morning', 'afternoon', 'evening'));
