-- 004_add_line_targets.sql
CREATE TABLE IF NOT EXISTS line_targets (
  line_user_id TEXT PRIMARY KEY,
  display_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Add index for faster lookups
CREATE INDEX IF NOT EXISTS idx_line_targets_line_user_id ON line_targets(line_user_id);

-- Add triggers to maintain updated_at
CREATE TRIGGER IF NOT EXISTS tg_line_targets_updated_at
  AFTER UPDATE ON line_targets
  FOR EACH ROW
  BEGIN
    UPDATE line_targets SET updated_at = datetime('now')
    WHERE line_user_id = NEW.line_user_id;
  END;