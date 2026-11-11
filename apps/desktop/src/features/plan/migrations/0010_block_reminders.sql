-- Toasts for today's blocks (plan §3.6, §8), in the shape the Rust tick reads.
--
-- * A focus block or a routine (Quran, gym, email check) gets one toast when it
--   starts. Work blocks stay silent, and the night review has its own prompt.
-- * A focus block with no session started within 10 minutes gets one nudge.
CREATE VIEW v_reminders_block AS
  SELECT 'block:' || id AS key,
         'block'        AS kind,
         id             AS entity_id,
         start_at       AS fire_at,
         title          AS title,
         NULL           AS body
  FROM day_blocks
  WHERE deleted_at IS NULL AND status = 'planned'
    AND kind IN ('area', 'routine') AND title != 'Night review'
  UNION ALL
  SELECT 'nudge:' || b.id,
         'nudge',
         b.id,
         b.start_at + 600000,
         b.title,
         NULL
  FROM day_blocks AS b
  WHERE b.deleted_at IS NULL AND b.status = 'planned' AND b.kind = 'area'
    AND NOT EXISTS (
      SELECT 1 FROM focus_sessions AS f
      WHERE f.kind = 'focus' AND f.started_at >= b.start_at - 600000 AND f.started_at < b.end_at
    );
