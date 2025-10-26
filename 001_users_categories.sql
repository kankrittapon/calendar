PRAGMA foreign_keys = ON;

-- ========= users =========
-- เก็บสิทธิ์บทบาทจาก LINE user id + api_key (สำหรับหน้าเว็บของเลขา)
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  line_user_id  TEXT UNIQUE,                                -- จาก LINE (Uxxxxxxxx)
  name          TEXT,
  role          TEXT NOT NULL CHECK (role IN ('boss','secretary')),
  api_key       TEXT UNIQUE,                                -- ใช้เป็น Bearer token สำหรับเว็บเลขา
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- ========= categories =========
CREATE TABLE IF NOT EXISTS categories (
  id         TEXT PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,                          -- 'internal' | 'department' | 'big' | 'external' | ...
  label      TEXT NOT NULL,                                 -- ชื่อที่แสดง
  color      TEXT NOT NULL,                                 -- ควรเป็น HEX เช่น #22c55e
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- seed ค่าพื้นฐาน (INSERT OR IGNORE ป้องกันซ้ำ)
INSERT OR IGNORE INTO categories (id, code, label, color, created_at, updated_at) VALUES
  ('00000000-0000-0000-0000-000000000001', 'internal',   'งานในหน่วย',   '#22c55e', datetime('now'), datetime('now')),
  ('00000000-0000-0000-0000-000000000002', 'department', 'งานในกรม',     '#facc15', datetime('now'), datetime('now')),
  ('00000000-0000-0000-0000-000000000003', 'big',        'งานใหญ่',       '#ef4444', datetime('now'), datetime('now')),
  ('00000000-0000-0000-0000-000000000004', 'external',   'งานนอก',        '#38bdf8', datetime('now'), datetime('now'));
