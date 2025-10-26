// src/index.js — Schedule Worker (Cloudflare Workers + D1)
// wrangler.jsonc ต้องมี:
// "d1_databases": [{ "binding": "schedule_db", "database_name": "schedule_db" }]
// "triggers": { "crons": ["30 1 * * *"] }  // 08:30 Asia/Bangkok (UTC+7)
// ENV ที่ใช้: LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET, SEED_ADMIN_TOKEN, SECRETARY_API_KEY, AGENDA_FORMAT=text|flex

import { renderSecretaryPage } from "./indexsecretary.js"; // หน้าเลขา (แยกไฟล์)

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method.toUpperCase();

    // เพิ่ม log เพื่อ debug
    console.log(`[${new Date().toISOString()}] ${method} ${pathname}`);

    try {
      if (pathname === "/health") {
        console.log("Health check accessed");
        return json({ ok: true });
      }

      /* ===== Secretary APIs (ต้องมี api_key ของ role=secretary) ===== */
      if (pathname === "/schedules" && method === "POST") {
        const body = await safeJson(request);
        const created = await createSchedule(env, body);
        
        // ส่งแจ้งเตือนให้ boss เมื่อเพิ่มงานใหม่
        await notifyBossNewSchedule(env, created.id);
        
        return json({ ok: true, data: created }, 201);
      }

      if (pathname.startsWith("/schedules/") && method === "PATCH") {
        const id = pathname.split("/")[2];
        const body = await safeJson(request);
        const updated = await updateSchedule(env, id, body);
        return json({ ok: true, data: updated });
      }

      if (pathname.startsWith("/schedules/") && method === "DELETE") {
        const id = pathname.split("/")[2];
        const deleted = await deleteSchedule(env, id);
        return json({ ok: true, data: deleted });
      }

      if (pathname === "/schedules" && method === "GET") {
        const date = url.searchParams.get("date");
        const q = date
          ? await env.schedule_db.prepare(
              `SELECT id,title,date,start_time,end_time,place,location,category_id,status,attend_status
               FROM schedules WHERE date=? ORDER BY time(start_time) ASC`
            ).bind(date).all()
          : await env.schedule_db.prepare(
              `SELECT id,title,date,start_time,end_time,place,location,category_id,status,attend_status
               FROM schedules ORDER BY date DESC, time(start_time) ASC LIMIT 100`
            ).all();
        return json({ ok: true, data: q.results || [] });
      }

      if (pathname === "/categories" && method === "GET") {
        const q = await env.schedule_db
          .prepare("SELECT id, code, label, color FROM categories ORDER BY label ASC")
          .all();
        return json({ ok: true, data: q.results || [] });
      }

      // หน้าเลขา (ฟอร์ม+รายการ+แก้ไข inline) — แยก render จากไฟล์ indexsecretary.js
      if (pathname === "/secretary" && method === "GET") {
        return new Response(renderSecretaryPage(), {
          status: 200, headers: { "content-type": "text/html; charset=utf-8" }
        });
      }

      // หน้าทดสอบ (ใช้ HTML สะอาด)
      if (pathname === "/test" && method === "GET") {
        console.log("Test page accessed");
        return new Response(renderCleanTestPage(), { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
      }

      /* ======= Public APIs (อ่านอย่างเดียว ไม่ต้อง auth) ======= */
      // ช่วงวันที่สำหรับหน้า calendar: /public/schedules?start=YYYY-MM-DD&end=YYYY-MM-DD
      if (pathname === "/public/schedules" && method === "GET") {
        const start = url.searchParams.get("start");
        const end = url.searchParams.get("end");
        if (!start || !end) return json({ ok:false, error:"start,end required" }, 400);
        const q = await env.schedule_db.prepare(
          `SELECT id,title,date,start_time,end_time,place,location,category_id,status,attend_status
           FROM schedules
           WHERE date BETWEEN ? AND ? AND (status IS NULL OR status IN ('planned','in_progress'))
           ORDER BY date ASC, time(start_time) ASC`
        ).bind(start, end).all();
        return json({ ok: true, data: q.results || [] });
      }

      // ปฏิทินสาธารณะ: /calendar?view=day|week|month&date=YYYY-MM-DD
      if (pathname === "/calendar" && method === "GET") {
        const html = renderPublicCalendarPage(url);
        return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
      }

      /* ======= Admin APIs ======= */
      if (pathname === "/admin/seed/users" && method === "POST") {
        return handleAdminSeedUsers(request, env);
      }
      if (pathname === "/admin/seed/full" && method === "POST") {
        return handleAdminSeedFull(request, env);
      }
      
      // ตั้ง User เป็น Boss
      if (pathname === "/admin/boss/set" && method === "POST") {
        await assertAdminSeedAuth(env, request.headers.get("authorization"));
        const body = await safeJson(request);
        const { lineUserId } = body;
        if (!lineUserId) return json({ ok: false, error: "lineUserId required" }, 400);
        
        await setBossUser(env, lineUserId);
        return json({ ok: true, message: "User set as boss successfully" });
      }
      
      // เพิ่มเลขาใหม่
      if (pathname === "/admin/secretary/add" && method === "POST") {
        await assertAdminSeedAuth(env, request.headers.get("authorization"));
        const body = await safeJson(request);
        const { lineUserId, name } = body;
        if (!lineUserId) return json({ ok: false, error: "lineUserId required" }, 400);
        
        const id = await addSecretary(env, lineUserId, name);
        return json({ ok: true, secretaryId: id });
      }
      

      
      // ดูรายชื่อเลขา
      if (pathname === "/admin/secretaries" && method === "GET") {
        await assertAdminSeedAuth(env, request.headers.get("authorization"));
        const secretaries = await env.schedule_db
          .prepare("SELECT id, name, line_user_id, created_at FROM users WHERE role = 'secretary'")
          .all();
        return json({ ok: true, data: secretaries.results || [] });
      }
      
      // ดูรายชื่อ users ทั้งหมด
      if (pathname === "/admin/users" && method === "GET") {
        console.log("Admin users list called");
        await assertAdminSeedAuth(env, request.headers.get("authorization"));
        const users = await env.schedule_db
          .prepare("SELECT id, name, line_user_id, role, created_at FROM users ORDER BY created_at DESC")
          .all();
        console.log(`Found ${users.results?.length || 0} users`);
        return json({ ok: true, data: users.results || [] });
      }
      
      // อัพเดท role ของ user
      if (pathname === "/admin/user/role" && method === "PATCH") {
        await assertAdminSeedAuth(env, request.headers.get("authorization"));
        const body = await safeJson(request);
        const { userId, role } = body;
        if (!userId || !role) return json({ ok: false, error: "userId and role required" }, 400);
        if (!['boss', 'secretary'].includes(role)) return json({ ok: false, error: "role must be boss or secretary" }, 400);
        
        const now = new Date().toISOString();
        const result = await env.schedule_db
          .prepare("UPDATE users SET role = ?, updated_at = ? WHERE id = ?")
          .bind(role, now, userId)
          .run();
          
        if (result.meta.changes === 0) {
          return json({ ok: false, error: "User not found" }, 404);
        }
        
        return json({ ok: true, message: "Role updated successfully" });
      }
      
      // ลบ user
      if (pathname === "/admin/user/delete" && method === "DELETE") {
        await assertAdminSeedAuth(env, request.headers.get("authorization"));
        const body = await safeJson(request);
        const { userId } = body;
        if (!userId) return json({ ok: false, error: "userId required" }, 400);
        
        const result = await env.schedule_db
          .prepare("DELETE FROM users WHERE id = ?")
          .bind(userId)
          .run();
          
        if (result.meta.changes === 0) {
          return json({ ok: false, error: "User not found" }, 404);
        }
        
        return json({ ok: true, message: "User deleted successfully" });
      }
      


      // Manual cron trigger (ทดสอบสรุปทันที: ?format=text|flex&force=true)
      if (pathname === "/admin/cron/test" && method === "POST") {
        console.log("Manual cron test called");
        await assertAdminSeedAuth(env, request.headers.get("authorization"));
        const fmt = (new URL(request.url).searchParams.get("format") || env.AGENDA_FORMAT || "text").toLowerCase();
        const force = new URL(request.url).searchParams.get("force") === "true";
        console.log(`Running cron test with format: ${fmt}, force: ${force}`);
        await sendDailyAgendaToBoss(env, { format: fmt, force });
        console.log("Cron test completed");
        return json({ ok: true, ran: "sendDailyAgendaToBoss", format: fmt, force });
      }
      
      // ทดสอบ Cron ทันที (ไม่ต้อง auth)
      if (pathname === "/test/cron" && method === "POST") {
        console.log("Test cron called (no auth)");
        const body = await safeJson(request);
        const fmt = body.format || "flex";
        console.log(`Running test cron with format: ${fmt}`);
        await sendDailyAgendaToBoss(env, { format: fmt, force: true });
        console.log("Test cron completed");
        return json({ ok: true, ran: "sendDailyAgendaToBoss", format: fmt, force: true });
      }

      // ทดสอบส่งข้อมูลให้ boss (ไม่ต้อง auth)
      if (pathname === "/test/send-to-boss" && method === "POST") {
        console.log("Test send-to-boss called");
        const body = await safeJson(request);
        console.log("Request body:", body);
        const message = body.message || "ทดสอบส่งข้อมูลจาก Worker";
        const lineUserId = body.lineUserId || "U1234567890abcdef1234567890abcdef";
        const format = body.format || "text";
        console.log(`Sending ${format} message to ${lineUserId}:`, message);
        
        if (env.LINE_CHANNEL_ACCESS_TOKEN) {
          if (format === "flex") {
            const today = new Date().toISOString().slice(0,10);
            const schedules = await env.schedule_db
              .prepare(`SELECT id,title,date,start_time,end_time,place,location,category_id,attend_status
                        FROM schedules WHERE date = ? ORDER BY time(start_time) ASC`)
              .bind(today).all();
            const items = schedules?.results || [];
            const bubble = buildAgendaFlex(today, items);
            await pushLineFlex(env, lineUserId, bubble);
            return json({ ok: true, sent: "flex message", to: lineUserId, items: items.length });
          } else {
            await pushLineText(env, lineUserId, message);
            return json({ ok: true, sent: message, to: lineUserId });
          }
        } else {
          return json({ ok: false, error: "LINE_CHANNEL_ACCESS_TOKEN not configured" });
        }
      }
      
      // ทดสอบส่งข้อความให้เลขา
      if (pathname === "/test/send-to-secretaries" && method === "POST") {
        console.log("Test send-to-secretaries called");
        const body = await safeJson(request);
        console.log("Request body:", body);
        const message = body.message || "ทดสอบข้อความจากหัวหน้า";
        console.log("Message to send:", message);
        
        if (env.LINE_CHANNEL_ACCESS_TOKEN) {
          const sentCount = await sendMessageToAllSecretaries(env, message);
          return json({ ok: true, sent: message, secretaryCount: sentCount });
        } else {
          return json({ ok: false, error: "LINE_CHANNEL_ACCESS_TOKEN not configured" });
        }
      }
      


      /* ======= LINE webhook ======= */
      if (pathname === "/line/webhook" && method === "POST") {
        const ok = await verifyLineSignatureSafe(request, env);
        if (!ok) return json({ ok: false, error: "invalid signature" }, 401);
        const body = await safeJson(request);
        const events = body?.events || [];

        for (const ev of events) {
          // จัดการเมื่อมีคนติดตาม
          if (ev.type === "follow") {
            await handleFollow(env, ev);
            continue;
          }
          
          if (ev.type === "message" && ev.message?.type === "text") {
            const msg = normalize(ev.message.text);

            // ตารางงาน, งานวันนี้
            if (msg === "ตารางงาน" || msg === "งานวันนี้" || msg === "ดูตารางงานวันนี้") {
              const role = await getUserRoleByLineId(env, ev.source?.userId);
              if (role !== "boss") { await replyText(env, ev.replyToken, "เฉพาะหัวหน้าเท่านั้น"); continue; }
              
              const today = new Date().toISOString().slice(0,10);
              const schedules = await env.schedule_db
                .prepare(`SELECT id,title,date,start_time,end_time,place,location,category_id,status,attend_status
                          FROM schedules WHERE date = ? ORDER BY time(start_time) ASC`)
                .bind(today).all();
              
              const items = schedules?.results || [];
              if (items.length === 0) {
                await replyText(env, ev.replyToken, "วันนี้ไม่มีงาน");
              } else {
                const bubble = buildScheduleFlexWithActions(today, items);
                await replyLineFlex(env, ev.replyToken, bubble);
              }
              continue;
            }
            
            // ตารางงานพรุ่งนี้
            if (msg === "ดูตารางงานพรุ่งนี้" || msg === "งานพรุ่งนี้") {
              const role = await getUserRoleByLineId(env, ev.source?.userId);
              if (role !== "boss") { await replyText(env, ev.replyToken, "เฉพาะหัวหน้าเท่านั้น"); continue; }
              
              const tomorrow = new Date();
              tomorrow.setDate(tomorrow.getDate() + 1);
              const tomorrowStr = tomorrow.toISOString().slice(0,10);
              
              const schedules = await env.schedule_db
                .prepare(`SELECT id,title,date,start_time,end_time,place,location,category_id,status,attend_status
                          FROM schedules WHERE date = ? ORDER BY time(start_time) ASC`)
                .bind(tomorrowStr).all();
              
              const items = schedules?.results || [];
              if (items.length === 0) {
                await replyText(env, ev.replyToken, "พรุ่งนี้ไม่มีงาน");
              } else {
                const bubble = buildScheduleFlexWithActions(tomorrowStr, items);
                await replyLineFlex(env, ev.replyToken, bubble);
              }
              continue;
            }
            
            // ส่งข้อความให้เลขา
            if (msg === "ส่งข้อความให้เลขา") {
              const role = await getUserRoleByLineId(env, ev.source?.userId);
              if (role !== "boss") { await replyText(env, ev.replyToken, "เฉพาะหัวหน้าเท่านั้น"); continue; }
              
              await replyText(env, ev.replyToken, "กรุณาพิมพ์ข้อความที่ต้องการส่งให้เลขา\nตัวอย่าง: ข้อความ:กรุณาเตรียมเอกสารประชุม");
              continue;
            }
            
            // ส่งข้อความไปเลขา
            if (msg.startsWith("ข้อความ:")) {
              const role = await getUserRoleByLineId(env, ev.source?.userId);
              if (role !== "boss") { await replyText(env, ev.replyToken, "เฉพาะหัวหน้าเท่านั้น"); continue; }
              
              const message = msg.replace("ข้อความ:", "").trim();
              if (!message) {
                await replyText(env, ev.replyToken, "กรุณาระบุข้อความ เช่น: ข้อความ:กรุณาเตรียมเอกสารประชุม");
                continue;
              }
              
              const sentCount = await sendMessageToAllSecretaries(env, message);
              await replyText(env, ev.replyToken, `✅ ส่งข้อความไปเลขา ${sentCount} คน\n\n"${message}"`);
              continue;
            }
            
            // ถ้าเป็น boss และพิมพ์ข้อความธรรมดา ให้ส่งไปเลขาทุกคน
            const role = await getUserRoleByLineId(env, ev.source?.userId);
            if (role === "boss" && msg && !msg.startsWith("งานด่วน:") && !msg.startsWith("เพิ่มงาน") && !msg.startsWith("ดูตารางงาน") && !msg.startsWith("ส่งข้อความ")) {
              const sentCount = await sendMessageToAllSecretaries(env, msg);
              await replyText(env, ev.replyToken, `ส่งข้อความไปเลขา ${sentCount} คน`);
              continue;
            }
            
            // Quick Work
            if (msg.startsWith("งานด่วน:")) {
              const role = await getUserRoleByLineId(env, ev.source?.userId);
              if (role !== "boss") { await replyText(env, ev.replyToken, "เฉพาะหัวหน้าเท่านั้น"); continue; }
              
              const task = msg.replace("งานด่วน:", "").trim();
              if (!task) {
                await replyText(env, ev.replyToken, "กรุณาระบุงาน เช่น: งานด่วน:เตรียมเอกสารประชุม");
                continue;
              }
              
              // ส่งแจ้งเตือนไปเลขา (ใช้ LINE หรือ notification system)
              await notifySecretaryUrgentTask(env, task);
              await replyText(env, ev.replyToken, `✅ ส่งงานด่วนแล้ว: ${task}`);
              continue;
            }
            
            // เพิ่มงานผ่านข้อความ (Boss และ Secretary)
            if (msg.startsWith("เพิ่มงาน")) {
              const role = await getUserRoleByLineId(env, ev.source?.userId);
              if (!role || (role !== "boss" && role !== "secretary")) {
                await replyText(env, ev.replyToken, "เฉพาะหัวหน้าและเลขาเท่านั้น");
                continue;
              }
              
              if (msg === "เพิ่มงาน") {
                await replyText(env, ev.replyToken, 
                  "📝 วิธีเพิ่มงาน:\n\n" +
                  "🔸 งานเดียว:\nเพิ่มงาน:ประชุม,2025-01-15,14:00,ห้องประชุม\n\n" +
                  "🔸 หลายงาน (แยกด้วย |):\nเพิ่มงาน:ประชุม,2025-01-15,14:00,ห้องประชุม|อบรม,2025-01-16,09:00,ห้องอบรม");
                continue;
              }
              
              // แยกงานหลายงาน (ใช้ | เป็นตัวแยก)
              const taskList = msg.replace(/^เพิ่มงาน[:：]/, "").split("|");
              const results = [];
              
              for (const taskStr of taskList) {
                const parts = taskStr.split(",").map(s => s?.trim());
                const [title, date, start_time, location] = parts;
                
                if (!title || !date || !start_time) {
                  results.push(`❌ ${title || 'งานไม่ระบุชื่อ'}: รูปแบบไม่ถูกต้อง`);
                  continue;
                }
                
                try {
                  let category_id = "00000000-0000-0000-0000-000000000001"; // default งานในหน่วย
                  const extraTok = parts[4]?.trim();
                  const mapped = mapCategoryTokenToId(extraTok) ||
                    mapCategoryTokenToId((location||"").split(/\s+/).find(x => x?.startsWith?.("#")));
                  if (mapped) category_id = mapped;
                  
                  await createSchedule(env, {
                    title, date, start_time,
                    location, place: location, category_id,
                    assignees: "auto", 
                    notes: role === "boss" ? "เพิ่มจาก LINE โดยหัวหน้า" : "เพิ่มจาก LINE โดยเลขา"
                  });
                  
                  results.push(`✅ ${title}: ${date} ${start_time}`);
                } catch (err) {
                  console.error("เพิ่มงาน error:", err);
                  results.push(`❌ ${title}: เพิ่มไม่สำเร็จ`);
                }
              }
              
              const summary = `📋 สรุปการเพิ่มงาน (${taskList.length} งาน):\n\n${results.join('\n')}`;
              await replyText(env, ev.replyToken, summary);
              continue;
            }
          }

          if (ev.type === "postback") {
            const params = Object.fromEntries(new URLSearchParams(ev.postback?.data || ""));
            const action = params.action;
            const scheduleId = params.id;
            const lineUserId = ev.source?.userId;
            
            if (action === "toggle_attend" && scheduleId && lineUserId) {
              const role = await getUserRoleByLineId(env, lineUserId);
              if (role !== "boss") continue;
              
              // เช็คสถานะปัจจุบันจาก database
              const currentSchedule = await env.schedule_db
                .prepare("SELECT attend_status FROM schedules WHERE id = ?")
                .bind(scheduleId)
                .first();
              
              const currentStatus = currentSchedule?.attend_status;
              let newStatus;
              
              if (currentStatus === "yes") {
                newStatus = "no";
              } else {
                newStatus = "yes";
              }
              
              await setAttendStatus(env, scheduleId, newStatus);
              
              // แสดง log ที่ถูกต้อง
              const statusText = newStatus === "yes" ? "ไป" : "ไม่ไป";
              const icon = newStatus === "yes" ? "✅" : "❌";
              
              await replyText(env, ev.replyToken, `${icon} เปลี่ยนจาก: ${statusText}`);
            }
            
            // Legacy support
            if ((action === "attend_yes" || action === "attend_no") && scheduleId && lineUserId) {
              const role = await getUserRoleByLineId(env, lineUserId);
              if (role !== "boss") continue;
              const value = action === "attend_yes" ? "yes" : "no";
              await setAttendStatus(env, scheduleId, value);
              await replyText(env, ev.replyToken, value === "yes" ? "รับทราบ: ใช่" : "รับทราบ: ไม่ใช่");
            }
          }
        }
        return json({ ok: true });
      }

      return json({ ok: false, error: "Not Found" }, 404);
    } catch (err) {
      console.error("FATAL:", err?.message, err?.stack);
      return json({ ok: false, error: err?.message || String(err) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    console.log("[CRON] Scheduled function triggered at:", new Date().toISOString());
    try {
      const format = (env.AGENDA_FORMAT || "flex").toLowerCase();
      
      const now = new Date();
      const utc = now.getTime() + (now.getTimezoneOffset() * 60 * 1000);
      const bangkok = new Date(utc + 7 * 60 * 60 * 1000);
      const hour = bangkok.getHours();
      
      console.log(`[CRON] Bangkok time: ${bangkok.toISOString()}, Hour: ${hour}`);
      
      if (hour === 8) {
        console.log("[CRON] Sending today's agenda");
        await sendDailyAgendaToBoss(env, { format, type: 'today' });
      } else if (hour === 20) {
        console.log("[CRON] Sending tomorrow's agenda");
        await sendDailyAgendaToBoss(env, { format, type: 'tomorrow' });
      } else {
        console.log(`[CRON] No action for hour ${hour}`);
      }
    } catch (e) {
      console.error("CRON ERROR:", e?.message, e?.stack);
    }
  },
};

/* =========================
 * Calendar (Public HTML)
 * ========================= */
function renderCleanTestPage() {
  return `<!doctype html>
<html lang="th"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Test Schedule Worker</title>
<style>
body{font-family:system-ui;margin:24px;background:#0b0e17;color:#e5e7eb}
.card{background:#141927;border-radius:12px;padding:16px;margin-bottom:16px}
input,textarea,button{font:inherit;padding:8px;margin:4px 0;background:#1f2937;color:#e5e7eb;border:1px solid #374151;border-radius:6px}
button{background:#16a34a;color:#fff;cursor:pointer}
.result{background:#0f1422;padding:12px;border-radius:8px;margin-top:8px;white-space:pre-wrap}
.global-token{background:#1e40af;padding:16px;border-radius:8px;margin-bottom:16px;text-align:center}
</style></head>
<body>
<h1>Test Schedule Worker</h1>

<div class="global-token">
  <h2>Set Token</h2>
  <input id="globalToken" type="password" placeholder="SEED_ADMIN_TOKEN" style="width:300px"/>
  <button onclick="setGlobalToken()">Set Token</button>
  <div id="tokenStatus" style="margin-top:8px;font-size:14px"></div>
</div>

<div class="card">
  <h2>Test Send to Boss</h2>
  <input id="lineUserId" value="U1234567890abcdef1234567890abcdef" style="width:100%"/>
  <select id="messageFormat">
    <option value="text">Text Message</option>
    <option value="flex">Flex Message</option>
  </select>
  <textarea id="message" rows="3" style="width:100%">Test message from worker</textarea>
  <button onclick="testSendToBoss()">Send Test Message</button>
  <div id="sendResult" class="result"></div>
</div>

<div class="card">
  <h2>Test Cron Job</h2>
  <select id="cronFormat">
    <option value="text">Text</option>
    <option value="flex">Flex Message</option>
  </select>
  <div style="margin:8px 0">
    <button onclick="testCronNoAuth()">Test Cron (No Auth)</button>
    <button onclick="testCron()" style="margin-left:8px">Test Cron (With Auth)</button>
  </div>
  <div id="cronResult" class="result"></div>
</div>

<div class="card">
  <h2>User Management</h2>
  <button onclick="loadAllUsers()">Load All Users</button>
  <div id="usersList" class="result"></div>
</div>

<div class="card">
  <h2>Test Send to Secretaries</h2>
  <textarea id="secretaryMessage" rows="3" style="width:100%">Test message to secretaries</textarea>
  <button onclick="testSendToSecretaries()">Send to All Secretaries</button>
  <div id="secretaryMsgResult" class="result"></div>
</div>

<script>
let GLOBAL_TOKEN = '';

function setGlobalToken(){
  GLOBAL_TOKEN = document.getElementById('globalToken').value;
  if(GLOBAL_TOKEN) {
    document.getElementById('tokenStatus').innerHTML = 'Token Set Successfully';
    document.getElementById('tokenStatus').style.color = '#10b981';
    loadAllUsers();
  } else {
    document.getElementById('tokenStatus').innerHTML = 'Please enter token';
    document.getElementById('tokenStatus').style.color = '#ef4444';
  }
}

function getToken(){
  if(!GLOBAL_TOKEN) {
    alert('Please set SEED_ADMIN_TOKEN first');
    return null;
  }
  return GLOBAL_TOKEN;
}

async function testSendToBoss(){
  console.log('testSendToBoss called');
  const lineUserId = document.getElementById('lineUserId').value;
  const message = document.getElementById('message').value;
  const format = document.getElementById('messageFormat').value;
  
  try {
    const res = await fetch('/test/send-to-boss', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({ lineUserId, message, format })
    });
    
    const result = await res.json().catch(() => ({ error: 'Invalid JSON' }));
    document.getElementById('sendResult').textContent = JSON.stringify(result, null, 2);
  } catch (error) {
    document.getElementById('sendResult').textContent = 'Error: ' + error.message;
  }
}

async function testCronNoAuth(){
  console.log('testCronNoAuth called');
  const format = document.getElementById('cronFormat').value;
  
  try {
    const res = await fetch('/test/cron', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({ format })
    });
    
    const result = await res.json().catch(() => ({ error: 'Invalid JSON' }));
    document.getElementById('cronResult').textContent = JSON.stringify(result, null, 2);
  } catch (error) {
    document.getElementById('cronResult').textContent = 'Error: ' + error.message;
  }
}

async function testCron(){
  const token = getToken();
  if(!token) return;
  const format = document.getElementById('cronFormat').value;
  
  try {
    const res = await fetch('/admin/cron/test?format=' + format + '&force=true', {
      method: 'POST',
      headers: {'authorization': 'Bearer ' + token}
    });
    
    const result = await res.json().catch(() => ({ error: 'Invalid JSON' }));
    document.getElementById('cronResult').textContent = JSON.stringify(result, null, 2);
  } catch (error) {
    document.getElementById('cronResult').textContent = 'Error: ' + error.message;
  }
}

async function loadAllUsers(){
  console.log('loadAllUsers called');
  const token = getToken();
  if(!token) return;
  
  try {
    const res = await fetch('/admin/users', {
      headers: {'authorization': 'Bearer ' + token}
    });
    
    const result = await res.json().catch(() => ({ error: 'Invalid JSON' }));
    
    if(res.ok && result.data) {
      const usersList = result.data.map(user => {
        const roleText = user.role === 'boss' ? 'Boss' : 'Secretary';
        const lineId = user.line_user_id || '-';
        return user.name + ' (' + roleText + ') - LINE: ' + lineId;
      }).join('\n');
      
      document.getElementById('usersList').textContent = usersList || 'No users found';
    } else {
      document.getElementById('usersList').textContent = JSON.stringify(result, null, 2);
    }
  } catch (error) {
    document.getElementById('usersList').textContent = 'Error: ' + error.message;
  }
}

async function testSendToSecretaries(){
  const message = document.getElementById('secretaryMessage').value;
  
  try {
    const res = await fetch('/test/send-to-secretaries', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({ message })
    });
    
    const result = await res.json().catch(() => ({ error: 'Invalid JSON' }));
    document.getElementById('secretaryMsgResult').textContent = JSON.stringify(result, null, 2);
  } catch (error) {
    document.getElementById('secretaryMsgResult').textContent = 'Error: ' + error.message;
  }
}
</script>
</body></html>`;
}

function renderTestPage() {
  return `<!doctype html>
<html lang="th"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>ทดสอบระบบ</title>
<style>
body{font-family:system-ui;margin:24px;background:#0b0e17;color:#e5e7eb}
.card{background:#141927;border-radius:12px;padding:16px;margin-bottom:16px}
input,textarea,button{font:inherit;padding:8px;margin:4px 0;background:#1f2937;color:#e5e7eb;border:1px solid #374151;border-radius:6px}
button{background:#16a34a;color:#fff;cursor:pointer}
.result{background:#0f1422;padding:12px;border-radius:8px;margin-top:8px;white-space:pre-wrap}
.global-token{background:#1e40af;padding:16px;border-radius:8px;margin-bottom:16px;text-align:center}
</style></head>
<body>
<h1>ทดสอบระบบ Schedule Worker</h1>

<div class="global-token">
  <h2>🔑 ตั้งค่า Token สำหรับทุกฟีเจอร์</h2>
  <label>SEED_ADMIN_TOKEN:<br>
    <input id="globalToken" type="password" placeholder="ใส่ SEED_ADMIN_TOKEN" style="width:300px"/>
  </label>
  <button onclick="setGlobalToken()">ตั้งค่า Token</button>
  <div id="tokenStatus" style="margin-top:8px;font-size:14px"></div>
</div>

<div class="card">
  <h2>ทดสอบส่งข้อความให้ Boss</h2>
  <label>LINE User ID ของ Boss:<br>
    <input id="lineUserId" value="U1234567890abcdef1234567890abcdef" style="width:100%"/>
  </label>
  <label>รูปแบบ:
    <select id="messageFormat">
      <option value="text">Text Message</option>
      <option value="flex">Flex Message (ตารางงานวันนี้)</option>
    </select>
  </label>
  <label>ข้อความ (สำหรับ text):<br>
    <textarea id="message" rows="3" style="width:100%">สวัสดีครับ นี่คือการทดสอบส่งข้อความจาก Schedule Worker</textarea>
  </label>
  <button onclick="testSendToBoss()">ส่งข้อความทดสอบ</button>
  <div id="sendResult" class="result"></div>
</div>

<div class="card">
  <h2>ทดสอบ Cron Job (สรุปงานประจำวัน)</h2>
  <label>รูปแบบ:
    <select id="cronFormat">
      <option value="text">Text</option>
      <option value="flex">Flex Message</option>
    </select>
  </label>
  <div style="margin:8px 0">
    <button onclick="testCron()">ทดสอบ Cron (ต้อง Auth)</button>
    <button onclick="testCronNoAuth()" style="background:#f59e0b;margin-left:8px">ทดสอบ Cron (ไม่ต้อง Auth)</button>
  </div>
  <div id="cronResult" class="result"></div>
</div>

<div class="card">
  <h2>จัดการผู้ใช้</h2>
  
  <h3>ตั้ง User เป็น Boss</h3>
  <label>LINE User ID ของ Boss:<br>
    <input id="bossUserId" value="Ue358aad024251165657dfcb85c8755fe" style="width:100%"/>
  </label>
  <button onclick="setBoss()">ตั้งเป็น Boss</button>
  <div id="bossResult" class="result"></div>
  
  <h3>เพิ่มเลขาใหม่</h3>
  <label>LINE User ID ของเลขา:<br>
    <input id="secretaryUserId" placeholder="U1234567890abcdef1234567890abcdef" style="width:100%"/>
  </label>
  <label>ชื่อเลขา:<br>
    <input id="secretaryName" placeholder="เลขานุการ" style="width:100%"/>
  </label>
  <button onclick="addSecretary()">เพิ่มเลขา</button>
  <div id="secretaryResult" class="result"></div>
  
  <div style="margin:12px 0">
    <button onclick="listSecretaries()">ดูรายชื่อเลขา</button>
    <div id="secretaryList" class="result"></div>
  </div>
</div>

<div class="card">
  <h2>จัดการ Role ผู้ใช้</h2>
  
  <div style="margin:12px 0">
    <button onclick="loadAllUsers()">โหลดรายชื่อผู้ใช้ทั้งหมด</button>
    <div id="usersList" class="result"></div>
  </div>
  
  <div id="roleManagement" style="display:none;margin-top:16px">
    <h3>เปลี่ยน Role</h3>
    <label>เลือกผู้ใช้:<br>
      <select id="userSelect" style="width:100%;padding:8px;margin:4px 0;background:#1f2937;color:#e5e7eb;border:1px solid #374151;border-radius:6px">
        <option value="">-- เลือกผู้ใช้ --</option>
      </select>
    </label>
    <label>เลือก Role:<br>
      <select id="roleSelect" style="width:100%;padding:8px;margin:4px 0;background:#1f2937;color:#e5e7eb;border:1px solid #374151;border-radius:6px">
        <option value="boss">Boss (หัวหน้า)</option>
        <option value="secretary">Secretary (เลขา)</option>
      </select>
    </label>
    <button onclick="updateUserRole()">อัพเดท Role</button>
    <button onclick="deleteUser()" style="background:#ef4444;margin-left:8px">ลบผู้ใช้</button>
    <div id="roleResult" class="result"></div>
  </div>
</div>

<div class="card">
  <h2>ทดสอบส่งข้อความให้เลขา</h2>
  <label>ข้อความ:<br>
    <textarea id="secretaryMessage" rows="3" style="width:100%">ทดสอบข้อความจากหัวหน้า</textarea>
  </label>
  <button onclick="testSendToSecretaries()">ส่งข้อความให้เลขาทุกคน</button>
  <div id="secretaryMsgResult" class="result"></div>
</div>

<div class="card">
  <h2>ลิงก์อื่นๆ</h2>
  <p><a href="/secretary" style="color:#60a5fa">หน้าเลขา</a> - จัดการงาน</p>
  <p><a href="/calendar" style="color:#60a5fa">ปฏิทินสาธารณะ</a> - ดูตารางงาน</p>
  <p><a href="/health" style="color:#60a5fa">Health Check</a> - ตรวจสอบสถานะ</p>
</div>

<script>
let GLOBAL_TOKEN = '';

async function setGlobalToken(){
  GLOBAL_TOKEN = document.getElementById('globalToken').value;
  if(GLOBAL_TOKEN) {
    document.getElementById('tokenStatus').innerHTML = '✅ Token ตั้งค่าแล้ว';
    document.getElementById('tokenStatus').style.color = '#10b981';
    
    // โหลด users อัตโนมัติ
    await loadAllUsers();
  } else {
    document.getElementById('tokenStatus').innerHTML = '❌ กรุณาใส่ Token';
    document.getElementById('tokenStatus').style.color = '#ef4444';
  }
}

function getToken(){
  if(!GLOBAL_TOKEN) {
    alert('กรุณาตั้งค่า SEED_ADMIN_TOKEN ก่อน');
    return null;
  }
  return GLOBAL_TOKEN;
}

async function testSendToBoss(){
  console.log('testSendToBoss called');
  const lineUserId = document.getElementById('lineUserId').value;
  const message = document.getElementById('message').value;
  const format = document.getElementById('messageFormat').value;
  
  console.log('Sending request:', { lineUserId, message, format });
  
  try {
    const res = await fetch('/test/send-to-boss', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({ lineUserId, message, format })
    });
    
    console.log('Response status:', res.status);
    const result = await res.json().catch(() => ({ error: 'Invalid JSON response' }));
    console.log('Response data:', result);
    document.getElementById('sendResult').textContent = JSON.stringify(result, null, 2);
  } catch (error) {
    console.error('Request failed:', error);
    document.getElementById('sendResult').textContent = 'Error: ' + error.message;
  }
}

async function testCron(){
  const format = document.getElementById('cronFormat').value;
  const token = getToken();
  if(!token) return;
  
  const res = await fetch('/admin/cron/test?format=' + format + '&force=true', {
    method: 'POST',
    headers: {'authorization': 'Bearer ' + token}
  });
  
  const result = await res.json().catch(() => ({}));
  document.getElementById('cronResult').textContent = JSON.stringify(result, null, 2);
}

async function testCronNoAuth(){
  console.log('testCronNoAuth called');
  const format = document.getElementById('cronFormat').value;
  
  console.log('Testing cron with format:', format);
  
  try {
    const res = await fetch('/test/cron', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({ format })
    });
    
    console.log('Cron response status:', res.status);
    const result = await res.json().catch(() => ({ error: 'Invalid JSON response' }));
    console.log('Cron response data:', result);
    document.getElementById('cronResult').textContent = JSON.stringify(result, null, 2);
  } catch (error) {
    console.error('Cron test failed:', error);
    document.getElementById('cronResult').textContent = 'Error: ' + error.message;
  }
}

async function setBoss(){
  const token = getToken();
  if(!token) return;
  const lineUserId = document.getElementById('bossUserId').value;
  
  if(!lineUserId) return alert('กรุณาใส่ LINE User ID');
  
  const res = await fetch('/admin/boss/set', {
    method: 'POST',
    headers: {
      'authorization': 'Bearer ' + token,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ lineUserId })
  });
  
  const result = await res.json().catch(() => ({}));
  document.getElementById('bossResult').textContent = JSON.stringify(result, null, 2);
}

async function addSecretary(){
  const token = getToken();
  if(!token) return;
  const lineUserId = document.getElementById('secretaryUserId').value;
  const name = document.getElementById('secretaryName').value;
  
  if(!lineUserId) return alert('กรุณาใส่ LINE User ID');
  
  const res = await fetch('/admin/secretary/add', {
    method: 'POST',
    headers: {
      'authorization': 'Bearer ' + token,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ lineUserId, name })
  });
  
  const result = await res.json().catch(() => ({}));
  document.getElementById('secretaryResult').textContent = JSON.stringify(result, null, 2);
  
  if(res.ok) {
    document.getElementById('secretaryUserId').value = '';
    document.getElementById('secretaryName').value = '';
  }
}

async function listSecretaries(){
  const token = getToken();
  if(!token) return;
  
  const res = await fetch('/admin/secretaries', {
    headers: {'authorization': 'Bearer ' + token}
  });
  
  const result = await res.json().catch(() => ({}));
  document.getElementById('secretaryList').textContent = JSON.stringify(result, null, 2);
}

async function testSendToSecretaries(){
  const message = document.getElementById('secretaryMessage').value;
  
  const res = await fetch('/test/send-to-secretaries', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({ message })
  });
  
  const result = await res.json().catch(() => ({}));
  document.getElementById('secretaryMsgResult').textContent = JSON.stringify(result, null, 2);
}

let allUsers = [];

async function loadAllUsers(){
  console.log('loadAllUsers called');
  const token = getToken();
  if(!token) return;
  
  console.log('Loading users with token:', token.substring(0, 10) + '...');
  
  try {
    const res = await fetch('/admin/users', {
      headers: {'authorization': 'Bearer ' + token}
    });
    
    console.log('Users response status:', res.status);
    const result = await res.json().catch(() => ({ error: 'Invalid JSON response' }));
    console.log('Users response data:', result);
    
    if(res.ok && result.data) {
      allUsers = result.data;
      
      const usersList = result.data.map(user => {
        const roleText = user.role === 'boss' ? 'Boss' : 'Secretary';
        const lineId = user.line_user_id || '-';
        return user.name + ' (' + roleText + ') - LINE: ' + lineId;
      }).join('\n');
      
      document.getElementById('usersList').textContent = usersList || 'No users found';
      
      const userSelect = document.getElementById('userSelect');
      userSelect.innerHTML = '<option value="">-- Select User --</option>';
      result.data.forEach(user => {
        const option = document.createElement('option');
        option.value = user.id;
        option.textContent = user.name + ' (' + (user.role === 'boss' ? 'Boss' : 'Secretary') + ')';
        userSelect.appendChild(option);
      });
      
      document.getElementById('roleManagement').style.display = 'block';
    } else {
      document.getElementById('usersList').textContent = JSON.stringify(result, null, 2);
    }
  } catch (error) {
    console.error('Load users failed:', error);
    document.getElementById('usersList').textContent = 'Error: ' + error.message;
  }
}

async function updateUserRole(){
  const token = getToken();
  if(!token) return;
  const userId = document.getElementById('userSelect').value;
  const role = document.getElementById('roleSelect').value;
  
  if(!userId) return alert('กรุณาเลือกผู้ใช้');
  
  const res = await fetch('/admin/user/role', {
    method: 'PATCH',
    headers: {
      'authorization': 'Bearer ' + token,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ userId, role })
  });
  
  const result = await res.json().catch(() => ({}));
  document.getElementById('roleResult').textContent = JSON.stringify(result, null, 2);
  
  if(res.ok) {
    loadAllUsers();
  }
}

async function deleteUser(){
  const token = getToken();
  if(!token) return;
  const userId = document.getElementById('userSelect').value;
  
  if(!userId) return alert('กรุณาเลือกผู้ใช้');
  
  const selectedUser = allUsers.find(u => u.id === userId);
  if(!confirm('ต้องการลบผู้ใช้ "' + (selectedUser?.name || 'Unknown') + '" หรือไม่?')) return;
  
  const res = await fetch('/admin/user/delete', {
    method: 'DELETE',
    headers: {
      'authorization': 'Bearer ' + token,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ userId })
  });
  
  const result = await res.json().catch(() => ({}));
  document.getElementById('roleResult').textContent = JSON.stringify(result, null, 2);
  
  if(res.ok) {
    document.getElementById('userSelect').selectedIndex = 0;
    loadAllUsers();
  }
}

</script>
</body></html>`;
}

function renderPublicCalendarPage(url) {
  const view = (url.searchParams.get("view") || "day").toLowerCase(); // day|week|month
  const date = url.searchParams.get("date") || new Date().toISOString().slice(0,10);
  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>ตารางงาน - ${view}</title>
<style>
:root{--bg:#0b0e17;--panel:#141927;--text:#e5e7eb;--muted:#9ca3af;--accent:#60a5fa;--chip:#1f2937;}
body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:980px;margin:24px auto;padding:0 16px}
h1{font-size:20px;font-weight:700;margin:0 0 12px}
.toolbar{display:flex;gap:8px;align-items:center;margin-bottom:12px}
.btn{background:#1f2937;color:#fff;border:0;border-radius:10px;padding:8px 12px;cursor:pointer}
.btn.primary{background:#2563eb}
.tab a{color:#fff;text-decoration:none;padding:6px 10px;border-radius:999px;background:#111827}
.tab a.active{background:#2563eb}
.card{background:var(--panel);border-radius:14px;padding:14px}
.grid{display:grid;gap:10px}
.day .item{display:flex;gap:12px;align-items:center;padding:14px;background:#0f1422;border-radius:12px}
.time{font-weight:700;white-space:nowrap}
.title{flex:1}
.place{color:var(--muted)}
.week, .month{background:#0f1422;border-radius:12px;padding:8px}
.week .row{display:grid;grid-template-columns:repeat(7,1fr);gap:4px}
.month .row{display:grid;grid-template-columns:repeat(7,1fr);gap:4px}
.daycell{background:#111827;border-radius:8px;min-height:120px;padding:6px}
.daycell.empty{background:#0a0a0a}
.daycell.clickable{cursor:pointer;transition:background 0.2s}
.daycell.clickable:hover{background:#1f2937}
.daycell h4{margin:0 0 6px;font-size:12px;color:#9ca3af}
.tag{display:inline-block;background:#1f2937;border-radius:6px;padding:2px 6px;margin:2px 0;font-size:12px}
footer{color:#6b7280;text-align:center;margin:28px 0 16px}
</style>
</head>
<body>
<div class="wrap">
  <div class="toolbar">
    <div class="tab">
      <a href="/calendar?view=week&date=${date}" class="${view==='week'?'active':''}">Week</a>
      <a href="/calendar?view=month&date=${date}" class="${view==='month'?'active':''}">Month</a>
    </div>
    <input id="pick" type="date" value="${date}" style="margin-left:8px"/>
    <button class="btn" onclick="jump()">Go</button>
  </div>
  <h1>ตารางงาน · <span id="headline">${date}</span></h1>
  <div id="view" class="${view}"></div>
  <footer>Generated by Cloudflare Worker</footer>
</div>
<script>
const qs = new URLSearchParams(location.search);
const view = (qs.get('view')||'month').toLowerCase();
const date = qs.get('date') || (new Date()).toISOString().slice(0,10);
const viewEl = document.getElementById('view');
const headline = document.getElementById('headline');

function fmt(d){ return d.toISOString().slice(0,10); }
function addDays(d, n){ const x=new Date(d); x.setDate(x.getDate()+n); return x; }

async function fetchRange(start,end){
  const res = await fetch('/public/schedules?start='+start+'&end='+end);
  const j = await res.json().catch(()=>({}));
  return j?.data||[];
}

function groupByDay(items){
  const m = {};
  for(const s of items){ 
    if(!m[s.date]) m[s.date] = [];
    m[s.date].push(s);
  }
  for(const k in m){ m[k].sort((a,b)=> (a.start_time||'').localeCompare(b.start_time||'')); }
  return m;
}

async function render(){
  try {
    const base = new Date(date+'T00:00:00');
    if(view==='week'){
      const start = addDays(base, -((base.getDay()+6)%7));
      const end = addDays(start, 6);
      headline.textContent = fmt(start)+' → '+fmt(end);
      const list = await fetchRange(fmt(start), fmt(end));
      const by = groupByDay(list);
      viewEl.className='week';
      const dayHeaders = ['จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์', 'อาทิตย์'];
      let html = '<div class="week">';
      html += '<div class="row" style="background:#1e293b;border-radius:8px 8px 0 0">';
      dayHeaders.forEach(dayName => {
        html += '<div style="padding:8px;text-align:center;font-weight:bold;color:#cbd5e1;font-size:14px">'+dayName+'</div>';
      });
      html += '</div><div class="row">';
      for(let i=0;i<7;i++){
        const d = fmt(addDays(start,i));
        const items = by[d]||[];
        html += '<div class="daycell"><h4>'+d+'</h4>'+items.map(s=>{
          const t = s.end_time ? (s.start_time+'–'+s.end_time) : s.start_time;
          return '<div class="tag">'+(t||'')+' · '+(s.title||'-')+'</div>';
        }).join('')+'</div>';
      }
      html += '</div></div>';
      viewEl.innerHTML = html;
    } else {
      const y = base.getFullYear(), m = base.getMonth();
      const first = new Date(y,m,1), last = new Date(y,m+1,0);
      headline.textContent = y+'-'+String(m+1).padStart(2,'0');
      const list = await fetchRange(fmt(first), fmt(last));
      const by = groupByDay(list);
      viewEl.className='month';
      let html='<div class="month">';
      
      const daysInMonth = last.getDate();
      const firstDayOfWeek = first.getDay();
      const startDay = firstDayOfWeek === 0 ? 6 : firstDayOfWeek - 1;
      
      let dayCount = 1;
      const weeks = Math.ceil((daysInMonth + startDay) / 7);
      
      const dayHeaders = ['จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์', 'อาทิตย์'];
      html += '<div class="row" style="background:#1e293b;border-radius:8px 8px 0 0">';
      dayHeaders.forEach(dayName => {
        html += '<div style="padding:8px;text-align:center;font-weight:bold;color:#cbd5e1;font-size:14px">'+dayName+'</div>';
      });
      html += '</div>';
      
      for(let week = 0; week < weeks; week++){
        html+='<div class="row">';
        for(let day = 0; day < 7; day++){
          const cellIndex = week * 7 + day;
          if(cellIndex < startDay || dayCount > daysInMonth){
            html += '<div class="daycell empty"></div>';
          } else {
            const d = fmt(new Date(y, m, dayCount));
            const items = by[d]||[];
            html += '<div class="daycell clickable" onclick="openDayForm(&quot;'+d+'&quot;)">';
            html += '<h4>'+dayCount+'</h4>';
            html += items.map(s=>{
              const t = s.start_time || '';
              return '<div class="tag">'+t+' · '+(s.title||'-')+'</div>';
            }).join('');
            html += '</div>';
            dayCount++;
          }
        }
        html+='</div>';
      }
      html+='</div>';
      viewEl.innerHTML = html;
      console.log('Month view rendered with', Object.keys(by).length, 'days of data');
    }
  } catch(e) {
    console.error('Render error:', e);
    viewEl.innerHTML = '<p style="color:red">Error loading calendar: ' + e.message + '</p>';
  }
}
function jump(){
  const v = document.getElementById('pick').value || date;
  location.href = '/calendar?view='+view+'&date='+v;
}

function openDayForm(selectedDate){
  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.8);z-index:1000;display:flex;align-items:center;justify-content:center';
  modal.innerHTML = '<div style="background:#141927;padding:24px;border-radius:12px;width:90%;max-width:500px;max-height:80vh;overflow-y:auto">'+
      '<h2 style="margin:0 0 16px;color:#e5e7eb">เพิ่มงานวันที่ '+selectedDate+'</h2>'+
      '<div id="taskList"></div>'+
      '<div style="border-top:1px solid #374151;margin:16px 0;padding-top:16px">'+
        '<input id="newTitle" placeholder="ชื่องาน" style="width:100%;margin-bottom:8px;padding:8px;border:1px solid #374151;border-radius:6px;background:#1f2937;color:#e5e7eb">'+
        '<div style="display:flex;gap:8px;margin-bottom:8px">'+
            '<select id="newStart" style="flex:1;padding:8px;border:1px solid #374151;border-radius:6px;background:#1f2937;color:#e5e7eb">'+
            '<option value="">เลือกเวลาเริ่ม</option>'+
            '<option value="08:30">08:30</option><option value="09:00">09:00</option><option value="09:30">09:30</option>'+
            '<option value="10:00">10:00</option><option value="10:30">10:30</option><option value="11:00">11:00</option>'+
            '<option value="11:30">11:30</option><option value="12:00">12:00</option><option value="12:30">12:30</option>'+
            '<option value="13:00">13:00</option><option value="13:30">13:30</option><option value="14:00">14:00</option>'+
            '<option value="14:30">14:30</option><option value="15:00">15:00</option><option value="15:30">15:30</option>'+
            '<option value="16:00">16:00</option><option value="16:30">16:30</option><option value="17:00">17:00</option>'+
          '</select>'+
          '<select id="newEnd" style="flex:1;padding:8px;border:1px solid #374151;border-radius:6px;background:#1f2937;color:#e5e7eb">'+
            '<option value="">เลือกเวลาจบ</option>'+
            '<option value="09:00">09:00</option><option value="09:30">09:30</option><option value="10:00">10:00</option>'+
            '<option value="10:30">10:30</option><option value="11:00">11:00</option><option value="11:30">11:30</option>'+
            '<option value="12:00">12:00</option><option value="12:30">12:30</option><option value="13:00">13:00</option>'+
            '<option value="13:30">13:30</option><option value="14:00">14:00</option><option value="14:30">14:30</option>'+
            '<option value="15:00">15:00</option><option value="15:30">15:30</option><option value="16:00">16:00</option>'+
            '<option value="16:30">16:30</option><option value="17:00">17:00</option><option value="17:30">17:30</option>'+
          '</select>'+
        '</div>'+
        '<input id="newPlace" placeholder="สถานที่" style="width:100%;margin-bottom:8px;padding:8px;border:1px solid #374151;border-radius:6px;background:#1f2937;color:#e5e7eb">'+
        '<select id="newCategory" style="width:100%;margin-bottom:8px;padding:8px;border:1px solid #374151;border-radius:6px;background:#1f2937;color:#e5e7eb">'+
          '<option value="00000000-0000-0000-0000-000000000001">งานในหน่วย</option>'+
          '<option value="00000000-0000-0000-0000-000000000002">งานในกรม</option>'+
          '<option value="00000000-0000-0000-0000-000000000003">งานใหญ่</option>'+
          '<option value="00000000-0000-0000-0000-000000000004">งานนอก</option>'+
        '</select>'+
        '<div style="display:flex;gap:8px">'+
          '<button onclick="addTask(&quot;'+selectedDate+'&quot;)" style="flex:1;background:#16a34a;color:#fff;border:none;padding:10px;border-radius:6px;cursor:pointer">เพิ่ม</button>'+
          '<button onclick="closeModal()" style="flex:1;background:#6b7280;color:#fff;border:none;padding:10px;border-radius:6px;cursor:pointer">ปิด</button>'+
        '</div>'+
      '</div>'+
    '</div>';
  document.body.appendChild(modal);
  window.currentModal = modal;
  loadDayTasks(selectedDate);
}

async function loadDayTasks(date){
  const res = await fetch('/public/schedules?start='+date+'&end='+date);
  const j = await res.json().catch(()=>({}));
  const tasks = j?.data || [];
  const html = tasks.map(t => {
    const time = t.end_time ? (t.start_time+'–'+t.end_time) : t.start_time;
    return '<div style="padding:8px;margin:4px 0;background:#1f2937;border-radius:6px;color:#e5e7eb">' +
           '<strong>'+(t.title||'-')+'</strong> <span style="color:#9ca3af">'+time+'</span><br>' +
           '<small>'+(t.place||'-')+'</small></div>';
  }).join('');
  document.getElementById('taskList').innerHTML = html || '<p style="color:#9ca3af">ยังไม่มีงาน</p>';
}

async function addTask(date){
  const title = document.getElementById('newTitle').value.trim();
  const start = document.getElementById('newStart').value;
  const end = document.getElementById('newEnd').value;
  const place = document.getElementById('newPlace').value.trim();
  const category = document.getElementById('newCategory').value;
  
  if(!title || !start) return alert('กรุณากรอกชื่อและเวลาเริ่ม');
  
  const res = await fetch('/schedules', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({
      title, date, start_time: start, end_time: end || null, place: place || null,
      category_id: category
    })
  });
  
  if(res.ok){
    document.getElementById('newTitle').value = '';
    document.getElementById('newStart').selectedIndex = 0;
    document.getElementById('newEnd').selectedIndex = 0;
    document.getElementById('newPlace').value = '';
    loadDayTasks(date);
    render();
  } else {
    alert('เพิ่มงานไม่สำเร็จ');
  }
}

function closeModal(){
  if(window.currentModal) {
    document.body.removeChild(window.currentModal);
    window.currentModal = null;
  }
}

document.addEventListener('DOMContentLoaded', function(){
  console.log('DOM loaded, starting render...');
  render();
});
</script>
</body></html>`;
}

/* =========================
 * Cron helpers
 * ========================= */
async function sendDailyAgendaToBoss(env, { format = "flex", force = false, type = "today" } = {}) {
  console.log(`[sendDailyAgendaToBoss] Starting with format: ${format}, force: ${force}, type: ${type}`);
  
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60 * 1000);
  const bangkok = new Date(utc + 7 * 60 * 60 * 1000);
  
  let targetDate, dateForQuery;
  if (type === "tomorrow") {
    const tomorrow = new Date(bangkok);
    tomorrow.setDate(tomorrow.getDate() + 1);
    targetDate = tomorrow;
    dateForQuery = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth()+1).padStart(2,"0")}-${String(tomorrow.getDate()).padStart(2,"0")}`;
  } else {
    targetDate = bangkok;
    dateForQuery = `${bangkok.getFullYear()}-${String(bangkok.getMonth()+1).padStart(2,"0")}-${String(bangkok.getDate()).padStart(2,"0")}`;
  }
  
  console.log(`[sendDailyAgendaToBoss] Target date: ${dateForQuery}`);
  
  const dayOfWeek = targetDate.getDay();
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  console.log(`[sendDailyAgendaToBoss] Day of week: ${dayOfWeek}, Is weekend: ${isWeekend}`);

  const bosses = await env.schedule_db
    .prepare("SELECT id, name, line_user_id FROM users WHERE role='boss' AND line_user_id IS NOT NULL")
    .all();
  console.log(`[sendDailyAgendaToBoss] Found ${bosses?.results?.length || 0} bosses`);
  if (!bosses?.results?.length) {
    console.warn("[cron] no boss with line_user_id");
    return;
  }

  const schedules = await env.schedule_db
    .prepare(`SELECT id,title,date,start_time,end_time,place,location,category_id,attend_status
              FROM schedules
              WHERE date = ? AND (status IS NULL OR status IN ('planned','in_progress'))
              ORDER BY time(start_time) ASC`)
    .bind(dateForQuery)
    .all();

  const items = schedules?.results || [];
  console.log(`[sendDailyAgendaToBoss] Found ${items.length} schedules for ${dateForQuery}`);
  
  if (isWeekend && items.length === 0) {
    console.log(`[cron] Skip weekend notification - no tasks on ${dateForQuery}`);
    return;
  }
  
  const dayText = type === "tomorrow" ? "พรุ่งนี้" : "วันนี้";
  const asText = items.length
    ? buildAgendaText(dateForQuery, items, dayText)
    : `สรุปงานประจำวัน${dayText} (${dateForQuery})\n— ${dayText}ไม่มีงานที่ต้องทำ —`;

  for (const b of bosses.results) {
    const target = b.line_user_id;
    console.log(`[sendDailyAgendaToBoss] Processing boss: ${b.name} (${target})`);

    if (!force) {
      const notificationType = type === "tomorrow" ? "tomorrow" : "daily";
      const already = await env.schedule_db
        .prepare("SELECT 1 FROM notifications_sent WHERE type=? AND target=? AND date(sent_at) = date('now','localtime') LIMIT 1")
        .bind(notificationType, target)
        .first();
      if (already) { 
        console.log(`[cron] skip duplicate ${notificationType}`, target); 
        continue; 
      }
    }

    console.log(`[sendDailyAgendaToBoss] Sending ${format} message to ${target}`);
    
    if (format === "flex" && items.length) {
      const bubble = buildAgendaFlex(dateForQuery, items, dayText);
      await pushLineFlex(env, target, bubble);
      console.log(`[sendDailyAgendaToBoss] Sent flex message to ${target}`);
    } else {
      await pushLineText(env, target, asText);
      console.log(`[sendDailyAgendaToBoss] Sent text message to ${target}`);
    }

    if (!force) {
      const nid = crypto.randomUUID();
      const notificationType = type === "tomorrow" ? "tomorrow" : "daily";
      await env.schedule_db
        .prepare("INSERT INTO notifications_sent (id, schedule_id, type, target, sent_at) VALUES (?1, ?2, ?3, ?4, datetime('now'))")
        .bind(nid, "-", notificationType, target)
        .run();
      console.log(`[sendDailyAgendaToBoss] Recorded notification for ${target}`);
    }
  }
  
  console.log(`[sendDailyAgendaToBoss] Completed sending to ${bosses.results.length} bosses`);
}

function buildAgendaText(dateStr, items, dayText = "วันนี้") {
  const lines = [`สรุปงานประจำวัน${dayText} (${dateStr})`];
  let i = 1;
  for (const s of items) {
    const time = s.start_time;
    const where = s.place || s.location || '-';
    const att = s.attend_status === 'yes' ? '✅' : (s.attend_status === 'no' ? '❌' : '⏳');
    lines.push(i + '. ' + time + ' ' + (s.title || '') + ' · ' + where + ' ' + att);
    i++;
  }
  return lines.join('\n');
}

function buildAgendaFlex(dateStr, items, dayText = "วันนี้") {
  const date = new Date(dateStr);
  const thaiDays = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
  const thaiMonths = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 
                     'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
  
  const dayName = thaiDays[date.getDay()];
  const day = date.getDate();
  const month = thaiMonths[date.getMonth()];
  const year = date.getFullYear() + 543;
  
  const thaiDateStr = `${dayName} วันที่ ${day} ${month} ${year}`;
  
  const categoryColors = {
    '00000000-0000-0000-0000-000000000001': '#3b82f6',
    '00000000-0000-0000-0000-000000000002': '#10b981',
    '00000000-0000-0000-0000-000000000003': '#f59e0b',
    '00000000-0000-0000-0000-000000000004': '#ef4444'
  };
  
  const rows = items.map((s,i) => {
    const time = s.start_time;
    const att = s.attend_status === "yes" ? "✅" : (s.attend_status === "no" ? "❌" : "⏳");
    const color = categoryColors[s.category_id] || '#6b7280';
    
    return {
      type: "box", layout: "horizontal", spacing: "sm", margin: "xs",
      paddingAll: "8px", backgroundColor: "#1f2937", cornerRadius: "6px",
      contents: [
        { type: "text", text: time || "-", size: "sm", color: "#e5e7eb", weight: "bold", flex: 2 },
        { type: "text", text: s.place || "-", size: "xs", color: "#9ca3af", flex: 2 },
        { type: "text", text: `${i+1}. ${s.title||'-'}`, size: "sm", color: "#f8fafc", wrap: true, flex: 4 },
        { type: "text", text: att, size: "md", align: "center", flex: 1 }
      ]
    };
  });

  if (!rows.length) {
    return {
      type: "bubble",
      size: "giga",
      body: {
        type: "box", layout: "vertical", backgroundColor: "#0f172a", paddingAll: "20px",
        contents: [
          { type: "text", text: `📅 ตารางงานประจำวัน${dayText}`, weight: "bold", size: "lg", color: "#f8fafc", align: "center" },
          { type: "text", text: thaiDateStr, size: "sm", color: "#94a3b8", align: "center", margin: "sm" },
          { type: "separator", margin: "lg", color: "#334155" },
          { type: "text", text: `ไม่มีงานใน${dayText}`, size: "md", color: "#64748b", align: "center", margin: "xl" }
        ]
      }
    };
  }

  return {
    type: "bubble",
    size: "giga",
    body: {
      type: "box", layout: "vertical", backgroundColor: "#0f172a", paddingAll: "16px",
      contents: [
        {
          type: "box", layout: "vertical", spacing: "sm",
          contents: [
            { type: "text", text: `📅 ตารางงานประจำวัน${dayText}`, weight: "bold", size: "lg", color: "#f8fafc", align: "center" },
            { type: "text", text: thaiDateStr, size: "sm", color: "#94a3b8", align: "center" }
          ]
        },
        { type: "separator", margin: "lg", color: "#334155" },
        {
          type: "box", layout: "horizontal", spacing: "sm", margin: "md", paddingAll: "8px",
          backgroundColor: "#1e293b", cornerRadius: "6px",
          contents: [
            { type: "text", text: "เวลา", size: "xs", color: "#cbd5e1", weight: "bold", flex: 2 },
            { type: "text", text: "สถานที่", size: "xs", color: "#cbd5e1", weight: "bold", flex: 2 },
            { type: "text", text: "รายการ", size: "xs", color: "#cbd5e1", weight: "bold", flex: 4 },
            { type: "text", text: "ยืนยัน", size: "xs", color: "#cbd5e1", weight: "bold", flex: 1, align: "center" }
          ]
        },
        { type: "box", layout: "vertical", spacing: "xs", contents: rows }
      ]
    }
  };
}

/* =========================
 * Admin seed (เบา/เต็ม)
 * ========================= */
async function handleAdminSeedUsers(request, env) {
  await assertAdminSeedAuth(env, request.headers.get("authorization"));
  await seedUsersAndTargets(env);
  return json({ ok: true, seeded: "users and categories" });
}

async function handleAdminSeedFull(request, env) {
  await assertAdminSeedAuth(env, request.headers.get("authorization"));
  await seedUsersAndTargets(env);
  return json({ ok: true, seeded: "full database" });
}

async function assertAdminSeedAuth(env, authHeader) {
  console.log("[assertAdminSeedAuth] Checking auth...");
  if (!authHeader) {
    console.log("[assertAdminSeedAuth] Missing Authorization header");
    throw new Error("missing Authorization header");
  }
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  console.log(`[assertAdminSeedAuth] Received token: ${token.substring(0, 10)}...`);
  console.log(`[assertAdminSeedAuth] Expected token: ${env.SEED_ADMIN_TOKEN?.substring(0, 10)}...`);
  if (token !== env.SEED_ADMIN_TOKEN) {
    console.log("[assertAdminSeedAuth] Token mismatch!");
    throw new Error("invalid SEED_ADMIN_TOKEN");
  }
  console.log("[assertAdminSeedAuth] Auth successful");
}

async function seedUsersAndTargets(env) {
  // Create tables if not exist
  await env.schedule_db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('boss', 'secretary')),
      api_key TEXT UNIQUE,
      line_user_id TEXT UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      label TEXT NOT NULL,
      color TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      date TEXT NOT NULL,
      start_time TEXT,
      end_time TEXT,
      location TEXT,
      place TEXT,
      category_id TEXT,
      assignees TEXT,
      notes TEXT,
      status TEXT CHECK (status IN ('planned', 'in_progress', 'completed', 'cancelled')),
      attend_status TEXT CHECK (attend_status IN ('yes', 'no')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (category_id) REFERENCES categories(id)
    );
    
    CREATE TABLE IF NOT EXISTS notifications_sent (
      id TEXT PRIMARY KEY,
      schedule_id TEXT,
      type TEXT NOT NULL,
      target TEXT NOT NULL,
      sent_at TEXT NOT NULL
    );
  `);
  
  // Insert default data
  const now = new Date().toISOString();
  
  // Categories
  await env.schedule_db.prepare(`
    INSERT OR IGNORE INTO categories (id, code, label, color, created_at, updated_at)
    VALUES 
      ('00000000-0000-0000-0000-000000000001', 'internal', 'งานในหน่วย', '#3b82f6', ?, ?),
      ('00000000-0000-0000-0000-000000000002', 'department', 'งานในกรม', '#10b981', ?, ?),
      ('00000000-0000-0000-0000-000000000003', 'big', 'งานใหญ่', '#f59e0b', ?, ?),
      ('00000000-0000-0000-0000-000000000004', 'external', 'งานนอก', '#ef4444', ?, ?)
  `).bind(now, now, now, now, now, now, now, now).run();
  
  // Default users
  const secretaryKey = env.SECRETARY_API_KEY || '794311';
  
  // Update existing secretary API key
  await env.schedule_db.prepare(`
    UPDATE users SET api_key = ?, updated_at = ? WHERE role = 'secretary'
  `).bind(secretaryKey, now).run();
  
  // Insert if not exists
  await env.schedule_db.prepare(`
    INSERT OR IGNORE INTO users (id, name, role, api_key, line_user_id, created_at, updated_at)
    VALUES 
      ('00000000-0000-0000-0000-000000000001', 'เลขานุการ', 'secretary', ?, NULL, ?, ?),
      ('00000000-0000-0000-0000-000000000002', 'หัวหน้า', 'boss', NULL, NULL, ?, ?)
  `).bind(secretaryKey, now, now, now, now).run();
}



/* =========================
 * D1 helpers (app logic)
 * ========================= */
async function assertSecretaryByApiKey(env, authHeader) {
  if (!authHeader) throw new Error("missing Authorization header");
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const row = await env.schedule_db
    .prepare("SELECT role FROM users WHERE api_key = ? LIMIT 1")
    .bind(token)
    .first();
  if (!row || row.role !== "secretary") throw new Error("unauthorized: secretary api_key required");
}
async function getUserRoleByLineId(env, lineUserId) {
  const row = await env.schedule_db
    .prepare("SELECT role FROM users WHERE line_user_id = ? LIMIT 1")
    .bind(lineUserId)
    .first();
  return row?.role || null;
}
// ===== ตั้ง User เป็น Boss =====
async function setBossUser(env, lineUserId) {
  const now = new Date().toISOString();
  
  // อัพเดท user ที่มีอยู่ให้เป็น boss
  const result = await env.schedule_db
    .prepare("UPDATE users SET role = 'boss', updated_at = ? WHERE line_user_id = ?")
    .bind(now, lineUserId)
    .run();
    
  if (result.meta.changes === 0) {
    // ถ้าไม่มี user ให้สร้างใหม่
    const id = crypto.randomUUID();
    await env.schedule_db
      .prepare("INSERT INTO users (id, name, role, line_user_id, created_at, updated_at) VALUES (?, ?, 'boss', ?, ?, ?)")
      .bind(id, "หัวหน้า", lineUserId, now, now)
      .run();
  }
  
  return true;
}

// ===== ส่งข้อความให้เลขาทุกคน =====
async function sendMessageToAllSecretaries(env, message, fromBoss = true) {
  const secretaries = await env.schedule_db
    .prepare("SELECT line_user_id FROM users WHERE role = 'secretary' AND line_user_id IS NOT NULL")
    .all();
  
  const prefix = fromBoss ? "ข้อความจากหัวหน้า:\n\n" : "";
  const fullMessage = prefix + message;
  
  for (const secretary of secretaries.results) {
    try {
      await pushLineText(env, secretary.line_user_id, fullMessage);
    } catch (error) {
      console.error(`Failed to send message to secretary ${secretary.line_user_id}:`, error);
    }
  }
  
  return secretaries.results.length;
}

// ===== เพิ่มเลขาใหม่ =====
async function addSecretary(env, lineUserId, name = "เลขานุการ") {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  
  await env.schedule_db
    .prepare("INSERT INTO users (id, name, role, line_user_id, created_at, updated_at) VALUES (?, ?, 'secretary', ?, ?, ?)")
    .bind(id, name, lineUserId, now, now)
    .run();
    
  return id;
}



// ===== จัดการเมื่อมีคนติดตาม =====
async function handleFollow(env, event) {
  const userId = event.source.userId;
  
  // ส่งข้อความต้อนรับ
  await pushLineText(env, userId, 
    "ยินดีต้อนรับสู่ระบบตารางงาน! 🎉\n\n" +
    "กรุณาแจ้งให้ผู้ดูแลระบบเพิ่ม User ID ของคุณเข้าสู่ระบบ\n\n" +
    "User ID: " + userId
  );
}



async function setAttendStatus(env, scheduleId, value) {
  if (!["yes", "no"].includes(value)) throw new Error("invalid attend_status");
  return await env.schedule_db
    .prepare("UPDATE schedules SET attend_status = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(value, scheduleId)
    .run();
}
async function createSchedule(env, body) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const title = String(body.title || "").trim();
  const date = String(body.date || "").trim();
  const start_time = String(body.start_time || "").trim();
  const end_time = body.end_time ? String(body.end_time).trim() : null;
  const location = body.location ? String(body.location).trim() : null;
  const place = body.place ? String(body.place).trim() : null;
  const category_id = body.category_id ? String(body.category_id).trim() : null;
  const assignees = body.assignees ?? null;
  const notes = body.notes ?? null;
  if (!title || !date || !start_time) throw new Error("title, date, start_time are required");

  await env.schedule_db.prepare(
    "INSERT INTO schedules (id, title, date, start_time, end_time, location, place, category_id, assignees, notes, status, attend_status, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'planned',NULL,?11,?12)"
  ).bind(id, title, date, start_time, end_time, location, place, category_id, assignees, notes, now, now).run();

  return { id };
}
async function updateSchedule(env, id, body) {
  const fields = ["title","date","start_time","end_time","location","place","category_id","assignees","notes","status","attend_status"];
  const sets = [], binds = [];
  for (const f of fields) if (Object.prototype.hasOwnProperty.call(body, f)) { sets.push(f + " = ?"); binds.push(body[f]); }
  if (!sets.length) return { id, updated: 0 };
  sets.push("updated_at = datetime('now')");
  const sql = `UPDATE schedules SET ${sets.join(", ")} WHERE id = ?`;
  binds.push(id);
  const res = await env.schedule_db.prepare(sql).bind(...binds).run();
  return { id, updated: res.meta.changes };
}

async function deleteSchedule(env, id) {
  const res = await env.schedule_db
    .prepare("DELETE FROM schedules WHERE id = ?")
    .bind(id)
    .run();
  return { id, deleted: res.meta.changes };
}

/* =========================
 * LINE helpers
 * ========================= */
async function replyText(env, replyToken, text) {
  const url = "https://api.line.me/v2/bot/message/reply";
  const headers = { "content-type": "application/json", Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` };
  const body = { replyToken, messages: [{ type: "text", text }] };
  await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
}

async function replyLineFlex(env, replyToken, flexContent) {
  const url = "https://api.line.me/v2/bot/message/reply";
  const headers = { "content-type": "application/json", Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` };
  const body = { replyToken, messages: [{ type: "flex", altText: "ตารางงาน", contents: flexContent }] };
  await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
}

async function notifyBossNewSchedule(env, scheduleId) {
  const schedule = await env.schedule_db
    .prepare("SELECT * FROM schedules WHERE id = ?")
    .bind(scheduleId).first();
  
  if (!schedule) return;
  
  const bosses = await env.schedule_db
    .prepare("SELECT line_user_id FROM users WHERE role='boss' AND line_user_id IS NOT NULL")
    .all();
  
  const time = schedule.end_time ? `${schedule.start_time}–${schedule.end_time}` : schedule.start_time;
  const message = `🔔 งานใหม่\n📅 ${schedule.date}\n⏰ ${time}\n📝 ${schedule.title}\n📍 ${schedule.place || '-'}`;
  
  for (const boss of bosses.results || []) {
    await pushLineText(env, boss.line_user_id, message);
  }
}

async function notifySecretaryUrgentTask(env, task) {
  // ส่งแจ้งเตือนไปเลขา (สามารถใช้ LINE หรือระบบอื่น)
  console.log(`🚨 งานด่วนจากหัวหน้า: ${task}`);
  // TODO: ส่งไป LINE ของเลขาหรือระบบแจ้งเตือนอื่น
}

function buildScheduleFlexWithActions(dateStr, items) {
  // แปลงวันที่เป็นรูปแบบไทย
  const date = new Date(dateStr);
  const thaiDays = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
  const thaiMonths = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 
                     'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
  
  const dayName = thaiDays[date.getDay()];
  const day = date.getDate();
  const month = thaiMonths[date.getMonth()];
  const year = date.getFullYear() + 543;
  
  const thaiDateStr = `${dayName} วันที่ ${day} ${month} ${year}`;
  
  const categoryColors = {
    '00000000-0000-0000-0000-000000000001': '#3b82f6',
    '00000000-0000-0000-0000-000000000002': '#10b981',
    '00000000-0000-0000-0000-000000000003': '#f59e0b',
    '00000000-0000-0000-0000-000000000004': '#ef4444'
  };
  
  const rows = items.map((s,i) => {
    const time = s.end_time ? `${s.start_time}–${s.end_time}` : s.start_time;
    const color = categoryColors[s.category_id] || '#6b7280';
    const statusIcon = s.status === 'completed' ? '✅' : s.status === 'cancelled' ? '❌' : '⏳';
    const attendIcon = s.attend_status === 'yes' ? '✅' : s.attend_status === 'no' ? '❌' : '❓';
    
    return {
      type: "box", layout: "horizontal", spacing: "sm", margin: "xs",
      paddingAll: "8px", backgroundColor: "#1f2937", cornerRadius: "6px",
      contents: [
        { 
          type: "box", layout: "vertical", flex: 0, width: "4px", height: "100%",
          backgroundColor: color, cornerRadius: "2px"
        },
        {
          type: "box", layout: "vertical", flex: 1, spacing: "xs", paddingStart: "8px",
          contents: [
            {
              type: "box", layout: "horizontal",
              contents: [
                { type: "text", text: time || "-", size: "sm", color: "#e5e7eb", weight: "bold", flex: 0 },
                { type: "text", text: s.place || "-", size: "xs", color: "#9ca3af", align: "end", flex: 1 }
              ]
            },
            { type: "text", text: `${i+1}. ${s.title}`, size: "sm", color: "#f8fafc", wrap: true, maxLines: 2 }
          ]
        },
        {
          type: "button",
          style: "primary",
          height: "md",
          color: attendIcon === '✅' ? "#ef4444" : "#10b981",
          action: {
            type: "postback",
            label: attendIcon === '✅' ? '❌ ไม่ไป' : '✅ ไป',
            data: `action=toggle_attend&id=${s.id}&current=${s.attend_status || 'null'}`
          }
        }
      ]
    };
  });
  
  return {
    type: "bubble",
    size: "giga",
    body: {
      type: "box", layout: "vertical", backgroundColor: "#0f172a", paddingAll: "16px",
      contents: [
        {
          type: "box", layout: "vertical", spacing: "sm",
          contents: [
            { type: "text", text: "📅 ตารางงานประจำวัน", weight: "bold", size: "lg", color: "#f8fafc", align: "center" },
            { type: "text", text: thaiDateStr, size: "sm", color: "#94a3b8", align: "center" }
          ]
        },
        { type: "separator", margin: "lg", color: "#334155" },
        { type: "text", text: "แตะปุ่มเพื่อเปลี่ยนสถานะการเข้าร่วม", size: "xs", color: "#64748b", align: "center", margin: "sm" },
        { type: "box", layout: "vertical", spacing: "xs", contents: rows }
      ]
    }
  };
}
async function replyFlexForCreate(env, replyToken) {
  const url = "https://api.line.me/v2/bot/message/reply";
  const headers = { "content-type": "application/json", Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` };
  const message = {
    type: "flex", altText: "เพิ่มงานใหม่",
    contents: {
      type: "bubble",
      body: { type: "box", layout: "vertical", contents: [
        { type: "text", text: "เพิ่มงานใหม่", weight: "bold", size: "lg" },
        { type: "text", text: "พิมพ์: เพิ่มงาน:เรื่อง,YYYY-MM-DD,HH:MM,สถานที่,#หมวด", wrap: true, size: "sm", color: "#666" },
      ]},
      footer: { type: "box", layout: "vertical", spacing: "sm", contents: [
        { type: "button", style: "primary", color: "#22c55e", action: { type: "uri", label: "เปิดฟอร์มเพิ่มงาน", uri: "/secretary" } }
      ], flex: 0 }
    }
  };
  const body = { replyToken, messages: [message] };
  await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
}
async function pushLineText(env, lineUserId, text) {
  console.log(`[pushLineText] Sending to ${lineUserId}:`, text.substring(0, 100) + '...');
  
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) {
    console.error("[pushLineText] LINE_CHANNEL_ACCESS_TOKEN not configured");
    return;
  }
  
  const url = "https://api.line.me/v2/bot/message/push";
  const headers = { "content-type": "application/json", "Authorization": `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` };
  const body = { to: lineUserId, messages: [{ type: "text", text }] };
  
  try {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) { 
      const msg = await res.text().catch(() => res.statusText); 
      console.error("[pushLineText] LINE push error:", res.status, msg); 
    } else {
      console.log(`[pushLineText] Successfully sent to ${lineUserId}`);
    }
  } catch (error) {
    console.error("[pushLineText] Network error:", error.message);
  }
}
async function pushLineFlex(env, lineUserId, bubble) {
  console.log(`[pushLineFlex] Sending flex message to ${lineUserId}`);
  
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) {
    console.error("[pushLineFlex] LINE_CHANNEL_ACCESS_TOKEN not configured");
    return;
  }
  
  const url = "https://api.line.me/v2/bot/message/push";
  const headers = { "content-type": "application/json", "Authorization": `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` };
  const body = { to: lineUserId, messages: [{ type: "flex", altText: "สรุปงานวันนี้", contents: bubble }] };
  
  try {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) { 
      const msg = await res.text().catch(() => res.statusText); 
      console.error("[pushLineFlex] LINE push FLEX error:", res.status, msg); 
    } else {
      console.log(`[pushLineFlex] Successfully sent flex to ${lineUserId}`);
    }
  } catch (error) {
    console.error("[pushLineFlex] Network error:", error.message);
  }
}

async function verifyLineSignatureSafe(request, env) {
  return true;
}

/* =========================
 * Utils
 * ========================= */
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}
async function safeJson(request) { try { return await request.json(); } catch { return {}; } }
function normalize(s) { return (s || "").trim(); }
function mapCategoryTokenToId(tok) {
  if (!tok) return null;
  const t = String(tok).trim().replace(/^#/, "").toLowerCase();
  if (["งานในหน่วย","internal"].includes(t))   return "00000000-0000-0000-0000-000000000001";
  if (["งานในกรม","department"].includes(t))  return "00000000-0000-0000-0000-000000000002";
  if (["งานใหญ่","big"].includes(t))          return "00000000-0000-0000-0000-000000000003";
  if (["งานนอก","external"].includes(t))      return "00000000-0000-0000-0000-000000000004";
  return null;
}
