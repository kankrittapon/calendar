PRAGMA foreign_keys = ON;

/* เพิ่มคอลัมน์ใหม่ใน schedules (รันครั้งเดียวพอ) */
ALTER TABLE schedules ADD COLUMN category_id   TEXT;                             -- FK → categories.id (อาจว่างได้)
ALTER TABLE schedules ADD COLUMN place         TEXT;                             -- สถานที่
ALTER TABLE schedules ADD COLUMN attend_status TEXT CHECK (attend_status IN ('yes','no')) NULL;  -- สถานะจากหัวหน้า

/* ดัชนีช่วยค้น */
CREATE INDEX IF NOT EXISTS idx_schedules_date       ON schedules(date);
CREATE INDEX IF NOT EXISTS idx_schedules_category   ON schedules(category_id);
CREATE INDEX IF NOT EXISTS idx_schedules_attend     ON schedules(attend_status);

/* (ออปชัน) เปิดใช้ FK ถ้าต้องการเข้มงวด
   หมายเหตุ: SQLite ต้อง PRAGMA foreign_keys=ON ตอนเชื่อมต่อถึงจะบังคับจริง
-- UPDATE schedules SET category_id=NULL WHERE category_id NOT IN (SELECT id FROM categories);
*/
