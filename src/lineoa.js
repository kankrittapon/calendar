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

  return {
    type: "bubble",
    size: "mega",
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: [
        { type: "text", text: "ตารางงานวันนี้", weight:"bold", size:"sm", color:"#a1a1aa" },
        { type: "text", text: title, weight:"bold", size:"xl", wrap:true },
        { type: "box", layout:"baseline", spacing:"sm", contents:[
          { type:"text", text:"เวลา", size:"sm", color:"#a1a1aa" },
          { type:"text", text: time || "-", size:"sm", wrap:true, color:"#e5e7eb" }
        ]},
        { type: "box", layout:"baseline", spacing:"sm", contents:[
          { type:"text", text:"สถานที่", size:"sm", color:"#a1a1aa" },
          { type:"text", text: place || "-", size:"sm", wrap:true, color:"#e5e7eb" }
        ]},
      ],
      borderColor: color,
      borderWidth: "2px",
      cornerRadius: "xl",
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
            label: "ไป",
            data: `action=attend_yes&id=${task.id}`
          }
        },
        {
          type: "button",
          style: "secondary",
          color: "#ef4444",
          action: {
            type: "postback",
            label: "ไม่ไป",
            data: `action=attend_no&id=${task.id}`
          }
        }
      ],
      backgroundColor: "#111827"
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
