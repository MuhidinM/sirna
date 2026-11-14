-- The day you plan to do a task, apart from its deadline (T-050).
-- due_date stays the deadline; planned_date, when set, decides which day's
-- list the task is on. Moving a task (night review, "Tomorrow") sets only
-- planned_date, so a deadline is never rewritten by a move.
ALTER TABLE task_items ADD COLUMN planned_date TEXT;
-- 1 = the deadline may be one an old carry wrote; cleared when you edit it.
ALTER TABLE task_items ADD COLUMN deadline_stale INTEGER NOT NULL DEFAULT 0;

-- Tasks carried before this change: their due_date is the carry, not a real
-- deadline. Keep the day, and ask once to check the deadline.
UPDATE task_items
SET planned_date = due_date, deadline_stale = 1
WHERE carries > 0 AND due_date IS NOT NULL AND status IN ('todo', 'waiting', 'someday');
