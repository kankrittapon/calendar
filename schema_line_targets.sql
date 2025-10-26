-- file: schema_line_targets.sql
CREATE TABLE IF NOT EXISTS line_targets (
  id TEXT PRIMARY KEY,               -- U... (user) / C... (group) / R... (room)
  type TEXT NOT NULL,                -- 'user' | 'group' | 'room'
  display_name TEXT,
  note TEXT,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  added_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- เก็บอีเวนต์ล่าสุดเผื่อ debug (ออปชัน)
CREATE TABLE IF NOT EXISTS line_event_logs (
  id TEXT PRIMARY KEY,
  event_ts TEXT NOT NULL,
  source_id TEXT,
  type TEXT,
  raw_json TEXT
);