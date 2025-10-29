-- Line targets สำหรับเก็บ user ID ที่เพิ่งเข้ามา
CREATE TABLE IF NOT EXISTS line_targets (
  id TEXT PRIMARY KEY,
  line_user_id TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);