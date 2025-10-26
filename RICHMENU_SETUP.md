# Rich Menu และระบบเลขา - คู่มือการใช้งาน

## ฟีเจอร์ใหม่ที่เพิ่มเข้ามา

### 1. Rich Menu สำหรับ Boss
Rich Menu จะแสดงเมนู 4 ปุ่มสำหรับหัวหน้า:
- **ดูตารางงานวันนี้** - แสดงงานประจำวันปัจจุบัน
- **ดูตารางงานพรุ่งนี้** - แสดงงานของวันถัดไป
- **ส่งข้อความให้เลขา** - เปิดโหมดส่งข้อความ
- **หน้าเลขา** - เปิดหน้าจัดการงาน

### 2. ระบบส่งข้อความให้เลขาทุกคน
- เมื่อ boss พิมพ์ข้อความใดๆ ข้อความจะถูกส่งไปยังเลขาทุกคน
- สามารถใช้คำสั่ง `ข้อความ:เนื้อหา` เพื่อส่งข้อความเฉพาะ
- ข้อความจะมี prefix "📢 ข้อความจากหัวหน้า:"

### 3. ระบบจัดการเลขาหลายคน
- สามารถเพิ่มเลขาหลายคนได้
- แค่เพิ่ม User ID ของเลขาแต่ละคนเข้าระบบ

## วิธีการตั้งค่า

### 1. ตั้งค่า Rich Menu
```bash
# เรียก API ตั้งค่า Rich Menu
POST /admin/richmenu/boss
Authorization: Bearer YOUR_SEED_ADMIN_TOKEN
```

### 2. เพิ่มเลขาใหม่
```bash
# เพิ่มเลขาคนใหม่
POST /admin/secretary/add
Authorization: Bearer YOUR_SEED_ADMIN_TOKEN
Content-Type: application/json

{
  "lineUserId": "U1234567890abcdef1234567890abcdef",
  "name": "เลขานุการคนที่ 1"
}
```

### 3. ดูรายชื่อเลขา
```bash
# ดูรายชื่อเลขาทั้งหมด
GET /admin/secretaries
Authorization: Bearer YOUR_SEED_ADMIN_TOKEN
```

## คำสั่งใหม่สำหรับ Boss ใน LINE

### คำสั่งพื้นฐาน
- `ดูตารางงานวันนี้` - แสดงตารางงานวันนี้
- `ดูตารางงานพรุ่งนี้` - แสดงตารางงานพรุ่งนี้
- `ส่งข้อความให้เลขา` - แสดงวิธีส่งข้อความ

### การส่งข้อความ
- `ข้อความ:กรุณาเตรียมเอกสารประชุม` - ส่งข้อความเฉพาะ
- พิมพ์ข้อความธรรมดา - จะส่งไปเลขาทุกคนโดยอัตโนมัติ

### การเพิ่มงาน (เดิม)
- `เพิ่มงาน:ประชุม,2025-01-15,14:00,ห้องประชุม,#งานในหน่วย`

## API Endpoints ใหม่

### Rich Menu Management
- `POST /admin/richmenu/boss` - ตั้งค่า Rich Menu สำหรับ Boss
- `POST /admin/richmenu/set/{userId}/{richMenuId}` - กำหนด Rich Menu ให้ user

### Secretary Management  
- `POST /admin/secretary/add` - เพิ่มเลขาใหม่
- `GET /admin/secretaries` - ดูรายชื่อเลขา
- `POST /test/send-to-secretaries` - ทดสอบส่งข้อความให้เลขา

## การทดสอบ

เข้าไปที่ `/test` เพื่อทดสอบฟีเจอร์ใหม่:

1. **ตั้งค่า Rich Menu** - ใส่ SEED_ADMIN_TOKEN และกดปุ่ม
2. **เพิ่มเลขา** - ใส่ LINE User ID และชื่อ
3. **ทดสอบส่งข้อความ** - ส่งข้อความทดสอบไปเลขาทุกคน

## ข้อมูลเพิ่มเติม

### Rich Menu Image
ระบบจะสร้างรูปภาพ Rich Menu แบบพื้นฐาน (สีเรียบ) โดยอัตโนมัติ
หากต้องการรูปภาพสวยงาม ให้แก้ไขฟังก์ชัน `createRichMenuImage()`

### Database Schema
ตาราง `users` มีฟิลด์:
- `role`: 'boss' หรือ 'secretary'  
- `line_user_id`: สำหรับเชื่อมต่อกับ LINE
- `api_key`: สำหรับ secretary เท่านั้น

### การแจ้งเตือน
- เมื่อเลขาเพิ่มงานใหม่ จะแจ้งเตือน boss อัตโนมัติ
- เมื่อ boss ส่งข้อความ จะส่งไปเลขาทุกคนที่มี `line_user_id`

## ตัวอย่างการใช้งาน

1. **Boss เปิด LINE** → เห็น Rich Menu 4 ปุ่ม
2. **กดปุ่ม "ดูตารางงานวันนี้"** → แสดงงานวันนี้พร้อมปุ่มยืนยันเข้าร่วม
3. **พิมพ์ "กรุณาเตรียมเอกสาร"** → ส่งไปเลขาทุกคน
4. **เลขาเพิ่มงานใหม่** → Boss ได้รับแจ้งเตือนทันที

## การ Deploy

1. อัปเดต environment variables:
   - `LINE_CHANNEL_ACCESS_TOKEN`
   - `LINE_CHANNEL_SECRET` 
   - `SEED_ADMIN_TOKEN`

2. Deploy worker ใหม่:
   ```bash
   wrangler deploy
   ```

3. ตั้งค่า Rich Menu:
   ```bash
   curl -X POST https://your-worker.workers.dev/admin/richmenu/boss \
     -H "Authorization: Bearer YOUR_SEED_ADMIN_TOKEN"
   ```

4. เพิ่มเลขา:
   ```bash
   curl -X POST https://your-worker.workers.dev/admin/secretary/add \
     -H "Authorization: Bearer YOUR_SEED_ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"lineUserId":"U...", "name":"เลขาคนที่ 1"}'
   ```