-- One fixture for Up next, loaded by both up_next.test.ts and the Rust test
-- in tasks.rs, so the tray and Today are checked against the same order.
-- Now is 2026-11-11 12:00 Addis (1794387600000); the logical day started at
-- 03:00 (1794355200000).
INSERT INTO task_items (id, title, status, area_id, due_date, due_at, remind_at, planned_date,
                        deadline_stale, parent_id, step_no, created_at, updated_at) VALUES
  -- In hand: open in a run started this morning.
  ('hand',          'In hand',            'todo',    'coding',  NULL,         NULL,          NULL,          NULL,         0, NULL, NULL, 11, 0),
  -- In a run yesterday: not in hand any more.
  ('old-run',       'Old run',            'todo',    'coding',  NULL,         NULL,          NULL,          NULL,         0, NULL, NULL,  8, 0),
  -- Due soon, soonest first; a timed one already past counts by its time.
  ('due-tom',       'Due tomorrow',       'todo',    'jobb',    '2026-11-12', NULL,          NULL,          NULL,         0, NULL, NULL, 12, 0),
  ('due-past',      'Due 10:00',          'todo',    'joba',    '2026-11-11', 1794380400000, NULL,          NULL,         0, NULL, NULL, 13, 0),
  -- A timed task still ahead today has its own time: not offered.
  ('timed-later',   'Call at 15:00',      'todo',    'joba',    '2026-11-11', 1794398400000, NULL,          NULL,         0, NULL, NULL, 14, 0),
  ('due-far',       'Due next week',      'todo',    'jobhunt', '2026-11-20', NULL,          NULL,          NULL,         0, NULL, NULL,  6, 0),
  -- A date an old carry wrote is not a deadline: planned for today.
  ('stale',         'Stale date',         'todo',    NULL,      '2026-11-11', NULL,          NULL,          '2026-11-11', 1, NULL, NULL,  9, 0),
  ('pinned',        'Pinned',             'todo',    'admin',   NULL,         NULL,          NULL,          NULL,         0, NULL, NULL, 15, 0),
  ('planned',       'Planned yesterday',  'todo',    NULL,      NULL,         NULL,          NULL,          '2026-11-10', 0, NULL, NULL, 10, 0),
  ('later-day',     'Planned Friday',     'todo',    NULL,      NULL,         NULL,          NULL,          '2026-11-13', 0, NULL, NULL, 16, 0),
  ('remind-later',  'Reminder at 14:00',  'todo',    NULL,      NULL,         NULL,          1794394800000, NULL,         0, NULL, NULL, 17, 0),
  ('waiting',       'Waiting',            'waiting', NULL,      NULL,         NULL,          NULL,          NULL,         0, NULL, NULL, 18, 0),
  ('someday',       'Someday',            'someday', NULL,      NULL,         NULL,          NULL,          NULL,         0, NULL, NULL, 19, 0),
  ('done',          'Done',               'done',    NULL,      NULL,         NULL,          NULL,          NULL,         0, NULL, NULL, 20, 0),
  -- Steps: the second waits for the first.
  ('step1',         'Step 1',             'todo',    NULL,      NULL,         NULL,          NULL,          NULL,         0, 'p',  1,     7, 0),
  ('step2',         'Step 2',             'todo',    NULL,      NULL,         NULL,          NULL,          NULL,         0, 'p',  2,     7, 0),
  -- The rest take turns by area, jobs first in each turn.
  ('c1',            'Coding 1',           'todo',    'coding',  NULL,         NULL,          NULL,          NULL,         0, NULL, NULL,  0, 0),
  ('ja1',           'Job A 1',            'todo',    'joba',    NULL,         NULL,          NULL,          NULL,         0, NULL, NULL,  1, 0),
  ('ja2',           'Job A 2',            'todo',    'joba',    NULL,         NULL,          NULL,          NULL,         0, NULL, NULL,  2, 0),
  ('jb1',           'Job B 1',            'todo',    'jobb',    NULL,         NULL,          NULL,          NULL,         0, NULL, NULL,  3, 0),
  ('jb2',           'Job B 2',            'todo',    'jobb',    NULL,         NULL,          NULL,          NULL,         0, NULL, NULL,  4, 0),
  ('n1',            'No area',            'todo',    NULL,      NULL,         NULL,          NULL,          NULL,         0, NULL, NULL,  5, 0);

INSERT INTO task_daily_top (id, logical_date, position, task_id, created_at, updated_at)
  VALUES ('2026-11-11:1', '2026-11-11', 1, 'pinned', 0, 0);

INSERT INTO focus_sessions (id, kind, started_at, planned_min, ended_at, outcome) VALUES
  ('run-today', 'focus', 1794376800000, 30, 1794378600000, 'completed'),
  ('run-yesterday', 'focus', 1794290400000, 30, 1794292200000, 'completed');
INSERT INTO focus_run_tasks (session_id, task_id, area_id, position, result) VALUES
  ('run-today', 'hand', 'coding', 1, NULL),
  ('run-today', 'done', NULL, 2, 'done'),
  ('run-yesterday', 'old-run', 'coding', 1, NULL);
