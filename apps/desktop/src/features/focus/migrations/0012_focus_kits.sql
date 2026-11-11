-- Focus kits (plan §3.6a): what the set-up sheet does when a session starts
-- in an area. Lists are JSON arrays of strings.
--   open_json      URLs, files, folders, or a command such as `code D:\Projects\sirna`
--   minimize_json  program names to minimize (never closed), e.g. "Telegram.exe"
--   checklist_json ticks shown on the sheet; they never block the start
CREATE TABLE focus_kits (
  area_id        TEXT PRIMARY KEY REFERENCES area_items (id),
  open_json      TEXT    NOT NULL DEFAULT '[]',
  minimize_json  TEXT    NOT NULL DEFAULT '[]',
  checklist_json TEXT    NOT NULL DEFAULT '[]',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

-- Starting kits. Opens stay empty until you add your own folders and links
-- (Today → Focus kits); the gym kit has no screen steps.
INSERT INTO focus_kits (area_id, minimize_json, checklist_json, created_at, updated_at) VALUES
  ('coding',      '["Telegram.exe"]', '["Phone in another room", "Water on the desk", "Do not disturb on (Win+N)"]', 0, 0),
  ('experiments', '["Telegram.exe"]', '["Phone in another room", "Water on the desk", "Do not disturb on (Win+N)"]', 0, 0),
  ('jobhunt',     '["Telegram.exe"]', '["Phone face down", "Water on the desk", "Do not disturb on (Win+N)"]', 0, 0),
  ('admin',       '[]',               '["Water on the desk"]', 0, 0),
  ('quran',       '["Telegram.exe"]', '["Phone in another room"]', 0, 0),
  ('gym',         '[]',               '[]', 0, 0),
  ('joba',        '[]',               '["Do not disturb on (Win+N)"]', 0, 0),
  ('jobb',        '[]',               '["Do not disturb on (Win+N)"]', 0, 0);
