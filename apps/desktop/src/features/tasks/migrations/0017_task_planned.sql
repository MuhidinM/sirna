-- The day you plan to do a task, apart from its deadline (T-050).
-- due_date stays the deadline; planned_date, when set, decides which day's
-- list the task is on. Moving a task (night review, "Tomorrow") sets only
-- planned_date, so a deadline is never rewritten by a move.
ALTER TABLE task_items ADD COLUMN planned_date TEXT;
-- 1 = the deadline may be one an old carry wrote; cleared when you edit it.
ALTER TABLE task_items ADD COLUMN deadline_stale INTEGER NOT NULL DEFAULT 0;

-- Tasks whose last date change was a night-review carry: their due_date is
-- the carry, not a real deadline. Keep the day, and ask once to check the
-- deadline. The audit log says which write changed the date last, so a task
-- re-dated by hand after a carry keeps its deadline, and one whose carry
-- count was reset ("Smaller") is still caught.
UPDATE task_items
SET planned_date = due_date, deadline_stale = 1
WHERE due_date IS NOT NULL
  AND status IN ('todo', 'waiting', 'someday')
  AND (
    SELECT a.context FROM core_activity a
    WHERE a.entity_type = 'task_items' AND a.entity_id = task_items.id AND a.action = 'update'
      AND json_extract(a.before_json, '$.due_date') IS NOT json_extract(a.after_json, '$.due_date')
    ORDER BY a.at DESC, a.id DESC
    LIMIT 1
  ) = 'review';
