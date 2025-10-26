CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  date TEXT NOT NULL,        -- 'YYYY-MM-DD'
  start_time TEXT NOT NULL,  -- 'HH:MM'
  end_time TEXT,
  location TEXT,
  assignees TEXT,
  notes TEXT,
  status TEXT DEFAULT 'planned', -- planned | done | canceled
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications_sent (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL,
  type TEXT NOT NULL,            -- 'daily' | '30m'
  target TEXT NOT NULL,          -- line_user_id
  sent_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_schedules_date ON schedules(date);
CREATE INDEX IF NOT EXISTS idx_schedules_status ON schedules(status);
