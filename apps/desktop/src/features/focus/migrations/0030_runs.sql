-- Runs with task lanes (T-084, R-RUN-01). A run is a focus session that holds
-- one or more tasks; each task is a lane you start, pause and finish on its
-- own. Written by the Rust timer (focus.rs), never by the webview.
--
-- focus_sessions.task_id and area_id keep the run's first task, so queries
-- written before runs still read something sensible.
ALTER TABLE focus_sessions ADD COLUMN run_of TEXT;            -- a break or "+5 min": the run it follows
ALTER TABLE focus_sessions ADD COLUMN checked_out_at INTEGER;  -- set by the check-out (T-088)
ALTER TABLE focus_sessions ADD COLUMN backdated INTEGER NOT NULL DEFAULT 0;

-- The tasks of a run. area_id is a snapshot taken when the task joined, so
-- moving a task to another area later doesn't rewrite where past time went.
-- effort_min, wall_min and clean are filled when the run closes.
CREATE TABLE focus_run_tasks (
  session_id  TEXT    NOT NULL REFERENCES focus_sessions (id),
  task_id     TEXT    NOT NULL REFERENCES task_items (id),
  area_id     TEXT,
  position    INTEGER NOT NULL,
  result      TEXT CHECK (result IN ('done', 'open', 'same', 'unknown')),
  next_step   TEXT,
  effort_min  REAL,                    -- the task's share of the run (v_focus_share)
  wall_min    INTEGER,                 -- clock time its lane ran, shared or not
  clean       INTEGER,                 -- 1: done live, mostly on its own; teaches its time
  PRIMARY KEY (session_id, task_id)
) WITHOUT ROWID;
CREATE INDEX focus_run_tasks_task ON focus_run_tasks (task_id);

-- When each lane ran. end_at is NULL while it runs; every open span closes
-- with 'run_end' when the run's focus part ends.
CREATE TABLE focus_lane_spans (
  id          INTEGER PRIMARY KEY,
  session_id  TEXT    NOT NULL,
  task_id     TEXT    NOT NULL,
  start_at    INTEGER NOT NULL,
  end_at      INTEGER,
  end_kind    TEXT CHECK (end_kind IN ('done', 'pause', 'run_end')),
  FOREIGN KEY (session_id, task_id) REFERENCES focus_run_tasks (session_id, task_id)
);
CREATE INDEX focus_lane_spans_session ON focus_lane_spans (session_id, start_at);

-- Minutes of focus per (session, task, area), shared fairly between lanes:
-- each moment of a run is split equally among the lanes running then, and a
-- moment with no lane running is split across all the run's tasks. A run's
-- shares are scaled to its focus time (wall time less pauses), so they always
-- add up to the run's length and pay per hour stays honest.
-- A session with no run rows (every session before runs) counts in full for
-- its own task and area, in whole minutes as before.
-- Only ended focus sessions: a running one has no length yet.
CREATE VIEW v_focus_share AS
WITH runs AS (
  SELECT s.id, s.started_at AS s0, s.ended_at AS s1,
         MAX(0, s.ended_at - s.started_at - s.paused_ms) AS focus_ms
  FROM focus_sessions AS s
  WHERE s.kind = 'focus' AND s.ended_at IS NOT NULL AND s.ended_at > s.started_at
    AND EXISTS (SELECT 1 FROM focus_run_tasks AS r WHERE r.session_id = s.id)
),
spans AS (
  SELECT p.session_id, p.task_id,
         MAX(p.start_at, runs.s0) AS a,
         MIN(COALESCE(p.end_at, runs.s1), runs.s1) AS b
  FROM focus_lane_spans AS p JOIN runs ON runs.id = p.session_id
),
points AS (
  SELECT id AS session_id, s0 AS t FROM runs
  UNION SELECT id, s1 FROM runs
  UNION SELECT session_id, a FROM spans WHERE b > a
  UNION SELECT session_id, b FROM spans WHERE b > a
),
pieces AS (
  SELECT session_id, a, b FROM (
    SELECT session_id, t AS a, LEAD(t) OVER (PARTITION BY session_id ORDER BY t) AS b FROM points)
  WHERE b IS NOT NULL AND b > a
),
covered AS (
  SELECT DISTINCT x.session_id, x.a, x.b, sp.task_id
  FROM pieces AS x
  JOIN spans AS sp ON sp.session_id = x.session_id AND sp.a <= x.a AND sp.b >= x.b
),
shared AS (
  SELECT c.session_id, c.task_id,
         (c.b - c.a) * 1.0 / (SELECT count(*) FROM covered AS o
                              WHERE o.session_id = c.session_id AND o.a = c.a) AS ms
  FROM covered AS c
  UNION ALL
  SELECT x.session_id, r.task_id,
         (x.b - x.a) * 1.0 / (SELECT count(*) FROM focus_run_tasks AS k
                              WHERE k.session_id = x.session_id) AS ms
  FROM pieces AS x JOIN focus_run_tasks AS r ON r.session_id = x.session_id
  WHERE NOT EXISTS (SELECT 1 FROM covered AS c WHERE c.session_id = x.session_id AND c.a = x.a)
)
SELECT r.session_id, r.task_id, r.area_id, runs.s0 AS started_at,
       COALESCE((SELECT SUM(m.ms) FROM shared AS m
                 WHERE m.session_id = r.session_id AND m.task_id = r.task_id), 0)
         * runs.focus_ms / (runs.s1 - runs.s0) / 60000.0 AS minutes
FROM focus_run_tasks AS r JOIN runs ON runs.id = r.session_id
UNION ALL
SELECT s.id, s.task_id, s.area_id, s.started_at,
       MAX(0, (s.ended_at - s.started_at - s.paused_ms) / 60000) AS minutes
FROM focus_sessions AS s
WHERE s.kind = 'focus' AND s.ended_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM focus_run_tasks AS r WHERE r.session_id = s.id);
