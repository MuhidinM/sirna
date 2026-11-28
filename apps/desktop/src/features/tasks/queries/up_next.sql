-- Up next (T-086, R-RUN-03): the one order the tray and Today offer work in.
-- Open to-do tasks only: not waiting or someday, not one whose reminder is
-- still ahead, not one planned for a later day, not a later step while a step
-- before it is open, and not a timed task still ahead today (it has its time).
-- Order, first to last:
--   0 in hand: open in a run started today (latest run first, then its lane order)
--   1 due soon: a deadline within 2 days, soonest first (a deadline an old
--     carry may have written, deadline_stale, is not one)
--   2 pinned: chosen for today (task_daily_top)
--   3 planned for today or earlier
--   4 the rest
-- Ties take turns by area, so each job gets a turn before any job gets a
-- second (areas of kind 'work' are jobs and go first in a turn); then the
-- area's planning rank; then oldest first.
-- Rust reads the first two columns by position: keep id, title first.
-- ?1 = logical date (YYYY-MM-DD), ?2 = start of that logical day (UTC epoch ms),
-- ?3 = now (UTC epoch ms), ?4 = how many.
-- Shared by the tray (Rust, include_str!) and Today (TypeScript, ?raw).
WITH hand AS (
  SELECT r.task_id, MAX(s.started_at) AS run_at, MIN(r.position) AS lane
  FROM focus_run_tasks AS r
  JOIN focus_sessions AS s ON s.id = r.session_id
  WHERE s.kind = 'focus' AND s.started_at >= ?2 AND r.result IS NOT 'done'
  GROUP BY r.task_id
),
candidates AS (
  SELECT t.id, t.title, t.area_id, t.estimate_min, t.created_at, t.due_at, t.planned_date,
         CASE WHEN t.deadline_stale = 1 THEN NULL ELSE t.due_date END AS deadline,
         a.kind AS area_kind, a.priority_rank AS area_rank,
         hand.run_at, hand.lane, top.position AS pin
  FROM task_items AS t
  LEFT JOIN area_items AS a ON a.id = t.area_id
  LEFT JOIN hand ON hand.task_id = t.id
  LEFT JOIN task_daily_top AS top ON top.task_id = t.id AND top.logical_date = ?1
  WHERE t.deleted_at IS NULL AND t.status = 'todo'
    AND (t.remind_at IS NULL OR t.remind_at <= ?3)
    AND (t.planned_date IS NULL OR t.planned_date <= ?1)
    AND NOT (t.due_at IS NOT NULL AND t.due_at > ?3 AND t.due_at < ?2 + 86400000)
    AND NOT EXISTS (
      SELECT 1 FROM task_items AS before_step
      WHERE before_step.parent_id = t.parent_id AND before_step.step_no < t.step_no
        AND before_step.status IN ('todo', 'waiting') AND before_step.deleted_at IS NULL)
),
tiered AS (
  SELECT c.*,
         CASE
           WHEN c.run_at IS NOT NULL THEN 0
           WHEN c.deadline IS NOT NULL AND c.deadline <= date(?1, '+2 days') THEN 1
           WHEN c.pin IS NOT NULL THEN 2
           WHEN c.planned_date IS NOT NULL THEN 3
           ELSE 4
         END AS tier
  FROM candidates AS c
),
keyed AS (
  SELECT t.*,
         CASE WHEN t.tier = 0 THEN -t.run_at END AS k1,
         CASE t.tier WHEN 0 THEN t.lane WHEN 1 THEN t.deadline WHEN 2 THEN t.pin END AS k2,
         CASE WHEN t.tier = 1 THEN COALESCE(t.due_at, 9e15) END AS k3
  FROM tiered AS t
),
turns AS (
  SELECT k.*,
         ROW_NUMBER() OVER (
           PARTITION BY k.tier, k.k1, k.k2, k.k3, COALESCE(k.area_id, '')
           ORDER BY k.created_at, k.id) AS turn
  FROM keyed AS k
)
SELECT id, title, area_id, tier, deadline AS due_date, estimate_min
FROM turns
ORDER BY tier, k1, k2, k3, turn,
         CASE WHEN area_kind = 'work' THEN 0 ELSE 1 END,
         COALESCE(area_rank, 99), created_at, id
LIMIT ?4
