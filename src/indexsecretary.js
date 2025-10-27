// src/indexsecretary.js
export function renderSecretaryPage() {
  return `<!doctype html>
<html lang="th"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>เลขา - จัดการงาน</title>
<style>
:root{--bg:#0f172a;--card:#1e293b;--border:#334155;--text:#f1f5f9;--muted:#94a3b8;--primary:#3b82f6;--success:#10b981;--warning:#f59e0b;--danger:#ef4444}
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:var(--bg);color:var(--text);min-height:100vh}
.container{max-width:1200px;margin:0 auto;padding:24px}
h1{font-size:28px;font-weight:700;margin:0 0 24px;color:var(--text)}
input,select,button,textarea{font:inherit;padding:12px;margin:4px 0;background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:8px}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--primary);box-shadow:0 0 0 3px rgba(59,130,246,0.1)}
label{display:block;margin-top:12px;font-weight:500;color:var(--text)}
.card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:24px;margin-bottom:24px;box-shadow:0 4px 6px -1px rgba(0,0,0,0.1)}
.card h2{margin:0 0 16px;font-size:20px;font-weight:600;color:var(--text)}
.row{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px}
table{border-collapse:collapse;width:100%;background:var(--card);border-radius:8px;overflow:hidden}
th{background:var(--border);padding:12px;text-align:left;font-weight:600;color:var(--text)}
td{padding:12px;border-bottom:1px solid var(--border)}
.btn{background:var(--success);color:#fff;border:none;border-radius:8px;padding:12px 20px;cursor:pointer;font-weight:500;transition:all 0.2s}
.btn:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(16,185,129,0.3)}
.btn:disabled{opacity:.5;cursor:not-allowed}
.btn-edit{background:var(--warning)}
.btn-delete{background:var(--danger)}
.btn-complete{background:var(--success)}
.badge{display:inline-block;padding:4px 12px;border-radius:999px;background:var(--border);font-size:12px;font-weight:500}
.success-msg{color:var(--success);font-weight:500}
.error-msg{color:var(--danger);font-weight:500}
</style></head>
<body>
<div class="container">
<h1>📅 ระบบจัดการตารางงาน</h1>
<div class="card">
  <h2>ตั้งค่า</h2>
  <p style="color:var(--success)">✅ ไม่ต้องใช้ API Key แล้ว</p>
</div>

<div class="card">
  <h2>เพิ่มงาน</h2>
  <div class="row">
    <div><label>ชื่อเรื่อง <input id="title" /></label></div>
    <div><label>วันที่ (1-31) <input id="date" type="number" min="1" max="31" placeholder="22" /></label></div>
    <div><label>เวลาเริ่ม
      <select id="start">
        <option value="">เลือกเวลา</option>
        <option value="08:30">08:30</option><option value="09:00">09:00</option><option value="09:30">09:30</option>
        <option value="10:00">10:00</option><option value="10:30">10:30</option><option value="11:00">11:00</option>
        <option value="11:30">11:30</option><option value="12:00">12:00</option><option value="12:30">12:30</option>
        <option value="13:00">13:00</option><option value="13:30">13:30</option><option value="14:00">14:00</option>
        <option value="14:30">14:30</option><option value="15:00">15:00</option><option value="15:30">15:30</option>
        <option value="16:00">16:00</option><option value="16:30">16:30</option><option value="17:00">17:00</option>
      </select>
    </label></div>
    <div><label>เวลาจบ (ไม่จำเป็น)
      <select id="end">
        <option value="">ไม่ระบุ</option>
        <option value="09:00">09:00</option><option value="09:30">09:30</option><option value="10:00">10:00</option>
        <option value="10:30">10:30</option><option value="11:00">11:00</option><option value="11:30">11:30</option>
        <option value="12:00">12:00</option><option value="12:30">12:30</option><option value="13:00">13:00</option>
        <option value="13:30">13:30</option><option value="14:00">14:00</option><option value="14:30">14:30</option>
        <option value="15:00">15:00</option><option value="15:30">15:30</option><option value="16:00">16:00</option>
        <option value="16:30">16:30</option><option value="17:00">17:00</option><option value="17:30">17:30</option>
      </select>
    </label></div>
  </div>
  <div class="row">
    <div><label>สถานที่/สถานที่ย่อย <input id="place" /></label></div>
    <div><label>หมวดหมู่ (category_id)
      <select id="category">
        <option value="">- ไม่ระบุ -</option>
        <option value="00000000-0000-0000-0000-000000000001">งานในหน่วย</option>
        <option value="00000000-0000-0000-0000-000000000002">งานในกรม</option>
        <option value="00000000-0000-0000-0000-000000000003">งานใหญ่</option>
        <option value="00000000-0000-0000-0000-000000000004">งานนอก</option>
      </select>
    </label></div>
  </div>
  <label>โน้ต <textarea id="notes" rows="3"></textarea></label>
  <button class="btn" onclick="createSchedule()">บันทึกงาน</button>
  <div id="createMsg"></div>
</div>

<div class="card">
  <h2>รายการงาน</h2>
  <div class="row">
    <div><label>ดูของวันที่ <input id="qdate" type="date" /></label></div>
    <div><button class="btn" onclick="loadList()">โหลด</button></div>
  </div>
  <table>
    <thead><tr><th>วันที่</th><th>เวลา</th><th>เรื่อง</th><th>สถานที่</th><th>หมายเหตุ</th><th>หมวดหมู่</th><th>สถานะ</th><th>การตอบ</th><th>จัดการ</th></tr></thead>
    <tbody id="list"></tbody>
  </table>
</div>

<script>
const base = location.origin;
const $ = (id) => document.getElementById(id);



async function createSchedule(){
  const day = $('date').value;
  if(!day) return alert('กรุณาใส่วันที่');

  const now = new Date();
  const currentDate = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-' + String(day).padStart(2,'0');

  const body = {
    title: $('title').value, date: currentDate, start_time: $('start').value,
    end_time: $('end').value || null, place: $('place').value || null,
    category_id: $('category').value || null, notes: $('notes').value || null
  };
  const res = await fetch(base + '/schedules', {
    method:'POST', headers: {'content-type':'application/json'},
    body: JSON.stringify(body)
  });
  const j = await res.json().catch(()=>({}));
  $('createMsg').innerText = res.ok ? '✅ สร้างแล้ว id=' + (j?.data?.id||'') : '❌ ' + (j?.error||res.status);
  if(res.ok){ $('title').value=''; $('date').value=''; $('start').selectedIndex=0; $('end').selectedIndex=0; $('place').value=''; $('notes').value=''; loadList(); }
}

async function loadList(){
  const q = $('qdate').value ? ('?date='+encodeURIComponent($('qdate').value)) : '';
  const res = await fetch(base + '/schedules'+q);
  const j = await res.json().catch(()=>({}));
  const rows = (j?.data||[]).map((s,i)=>{
    const time = s.end_time ? (s.start_time+'–'+s.end_time) : s.start_time;
    const att = s.attend_status || '-';
    const notes = s.notes || '-';
    return '<tr>'+
      '<td>'+ (s.date||'') +'</td>'+
      '<td>'+ (time||'') +'</td>'+
      '<td>'+ (s.title||'') +'</td>'+
      '<td>'+ (s.place||'') +'</td>'+
      '<td style="max-width:200px;word-wrap:break-word">'+ notes +'</td>'+
      '<td>'+
        '<select onchange="updateCategory(\\''+s.id+'\\',this.value)" style="padding:4px;border-radius:4px;border:1px solid var(--border);background:var(--card);color:var(--text)">'+
          '<option value="00000000-0000-0000-0000-000000000001" '+(s.category_id==='00000000-0000-0000-0000-000000000001'?'selected':'')+'>งานในหน่วย</option>'+
          '<option value="00000000-0000-0000-0000-000000000002" '+(s.category_id==='00000000-0000-0000-0000-000000000002'?'selected':'')+'>งานในกรม</option>'+
          '<option value="00000000-0000-0000-0000-000000000003" '+(s.category_id==='00000000-0000-0000-0000-000000000003'?'selected':'')+'>งานใหญ่</option>'+
          '<option value="00000000-0000-0000-0000-000000000004" '+(s.category_id==='00000000-0000-0000-0000-000000000004'?'selected':'')+'>งานนอก</option>'+
        '</select>'+
      '</td>'+
      '<td>'+
        '<select onchange="updateStatus(\\''+s.id+'\\',this.value)" style="padding:4px;border-radius:4px;border:1px solid var(--border);background:var(--card);color:var(--text)">'+
          '<option value="planned" '+(s.status==='planned'?'selected':'')+'>Planned</option>'+
          '<option value="in_progress" '+(s.status==='in_progress'?'selected':'')+'>In Progress</option>'+
          '<option value="completed" '+(s.status==='completed'?'selected':'')+'>Completed</option>'+
          '<option value="cancelled" '+(s.status==='cancelled'?'selected':'')+'>Cancelled</option>'+
        '</select>'+
      '</td>'+
      '<td>'+
        '<select onchange="updateAttend(\\''+s.id+'\\',this.value)" style="padding:4px;border-radius:4px;border:1px solid var(--border);background:var(--card);color:var(--text)">'+
          '<option value="" '+(att==='-'?'selected':'')+'>ยังไม่ตอบ</option>'+
          '<option value="yes" '+(s.attend_status==='yes'?'selected':'')+'>ไป</option>'+
          '<option value="no" '+(s.attend_status==='no'?'selected':'')+'>ไม่ไป</option>'+
        '</select>'+
      '</td>'+
      '<td>'+
        '<button onclick="editTask(\\''+s.id+'\\')" class="btn-edit" style="margin-right:4px;background:#f59e0b;color:#fff;border:none;padding:4px 8px;border-radius:4px;cursor:pointer">แก้ไข</button>'+
        '<button onclick="deleteTask(\\''+s.id+'\\')" class="btn-delete" style="background:#ef4444;color:#fff;border:none;padding:4px 8px;border-radius:4px;cursor:pointer">ลบ</button>'+
      '</td>'+
    '</tr>';
  }).join('');
  $('list').innerHTML = rows;
}

async function markDone(id){
  const apiKey = getKey();
  const res = await fetch(base + '/schedules/'+id, {
    method:'PATCH',
    headers: {'content-type':'application/json','authorization':'Bearer '+apiKey},
    body: JSON.stringify({ status: 'completed' })
  });
  if(res.ok) loadList(); else alert('แก้ไขไม่สำเร็จ');
}

async function deleteTask(id){
  if(!confirm('ต้องการลบงานนี้หรือไม่?')) return;
  const res = await fetch(base + '/schedules/'+id, {
    method:'DELETE'
  });
  if(res.ok) loadList(); else alert('ลบไม่สำเร็จ');
}

function editTask(id){
  const rows = document.querySelectorAll('#list tr');
  let taskData = null;
  rows.forEach(row => {
    const deleteBtn = row.querySelector('button[onclick*="deleteTask"]');
    if(deleteBtn && deleteBtn.onclick.toString().includes(id)){
      const cells = row.querySelectorAll('td');
      const timeText = cells[0].textContent.trim();
      const times = timeText.includes('–') ? timeText.split('–') : [timeText, ''];
      taskData = {
        title: cells[1].textContent.trim(),
        start_time: times[0],
        end_time: times[1],
        place: cells[2].textContent.trim()
      };
    }
  });

  if(!taskData) return alert('ไม่พบข้อมูลงาน');

  $('title').value = taskData.title;
  $('start').value = taskData.start_time;
  $('end').value = taskData.end_time;
  $('place').value = taskData.place;

  const btn = document.querySelector('button[onclick="createSchedule()"]');
  btn.textContent = 'อัพเดทงาน';
  btn.onclick = () => updateTask(id);
}

async function updateTask(id){
  const body = {
    title: $('title').value, start_time: $('start').value,
    end_time: $('end').value || null, place: $('place').value || null
  };
  const res = await fetch(base + '/schedules/'+id, {
    method:'PATCH', headers: {'content-type':'application/json'},
    body: JSON.stringify(body)
  });
  if(res.ok){
    $('title').value=''; $('date').value=''; $('start').selectedIndex=0; $('end').selectedIndex=0; $('place').value='';
    const btn = document.querySelector('button[onclick*="updateTask"]');
    btn.textContent = 'บันทึกงาน';
    btn.onclick = createSchedule;
    loadList();
  } else {
    alert('อัพเดทไม่สำเร็จ');
  }
}

async function updateStatus(id, status){
  await fetch(base + '/schedules/'+id, {
    method:'PATCH', headers: {'content-type':'application/json'},
    body: JSON.stringify({ status })
  });
}

async function updateAttend(id, attend_status){
  await fetch(base + '/schedules/'+id, {
    method:'PATCH', headers: {'content-type':'application/json'},
    body: JSON.stringify({ attend_status: attend_status || null })
  });
}

async function updateCategory(id, category_id){
  await fetch(base + '/schedules/'+id, {
    method:'PATCH', headers: {'content-type':'application/json'},
    body: JSON.stringify({ category_id })
  });
}

loadList();
</script>
</div>
</body></html>`;
}
