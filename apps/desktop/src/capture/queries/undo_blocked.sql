-- What undoing or fixing a capture would throw away (F2, F65): one row per
-- record the capture added (and the away setting or block it changed), with
--   entity_type: the table, or 'note_items:cheat' for a cheat-sheet line,
--                or 'core_settings:prayer.city' for `I'm in Adama`,
--   inserted: 1 when the capture added the record,
--   gone:     1 when that record has been deleted since,
--   changed:  1 when anything else has changed it since (an edit, a tick, a delete;
--             not a task only put into a project or under a parent, and not a
--             change you have undone since), or, for a loan, when a later loan
--             event for the same person (a repayment on Money) leans on it,
--   checked:  the name of an account it moved that has been checked since
--             (any balance check sets checked_at, a matching one too; older
--             checks show as a booked gap or a changed opening balance).
-- Undoing a record you have changed would throw your change away; undoing an
-- entry after a check would move the balance off the number you typed.
-- Rust reads the columns by position: keep this order.
-- ?1 = 'capture:<raw id>'.
-- Shared by capture_undo, capture_replace and the tray (Rust, include_str!)
-- and the capture bar (TypeScript, ?raw).
SELECT CASE WHEN a.entity_type = 'note_items' AND json_extract(a.after_json, '$.kind') = 'cheat'
            THEN 'note_items:cheat'
            WHEN a.entity_type = 'core_settings' AND a.entity_id = 'prayer.city'
            THEN 'core_settings:prayer.city' ELSE a.entity_type END AS entity_type,
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
       (EXISTS (SELECT 1 FROM core_activity b
               WHERE b.entity_type = a.entity_type AND b.entity_id = a.entity_id
                 AND b.id > a.id AND (b.context IS NULL OR b.context != a.context)
                 AND b.action != 'undo'
                 -- A later change you have undone since doesn't count (reg2-6).
                 AND NOT EXISTS (SELECT 1 FROM core_activity u
                                 WHERE u.context = 'undo:' || b.context AND u.action = 'undo')
                 -- Putting a task into a project or under a parent only
                 -- links it: a fix carries those links over, so they don't count.
                 AND NOT (a.entity_type = 'task_items' AND b.action = 'update'
                          AND json_remove(b.before_json, '$.project_id', '$.parent_id', '$.step_no',
                                          '$.updated_at', '$.user_edited_at')
                           IS json_remove(b.after_json, '$.project_id', '$.parent_id', '$.step_no',
                                          '$.updated_at', '$.user_edited_at')))
        -- A repayment written later for the same person counts against this
        -- loan: undoing the loan alone would flip the debt (reg2-2).
        OR (a.entity_type = 'money_loans' AND EXISTS (
              SELECT 1 FROM core_activity c
              JOIN money_loans l ON l.id = c.entity_id
              WHERE c.entity_type = 'money_loans' AND c.action = 'insert' AND c.id > a.id
                AND (c.context IS NULL OR c.context != a.context)
                AND l.deleted_at IS NULL
                AND lower(trim(l.person)) = lower(trim(json_extract(a.after_json, '$.person')))))) AS changed,
       (SELECT m.name FROM money_accounts m
        WHERE a.entity_type = 'money_txns' AND m.id = json_extract(a.after_json, '$.account')
          AND (EXISTS (SELECT 1 FROM money_txns r
                       JOIN core_activity c ON c.entity_type = 'money_txns' AND c.entity_id = r.id
                       WHERE r.origin = 'reconcile' AND r.deleted_at IS NULL AND r.account = m.id
                         AND c.action = 'insert' AND c.id > a.id)
               OR EXISTS (SELECT 1 FROM core_activity c
                          WHERE c.entity_type = 'money_accounts' AND c.entity_id = m.id
                            AND c.id > a.id AND c.action = 'update'
                            AND (json_extract(c.after_json, '$.checked_at')
                                   IS NOT json_extract(c.before_json, '$.checked_at')
                                 OR json_extract(c.after_json, '$.opening_minor')
                                   IS NOT json_extract(c.before_json, '$.opening_minor'))))) AS checked
FROM core_activity a
WHERE a.context = ?1 AND a.action != 'undo'
  -- `skipped quran` changes a block: a later move of it counts too (reg2-1).
  AND (a.action = 'insert' OR a.entity_type IN ('core_settings', 'day_blocks'))
ORDER BY a.id
