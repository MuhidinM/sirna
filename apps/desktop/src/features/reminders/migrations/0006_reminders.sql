-- What has been shown, so nothing fires twice (plan §5.2, §8).
CREATE TABLE core_notifications (
  key           TEXT PRIMARY KEY,        -- feature:entity:occurrence, e.g. task:01J…:1794466800000
  kind          TEXT    NOT NULL,        -- task | follow_up | summary | check
  fired_at      INTEGER NOT NULL,
  counted       INTEGER NOT NULL DEFAULT 0, -- counts toward the daily cap of app toasts
  outcome       TEXT CHECK (outcome IN ('done', 'snoozed', 'clicked', 'dismissed', 'summarized', 'expired')),
  outcome_at    INTEGER,
  snoozed_until INTEGER
);
CREATE INDEX core_notifications_fired ON core_notifications (fired_at);

-- Reminders a feature wants to show, in one shape the Rust tick unions
-- (plan §4.4). Times are UTC epoch ms.
CREATE VIEW v_reminders_task AS
  SELECT 'task:' || id || ':' || remind_at AS key,
         'task'        AS kind,
         id            AS entity_id,
         remind_at     AS fire_at,
         title         AS title,
         NULL          AS body
  FROM task_items
  WHERE deleted_at IS NULL AND status IN ('todo', 'waiting') AND remind_at IS NOT NULL
  UNION ALL
  -- Waiting-on follow-ups at 09:00 local (06:00 UTC) on their date.
  SELECT 'follow_up:' || id || ':' || follow_up_date,
         'follow_up',
         id,
         CAST((julianday(follow_up_date) - 2440587.5) * 86400000 AS INTEGER) + 6 * 3600000,
         'Follow up: ' || COALESCE(waiting_on, title),
         NULL
  FROM task_items
  WHERE deleted_at IS NULL AND status = 'waiting' AND follow_up_date IS NOT NULL;
