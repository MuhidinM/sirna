-- Steps of a split task keep their order (T-051). parent_id is the task it
-- was split from; step_no counts from 1. A step is offered only once the
-- steps before it are done or dropped.
ALTER TABLE task_items ADD COLUMN parent_id TEXT;
ALTER TABLE task_items ADD COLUMN step_no INTEGER;
CREATE INDEX task_items_parent ON task_items (parent_id, step_no);

-- Splits made before this change: origin is "split:<parent id>", and the
-- steps were written in order in one transaction.
UPDATE task_items
SET parent_id = substr(origin, 7),
    step_no = (
      SELECT count(*) FROM task_items AS s
      WHERE s.origin = task_items.origin AND s.rowid <= task_items.rowid
    )
WHERE origin LIKE 'split:%';
