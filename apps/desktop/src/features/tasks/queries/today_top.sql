-- Today's top 3 (plan §3.3 step 6, simplified until the day planner exists in M2):
-- tasks chosen for today first, then timed and dated tasks due today or overdue.
-- Done tasks stay visible for the day they were completed.
-- A task's day is its planned_date when set, else its deadline (T-050).
-- A deadline an old carry may have written (deadline_stale) is not shown or
-- ranked as a deadline until you confirm it.
-- Rust reads the first three columns by position: keep id, title, status first.
-- ?1 = logical date (YYYY-MM-DD), ?2 = start of that logical day (UTC epoch ms).
-- Shared by the tray (Rust, include_str!) and the Today screen (TypeScript, ?raw).
SELECT t.id, t.title, t.status, CASE WHEN t.deadline_stale = 1 THEN NULL ELSE t.due_date END AS due_date, t.due_at, t.estimate_min,
       t.area_id, t.planned_date, t.deadline_stale
FROM task_items AS t
LEFT JOIN task_daily_top AS top ON top.task_id = t.id AND top.logical_date = ?1
WHERE t.deleted_at IS NULL
  AND (
    (t.status = 'todo' AND (top.position IS NOT NULL OR COALESCE(t.planned_date, t.due_date) <= ?1))
    OR (t.status = 'done' AND t.completed_at >= ?2
        AND (top.position IS NOT NULL OR COALESCE(t.planned_date, t.due_date) <= ?1))
  )
ORDER BY
  CASE WHEN top.position IS NULL THEN 9 ELSE top.position END,
  CASE WHEN t.deadline_stale = 1 THEN NULL ELSE t.due_date END,
  CASE WHEN t.due_at IS NULL THEN 1 ELSE 0 END,
  t.due_at,
  t.created_at
LIMIT 3
