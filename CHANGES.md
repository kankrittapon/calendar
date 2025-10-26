# ต้องการปรับปรุงระบบ Calendar


### 1. การแจ้งเตือนวันเสาร์-อาทิตย์
- ✅ ตรวจสอบวันเสาร์-อาทิตย์ ถ้าไม่มีงานจะไม่แจ้งเตือน
- ✅ เพิ่มตรรกะใน `sendDailyAgendaToBoss()` เพื่อข้าม weekend ที่ไม่มีงาน

### 2. การแจ้งเตือนงานพรุ่งนี้เวลา 20:00
- ✅ เพิ่ม cron trigger ใหม่: `"0 13 * * *"` (20:00 เวลาไทย)
- ✅ อัพเดท `scheduled()` function เพื่อจัดการทั้งเวลา 08:30 และ 20:00
- ✅ เพิ่ม parameter `type` เพื่อแยกระหว่าง "today" และ "tomorrow"
- ✅ อัพเดท `buildAgendaText()` และ `buildAgendaFlex()` เพื่อรองรับข้อความ "วันนี้" และ "พรุ่งนี้"

### 3. ระบบจัดการ Role ผ่าน Dropdown
- ✅ เพิ่ม API endpoints ใหม่:
  - `GET /admin/users` - ดูรายชื่อ users ทั้งหมด
  - `PATCH /admin/user/role` - อัพเดท role ของ user
  - `DELETE /admin/user/delete` - ลบ user
- ✅ เพิ่มหน้าจัดการ role ในหน้าทดสอบ
- ✅ เพิ่ม dropdown สำหรับเลือก user และ role
- ✅ เพิ่มฟังก์ชัน JavaScript สำหรับจัดการ role

### 4. เปลี่ยนจาก Text เป็น Flex Message
- ✅ เปลี่ยน default format จาก "text" เป็น "flex"
- ✅ อัพเดท `buildAgendaFlex()` เพื่อแสดงข้อความที่ถูกต้อง

### 5. แก้ไขการสร้างปฎิทิน
- ✅ อยากให้ระบุวันด้วยว่าเป็นวันอะไร monday tuesday wednesday thursday friday saturday และ sunday

## 🔧 การตั้งค่า Cron ใหม่

```json
"triggers": {
  "crons": [
    "*/5 * * * *",     // ทุก 5 นาที (สำหรับทดสอบ)
    "30 1 * * *",      // 08:30 เวลาไทย (สรุปงานวันนี้)
    "0 13 * * *"       // 20:00 เวลาไทย (สรุปงานพรุ่งนี้)
  ]
}
```

## 📋 วิธีใช้งานใหม่

### จัดการ Role ผู้ใช้
1. เข้าหน้า `/test`
2. ใส่ SEED_ADMIN_TOKEN
3. คลิก "โหลดรายชื่อผู้ใช้ทั้งหมด"
4. เลือกผู้ใช้จาก dropdown
5. เลือก role ใหม่ (Boss/Secretary)
6. คลิก "อัพเดท Role" หรือ "ลบผู้ใช้"

### การแจ้งเตือนใหม่
- **08:30** - แจ้งเตือนงานวันนี้
- **20:00** - แจ้งเตือนงานพรุ่งนี้
- **วันเสาร์-อาทิตย์** - ไม่แจ้งเตือนถ้าไม่มีงาน

## 🚀 การ Deploy

1. อัพเดท `wrangler.jsonc` ด้วย cron triggers ใหม่
2. Deploy ด้วย `wrangler deploy`
3. ทดสอบการทำงานผ่านหน้า `/test`