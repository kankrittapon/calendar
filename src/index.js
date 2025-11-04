// src/index.js — Schedule Worker (Cloudflare Workers + D1)
// wrangler.jsonc ต้องมี:
// "d1_databases": [{ "binding": "schedule_db", "database_name": "schedule_db" }]
// "triggers": { "crons": ["30 1 * * *"] }  // 08:30 Asia/Bangkok (UTC+7)
// ENV ที่ใช้: LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET, SEED_ADMIN_TOKEN, AGENDA_FORMAT=text|flex

import { renderSecretaryPage } from "./indexsecretary.js"; // หน้าเลขา (แยกไฟล์)

// CSRF Token validation
function validateCSRFToken(request, requiredToken) {
  const token = request.headers.get('x-csrf-token') || request.headers.get('csrf-token');
  return token === requiredToken;
}

// Input validation helper
function validateInput(input, type, maxLength = 1000) {
  if (!input || typeof input !== 'string') return false;
  if (input.length > maxLength) return false;
  
  switch (type) {
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(input);
    case 'time':
      return /^\d{2}:\d{2}$/.test(input);
    case 'uuid':
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input);
    default:
      return input.trim().length > 0;
  }
}

// Timeout wrapper for fetch requests
async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error('Request timeout');
    }
    throw error;
  }
}

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

      /* ===== LINE Targets APIs ===== */
      if (pathname === "/admin/line-targets" && method === "GET") {
        try {
          await assertAdminSeedAuth(env, request.headers.get("authorization"));
          const targets = await env.schedule_db.prepare(
            "SELECT * FROM line_targets ORDER BY created_at DESC"
          ).all();
          return json({ ok: true, data: targets.results || [] });
        } catch (error) {
          console.error('Error loading line targets:', error);
          return json({ ok: false, error: error.message }, 500);
        }
      }

      if (pathname === "/admin/line-target/delete" && method === "DELETE") {
        try {
          await assertAdminSeedAuth(env, request.headers.get("authorization"));
          
          // CSRF Protection
          if (!validateCSRFToken(request, env.CSRF_TOKEN)) {
            return json({ ok: false, error: "Invalid CSRF token" }, 403);
          }
          
          const { lineUserId } = await safeJson(request);
          if (!validateInput(lineUserId, 'default', 100)) {
            return json({ ok: false, error: "Invalid lineUserId" }, 400);
          }

          const result = await env.schedule_db.prepare(
            "DELETE FROM line_targets WHERE line_user_id = ?"
          ).bind(lineUserId).run();
          
          return json({ ok: true, deleted: result.meta.changes });
        } catch (error) {
          console.error('Error deleting line target:', error);
          return json({ ok: false, error: error.message }, 500);
        }
      }
      
      if (pathname === "/admin/user/add-from-target" && method === "POST") {
        try {
          await assertAdminSeedAuth(env, request.headers.get("authorization"));
          
          // CSRF Protection
          if (!validateCSRFToken(request, env.CSRF_TOKEN)) {
            return json({ ok: false, error: "Invalid CSRF token" }, 403);
          }
          
          const { lineUserId, name, role } = await safeJson(request);
          
          // Input validation
          if (!validateInput(lineUserId, 'default', 100) || 
              !validateInput(name, 'default', 200) || 
              !validateInput(role, 'default', 20)) {
            return json({ ok: false, error: "Invalid input parameters" }, 400);
          }
          
          if (!["boss", "secretary"].includes(role)) {
            return json({ ok: false, error: "Invalid role" }, 400);
          }

          // เพิ่ม user จาก target
          const id = crypto.randomUUID();
          const now = new Date().toISOString();
          await env.schedule_db.prepare(
            "INSERT INTO users (id, name, role, line_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
          ).bind(id, name, role, lineUserId, now, now).run();

          // ลบ target เมื่อเพิ่ม user แล้ว
          await env.schedule_db.prepare(
            "DELETE FROM line_targets WHERE line_user_id = ?"
          ).bind(lineUserId).run();

          return json({ ok: true, userId: id });
        } catch (error) {
          console.error('Error adding user from target:', error);
          return json({ ok: false, error: error.message }, 500);
        }
      }

      /* ===== Secretary APIs ===== */
      if (pathname === "/schedules" && method === "POST") {
        try {
          const body = await safeJson(request);
          
          // Input validation
          if (!body || typeof body !== 'object') {
            return json({ ok: false, error: "Invalid request body" }, 400);
          }
          
          if (!validateInput(body.title, 'default', 500) || 
              !validateInput(body.date, 'date') || 
              !validateInput(body.start_time, 'time')) {
            return json({ ok: false, error: "Invalid input parameters" }, 400);
          }
          
          const created = await createSchedule(env, body);

          // ส่งแจ้งเตือนให้ boss เมื่อเพิ่มงานใหม่
          try {
            await notifyBossNewSchedule(env, created.id);
          } catch (notifyError) {
            console.error('Failed to notify boss:', notifyError);
            // Continue execution even if notification fails
          }

          return json({ ok: true, data: created }, 201);
        } catch (error) {
          console.error('Error creating schedule:', error);
          return json({ ok: false, error: error.message }, 500);
        }
      }

      if (pathname.startsWith("/schedules/") && method === "PATCH") {
        try {
          const id = pathname.split("/")[2];
          
          if (!validateInput(id, 'uuid')) {
            return json({ ok: false, error: "Invalid schedule ID" }, 400);
          }
          
          const body = await safeJson(request);
          
          if (!body || typeof body !== 'object') {
            return json({ ok: false, error: "Invalid request body" }, 400);
          }
          
          const updated = await updateSchedule(env, id, body);
          return json({ ok: true, data: updated });
        } catch (error) {
          console.error('Error updating schedule:', error);
          return json({ ok: false, error: error.message }, 500);
        }
      }

      if (pathname.startsWith("/schedules/") && method === "DELETE") {
        try {
          const id = pathname.split("/")[2];
          
          if (!validateInput(id, 'uuid')) {
            return json({ ok: false, error: "Invalid schedule ID" }, 400);
          }
          
          // CSRF Protection for DELETE operations
          if (!validateCSRFToken(request, env.CSRF_TOKEN)) {
            return json({ ok: false, error: "Invalid CSRF token" }, 403);
          }
          
          const deleted = await deleteSchedule(env, id);
          return json({ ok: true, data: deleted });
        } catch (error) {
          console.error('Error deleting schedule:', error);
          return json({ ok: false, error: error.message }, 500);
        }
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

      // หน้าทดสอบ
      if (pathname === "/test" && method === "GET") {
        console.log("Test page accessed");
        return new Response(renderTestPage(), {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" }
        });
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
      
      // สร้างตารางทั้งหมด
      if (pathname === "/admin/seed/tables" && method === "POST") {
        try {
          await assertAdminSeedAuth(env, request.headers.get("authorization"));
          await seedUsersAndTargets(env);
          return json({ ok: true, message: "Tables created successfully" });
        } catch (error) {
          console.error('Error creating tables:', error);
          return json({ ok: false, error: error.message }, 500);
        }
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

      // ดูรายชื่อ LINE targets
      if (pathname === "/admin/line-targets" && method === "GET") {
        try {
          await assertAdminSeedAuth(env, request.headers.get("authorization"));
          const targets = await env.schedule_db
            .prepare("SELECT line_user_id, display_name, created_at FROM line_targets ORDER BY created_at DESC")
            .all();
          return json({ ok: true, data: targets.results || [] });
        } catch (error) {
          console.error('Error loading line targets:', error);
          return json({ ok: false, error: error.message }, 500);
        }
      }

      // ลบ LINE target
      if (pathname === "/admin/line-target/delete" && method === "DELETE") {
        await assertAdminSeedAuth(env, request.headers.get("authorization"));
        const body = await safeJson(request);
        const { lineUserId } = body;
        if (!lineUserId) return json({ ok: false, error: "lineUserId required" }, 400);

        const result = await env.schedule_db
          .prepare("DELETE FROM line_targets WHERE line_user_id = ?")
          .bind(lineUserId)
          .run();

        if (result.meta.changes === 0) {
          return json({ ok: false, error: "Target not found" }, 404);
        }

        return json({ ok: true });
      }

      // เพิ่มผู้ใช้จาก LINE target
      if (pathname === "/admin/user/add-from-target" && method === "POST") {
        await assertAdminSeedAuth(env, request.headers.get("authorization"));
        const body = await safeJson(request);
        const { lineUserId, name, role } = body;
        if (!lineUserId || !name || !role) {
          return json({ ok: false, error: "lineUserId, name, and role required" }, 400);
        }
        if (!['boss', 'secretary'].includes(role)) {
          return json({ ok: false, error: "role must be boss or secretary" }, 400);
        }

        // Check if target exists
        const target = await env.schedule_db
          .prepare("SELECT 1 FROM line_targets WHERE line_user_id = ?")
          .bind(lineUserId)
          .first();
        if (!target) {
          return json({ ok: false, error: "LINE target not found" }, 404);
        }

        // Create user
        const userId = crypto.randomUUID();
        const now = new Date().toISOString();
        await env.schedule_db
          .prepare("INSERT INTO users (id, name, role, line_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
          .bind(userId, name, role, lineUserId, now, now)
          .run();

        return json({ ok: true, userId });
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

      // สร้างตารางครั้งแรก (ไม่ต้อง auth)
      if (pathname === "/test/setup" && method === "POST") {
        try {
          console.log("Setting up database tables...");
          await seedUsersAndTargets(env);
          return json({ ok: true, message: "Database setup completed" });
        } catch (error) {
          console.error('Setup error:', error);
          return json({ ok: false, error: error.message }, 500);
        }
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
              .prepare(`SELECT id,title,date,start_time,end_time,place,location,category_id,attend_status,notes
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

      // ทดสอบการแจ้งเตือนก่อนเวลานัดหมาย
      if (pathname === "/test/reminder" && method === "POST") {
        console.log("Test reminder called");
        const { sendUpcomingReminders } = await import('./lineoa.js');
        await sendUpcomingReminders(env);
        return json({ ok: true, message: "Reminder check completed" });
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

            // ตารางนัดหมายวันนี้, งานวันนี้
            if (msg === "ตารางนัดหมายวันนี้" || msg === "ตารางงาน" || msg === "งานวันนี้" || msg === "ดูตารางงานวันนี้") {
              const role = await getUserRoleByLineId(env, ev.source?.userId);
              if (role !== "boss") { await replyText(env, ev.replyToken, "เฉพาะหัวหน้าเท่านั้น"); continue; }

              const today = new Date().toISOString().slice(0,10);
              const schedules = await env.schedule_db
                .prepare(`SELECT id,title,date,start_time,end_time,place,location,category_id,status,attend_status,notes
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

            // ตารางงานสัปดาห์นี้
            if (msg === "ตารางงานสัปดาห์นี้" || msg === "งานสัปดาห์นี้") {
              const role = await getUserRoleByLineId(env, ev.source?.userId);
              if (role !== "boss") { await replyText(env, ev.replyToken, "เฉพาะหัวหน้าเท่านั้น"); continue; }

              const today = new Date();
              const startOfWeek = new Date(today);
              startOfWeek.setDate(today.getDate() - today.getDay() + 1); // จันทร์
              const endOfWeek = new Date(startOfWeek);
              endOfWeek.setDate(startOfWeek.getDate() + 6); // อาทิตย์

              const startDate = startOfWeek.toISOString().slice(0,10);
              const endDate = endOfWeek.toISOString().slice(0,10);

              const schedules = await env.schedule_db
                .prepare(`SELECT id,title,date,start_time,end_time,place,location,category_id,status,attend_status,notes
                          FROM schedules WHERE date BETWEEN ? AND ? ORDER BY date ASC, time(start_time) ASC`)
                .bind(startDate, endDate).all();

              const items = schedules?.results || [];
              if (items.length === 0) {
                await replyText(env, ev.replyToken, "สัปดาห์นี้ไม่มีงาน");
              } else {
                const bubble = buildWeeklyScheduleFlex(startDate, endDate, items);
                await replyLineFlex(env, ev.replyToken, bubble);
              }
              continue;
            }

            // ตารางงานเดือนนี้
            if (msg === "ตารางงานเดือนนี้" || msg === "งานเดือนนี้") {
              const role = await getUserRoleByLineId(env, ev.source?.userId);
              if (role !== "boss") { await replyText(env, ev.replyToken, "เฉพาะหัวหน้าเท่านั้น"); continue; }

              const today = new Date();
              const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
              const endOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);

              const startDate = startOfMonth.toISOString().slice(0,10);
              const endDate = endOfMonth.toISOString().slice(0,10);

              const schedules = await env.schedule_db
                .prepare(`SELECT id,title,date,start_time,end_time,place,location,category_id,status,attend_status,notes
                          FROM schedules WHERE date BETWEEN ? AND ? ORDER BY date ASC, time(start_time) ASC`)
                .bind(startDate, endDate).all();

              const items = schedules?.results || [];
              if (items.length === 0) {
                await replyText(env, ev.replyToken, "เดือนนี้ไม่มีงาน");
              } else {
                // ส่งเป็นภาพปฏิทิน
                await sendCalendarImage(env, ev.replyToken, startDate, endDate, items, "เดือนนี้");
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
                .prepare(`SELECT id,title,date,start_time,end_time,place,location,category_id,status,attend_status,notes
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

            // คำสั่ง help
            if (msg === "help" || msg === "ช่วยเหลือ" || msg === "คำสั่ง") {
              const role = await getUserRoleByLineId(env, ev.source?.userId);
              if (role !== "boss") { await replyText(env, ev.replyToken, "เฉพาะหัวหน้าเท่านั้น"); continue; }

              const helpBubble = buildHelpFlex();
              await replyLineFlex(env, ev.replyToken, helpBubble);
              continue;
            }

            // ส่งข้อความให้เลขา
            if (msg === "ส่งข้อความให้เลขา") {
              const role = await getUserRoleByLineId(env, ev.source?.userId);
              if (role !== "boss") { await replyText(env, ev.replyToken, "เฉพาะหัวหน้าเท่านั้น"); continue; }

              await replyText(env, ev.replyToken, "กรุณาพิมพ์: ผู้ช่วย หรือ เลขา ตามด้วยข้อความ\nตัวอย่าง: ผู้ช่วย กรุณาเตรียมเอกสารประชุม");
              continue;
            }

            // ส่งข้อความไปเลขา (ต้องใช้คำสำคัญ "ผู้ช่วย" หรือ "เลขา" เป็น trigger)
            if (msg.startsWith("ผู้ช่วย ") || msg.startsWith("เลขา ")) {
              const role = await getUserRoleByLineId(env, ev.source?.userId);
              if (role !== "boss") { await replyText(env, ev.replyToken, "เฉพาะหัวหน้าเท่านั้น"); continue; }

              const message = msg.replace(/^(ผู้ช่วย|เลขา)\s+/, "").trim();
              if (!message) {
                await replyText(env, ev.replyToken, "กรุณาระบุข้อความ เช่น: ผู้ช่วย กรุณาเตรียมเอกสารประชุม");
                continue;
              }

              const sentCount = await sendMessageToAllSecretaries(env, message);
              await replyText(env, ev.replyToken, `✅ ส่งข้อความไป ${sentCount} คน: ${message}`);
              continue;
            }

            // รองรับรูปแบบเดิมด้วยเครื่องหมาย : (สำหรับความเข้ากันได้)
            if (msg.startsWith("ผู้ช่วย:") || msg.startsWith("เลขา:")) {
              const role = await getUserRoleByLineId(env, ev.source?.userId);
              if (role !== "boss") { await replyText(env, ev.replyToken, "เฉพาะหัวหน้าเท่านั้น"); continue; }

              const message = msg.replace(/^(ผู้ช่วย|เลขา):/, "").trim();
              if (!message) {
                await replyText(env, ev.replyToken, "กรุณาระบุข้อความ เช่น: ผู้ช่วย:กรุณาเตรียมเอกสารประชุม");
                continue;
              }

              const sentCount = await sendMessageToAllSecretaries(env, message);
              await replyText(env, ev.replyToken, `✅ ส่งข้อความไป ${sentCount} คน: ${message}`);
              continue;
            }

            // รองรับรูปแบบเดิม "ข้อความ:" (สำหรับความเข้ากันได้)
            if (msg.startsWith("ข้อความ:")) {
              const role = await getUserRoleByLineId(env, ev.source?.userId);
              if (role !== "boss") { await replyText(env, ev.replyToken, "เฉพาะหัวหน้าเท่านั้น"); continue; }

              const message = msg.replace("ข้อความ:", "").trim();
              if (!message) {
                await replyText(env, ev.replyToken, "กรุณาระบุข้อความ เช่น: ข้อความ:กรุณาเตรียมเอกสารประชุม");
                continue;
              }

              const sentCount = await sendMessageToAllSecretaries(env, message);
              await replyText(env, ev.replyToken, `✅ ส่งข้อความไป ${sentCount} คน: ${message}`);
              continue;
            }

            // ตอบสนองตัวเลือกจาก help menu
            if (/^[1-6]$/.test(msg)) {
              const role = await getUserRoleByLineId(env, ev.source?.userId);
              if (role !== "boss") { await replyText(env, ev.replyToken, "เฉพาะหัวหน้าเท่านั้น"); continue; }

              if (msg === "1") {
                const today = new Date().toISOString().slice(0,10);
                const schedules = await env.schedule_db
                  .prepare(`SELECT id,title,date,start_time,end_time,place,location,category_id,status,attend_status,notes
                            FROM schedules WHERE date = ? ORDER BY time(start_time) ASC`)
                  .bind(today).all();
                const items = schedules?.results || [];
                if (items.length === 0) {
                  await replyText(env, ev.replyToken, "วันนี้ไม่มีงาน");
                } else {
                  const bubble = buildScheduleFlexWithActions(today, items);
                  await replyLineFlex(env, ev.replyToken, bubble);
                }
              } else if (msg === "2") {
                const tomorrow = new Date();
                tomorrow.setDate(tomorrow.getDate() + 1);
                const tomorrowStr = tomorrow.toISOString().slice(0,10);
                const schedules = await env.schedule_db
                  .prepare(`SELECT id,title,date,start_time,end_time,place,location,category_id,status,attend_status,notes
                            FROM schedules WHERE date = ? ORDER BY time(start_time) ASC`)
                  .bind(tomorrowStr).all();
                const items = schedules?.results || [];
                if (items.length === 0) {
                  await replyText(env, ev.replyToken, "พรุ่งนี้ไม่มีงาน");
                } else {
                  const bubble = buildScheduleFlexWithActions(tomorrowStr, items);
                  await replyLineFlex(env, ev.replyToken, bubble);
                }
              } else if (msg === "3") {
                await replyText(env, ev.replyToken, "กรุณาพิมพ์ข้อความที่ต้องการส่งให้เลขา\nตัวอย่าง: ผู้ช่วย กรุณาเตรียมเอกสารประชุม\nหรือ: เลขา กรุณาจัดเตรียมห้องประชุม");
              } else if (msg === "4") {
                await replyText(env, ev.replyToken, "วิธีส่งข้อความให้เลขา:\n\n🔸 รูปแบบใหม่ (แนะนำ):\nผู้ช่วย กรุณาเตรียมเอกสารประชุม\nเลขา กรุณาจัดเตรียมห้องประชุม\n\n🔸 รูปแบบเดิม (ยังใช้ได้):\nผู้ช่วย:กรุณาเตรียมเอกสารประชุม\nเลขา:กรุณาจัดเตรียมห้องประชุม\nข้อความ:กรุณาเตรียมเอกสารประชุม\n\n🔸 วิธีเพิ่มงาน:\nเพิ่มงาน:ประชุม 15 14:00 ห้องประชุม\nนัดหมาย:พบลูกค้า 20 10:00 ออฟฟิศ");
              } else if (msg === "5") {
                // ตารางงานสัปดาห์นี้
                const today = new Date();
                const startOfWeek = new Date(today);
                startOfWeek.setDate(today.getDate() - today.getDay() + 1);
                const endOfWeek = new Date(startOfWeek);
                endOfWeek.setDate(startOfWeek.getDate() + 6);

                const startDate = startOfWeek.toISOString().slice(0,10);
                const endDate = endOfWeek.toISOString().slice(0,10);

                const schedules = await env.schedule_db
                  .prepare(`SELECT id,title,date,start_time,end_time,place,location,category_id,status,attend_status,notes
                            FROM schedules WHERE date BETWEEN ? AND ? ORDER BY date ASC, time(start_time) ASC`)
                  .bind(startDate, endDate).all();

                const items = schedules?.results || [];
                if (items.length === 0) {
                  await replyText(env, ev.replyToken, "สัปดาห์นี้ไม่มีงาน");
                } else {
                  const bubble = buildWeeklyScheduleFlex(startDate, endDate, items);
                  await replyLineFlex(env, ev.replyToken, bubble);
                }
              } else if (msg === "6") {
                // ตารางงานเดือนนี้
                const today = new Date();
                const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
                const endOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);

                const startDate = startOfMonth.toISOString().slice(0,10);
                const endDate = endOfMonth.toISOString().slice(0,10);

                const schedules = await env.schedule_db
                  .prepare(`SELECT id,title,date,start_time,end_time,place,location,category_id,status,attend_status,notes
                            FROM schedules WHERE date BETWEEN ? AND ? ORDER BY date ASC, time(start_time) ASC`)
                  .bind(startDate, endDate).all();

                const items = schedules?.results || [];
                if (items.length === 0) {
                  await replyText(env, ev.replyToken, "เดือนนี้ไม่มีงาน");
                } else {
                  await sendCalendarImage(env, ev.replyToken, startDate, endDate, items, "เดือนนี้");
                }
              }
              continue;
            }

            // งานด่วน
            if (msg.startsWith("งานด่วน:")) {
              const role = await getUserRoleByLineId(env, ev.source?.userId);
              if (role !== "boss") { await replyText(env, ev.replyToken, "เฉพาะหัวหน้าเท่านั้น"); continue; }

              const task = msg.replace("งานด่วน:", "").trim();
              if (!task) {
                await replyText(env, ev.replyToken, "กรุณาระบุงาน เช่น: งานด่วน:เตรียมเอกสารประชุม");
                continue;
              }

              await notifySecretaryUrgentTask(env, task);
              await replyText(env, ev.replyToken, `✅ ส่งงานด่วนแล้ว: ${task}`);
              continue;
            }

            // Default case - ไม่เข้าใจคำสั่ง
            console.log(`Unhandled message from boss: ${msg}`);
            await replyText(env, ev.replyToken, "ไม่เข้าใจคำสั่ง กรุณาพิมพ์ 'help' เพื่อดูคำสั่งที่ใช้ได้");
            continue;

            // เพิ่มงานผ่านข้อความ (Boss และ Secretary)
            if (msg.startsWith("เพิ่มงาน") || msg.startsWith("นัดหมาย") || msg.startsWith("กำหนดการ")) {
              const role = await getUserRoleByLineId(env, ev.source?.userId);
              if (!role || (role !== "boss" && role !== "secretary")) {
                await replyText(env, ev.replyToken, "เฉพาะหัวหน้าและเลขาเท่านั้น");
                continue;
              }

              if (msg === "เพิ่มงาน" || msg === "นัดหมาย" || msg === "กำหนดการ") {
                await replyText(env, ev.replyToken,
                  "📝 วิธีเพิ่มงาน/นัดหมาย/กำหนดการ:\n\n" +
                  "🔸 งานเดียว:\nเพิ่มงาน:ประชุม 15 14:00 ห้องประชุม\nนัดหมาย:พบลูกค้า 20 10:00 ออฟฟิศ\nกำหนดการ:ส่งรายงาน 25 16:00 แผนกบัญชี\n\n" +
                  "🔸 หลายงาน (แยกด้วย |):\nเพิ่มงาน:ประชุม 15 14:00 ห้องประชุม|นัดหมาย:พบลูกค้า 20 10:00 ออฟฟิศ");
                continue;
              }

              // แยกงานหลายงาน (ใช้ | เป็นตัวแยก)
              const taskList = msg.replace(/^(เพิ่มงาน|นัดหมาย|กำหนดการ)[:：]/, "").split("|");
              const results = [];

              for (const taskStr of taskList) {
                // ใช้ spacebar แทนจุลภาค - แต่ยังรองรับจุลภาคเดิมด้วย
                let parts;
                if (taskStr.includes(',')) {
                  // รูปแบบเดิม (จุลภาค)
                  parts = taskStr.trim().split(',').map(p => p.trim());
                } else {
                  // รูปแบบใหม่ (spacebar)
                  parts = taskStr.trim().split(/\s+/);
                }
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

                  // ตรวจสอบรูปแบบวันที่
                  const dateObj = new Date(date + 'T00:00:00');
                  if (isNaN(dateObj.getTime())) {
                    results.push(`❌ ${title}: รูปแบบวันที่ไม่ถูกต้อง`);
                    continue;
                  }
                  
                  // แปลงวันที่เป็นรูปแบบ YYYY-MM-DD
                  const formattedDate = `${dateObj.getFullYear()}-${String(dateObj.getMonth()+1).padStart(2,'0')}-${String(dateObj.getDate()).padStart(2,'0')}`;
                  
                  await createSchedule(env, {
                    title, 
                    date: formattedDate, 
                    start_time,
                    location, 
                    place: location, 
                    category_id,
                    assignees: "auto",
                    notes: role === "boss" ? "เพิ่มจาก LINE โดยหัวหน้า" : "เพิ่มจาก LINE โดยเลขา"
                  });

                  results.push(`✅ ${title}: ${formattedDate} ${start_time}`);
                } catch (err) {
                  console.error("เพิ่มงาน error:", err);
                  results.push(`❌ ${title}: ${err.message || 'เพิ่มไม่สำเร็จ'}`);
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
      const minute = bangkok.getMinutes();

      console.log(`[CRON] Bangkok time: ${bangkok.toISOString()}, Hour: ${hour}, Minute: ${minute}`);

      // ส่งสรุปงานประจำวัน
      if (hour === 8 && minute === 30) {
        console.log("[CRON] Sending today's agenda");
        await sendDailyAgendaToBoss(env, { format, type: 'today' });
      } else if (hour === 20 && minute === 0) {
        console.log("[CRON] Sending tomorrow's agenda");
        await sendDailyAgendaToBoss(env, { format, type: 'tomorrow' });
      }
      
      // ตรวจสอบและส่งการแจ้งเตือนก่อนเวลานัดหมาย (ทุก 30 นาที)
      if (minute === 0 || minute === 30) {
        console.log("[CRON] Checking for upcoming reminders");
        const { sendUpcomingReminders } = await import('./lineoa.js');
        await sendUpcomingReminders(env);
      }
      
      if (hour !== 8 && hour !== 20 && minute !== 0 && minute !== 30) {
        console.log(`[CRON] No action for ${hour}:${minute.toString().padStart(2, '0')}`);
      }
    } catch (e) {
      console.error("CRON ERROR:", e?.message, e?.stack);
    }
  },
};

/* =========================
 * Test Page HTML
 * ========================= */
function renderTestPage() {
  return `<!doctype html>
<html lang="th"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>ทดสอบระบบ Schedule Worker</title>
<style>
body{font-family:system-ui;margin:24px;background:#0b0e17;color:#e5e7eb}
.card{background:#141927;border-radius:12px;padding:16px;margin-bottom:16px}
input,textarea,button,select{font:inherit;padding:8px;margin:4px 0;background:#1f2937;color:#e5e7eb;border:1px solid #374151;border-radius:6px;width:100%;box-sizing:border-box}
button{background:#16a34a;color:#fff;cursor:pointer;border:none;width:auto}
button.danger{background:#ef4444}
button:hover{opacity:0.9}
.result{background:#0f1422;padding:12px;border-radius:8px;margin-top:8px;white-space:pre-wrap;font-family:monospace;font-size:12px}
table{width:100%;border-collapse:collapse;margin-top:8px}
th,td{padding:8px;text-align:left;border-bottom:1px solid #374151}
th{background:#1f2937;color:#cbd5e1;font-weight:bold}
td{background:#0f1422;color:#e5e7eb}
.status-boss{color:#10b981}
.status-secretary{color:#60a5fa}
.global-token{background:#1e40af;padding:16px;border-radius:8px;margin-bottom:16px;text-align:center}
h1{color:#f8fafc;margin-bottom:24px;font-size:24px}
h2{color:#e5e7eb;margin-bottom:12px;font-size:18px}
h3{color:#cbd5e1;margin-top:16px;margin-bottom:8px;font-size:14px}
label{display:block;margin:8px 0;color:#94a3b8}
</style></head>
<body>
<h1>ทดสอบระบบ Schedule Worker</h1>

<div class="global-token">
  <h2>🔑 ตั้งค่า Token สำหรับทุกฟีเจอร์</h2>
  <label>SEED_ADMIN_TOKEN:<br>
    <input id="globalToken" type="password" placeholder="ใส่ SEED_ADMIN_TOKEN"/>
  </label>
  <button onclick="setGlobalToken()">ตั้งค่า Token</button>
  <div id="tokenStatus" style="margin-top:8px;font-size:14px"></div>
</div>

<div class="card">
  <h2>ทดสอบส่งข้อความให้ Boss</h2>
  <label>LINE User ID ของ Boss:<br>
    <input id="lineUserId" value="U1234567890abcdef1234567890abcdef"/>
  </label>
  <label>รูปแบบ:
    <select id="messageFormat">
      <option value="text">Text Message</option>
      <option value="flex">Flex Message (ตารางงานวันนี้)</option>
    </select>
  </label>
  <label>ข้อความ (สำหรับ text):<br>
    <textarea id="message" rows="3">สวัสดีครับ นี่คือการทดสอบส่งข้อความจาก Schedule Worker</textarea>
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
    <input id="bossUserId" value="Ue358aad024251165657dfcb85c8755fe"/>
  </label>
  <button onclick="setBoss()">ตั้งเป็น Boss</button>
  <div id="bossResult" class="result"></div>

  <h3>เพิ่มเลขาใหม่</h3>
  <label>LINE User ID ของเลขา:<br>
    <input id="secretaryUserId" placeholder="U1234567890abcdef1234567890abcdef"/>
  </label>
  <label>ชื่อเลขา:<br>
    <input id="secretaryName" placeholder="เลขานุการ"/>
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
    <div id="usersList"></div>
  </div>

  <div style="margin:12px 0">
    <button onclick="setupDatabase()" style="background:#f59e0b">Setup Database</button>
    <button onclick="createTables()" style="margin-left:8px">สร้างตาราง</button>
    <button onclick="loadLineTargets()" style="margin-left:8px">โหลด LINE User ID</button>
    <div id="lineTargetsList"></div>
  </div>

  <div id="roleManagement" style="display:none;margin-top:16px">
    <h3>เปลี่ยน Role</h3>
    <label>เลือกผู้ใช้:<br>
      <select id="userSelect">
        <option value="">-- เลือกผู้ใช้ --</option>
      </select>
    </label>
    <label>เลือก Role:<br>
      <select id="roleSelect">
        <option value="boss">Boss (หัวหน้า)</option>
        <option value="secretary">Secretary (เลขา)</option>
      </select>
    </label>
    <div style="margin-top:12px">
      <button onclick="updateUserRole()">อัพเดท Role</button>
      <button onclick="deleteUser()" class="danger" style="margin-left:8px">ลบผู้ใช้</button>
    </div>
    <div id="roleResult" class="result"></div>
  </div>
</div>

<div class="card">
  <h2>ทดสอบส่งข้อความให้เลขา</h2>
  <label>ข้อความ:<br>
    <textarea id="secretaryMessage" rows="3">ทดสอบข้อความจากหัวหน้า</textarea>
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
    if(result.ok) {
      document.getElementById('sendResult').innerHTML = '<div style="color:#10b981">✅ ส่งสำเร็จ: ' + (result.sent || 'message') + ' ไปยัง ' + result.to + '</div>';
    } else {
      document.getElementById('sendResult').innerHTML = '<div style="color:#ef4444">❌ Error: ' + (result.error || 'Unknown error') + '</div>';
    }
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
  if(result.ok) {
    document.getElementById('cronResult').innerHTML = '<div style="color:#10b981">✅ Cron ทำงานสำเร็จ: ' + result.ran + ' (' + result.format + ')</div>';
  } else {
    document.getElementById('cronResult').innerHTML = '<div style="color:#ef4444">❌ Error: ' + (result.error || 'Unknown error') + '</div>';
  }
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
    if(result.ok) {
      document.getElementById('cronResult').innerHTML = '<div style="color:#10b981">✅ Cron ทำงานสำเร็จ: ' + result.ran + ' (' + result.format + ')</div>';
    } else {
      document.getElementById('cronResult').innerHTML = '<div style="color:#ef4444">❌ Error: ' + (result.error || 'Unknown error') + '</div>';
    }
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
  
  if(res.ok && result.data) {
    let html = '<table><tr><th>ชื่อ</th><th>LINE User ID</th><th>วันที่สร้าง</th></tr>';
    result.data.forEach(secretary => {
      const date = new Date(secretary.created_at).toLocaleDateString('th-TH');
      html += '<tr><td>' + escapeHtml(secretary.name) + '</td><td>' + escapeHtml(secretary.line_user_id || '-') + '</td><td>' + date + '</td></tr>';
    });
    html += '</table>';
    document.getElementById('secretaryList').innerHTML = html;
  } else {
    document.getElementById('secretaryList').innerHTML = '<div class="result">' + JSON.stringify(result, null, 2) + '</div>';
  }
}

async function testSendToSecretaries(){
  const message = document.getElementById('secretaryMessage').value;

  const res = await fetch('/test/send-to-secretaries', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({ message })
  });

  const result = await res.json().catch(() => ({}));
  if(result.ok) {
    document.getElementById('secretaryMsgResult').innerHTML = '<div style="color:#10b981">✅ ส่งข้อความไปเลขา ' + result.secretaryCount + ' คนสำเร็จ</div>';
  } else {
    document.getElementById('secretaryMsgResult').innerHTML = '<div style="color:#ef4444">❌ Error: ' + (result.error || 'Unknown error') + '</div>';
  }
}

let allUsers = [];

function escapeHtml(unsafe) {
  if (!unsafe) return '';
  return String(unsafe)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function loadAllUsers(){
  const token = getToken();
  if(!token) return;

  try {
    const res = await fetch('/admin/users', {
      headers: {'authorization': 'Bearer ' + token}
    });

    const result = await res.json().catch(() => ({ error: 'Invalid JSON response' }));

    if(res.ok && result.data) {
      allUsers = result.data;

      let html = '<table><tr><th>ชื่อ</th><th>Role</th><th>LINE User ID</th><th>วันที่สร้าง</th></tr>';
      result.data.forEach(user => {
        const roleClass = user.role === 'boss' ? 'status-boss' : 'status-secretary';
        const roleText = user.role === 'boss' ? 'Boss' : 'Secretary';
        const lineId = escapeHtml(user.line_user_id || '-');
        const date = new Date(user.created_at).toLocaleDateString('th-TH');
        html += '<tr><td>' + escapeHtml(user.name) + '</td><td class="' + roleClass + '">' + roleText + '</td><td>' + lineId + '</td><td>' + date + '</td></tr>';
      });
      html += '</table>';

      document.getElementById('usersList').innerHTML = html;

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
      document.getElementById('usersList').innerHTML = '<div class="result">' + JSON.stringify(result, null, 2) + '</div>';
    }
  } catch (error) {
    document.getElementById('usersList').innerHTML = '<div class="result">Error: ' + error.message + '</div>';
  }
}

async function setupDatabase(){
  try {
    const res = await fetch('/test/setup', {
      method: 'POST',
      headers: {'content-type': 'application/json'}
    });

    const result = await res.json().catch(() => ({ error: 'Invalid JSON response' }));
    
    if(res.ok) {
      alert('✅ Database setup สำเร็จ! ตอนนี้สามารถใส่ token แล้วใช้งานได้');
    } else {
      alert('❌ Error: ' + (result.error || 'Unknown error'));
    }
  } catch (error) {
    alert('❌ Error: ' + error.message);
  }
}

async function createTables(){
  const token = getToken();
  if(!token) return;

  try {
    const res = await fetch('/admin/seed/tables', {
      method: 'POST',
      headers: {'authorization': 'Bearer ' + token}
    });

    const result = await res.json().catch(() => ({ error: 'Invalid JSON response' }));
    
    if(res.ok) {
      alert('✅ สร้างตารางสำเร็จ');
      loadLineTargets();
    } else {
      alert('❌ Error: ' + (result.error || 'Unknown error'));
    }
  } catch (error) {
    alert('❌ Error: ' + error.message);
  }
}

async function loadLineTargets(){
  const token = getToken();
  if(!token) return;

  try {
    const res = await fetch('/admin/line-targets', {
      headers: {'authorization': 'Bearer ' + token}
    });

    const result = await res.json().catch(() => ({ error: 'Invalid JSON response' }));

    if(res.ok && result.data) {
      if(result.data.length === 0) {
        document.getElementById('lineTargetsList').innerHTML = '<div style="color:#9ca3af;padding:12px">ไม่มี LINE User ID ในระบบ</div>';
      } else {
        let html = '<table><tr><th>ชื่อ LINE</th><th>LINE User ID</th><th>วันที่เพิ่ม</th></tr>';
        result.data.forEach(target => {
          const date = new Date(target.created_at).toLocaleDateString('th-TH');
          html += '<tr><td>' + escapeHtml(target.display_name || 'Unknown') + '</td><td>' + escapeHtml(target.line_user_id) + '</td><td>' + date + '</td></tr>';
        });
        html += '</table>';
        document.getElementById('lineTargetsList').innerHTML = html;
      }
    } else {
      if(res.status === 500) {
        document.getElementById('lineTargetsList').innerHTML = '<div style="color:#ef4444;padding:12px">❌ Database ยังไม่พร้อม กรุณากดปุ่ม "Setup Database" ก่อน</div>';
      } else {
        document.getElementById('lineTargetsList').innerHTML = '<div class="result">' + JSON.stringify(result, null, 2) + '</div>';
      }
    }
  } catch (error) {
    document.getElementById('lineTargetsList').innerHTML = '<div class="result">Error: ' + error.message + '</div>';
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

/* =========================
 * Calendar (Public HTML)
 * ========================= */
function renderPublicCalendarPage(url) {
  const view = (url.searchParams.get("view") || "month").toLowerCase(); // day|week|month
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
  <footer>Generated by Krittapon</footer>
</div>
<script>
const qs = new URLSearchParams(location.search);
const view = (qs.get('view')||'month').toLowerCase();
const date = qs.get('date') || (new Date()).toISOString().slice(0,10);
const viewEl = document.getElementById('view');
const headline = document.getElementById('headline');

function fmt(d){ 
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' }); 
}
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
            const targetDate = y + '-' + String(m + 1).padStart(2, '0') + '-' + String(dayCount).padStart(2, '0');
            const items = by[targetDate]||[];
            html += '<div class="daycell clickable" onclick="openDayForm(&quot;'+targetDate+'&quot;)">';
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
  window.selectedCalendarDate = selectedDate;
  
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
        '<textarea id="newNotes" placeholder="หมายเหตุ/กำหนดการ" rows="2" style="width:100%;margin-bottom:8px;padding:8px;border:1px solid #374151;border-radius:6px;background:#1f2937;color:#e5e7eb;resize:vertical"></textarea>'+
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
    const notes = t.notes ? '<br><small style="color:#cbd5e1">📝 '+t.notes+'</small>' : '';
    return '<div style="padding:8px;margin:4px 0;background:#1f2937;border-radius:6px;color:#e5e7eb">' +
           '<strong>'+(t.title||'-')+'</strong> <span style="color:#9ca3af">'+time+'</span><br>' +
           '<small>'+(t.place||'-')+'</small>' + notes + '</div>';
  }).join('');
  const taskListElement = document.getElementById('taskList');
  if (taskListElement) {
    taskListElement.innerHTML = html || '<p style="color:#9ca3af">ยังไม่มีงาน</p>';
  } else {
    console.error('Element with ID "taskList" not found');
  }
}

async function addTask(selectedDate){
  const title = document.getElementById('newTitle').value.trim();
  const start = document.getElementById('newStart').value;
  const end = document.getElementById('newEnd').value;
  const place = document.getElementById('newPlace').value.trim();
  const category = document.getElementById('newCategory').value;

  if(!title || !start) return alert('กรุณากรอกชื่อและเวลาเริ่ม');

  const targetDate = window.selectedCalendarDate;

  const notes = document.getElementById('newNotes').value.trim();
  const res = await fetch('/schedules', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({
      title, 
      date: targetDate,
      start_time: start, 
      end_time: end || null, 
      place: place || null,
      category_id: category, 
      notes: notes || null
    })
  });

  if(res.ok){
    document.getElementById('newTitle').value = '';
    document.getElementById('newStart').selectedIndex = 0;
    document.getElementById('newEnd').selectedIndex = 0;
    document.getElementById('newPlace').value = '';
    document.getElementById('newNotes').value = '';
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
    .prepare(`SELECT id,title,date,start_time,end_time,place,location,category_id,attend_status,notes
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

    if (items.length) {
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
  const now = new Date().toISOString();
  
  // Create tables one by one
  await env.schedule_db.prepare(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('boss', 'secretary')),
      api_key TEXT UNIQUE,
      line_user_id TEXT UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `).run();

  await env.schedule_db.prepare(`
    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      label TEXT NOT NULL,
      color TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `).run();

  await env.schedule_db.prepare(`
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
      updated_at TEXT NOT NULL
    )
  `).run();

  await env.schedule_db.prepare(`
    CREATE TABLE IF NOT EXISTS notifications_sent (
      id TEXT PRIMARY KEY,
      schedule_id TEXT,
      type TEXT NOT NULL,
      target TEXT NOT NULL,
      sent_at TEXT NOT NULL
    )
  `).run();

  await env.schedule_db.prepare(`
    CREATE TABLE IF NOT EXISTS line_targets (
      id TEXT PRIMARY KEY,
      line_user_id TEXT UNIQUE NOT NULL,
      display_name TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `).run();

  console.log('Tables created successfully');

  // Categories
  await env.schedule_db.prepare(`
    INSERT OR IGNORE INTO categories (id, code, label, color, created_at, updated_at)
    VALUES
      ('00000000-0000-0000-0000-000000000001', 'internal', 'งานในหน่วย', '#3b82f6', ?, ?),
      ('00000000-0000-0000-0000-000000000002', 'department', 'งานในกรม', '#10b981', ?, ?),
      ('00000000-0000-0000-0000-000000000003', 'big', 'งานใหญ่', '#f59e0b', ?, ?),
      ('00000000-0000-0000-0000-000000000004', 'external', 'งานนอก', '#ef4444', ?, ?)
  `).bind(now, now, now, now, now, now, now, now).run();

  console.log('Categories inserted');

  // Default users
  await env.schedule_db.prepare(`
    INSERT OR IGNORE INTO users (id, name, role, api_key, line_user_id, created_at, updated_at)
    VALUES
      ('00000000-0000-0000-0000-000000000001', 'เลขานุการ', 'secretary', NULL, NULL, ?, ?),
      ('00000000-0000-0000-0000-000000000002', 'หัวหน้า', 'boss', NULL, NULL, ?, ?)
  `).bind(now, now, now, now).run();

  console.log('Default users inserted');
}

/* =========================
 * D1 helpers (app logic)
 * ========================= */


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
  const userId = event?.source?.userId;
  if (!userId) {
    console.error('handleFollow: Missing userId');
    return;
  }

  try {
    // ดึงข้อมูลผู้ใช้จาก LINE
    const response = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
      headers: { 'Authorization': `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` }
    });
    
    if (!response.ok) {
      throw new Error(`LINE API error: ${response.status}`);
    }
    
    const profile = await response.json();

    // เพิ่มลงใน line_targets
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await env.schedule_db.prepare(
      "INSERT INTO line_targets (id, line_user_id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(id, userId, profile.displayName || 'Unknown', now, now).run();

    // ส่งข้อความต้อนรับ
    await pushLineText(env, userId,
      "ยินดีต้อนรับสู่ระบบตารางงาน! 🎉\n\n" +
      "กรุณาแจ้งให้ผู้ดูแลระบบเพิ่ม User ID ของคุณเข้าสู่ระบบ\n\n" +
      "User ID: " + userId
    );

  } catch (error) {
    console.error('Failed to handle follow:', error);
    await pushLineText(env, userId, "ขออภัย เกิดข้อผิดพลาดในการลงทะเบียน กรุณาลองใหม่อีกครั้ง");
  }
}

async function setAttendStatus(env, scheduleId, value) {
  if (!["yes", "no"].includes(value)) throw new Error("invalid attend_status");
  return await env.schedule_db
    .prepare("UPDATE schedules SET attend_status = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(value, scheduleId)
    .run();
}

async function createSchedule(env, body) {
  const startTime = Date.now();
  
  try {
    if (!body || typeof body !== 'object') {
      throw new Error("Invalid request body");
    }
    
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
    
    // Enhanced validation
    if (!title || title.length > 500) {
      throw new Error("Invalid title");
    }
    
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error("Invalid date format. Use YYYY-MM-DD");
    }
    
    if (!start_time || !/^\d{2}:\d{2}$/.test(start_time)) {
      throw new Error("Invalid start_time format. Use HH:MM");
    }
    
    if (end_time && !/^\d{2}:\d{2}$/.test(end_time)) {
      throw new Error("Invalid end_time format. Use HH:MM");
    }

    const result = await env.schedule_db.prepare(
      "INSERT INTO schedules (id, title, date, start_time, end_time, location, place, category_id, assignees, notes, status, attend_status, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'planned',NULL,?11,?12)"
    ).bind(id, title, date, start_time, end_time, location, place, category_id, assignees, notes, now, now).run();

    const duration = Date.now() - startTime;
    console.log(`[createSchedule] Created schedule ${id} in ${duration}ms`);
    
    return { id, created: true };
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[createSchedule] Error after ${duration}ms:`, error.message);
    throw error;
  }
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

  const bubble = {
    type: "bubble",
    header: { type: "box", layout: "vertical", contents: [
      { type: "text", text: "🔔 งานใหม่เข้ามา", weight: "bold", size: "lg", color: "#10b981" }
    ]},
    body: { type: "box", layout: "vertical", spacing: "md", contents: [
      { type: "box", layout: "baseline", spacing: "sm", contents: [
        { type: "text", text: "📅 วันที่:", size: "sm", color: "#9ca3af", flex: 2 },
        { type: "text", text: schedule.date, size: "sm", color: "#e5e7eb", flex: 3 }
      ]},
      { type: "box", layout: "baseline", spacing: "sm", contents: [
        { type: "text", text: "⏰ เวลา:", size: "sm", color: "#9ca3af", flex: 2 },
        { type: "text", text: time, size: "sm", color: "#e5e7eb", flex: 3 }
      ]},
      { type: "box", layout: "baseline", spacing: "sm", contents: [
        { type: "text", text: "📝 เรื่อง:", size: "sm", color: "#9ca3af", flex: 2 },
        { type: "text", text: schedule.title, size: "sm", color: "#e5e7eb", flex: 3, wrap: true }
      ]},
      { type: "box", layout: "baseline", spacing: "sm", contents: [
        { type: "text", text: "📍 สถานที่:", size: "sm", color: "#9ca3af", flex: 2 },
        { type: "text", text: schedule.place || "-", size: "sm", color: "#e5e7eb", flex: 3, wrap: true }
      ]}
    ]}
  };

  for (const boss of bosses.results || []) {
    await pushLineFlex(env, boss.line_user_id, bubble);
  }
}

async function notifySecretaryUrgentTask(env, task) {
  const secretaries = await env.schedule_db
    .prepare("SELECT line_user_id FROM users WHERE role='secretary' AND line_user_id IS NOT NULL")
    .all();

  if (!secretaries?.results?.length) {
    console.log(`🚨 ไม่มีเลขาที่มี LINE ID: ${task}`);
    return;
  }

  const bubble = {
    type: "bubble",
    header: { type: "box", layout: "vertical", contents: [
      { type: "text", text: "🚨 งานด่วนจากหัวหน้า", weight: "bold", size: "lg", color: "#ef4444" }
    ]},
    body: { type: "box", layout: "vertical", spacing: "md", contents: [
      { type: "text", text: task, size: "md", color: "#e5e7eb", wrap: true }
    ]},
    footer: { type: "box", layout: "vertical", spacing: "sm", contents: [
      { type: "text", text: "⏰ " + new Date().toLocaleString('th-TH'), size: "xs", color: "#9ca3af" }
    ]}
  };

  for (const sec of secretaries.results) {
    await pushLineFlex(env, sec.line_user_id, bubble);
  }
}

function buildHelpFlex() {
  return {
    type: "bubble",
    size: "giga",
    body: {
      type: "box", layout: "vertical", backgroundColor: "#0f172a", paddingAll: "16px",
      contents: [
        { type: "text", text: "📝 คู่มือการใช้งาน", weight: "bold", size: "lg", color: "#f8fafc", align: "center" },
        { type: "separator", margin: "lg", color: "#334155" },
        { type: "text", text: "กรุณาพิมพ์ตัวเลข 1-6 เพื่อเลือกฟังก์ชัน:", size: "sm", color: "#94a3b8", align: "center", margin: "md" },
        {
          type: "box", layout: "vertical", spacing: "md", margin: "lg",
          contents: [
            {
              type: "box", layout: "horizontal", spacing: "sm", paddingAll: "12px",
              backgroundColor: "#1f2937", cornerRadius: "8px",
              contents: [
                { type: "text", text: "1", size: "lg", color: "#3b82f6", weight: "bold", flex: 0 },
                { type: "text", text: "ดูตารางงานวันนี้", size: "md", color: "#e5e7eb", flex: 1, paddingStart: "8px" }
              ]
            },
            {
              type: "box", layout: "horizontal", spacing: "sm", paddingAll: "12px",
              backgroundColor: "#1f2937", cornerRadius: "8px",
              contents: [
                { type: "text", text: "2", size: "lg", color: "#10b981", weight: "bold", flex: 0 },
                { type: "text", text: "ดูตารางงานพรุ่งนี้", size: "md", color: "#e5e7eb", flex: 1, paddingStart: "8px" }
              ]
            },
            {
              type: "box", layout: "horizontal", spacing: "sm", paddingAll: "12px",
              backgroundColor: "#1f2937", cornerRadius: "8px",
              contents: [
                { type: "text", text: "3", size: "lg", color: "#f59e0b", weight: "bold", flex: 0 },
                { type: "text", text: "ส่งข้อความให้เลขา", size: "md", color: "#e5e7eb", flex: 1, paddingStart: "8px" }
              ]
            },
            {
              type: "box", layout: "horizontal", spacing: "sm", paddingAll: "12px",
              backgroundColor: "#1f2937", cornerRadius: "8px",
              contents: [
                { type: "text", text: "4", size: "lg", color: "#ef4444", weight: "bold", flex: 0 },
                { type: "text", text: "วิธีส่งข้อความให้เลขา", size: "md", color: "#e5e7eb", flex: 1, paddingStart: "8px" }
              ]
            },
            {
              type: "box", layout: "horizontal", spacing: "sm", paddingAll: "12px",
              backgroundColor: "#1f2937", cornerRadius: "8px",
              contents: [
                { type: "text", text: "5", size: "lg", color: "#8b5cf6", weight: "bold", flex: 0 },
                { type: "text", text: "ดูตารางงานสัปดาห์นี้", size: "md", color: "#e5e7eb", flex: 1, paddingStart: "8px" }
              ]
            },
            {
              type: "box", layout: "horizontal", spacing: "sm", paddingAll: "12px",
              backgroundColor: "#1f2937", cornerRadius: "8px",
              contents: [
                { type: "text", text: "6", size: "lg", color: "#06b6d4", weight: "bold", flex: 0 },
                { type: "text", text: "ดูตารางงานเดือนนี้", size: "md", color: "#e5e7eb", flex: 1, paddingStart: "8px" }
              ]
            }
          ]
        },
        { type: "separator", margin: "lg", color: "#334155" },
        { type: "text", text: "หรือพิมพ์ 'help' เพื่อดูเมนูนี้อีกครั้ง", size: "xs", color: "#64748b", align: "center", margin: "md" }
      ]
    }
  };
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

async function pushLineText(env, lineUserId, text) {
  const startTime = Date.now();
  
  if (!lineUserId || !text) {
    console.error('[pushLineText] Missing required parameters');
    return;
  }
  
  console.log(`[pushLineText] Sending to ${lineUserId}:`, text.substring(0, 100) + '...');

  if (!env?.LINE_CHANNEL_ACCESS_TOKEN) {
    console.error("[pushLineText] LINE_CHANNEL_ACCESS_TOKEN not configured");
    return;
  }

  const url = "https://api.line.me/v2/bot/message/push";
  const headers = { "content-type": "application/json", "Authorization": `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` };
  const body = { to: lineUserId, messages: [{ type: "text", text }] };

  try {
    const res = await fetchWithTimeout(url, { 
      method: "POST", 
      headers, 
      body: JSON.stringify(body) 
    }, 15000);
    
    if (!res.ok) {
      const msg = await res.text().catch(() => res.statusText);
      console.error("[pushLineText] LINE push error:", res.status, msg);
    } else {
      const duration = Date.now() - startTime;
      console.log(`[pushLineText] Successfully sent to ${lineUserId} in ${duration}ms`);
    }
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[pushLineText] Network error after ${duration}ms:`, error.message);
  }
}

async function pushLineFlex(env, lineUserId, bubble) {
  const startTime = Date.now();
  
  if (!lineUserId || !bubble) {
    console.error('[pushLineFlex] Missing required parameters');
    return;
  }
  
  console.log(`[pushLineFlex] Sending flex message to ${lineUserId}`);

  if (!env?.LINE_CHANNEL_ACCESS_TOKEN) {
    console.error("[pushLineFlex] LINE_CHANNEL_ACCESS_TOKEN not configured");
    return;
  }

  const url = "https://api.line.me/v2/bot/message/push";
  const headers = { "content-type": "application/json", "Authorization": `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` };
  const body = { to: lineUserId, messages: [{ type: "flex", altText: "สรุปงานวันนี้", contents: bubble }] };

  try {
    const res = await fetchWithTimeout(url, { 
      method: "POST", 
      headers, 
      body: JSON.stringify(body) 
    }, 15000);
    
    if (!res.ok) {
      const msg = await res.text().catch(() => res.statusText);
      console.error("[pushLineFlex] LINE push FLEX error:", res.status, msg);
    } else {
      const duration = Date.now() - startTime;
      console.log(`[pushLineFlex] Successfully sent flex to ${lineUserId} in ${duration}ms`);
    }
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[pushLineFlex] Network error after ${duration}ms:`, error.message);
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

async function safeJson(request) { 
  try { 
    return await request.json(); 
  } catch { 
    return {}; 
  } 
}

function normalize(s) { 
  return (s || "").trim(); 
}

function escapeHtml(unsafe) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function buildWeeklyScheduleFlex(startDate, endDate, items) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const thaiMonths = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
                     'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
  
  const startDay = start.getDate();
  const startMonth = thaiMonths[start.getMonth()];
  const endDay = end.getDate();
  const endMonth = thaiMonths[end.getMonth()];
  const year = start.getFullYear() + 543;
  
  const weekRange = `${startDay} ${startMonth} - ${endDay} ${endMonth} ${year}`;
  
  // จัดกลุ่มงานตามวันที่
  const groupedByDate = {};
  items.forEach(item => {
    if (!groupedByDate[item.date]) {
      groupedByDate[item.date] = [];
    }
    groupedByDate[item.date].push(item);
  });
  
  const categoryColors = {
    '00000000-0000-0000-0000-000000000001': '#3b82f6',
    '00000000-0000-0000-0000-000000000002': '#10b981',
    '00000000-0000-0000-0000-000000000003': '#f59e0b',
    '00000000-0000-0000-0000-000000000004': '#ef4444'
  };
  
  const dayContents = [];
  
  // สร้างเนื้อหาสำหรับแต่ละวัน
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().slice(0, 10);
    const dayItems = groupedByDate[dateStr] || [];
    const thaiDays = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
    const dayName = thaiDays[d.getDay()];
    const dayNum = d.getDate();
    
    if (dayItems.length > 0) {
      dayContents.push({
        type: "box", layout: "vertical", spacing: "xs", margin: "md",
        paddingAll: "12px", backgroundColor: "#1f2937", cornerRadius: "8px",
        contents: [
          { type: "text", text: `${dayName} ${dayNum}`, weight: "bold", size: "md", color: "#f8fafc" },
          { type: "separator", margin: "sm", color: "#374151" },
          ...dayItems.map((item, i) => {
            const time = item.end_time ? `${item.start_time}–${item.end_time}` : item.start_time;
            const color = categoryColors[item.category_id] || '#6b7280';
            return {
              type: "box", layout: "horizontal", spacing: "sm", margin: "xs",
              contents: [
                {
                  type: "box", layout: "vertical", flex: 0, width: "3px", height: "100%",
                  backgroundColor: color, cornerRadius: "2px"
                },
                {
                  type: "box", layout: "vertical", flex: 1, paddingStart: "6px",
                  contents: [
                    { type: "text", text: time || "-", size: "xs", color: "#94a3b8", weight: "bold" },
                    { type: "text", text: item.title, size: "sm", color: "#e5e7eb", wrap: true, maxLines: 2 },
                    { type: "text", text: item.place || "-", size: "xs", color: "#6b7280" }
                  ]
                }
              ]
            };
          })
        ]
      });
    }
  }
  
  if (dayContents.length === 0) {
    dayContents.push({
      type: "text", text: "ไม่มีงานในสัปดาห์นี้", size: "md", color: "#64748b", align: "center", margin: "xl"
    });
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
            { type: "text", text: "📅 ตารางงานสัปดาห์นี้", weight: "bold", size: "lg", color: "#f8fafc", align: "center" },
            { type: "text", text: weekRange, size: "sm", color: "#94a3b8", align: "center" }
          ]
        },
        { type: "separator", margin: "lg", color: "#334155" },
        { type: "box", layout: "vertical", spacing: "xs", contents: dayContents }
      ]
    }
  };
}

async function sendCalendarImage(env, replyToken, startDate, endDate, items, period) {
  try {
    // สร้าง HTML สำหรับปฏิทิน
    const calendarHTML = generateCalendarHTML(startDate, endDate, items, period);
    
    // ถ้ามี Browser Rendering API ให้ใช้
    if (env.CF_ACCOUNT_ID && env.CF_BR_TOKEN) {
      const { renderToPNGBase64 } = await import('./lineoa.js');
      const imageBase64 = await renderToPNGBase64(env, calendarHTML);
      
      // อัพโหลดภาพไปยัง temporary storage หรือใช้ data URL
      const imageUrl = `data:image/png;base64,${imageBase64}`;
      
      // ส่งภาพผ่าน LINE
      await replyLineImage(env, replyToken, imageUrl);
    } else {
      // ถ้าไม่มี Browser Rendering ให้ส่งเป็น text แทน
      const textSummary = generateTextSummary(startDate, endDate, items, period);
      await replyText(env, replyToken, textSummary);
    }
  } catch (error) {
    console.error('Error sending calendar image:', error);
    // ส่งเป็น text แทนถ้าเกิดข้อผิดพลาด
    const textSummary = generateTextSummary(startDate, endDate, items, period);
    await replyText(env, replyToken, textSummary);
  }
}

function generateCalendarHTML(startDate, endDate, items, period) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const thaiMonths = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
                     'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
  
  const month = thaiMonths[start.getMonth()];
  const year = start.getFullYear() + 543;
  
  // จัดกลุ่มงานตามวันที่
  const groupedByDate = {};
  items.forEach(item => {
    if (!groupedByDate[item.date]) {
      groupedByDate[item.date] = [];
    }
    groupedByDate[item.date].push(item);
  });
  
  let calendarRows = '';
  
  // สร้างปฏิทินแบบตาราง
  const firstDay = new Date(start.getFullYear(), start.getMonth(), 1);
  const lastDay = new Date(start.getFullYear(), start.getMonth() + 1, 0);
  const startDay = firstDay.getDay() === 0 ? 6 : firstDay.getDay() - 1; // จันทร์ = 0
  
  let currentDate = 1;
  const totalDays = lastDay.getDate();
  
  for (let week = 0; week < 6; week++) {
    let weekRow = '<tr>';
    
    for (let day = 0; day < 7; day++) {
      if ((week === 0 && day < startDay) || currentDate > totalDays) {
        weekRow += '<td class="empty"></td>';
      } else {
        const dateStr = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(currentDate).padStart(2, '0')}`;
        const dayItems = groupedByDate[dateStr] || [];
        
        let cellContent = `<div class="day-number">${currentDate}</div>`;
        
        if (dayItems.length > 0) {
          cellContent += '<div class="tasks">';
          dayItems.slice(0, 3).forEach(item => {
            const time = item.start_time ? item.start_time.slice(0, 5) : '';
            cellContent += `<div class="task">${time} ${item.title}</div>`;
          });
          if (dayItems.length > 3) {
            cellContent += `<div class="more">+${dayItems.length - 3} อื่นๆ</div>`;
          }
          cellContent += '</div>';
        }
        
        weekRow += `<td class="day-cell">${cellContent}</td>`;
        currentDate++;
      }
    }
    
    weekRow += '</tr>';
    calendarRows += weekRow;
    
    if (currentDate > totalDays) break;
  }
  
  return `<!DOCTYPE html>
<html lang="th">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ปฏิทิน${period}</title>
    <style>
        body {
            font-family: 'Sarabun', 'Noto Sans Thai', sans-serif;
            margin: 0;
            padding: 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: #333;
            width: 1200px;
            height: 800px;
        }
        .calendar-container {
            background: white;
            border-radius: 15px;
            padding: 30px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.2);
            height: calc(100% - 60px);
        }
        .header {
            text-align: center;
            margin-bottom: 30px;
        }
        .title {
            font-size: 36px;
            font-weight: bold;
            color: #2d3748;
            margin-bottom: 10px;
        }
        .subtitle {
            font-size: 24px;
            color: #4a5568;
        }
        .calendar {
            width: 100%;
            border-collapse: collapse;
            height: calc(100% - 120px);
        }
        .calendar th {
            background: #4a5568;
            color: white;
            padding: 15px;
            text-align: center;
            font-size: 18px;
            font-weight: bold;
        }
        .calendar td {
            border: 1px solid #e2e8f0;
            vertical-align: top;
            width: 14.28%;
            height: 100px;
            position: relative;
        }
        .day-cell {
            padding: 8px;
            background: #f7fafc;
        }
        .empty {
            background: #edf2f7;
        }
        .day-number {
            font-size: 16px;
            font-weight: bold;
            color: #2d3748;
            margin-bottom: 5px;
        }
        .tasks {
            font-size: 11px;
        }
        .task {
            background: #bee3f8;
            color: #2b6cb0;
            padding: 2px 4px;
            margin: 1px 0;
            border-radius: 3px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .more {
            color: #718096;
            font-style: italic;
            font-size: 10px;
        }
    </style>
</head>
<body>
    <div class="calendar-container">
        <div class="header">
            <div class="title">ปฏิทินงาน${period}</div>
            <div class="subtitle">${month} ${year}</div>
        </div>
        <table class="calendar">
            <thead>
                <tr>
                    <th>จันทร์</th>
                    <th>อังคาร</th>
                    <th>พุธ</th>
                    <th>พฤหัสบดี</th>
                    <th>ศุกร์</th>
                    <th>เสาร์</th>
                    <th>อาทิตย์</th>
                </tr>
            </thead>
            <tbody>
                ${calendarRows}
            </tbody>
        </table>
    </div>
</body>
</html>`;
}

function generateTextSummary(startDate, endDate, items, period) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const thaiMonths = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
                     'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
  
  const month = thaiMonths[start.getMonth()];
  const year = start.getFullYear() + 543;
  
  let summary = `📅 สรุปงาน${period} (${month} ${year})\n\n`;
  
  if (items.length === 0) {
    summary += `ไม่มีงานใน${period}`;
    return summary;
  }
  
  // จัดกลุ่มตามวันที่
  const groupedByDate = {};
  items.forEach(item => {
    if (!groupedByDate[item.date]) {
      groupedByDate[item.date] = [];
    }
    groupedByDate[item.date].push(item);
  });
  
  // แสดงรายการตามวันที่
  Object.keys(groupedByDate).sort().forEach(dateStr => {
    const date = new Date(dateStr);
    const thaiDays = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
    const dayName = thaiDays[date.getDay()];
    const day = date.getDate();
    
    summary += `\n🗓️ ${dayName} ${day} ${month}\n`;
    
    groupedByDate[dateStr].forEach((item, i) => {
      const time = item.end_time ? `${item.start_time}–${item.end_time}` : item.start_time;
      const place = item.place ? ` · ${item.place}` : '';
      summary += `${i + 1}. ${time} ${item.title}${place}\n`;
    });
  });
  
  return summary;
}

async function replyLineImage(env, replyToken, imageUrl) {
  const url = "https://api.line.me/v2/bot/message/reply";
  const headers = { "content-type": "application/json", Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` };
  const body = { 
    replyToken, 
    messages: [{ 
      type: "image", 
      originalContentUrl: imageUrl, 
      previewImageUrl: imageUrl 
    }] 
  };
  await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
}

function mapCategoryTokenToId(tok) {
  if (!tok) return null;
  const t = String(tok).trim().replace(/^#/, "").toLowerCase();
  if (["งานในหน่วย","internal"].includes(t))   return "00000000-0000-0000-0000-000000000001";
  if (["งานในกรม","department"].includes(t))  return "00000000-0000-0000-0000-000000000002";
  if (["งานใหญ่","big"].includes(t))          return "00000000-0000-0000-0000-000000000003";
  if (["งานนอก","external"].includes(t))      return "00000000-0000-0000-0000-000000000004";
  return null;
}