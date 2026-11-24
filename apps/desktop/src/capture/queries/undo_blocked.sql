-- What undoing or fixing a capture would throw away (F2, F65): one row per
-- record the capture added (and the away setting it wrote), with
--   inserted: 1 when the capture added the record,
--   gone:     1 when that record has been deleted since,
--   changed:  1 when anything else has changed it since (an edit, a tick, a delete),
--   checked:  the name of an account it moved that has been checked since
--             (a balance check booked a gap, or set the opening balance).
-- Undoing a record you have changed would throw your change away; undoing an
-- entry after a check would move the balance off the number you typed.
-- Rust reads the columns by position: keep this order.
-- ?1 = 'capture:<raw id>'.
-- Shared by capture_undo, capture_replace and the tray (Rust, include_str!)
-- and the capture bar (TypeScript, ?raw).
SELECT a.entity_type,
       a.action = 'insert' AS inserted,
       CASE a.entity_type
         WHEN 'task_items' THEN NOT EXISTS (SELECT 1 FROM task_items x WHERE x.id = a.entity_id AND x.deleted_at IS NULL)
         WHEN 'note_items' THEN NOT EXISTS (SELECT 1 FROM note_items x WHERE x.id = a.entity_id AND x.deleted_at IS NULL)
         WHEN 'money_txns' THEN NOT EXISTS (SELECT 1 FROM money_txns x WHERE x.id = a.entity_id AND x.deleted_at IS NULL)
         WHEN 'money_loans' THEN NOT EXISTS (SELECT 1 FROM money_loans x WHERE x.id = a.entity_id AND x.deleted_at IS NULL)
         WHEN 'project_items' THEN NOT EXISTS (SELECT 1 FROM project_items x WHERE x.id = a.entity_id AND x.deleted_at IS NULL)
         WHEN 'savings_entries' THEN NOT EXISTS (SELECT 1 FROM savings_entries x WHERE x.id = a.entity_id AND x.deleted_at IS NULL)
         ELSE 0
       END AS gone,
       EXISTS (SELECT 1 FROM core_activity b
               WHERE b.entity_type = a.entity_type AND b.entity_id = a.entity_id
                 AND b.id > a.id AND (b.context IS NULL OR b.context != a.context)
                 AND b.action != 'undo') AS changed,
       (SELECT m.name FROM money_accounts m
        WHERE a.entity_type = 'money_txns' AND m.id = json_extract(a.after_json, '$.account')
          AND (EXISTS (SELECT 1 FROM money_txns r
                       JOIN core_activity c ON c.entity_type = 'money_txns' AND c.entity_id = r.id
                       WHERE r.origin = 'reconcile' AND r.deleted_at IS NULL AND r.account = m.id
                         AND c.action = 'insert' AND c.id > a.id)
               OR EXISTS (SELECT 1 FROM core_activity c
                          WHERE c.entity_type = 'money_accounts' AND c.entity_id = m.id
                            AND c.id > a.id AND c.action = 'update'
                            AND json_extract(c.after_json, '$.opening_minor')
                                IS NOT json_extract(c.before_json, '$.opening_minor')))) AS checked
FROM core_activity a
WHERE a.context = ?1 AND a.action != 'undo'
  AND (a.action = 'insert' OR a.entity_type = 'core_settings')
ORDER BY a.id
