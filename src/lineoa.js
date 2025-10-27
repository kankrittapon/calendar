// src/lineoa.js

// ===== LINE push: text =====
export async function linePushText(env, to, text) {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) throw new Error("LINE token not set");
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ to, messages: [{ type: "text", text }] }),
  });
  if (!res.ok) throw new Error(`LINE push text failed: ${res.status} ${await res.text()}`);
}

// ===== LINE push: image by URL =====
export async function linePushImageByUrl(env, to, url) {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) throw new Error("LINE token not set");
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      to,
      messages: [{ type: "image", originalContentUrl: url, previewImageUrl: url }],
    }),
  });
  if (!res.ok) throw new Error(`LINE push image failed: ${res.status} ${await res.text()}`);
}

// ===== LINE push: Flex carousel =====
export function flexBubbleForTask(task) {
  const title = task.title || "-";
  const time  = `${task.start_time || ""}${task.end_time ? "–"+task.end_time : ""}`;
  const place = task.place || task.location || "";
  const color = task.category_color || "#4b5563";
  const notes = task.notes || task.agenda || "";

  // สร้างเนื้อหาหลัก
  const mainContents = [
    { type: "text", text: "📅 ตารางงานวันนี้", weight:"bold", size:"lg", color:"#f8fafc", align: "center" },
    { type: "separator", margin: "md", color: "#334155" },
    { type: "text", text: title, weight:"bold", size:"xl", wrap:true, color:"#e5e7eb", margin: "md" },
    { type: "box", layout:"baseline", spacing:"sm", margin: "sm", contents:[
      { type:"text", text:"⏰ เวลา:", size:"sm", color:"#94a3b8", flex: 2 },
      { type:"text", text: time || "-", size:"sm", wrap:true, color:"#e5e7eb", flex: 3, weight: "bold" }
    ]},
    { type: "box", layout:"baseline", spacing:"sm", margin: "sm", contents:[
      { type:"text", text:"📍 สถานที่:", size:"sm", color:"#94a3b8", flex: 2 },
      { type:"text", text: place || "-", size:"sm", wrap:true, color:"#e5e7eb", flex: 3 }
    ]}
  ];

  // เพิ่มหมายเหตุ/กำหนดการถ้ามี
  if (notes) {
    mainContents.push(
      { type: "separator", margin: "md", color: "#334155" },
      { type: "text", text: "📋 หมายเหตุ/กำหนดการ:", size: "sm", color: "#94a3b8", margin: "md" },
      { type: "text", text: notes, size: "sm", wrap: true, color: "#cbd5e1", margin: "sm" }
    );
  }

  return {
    type: "bubble",
    size: "giga",
    body: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: mainContents,
      paddingAll: "16px",
      backgroundColor: "#0f172a"
    },
    footer: {
      type: "box",
      layout: "horizontal",
      spacing: "md",
      contents: [
        {
          type: "button",
          style: "primary",
          color: "#16a34a",
          action: {
            type: "postback",
            label: "✅ ไป",
            data: `action=attend_yes&id=${task.id}`
          }
        },
        {
          type: "button",
          style: "secondary",
          color: "#ef4444",
          action: {
            type: "postback",
            label: "❌ ไม่ไป",
            data: `action=attend_no&id=${task.id}`
          }
        }
      ],
      backgroundColor: "#111827",
      paddingAll: "12px"
    }
  };
}

export async function linePushFlexCarousel(env, to, bubbles) {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) throw new Error("LINE token not set");
  const message = {
    to,
    messages: [{
      type: "flex",
      altText: "ตารางงานวันนี้",
      contents: { type: "carousel", contents: bubbles }
    }]
  };
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type":"application/json",
      "Authorization": `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(message),
  });
  if (!res.ok) throw new Error(`LINE push flex failed: ${res.status} ${await res.text()}`);
}

// ===== User profile (optional pretty name) =====
export async function getUserProfile(env, userId) {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) return null;
  const res = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
    headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
  });
  if (!res.ok) return null;
  return res.json().catch(() => null); // { userId, displayName, ... }
}

// ===== Verify LINE webhook signature =====
export async function verifyLineSignature(request, env) {
  if (!env.LINE_CHANNEL_SECRET) return true; // skip verify if not set
  const signature = request.headers.get("x-line-signature") || "";
  const body = await request.clone().arrayBuffer();

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.LINE_CHANNEL_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, body);
  const macB64 = ab2b64(mac); // standard base64
  return timingSafeEqualB64(macB64, signature);
}

function ab2b64(buf) {
  let s = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function timingSafeEqualB64(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ===== Daily calendar HTML (1080×1350) =====
export function renderDailyHTML(ymd, items = []) {
  const rows = items.map((it, i) => {
    const time = `${it.start_time ?? ""}${it.end_time ? "–" + it.end_time : ""}`;
    const loc  = it.location ? ` · ${escapeHTML(it.location)}` : "";
    const status = (it.status || "planned") === "done" ? "✓" : "";
    return `
      <div class="item">
        <div class="time">${time}</div>
        <div class="title">${i + 1}. ${escapeHTML(it.title || "-")}${loc}</div>
        <div class="status">${status}</div>
      </div>`;
  }).join("");

  return /* html */`
<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>
  :root { --bg:#0B0B0F; --bg2:#111122; --fg:#EAEAF2; --muted:#A1A1B2; --c1:#16162A; --c2:#121228; --ok:#6EE7B7; }
  * { box-sizing: border-box; }
  body {
    width:1080px; height:1350px; margin:0;
    background: linear-gradient(180deg, var(--bg) 0%, var(--bg2) 100%);
    color: var(--fg);
    font-family: "Noto Sans Thai","Sarabun", ui-sans-serif, system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans",Arial;
    display:flex; align-items:stretch; justify-content:center;
  }
  .wrap { width:100%; padding:60px 80px; display:flex; flex-direction:column; gap:28px; }
  .head { display:flex; align-items:baseline; justify-content:space-between; }
  .title { font-size:56px; font-weight:800; letter-spacing:.2px; }
  .date  { font-size:28px; color:var(--muted); }
  .list  { display:flex; flex-direction:column; gap:16px; }
  .item {
    display:grid; grid-template-columns: 220px 1fr 80px; gap:20px;
    background: linear-gradient(180deg, var(--c1) 0%, var(--c2) 100%);
    border:1px solid rgba(255,255,255,.06);
    padding:22px 24px; border-radius:24px;
  }
  .time { font-weight:800; font-size:34px; color:#E6E7FF; letter-spacing:.5px; }
  .title{ font-size:34px; color:#EDEDF5; line-height:1.3; }
  .status{ text-align:right; font-size:34px; color:var(--ok); font-weight:800; }
  .footer { margin-top:auto; color:var(--muted); font-size:24px; text-align:center; opacity:.85; }
</style>
</head>
<body>
  <div class="wrap">
    <div class="head">
      <div class="title">ตารางงานประจำวัน</div>
      <div class="date">${ymd}</div>
    </div>
    <div class="list">
      ${rows || `<div class="item"><div class="time">—</div><div class="title">ไม่มีงานวันนี้</div><div class="status"></div></div>`}
    </div>
    <div class="footer">Generated by Cloudflare Worker</div>
  </div>
</body>
</html>`;
}

function escapeHTML(s="") {
  return s.replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

// ===== ฟังก์ชันสำหรับการแจ้งเตือนก่อนเวลานัดหมาย =====
export async function sendUpcomingReminders(env) {
  console.log('[sendUpcomingReminders] Starting reminder check...');
  
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60 * 1000);
  const bangkok = new Date(utc + 7 * 60 * 60 * 1000);
  
  // หาเวลา 1-2 ชั่วโมงข้างหน้า
  const oneHourLater = new Date(bangkok.getTime() + 60 * 60 * 1000);
  const twoHoursLater = new Date(bangkok.getTime() + 2 * 60 * 60 * 1000);
  
  const today = bangkok.toISOString().slice(0, 10);
  const oneHourTime = oneHourLater.toTimeString().slice(0, 5);
  const twoHoursTime = twoHoursLater.toTimeString().slice(0, 5);
  
  console.log(`[sendUpcomingReminders] Checking for tasks between ${oneHourTime} and ${twoHoursTime} on ${today}`);
  
  // ค้นหางานที่จะเริ่มใน 1-2 ชั่วโมงข้างหน้า
  const upcomingTasks = await env.schedule_db
    .prepare(`
      SELECT id, title, date, start_time, end_time, place, location, notes, category_id
      FROM schedules 
      WHERE date = ? 
        AND start_time BETWEEN ? AND ?
        AND (status IS NULL OR status IN ('planned', 'in_progress'))
      ORDER BY start_time ASC
    `)
    .bind(today, oneHourTime, twoHoursTime)
    .all();
    
  const tasks = upcomingTasks?.results || [];
  console.log(`[sendUpcomingReminders] Found ${tasks.length} upcoming tasks`);
  
  if (tasks.length === 0) {
    console.log('[sendUpcomingReminders] No upcoming tasks found');
    return;
  }
  
  // หา Boss ที่มี LINE ID
  const bosses = await env.schedule_db
    .prepare("SELECT id, name, line_user_id FROM users WHERE role='boss' AND line_user_id IS NOT NULL")
    .all();
    
  if (!bosses?.results?.length) {
    console.log('[sendUpcomingReminders] No bosses with LINE ID found');
    return;
  }
  
  // ส่งแจ้งเตือนให้แต่ละ Boss
  for (const boss of bosses.results) {
    for (const task of tasks) {
      // ตรวจสอบว่าส่งแจ้งเตือนแล้วหรือยัง
      const alreadySent = await env.schedule_db
        .prepare("SELECT 1 FROM notifications_sent WHERE type='reminder' AND target=? AND schedule_id=? AND date(sent_at) = date('now','localtime') LIMIT 1")
        .bind(boss.line_user_id, task.id)
        .first();
        
      if (alreadySent) {
        console.log(`[sendUpcomingReminders] Reminder already sent for task ${task.id} to ${boss.line_user_id}`);
        continue;
      }
      
      // สร้าง Flex Message สำหรับการแจ้งเตือน
      const reminderBubble = buildReminderFlex(task);
      
      try {
        await pushLineFlex(env, boss.line_user_id, reminderBubble);
        console.log(`[sendUpcomingReminders] Sent reminder for task ${task.id} to ${boss.line_user_id}`);
        
        // บันทึกว่าส่งแจ้งเตือนแล้ว
        const nid = crypto.randomUUID();
        await env.schedule_db
          .prepare("INSERT INTO notifications_sent (id, schedule_id, type, target, sent_at) VALUES (?1, ?2, ?3, ?4, datetime('now'))")
          .bind(nid, task.id, "reminder", boss.line_user_id)
          .run();
          
      } catch (error) {
        console.error(`[sendUpcomingReminders] Failed to send reminder for task ${task.id}:`, error);
      }
    }
  }
  
  console.log('[sendUpcomingReminders] Reminder check completed');
}

function buildReminderFlex(task) {
  const time = task.end_time ? `${task.start_time}–${task.end_time}` : task.start_time;
  const place = task.place || task.location || "-";
  const notes = task.notes || task.agenda || "";
  
  const mainContents = [
    { type: "text", text: "⏰ แจ้งเตือนงานใกล้เวลา", weight: "bold", size: "lg", color: "#f59e0b", align: "center" },
    { type: "separator", margin: "md", color: "#f59e0b" },
    { type: "text", text: task.title || "-", weight: "bold", size: "xl", wrap: true, color: "#e5e7eb", margin: "md", align: "center" },
    { type: "box", layout: "baseline", spacing: "sm", margin: "md", contents: [
      { type: "text", text: "⏰ เวลา:", size: "sm", color: "#94a3b8", flex: 2 },
      { type: "text", text: time, size: "sm", wrap: true, color: "#e5e7eb", flex: 3, weight: "bold" }
    ]},
    { type: "box", layout: "baseline", spacing: "sm", margin: "sm", contents: [
      { type: "text", text: "📍 สถานที่:", size: "sm", color: "#94a3b8", flex: 2 },
      { type: "text", text: place, size: "sm", wrap: true, color: "#e5e7eb", flex: 3 }
    ]}
  ];
  
  // เพิ่มหมายเหตุ/กำหนดการถ้ามี
  if (notes) {
    mainContents.push(
      { type: "separator", margin: "md", color: "#334155" },
      { type: "text", text: "📝 กำหนดการ/หมายเหตุ:", size: "sm", color: "#94a3b8", margin: "md" },
      { type: "text", text: notes, size: "sm", wrap: true, color: "#cbd5e1", margin: "sm" }
    );
  }
  
  return {
    type: "bubble",
    size: "giga",
    body: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: mainContents,
      paddingAll: "16px",
      backgroundColor: "#0f172a"
    },
    footer: {
      type: "box",
      layout: "horizontal",
      spacing: "md",
      contents: [
        {
          type: "button",
          style: "primary",
          color: "#16a34a",
          action: {
            type: "postback",
            label: "✅ รับทราบ",
            data: `action=attend_yes&id=${task.id}`
          }
        },
        {
          type: "button",
          style: "secondary",
          color: "#ef4444",
          action: {
            type: "postback",
            label: "❌ ไม่สามารถไป",
            data: `action=attend_no&id=${task.id}`
          }
        }
      ],
      backgroundColor: "#111827",
      paddingAll: "12px"
    }
  };
}

// ===== Browser Rendering → PNG (base64) =====
export async function renderToPNGBase64(env, htmlString) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/browser-rendering/screenshot`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.CF_BR_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      html: htmlString,
      viewport: { width: 1080, height: 1350 },
      screenshotOptions: {}
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`CF rendering failed: ${res.status} ${body}`);
  }

  const ctype = res.headers.get("content-type") || "";
  if (ctype.startsWith("image/")) {
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = ""; for (let i=0;i<bytes.length;i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  } else {
    const js = await res.json().catch(() => null);
    const b64 = js?.result?.screenshot || js?.result?.image;
    if (!b64) throw new Error("render: missing screenshot base64");
    return b64;
  }
}
