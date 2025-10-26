PRAGMA foreign_keys = ON;

/* users ตัวอย่าง: boss + secretary (api_key สำหรับเว็บเลขา) */
INSERT OR IGNORE INTO users (id, line_user_id, name, role, api_key, created_at, updated_at) VALUES
  ('11111111-1111-1111-1111-111111111111', 'Ue358aad024251165657dfcb85c8755fe', 'หัวหน้า (ตัวอย่าง)', 'boss',       NULL,                       datetime('now'), datetime('now')),
  ('22222222-2222-2222-2222-222222222222', 'U11ccc3522ff35b9994303b3c1a2155c8', 'เลขา (ตัวอย่าง)',   'secretary', 'secretary-demo-key-123',  datetime('now'), datetime('now'));

/* line_targets (สำหรับ push แจ้งไปยัง LINE user/group/room) */
INSERT OR IGNORE INTO line_targets (id, type, display_name, note, is_enabled, added_at, updated_at) VALUES
  ('Ue358aad024251165657dfcb85c8755fe', 'user', 'หัวหน้า (ตัวอย่าง)', 'seed', 1, datetime('now'), datetime('now')),
  ('U11ccc3522ff35b9994303b3c1a2155c8', 'user', 'เลขา (ตัวอย่าง)',   'seed', 1, datetime('now'), datetime('now'));
