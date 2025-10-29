// src/test.js - Test page UI
export function renderTestUI() {
  return `<!doctype html>
<html lang="th"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>ทดสอบระบบ Schedule Worker</title>
<style>
body{font-family:system-ui;margin:24px;background:#0b0e17;color:#e5e7eb}
.card{background:#141927;border-radius:12px;padding:16px;margin-bottom:16px}
input,textarea,button,select{font:inherit;padding:8px;margin:4px 0;background:#1f2937;color:#e5e7eb;border:1px solid #374151;border-radius:6px;width:100%;box-sizing:border-box}
button{background:#16a34a;color:#fff;cursor:pointer;border:none;width:auto}
button.danger{background:#ef4444}
button:hover{opacity:0.9}
.result{background:#0f1422;padding:12px;border-radius:8px;margin-top:8px;white-space:pre-wrap;font-family:monospace;font-size:12px}
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
      <option value="flex">Flex Message</option>
    </select>
  </label>
  <label>ข้อความ:<br>
    <textarea id="message" rows="3">สวัสดีครับ นี่คือการทดสอบส่งข้อความจาก Schedule Worker</textarea>
  </label>
  <button onclick="testSendToBoss()">ส่งข้อความทดสอบ</button>
  <div id="sendResult" class="result"></div>
</div>

<div class="card">
  <h2>ทดสอบ Cron Job</h2>
  <label>รูปแบบ:
    <select id="cronFormat">
      <option value="text">Text</option>
      <option value="flex">Flex Message</option>
    </select>
  </label>
  <div style="margin:8px 0">
    <button onclick="testCronNoAuth()">ทดสอบ Cron (ไม่ต้อง Auth)</button>
    <button onclick="testCron()" style="margin-left:8px">ทดสอบ Cron (ต้อง Auth)</button>
  </div>
  <div id="cronResult" class="result"></div>
</div>

<div class="card">
  <h2>จัดการผู้ใช้</h2>
  <h3>ดูรายชื่อผู้ใช้ทั้งหมด</h3>
  <button onclick="loadAllUsers()">โหลดรายชื่อผู้ใช้</button>
  <div id="usersList" class="result"></div>
  
  <div id="roleManagement" style="display:none;margin-top:16px">
    <h3>เปลี่ยน Role</h3>
    <label>เลือกผู้ใช้:
      <select id="userSelect">
        <option value="">-- เลือกผู้ใช้ --</option>
      </select>
    </label>
    <label>เลือก Role:
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
  <h2>จัดการ LINE Targets</h2>
  
  <div style="margin:12px 0">
    <button onclick="loadLineTargets()">โหลดรายชื่อ LINE Targets</button>
    <div id="lineTargetsList" class="result"></div>
  </div>

  <div id="lineTargetManagement" style="margin-top:16px">
    <h3>เพิ่มผู้ใช้จาก LINE Target</h3>
    <label>เลือก LINE Target:
      <select id="targetSelect">
        <option value="">-- เลือก LINE Target --</option>
      </select>
    </label>
    <label>ชื่อผู้ใช้:
      <input id="targetUserName" placeholder="ชื่อผู้ใช้"/>
    </label>
    <label>Role:
      <select id="targetRoleSelect">
        <option value="boss">Boss (หัวหน้า)</option>
        <option value="secretary">Secretary (เลขา)</option>
      </select>
    </label>
    <div style="margin-top:12px">
      <button onclick="addUserFromTarget()">เพิ่มผู้ใช้</button>
      <button onclick="deleteTarget()" class="danger" style="margin-left:8px">ลบ LINE Target</button>
    </div>
    <div id="targetResult" class="result"></div>
  </div>
</div>

<div class="card">
  <h2>ส่งข้อความให้เลขา</h2>
  <label>ข้อความ:<br>
    <textarea id="secretaryMessage" rows="3" placeholder="ข้อความที่ต้องการส่ง">ทดสอบข้อความจากหัวหน้า</textarea>
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

  try {
    const res = await fetch('/test/send-to-boss', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({ lineUserId, message, format })
    });

    const result = await res.json().catch(() => ({ error: 'Invalid JSON response' }));
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

    const result = await res.json().catch(() => ({ error: 'Invalid JSON response' }));
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

    const result = await res.json().catch(() => ({ error: 'Invalid JSON response' }));
    document.getElementById('cronResult').textContent = JSON.stringify(result, null, 2);
  } catch (error) {
    document.getElementById('cronResult').textContent = 'Error: ' + error.message;
  }
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
      }).join('\\n');

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

let allTargets = [];

async function loadLineTargets() {
  const token = getToken();
  if(!token) return;

  try {
    const res = await fetch('/admin/line-targets', {
      headers: {'authorization': 'Bearer ' + token}
    });

    const result = await res.json().catch(() => ({ error: 'Invalid JSON response' }));

    if(res.ok && result.data) {
      allTargets = result.data;

      const targetsList = result.data.map(target => {
        const date = new Date(target.created_at);
        const dateStr = date.toLocaleString('th-TH');
        return target.display_name + ' (LINE: ' + target.line_user_id + ') - เพิ่มเมื่อ ' + dateStr;
      }).join('\\n');

      document.getElementById('lineTargetsList').textContent = targetsList || 'ไม่พบ LINE targets';

      const targetSelect = document.getElementById('targetSelect');
      targetSelect.innerHTML = '<option value="">-- เลือก LINE Target --</option>';
      result.data.forEach(target => {
        const option = document.createElement('option');
        option.value = target.line_user_id;
        option.textContent = target.display_name;
        targetSelect.appendChild(option);
      });
    } else {
      document.getElementById('lineTargetsList').textContent = JSON.stringify(result, null, 2);
    }
  } catch (error) {
    document.getElementById('lineTargetsList').textContent = 'Error: ' + error.message;
  }
}

async function addUserFromTarget() {
  const token = getToken();
  if(!token) return;
  const lineUserId = document.getElementById('targetSelect').value;
  const name = document.getElementById('targetUserName').value;
  const role = document.getElementById('targetRoleSelect').value;

  if(!lineUserId || !name) return alert('กรุณาเลือก LINE Target และใส่ชื่อผู้ใช้');

  const res = await fetch('/admin/user/add-from-target', {
    method: 'POST',
    headers: {
      'authorization': 'Bearer ' + token,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ lineUserId, name, role })
  });

  const result = await res.json().catch(() => ({}));
  document.getElementById('targetResult').textContent = JSON.stringify(result, null, 2);

  if(res.ok) {
    // Reset form
    document.getElementById('targetSelect').selectedIndex = 0;
    document.getElementById('targetUserName').value = '';
    document.getElementById('targetRoleSelect').selectedIndex = 0;
    // Reload users and targets
    await loadAllUsers();
    await loadLineTargets();
  }
}

async function deleteTarget() {
  const token = getToken();
  if(!token) return;
  const lineUserId = document.getElementById('targetSelect').value;

  if(!lineUserId) return alert('กรุณาเลือก LINE Target');

  const selectedTarget = allTargets.find(t => t.line_user_id === lineUserId);
  if(!confirm('ต้องการลบ LINE Target "' + (selectedTarget?.display_name || 'Unknown') + '" หรือไม่?')) return;

  const res = await fetch('/admin/line-target/delete', {
    method: 'DELETE',
    headers: {
      'authorization': 'Bearer ' + token,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ lineUserId })
  });

  const result = await res.json().catch(() => ({}));
  document.getElementById('targetResult').textContent = JSON.stringify(result, null, 2);

  if(res.ok) {
    // Reset form
    document.getElementById('targetSelect').selectedIndex = 0;
    // Reload targets
    await loadLineTargets();
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

    const result = await res.json().catch(() => ({ error: 'Invalid JSON response' }));
    document.getElementById('secretaryMsgResult').textContent = JSON.stringify(result, null, 2);
  } catch (error) {
    document.getElementById('secretaryMsgResult').textContent = 'Error: ' + error.message;
  }
}
</script>
</body></html>`
}