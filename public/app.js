// Rhyturn 관제 앱 (태블릿 PWA). 화면: W-02 현황, W-03 객실 상세(+W-05 조명), W-04 알람 대응, W-08 시스템, W-07 로그, W-10 설정
const { LEVELS } = window.RhyEngine;
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const LS = { get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
const ACTIVE = ['NEW', 'ACKNOWLEDGED', 'DISPATCHED'];
const STATE_KO = { NEW: '신규', ACKNOWLEDGED: '확인됨', DISPATCHED: '출동 중', RESOLVED: '해소', HANDED_OVER: '인계됨', FALSE_ALARM: '오알람', ESCALATED: '에스컬레이션' };
const CH = [{ n: 'D0 Green', c: '#4ade80' }, { n: 'D1 Yellow', c: '#facc15' }, { n: 'D2 Blue', c: '#60a5fa' }, { n: 'D3 Red', c: '#f87171' }];
let meta, facility, rhythms = [], snap = { rooms: [], alerts: [], faults: [], settings: { absenceMinutes: 30, shadowMode: false, soundOn: true } };
let rooms = new Map(), route = '/', view = {}, zoneFilter = LS.get('zone', 'all'), alertFilter = 'active', zoneOf = {};

const toast = (m) => { const t = $('#toast'); t.textContent = m; t.style.display = 'block'; clearTimeout(toast.t); toast.t = setTimeout(() => (t.style.display = 'none'), 2500); };
async function api(path, body) {
  if (window.DEMO) return window.DEMO.api(path, body);
  const r = await fetch(path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
  if (r.status === 401) { location.href = '/login.html'; throw 0; }
  if (!r.ok) { const e = await r.json().catch(() => ({})); toast(e.error || '요청 실패'); throw 0; }
  return r.json();
}
const mmss = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return s >= 3600 ? `${Math.floor(s / 3600)}시간 ${Math.floor((s % 3600) / 60)}분` : `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

// ---------- 상태 계산: 타일 색 = 미해소 알람 중 최고 등급, SYS는 별개 축 ----------
const activeAlerts = (id) => snap.alerts.filter((a) => (id ? a.room === id : true) && ACTIVE.includes(a.state));
function levelOf(r) {
  const as = activeAlerts(r.id); if (as.length) return as.reduce((m, a) => (LEVELS[a.level].rank > LEVELS[m].rank ? a.level : m), 'L2');
  return r.online && r.present ? 'L1' : 'L0';
}
const lvBadge = (k) => `<span class="lv-${k}" style="color:var(--lv)">${LEVELS[k].glyph} ${LEVELS[k].name}</span>`;
const rhName = (r) => (r.rhythm >= 0 ? rhythms[r.rhythm].name : r.rhythm === -1 ? '소등' : '수동');

// ---------- 라우터 ----------
function go(p) { location.hash = '#' + p; }
function onRoute() {
  leave(); route = location.hash.slice(1) || '/'; view = {}; const v = $('#view'); v.scrollTop = 0;
  const [, a, b] = route.split('/');
  document.querySelectorAll('.nav').forEach((n) => n.classList.toggle('act', n.dataset.go === (a ? '/' + a : '/') || (a === 'room' && n.dataset.go === '/')));
  if (!a) buildBoard(); else if (a === 'room') buildRoom(b); else if (a === 'alerts') buildAlerts(); else if (a === 'system') buildSystem(); else if (a === 'log') buildLog(); else if (a === 'settings') buildSettings(); else go('/');
  view.ready = true; refresh();
}
function leave() { const im = $('#vimg'); if (im) im.src = ''; clearInterval(view.timer); }
window.addEventListener('hashchange', onRoute);
$('#rail').onclick = (e) => { const b = e.target.closest('.nav'); if (b) go(b.dataset.go); };

// ---------- W-02 전체 현황판 ----------
function summary() {
  const c = { L4: 0, L3: 0, L2: 0, L1: 0, L0: 0, SYS: 0 };
  snap.rooms.forEach((r) => { c[levelOf(r)]++; if (!r.online) c.SYS++; });
  return Object.keys(c).map((k) => `<span class="chip lv-${k}"><span class="g">${LEVELS[k].glyph}</span>${LEVELS[k].name} <b>${c[k]}</b></span>`).join('');
}
function tileHTML(r) {
  const lv = levelOf(r), L = LEVELS[lv], dev = r.mode === 'device';
  return `<button class="tile lv-${lv} ${r.online ? '' : 'off'}" data-room="${r.id}" style="--bar:${L.bar}px">
    ${r.online ? '' : '<span class="sysb">▣ 점검</span>'}
    <div class="cam">${dev ? `<img data-th="${r.id}" alt="">` : ''}<span>${esc(r.name)}</span><small>${dev ? '실제 카메라' : '시뮬레이션'}</small></div>
    <div class="body"><div class="st"><span class="nm">${esc(r.name)}</span><span class="lvl">${L.glyph} ${L.name}${activeAlerts(r.id).length > 1 ? ' +' + (activeAlerts(r.id).length - 1) : ''}</span></div>
    <div class="kv"><span>조도 <b data-k="lux">-</b></span><span><b data-k="pres">-</b></span><span>조명 <b data-k="rh">-</b></span></div></div></button>`;
}
function buildBoard() {
  $('#view').innerHTML = `<div class="chips" id="sum"></div><div style="margin:12px 0" class="seg" id="zseg"></div><div id="zones"></div>`;
  $('#zseg').innerHTML = `<button class="btn sm ${zoneFilter === 'all' ? 'on' : ''}" data-z="all">전체</button>` + facility.zones.map((z) => `<button class="btn sm ${zoneFilter === z.id ? 'on' : ''}" data-z="${z.id}">${esc(z.name)}${z.poc ? ' · PoC' : ''}${z.assumed ? ' · 가정' : ''}</button>`).join('');
  $('#zseg').onclick = (e) => { const b = e.target.closest('button'); if (b) { zoneFilter = b.dataset.z; LS.set('zone', zoneFilter); buildBoard(); refresh(); } };
  $('#zones').onclick = (e) => { const t = e.target.closest('.tile'); if (t) go('/room/' + t.dataset.room); };
  view.sig = '';
}
function refreshBoard() {
  $('#sum').innerHTML = summary();
  const sig = snap.rooms.map((r) => r.id + levelOf(r) + r.online + r.mode + activeAlerts(r.id).length).join();
  if (sig !== view.sig) {
    view.sig = sig;
    $('#zones').innerHTML = facility.zones.filter((z) => zoneFilter === 'all' || z.id === zoneFilter).map((z) => `
      <h2 class="sec">${esc(z.name)} (${z.floor}·${z.id}구역)${z.poc ? '<span class="tag">PoC 1구역</span>' : ''}${z.assumed ? '<span class="tag">3층 복제 가정</span>' : ''}<span class="tag">${z.rooms[0]}–${z.rooms[z.rooms.length - 1]}호</span></h2>
      <div class="grid">${z.rooms.map((id) => tileHTML(rooms.get(id))).join('')}</div>`).join('');
  }
  snap.rooms.forEach((r) => { const t = $(`.tile[data-room="${r.id}"]`); if (!t) return;
    t.querySelector('[data-k=lux]').textContent = r.online ? r.lux + ' lx' : '-';
    t.querySelector('[data-k=pres]').textContent = !r.online ? '-' : r.present ? '재실' : '부재 ' + mmss(Date.now() - r.absentSince);
    t.querySelector('[data-k=rh]').textContent = r.online ? rhName(r) : '-'; });
}
setInterval(() => document.querySelectorAll('img[data-th]').forEach((im) => { const u = `/api/rooms/${im.dataset.th}/thumb?t=${Date.now()}`; const t = new Image(); t.onload = () => (im.src = u); t.src = u; }), 2000);

// ---------- 알람 카드 (W-04) ----------
function alertCard(a, showRoom = true) {
  const L = LEVELS[a.level], act = ACTIVE.includes(a.state), r = rooms.get(a.room);
  const steps = [['NEW', '신규'], ['ACKNOWLEDGED', '확인'], ['DISPATCHED', '출동'], ['RESOLVED', '해소']];
  const idx = a.state === 'FALSE_ALARM' ? -1 : ['NEW', 'ACKNOWLEDGED', 'DISPATCHED', 'RESOLVED', 'HANDED_OVER'].indexOf(a.state);
  const btn = (act_, label, cls = '') => `<button class="btn sm ${cls}" data-act="${act_}" data-id="${a.id}">${label}</button>`;
  return `<div class="alert-card lv-${a.level}" style="--bar:${L.bar}px"><div>
    <div class="t"><span class="g">${L.glyph} ${L.name}</span> · ${esc(a.title)} ${a.escalated ? '<span class="esc">· 3분 미확인 에스컬레이션</span>' : ''}</div>
    <div class="m">${showRoom ? `<a href="#/room/${a.room}" style="color:inherit;font-weight:700">${esc(r?.name || a.room)}</a> · ` : ''}${a.code} · ${a.id} · ${STATE_KO[a.state]} · ${act ? `<span data-since="${a.created}">${mmss(Date.now() - a.created)}</span> 경과` : new Date(a.last?.t || a.created).toLocaleTimeString('ko-KR')}</div></div>
    <div class="acts">${act ? (a.state === 'NEW' ? btn('ack', '확인', 'primary') : '') + (a.state !== 'DISPATCHED' ? btn('dispatch', '출동', a.state === 'ACKNOWLEDGED' ? 'primary' : '') : '') + btn('resolve', '해소', a.state === 'DISPATCHED' ? 'primary' : '') + btn('false-alarm', '오알람', 'warn') : ''}</div>
    <div class="flow">${a.state === 'FALSE_ALARM' ? '<span class="on">오알람 (튜닝 데이터셋)</span>' : steps.map(([k, n], i) => `<span class="${i <= idx ? 'on' : ''}">${n}</span>`).join('') + (a.state === 'HANDED_OVER' ? '<span class="on">인계됨</span>' : '')}</div></div>`;
}
async function onAlertAct(e) {
  const b = e.target.closest('[data-act]'); if (!b) return;
  try { await api(`/api/alerts/${b.dataset.id}/${b.dataset.act}`, {}); } catch {}
}
function buildAlerts() {
  $('#view').innerHTML = `<div class="seg" style="margin-bottom:12px"><button class="btn sm on" data-f="active">진행 중</button><button class="btn sm" data-f="all">전체(최근)</button><span class="sp" style="flex:1"></span><button class="btn sm" id="hand">근무 인계</button></div><div id="alist"></div>`;
  $('#view').querySelector('.seg').onclick = async (e) => { const b = e.target.closest('button'); if (!b) return;
    if (b.id === 'hand') { const r = await api('/api/handover', {}); return toast(`해소 알람 ${r.count}건을 인계했습니다`); }
    alertFilter = b.dataset.f; document.querySelectorAll('.seg [data-f]').forEach((x) => x.classList.toggle('on', x === b)); view.sig = ''; refresh(); };
  $('#alist').onclick = onAlertAct; view.sig = '';
}
function refreshAlerts() {
  const list = snap.alerts.filter((a) => alertFilter === 'all' || ACTIVE.includes(a.state)).sort((a, b) => (ACTIVE.includes(b.state) - ACTIVE.includes(a.state)) || LEVELS[b.level].rank - LEVELS[a.level].rank || b.created - a.created);
  const sig = list.map((a) => a.id + a.state + a.escalated).join();
  if (sig !== view.sig) { view.sig = sig; $('#alist').innerHTML = list.map((a) => alertCard(a)).join('') || '<div class="empty">진행 중인 알람이 없습니다.</div>'; }
}

// ---------- W-03 객실 상세 + W-05 조명 ----------
function buildRoom(id) {
  const r = rooms.get(id); if (!r) return go('/'); const z = zoneOf[r.zone], dev = r.mode === 'device';
  $('#view').innerHTML = `<button class="btn sm back" onclick="history.length>1?history.back():go('/')">← 현황</button>
  <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px"><h2 style="margin:0;font-size:24px">${esc(r.name)}</h2><span id="rlv" style="font-weight:800"></span><span class="tag">${esc(z.name)}</span><span class="tag">${esc(r.unitId)}</span><span class="tag">${dev ? '실제 장치' : '시뮬레이션'}</span><span class="sp" style="flex:1"></span><span class="conn" id="rst"></span></div>
  <div class="cols"><div>
    <div class="video" id="vid">${dev ? '<img id="vimg" alt="">' : ''}<div class="big">${esc(r.name)}</div><div style="opacity:.7">카메라 영상 영역</div></div><div class="conn" id="lat" style="margin:6px 0 12px"></div>
    <div class="card"><h3>조도 추이 (BH1750 · 최근 약 3분)</h3><canvas class="chart" id="chart"></canvas></div>
    <div class="card"><h3>타임라인</h3><div class="log" id="tl"></div></div>
  </div><div>
    <div class="card"><h3>이 호실의 알람</h3><div id="ra"></div></div>
    <div class="card"><h3>조명 제어 (W-05)</h3>
      <div class="sl"><label>밝기</label><input type="range" id="bri" min="0" max="100" value="${LS.get('bri' + id, 50)}"><span class="v" id="briV"></span></div>
      <div class="sl"><label>색온도</label><input type="range" id="cct" min="0" max="100" value="${LS.get('cct' + id, 30)}"><span class="v" id="cctV"></span></div>
      <div class="rg" id="rg" style="margin-top:12px">${rhythms.map((h, i) => `<button class="btn" data-i="${i}">${h.name}<small>${h.en}</small></button>`).join('')}<button class="btn wide" data-i="-1">전체 소등</button></div>
      <details style="margin-top:12px"><summary style="cursor:pointer;color:var(--mute);font-weight:700">채널 직접 조절 (전문가)</summary>${CH.map((c, i) => `<div class="sl"><label>${c.n}</label><input type="range" min="0" max="255" id="s${i}"><span class="v" id="v${i}">0</span></div>`).join('')}</details>
    </div>
    <div class="card"><h3>공간 정보 (facility.json)</h3><div class="log" style="max-height:none">침상 수 <b>${r.beds ?? '미확정'}</b> · 실면적 <b>${facility.rooms.find((x) => x.id === id).area ?? '미확정'}</b> · 입소자 프로파일 <b>${facility.rooms.find((x) => x.id === id).profile ?? '미확정'}</b>${z.assumed ? '<br>이 호실 번호는 3층 복제 가정값입니다.' : ''}</div></div>
  </div></div>`;
  view.room = id; view.dragUntil = 0; view.asig = '';
  if (dev) { const im = $('#vimg'); im.onerror = () => { $('#vid').classList.add('dead'); setTimeout(() => view.room === id && (im.src = `/api/rooms/${id}/stream?t=${Date.now()}`), 2500); }; im.onload = () => $('#vid').classList.remove('dead'); im.src = `/api/rooms/${id}/stream`; }
  const simple = () => { const b = +$('#bri').value, t = +$('#cct').value; $('#briV').textContent = b + '%'; $('#cctV').textContent = t < 34 ? '따뜻함' : t < 67 ? '중간' : '차가움';
    LS.set('bri' + id, b); LS.set('cct' + id, t); const m = t / 100, w = [.35, 1, 0, .9], c = [1, .25, 1, .1], mx = [160, 70, 90, 60]; return w.map((x, i) => Math.round((x * (1 - m) + c[i] * m) * mx[i] * b / 100)); };
  let tm; const push = () => { const v = simple(); view.dragUntil = Date.now() + 1500; clearTimeout(tm); tm = setTimeout(() => v.forEach((x, i) => api(`/api/rooms/${id}/set`, { ch: i, val: x }).catch(() => {})), 120); };
  $('#bri').oninput = $('#cct').oninput = push; simple();
  $('#rg').onclick = async (e) => { const b = e.target.closest('button'); if (!b) return; const t0 = performance.now(); try { await api(`/api/rooms/${id}/rhythm`, { id: +b.dataset.i }); $('#lat').textContent = `조명 명령 응답 ${Math.round(performance.now() - t0)} ms (목표 1초 이내)`; } catch {} };
  for (let i = 0; i < 4; i++) { let t; $('#s' + i).oninput = (e) => { $('#v' + i).textContent = e.target.value; view.dragUntil = Date.now() + 1500; clearTimeout(t); t = setTimeout(() => api(`/api/rooms/${id}/set`, { ch: i, val: +e.target.value }).catch(() => {}), 60); }; }
  $('#ra').onclick = onAlertAct;
  const loadTl = async () => { try { const l = await api('/api/log'); $('#tl') && ($('#tl').innerHTML = l.events.filter((e) => e.room === id || e.room === 'all').slice(0, 40).map((e) => `${new Date(e.t).toLocaleTimeString('ko-KR')} · <b>${esc(e.msg)}</b>`).join('<br>') || '이벤트 없음'); } catch {} };
  loadTl(); view.timer = setInterval(loadTl, 3000);
}
function refreshRoom() {
  const r = rooms.get(view.room); if (!r) return; const lv = levelOf(r);
  $('#rlv').innerHTML = lvBadge(lv) + (r.online ? '' : ' <span style="color:var(--sys)">▣ 점검(오프라인)</span>');
  $('#rst').textContent = r.online ? `조도 ${r.lux} lx · ${r.present ? '재실' : '부재 ' + mmss(Date.now() - r.absentSince)}${r.rssi ? ' · Wi-Fi ' + r.rssi + ' dBm' : ''}${r.fps ? ' · ' + r.fps + ' fps' : ''}` : '유닛 오프라인';
  if (r.mode !== 'device') $('#vid').classList.toggle('dead', !r.online);
  const as = snap.alerts.filter((a) => a.room === r.id && ACTIVE.includes(a.state)), sig = as.map((a) => a.id + a.state + a.escalated).join();
  if (sig !== view.asig) { view.asig = sig; $('#ra').innerHTML = as.map((a) => alertCard(a, false)).join('') || '<div class="empty" style="padding:8px">진행 중인 알람 없음</div>'; }
  $('#rg').querySelectorAll('button').forEach((b) => b.classList.toggle('active', +b.dataset.i === r.rhythm));
  if (Date.now() > view.dragUntil) r.ch.forEach((v, i) => { $('#s' + i).value = v; $('#v' + i).textContent = v; });
  drawChart($('#chart'), r.luxHist);
}
function drawChart(cv, d) {
  const dpr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight; cv.width = w * dpr; cv.height = h * dpr; const g = cv.getContext('2d'); g.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement), acc = css.getPropertyValue('--acc'), line = css.getPropertyValue('--line'), mute = css.getPropertyValue('--mute');
  const max = Math.max(50, ...d) * 1.15; g.strokeStyle = line; g.lineWidth = 1; g.fillStyle = mute; g.font = '11px sans-serif';
  [0, .5, 1].forEach((f) => { const y = h - 14 - f * (h - 22); g.beginPath(); g.moveTo(34, y); g.lineTo(w, y); g.stroke(); g.fillText(Math.round(max * f), 2, y + 4); });
  if (d.length < 2) return; g.strokeStyle = acc; g.lineWidth = 2; g.beginPath(); d.forEach((v, i) => { const x = 34 + i / (d.length - 1) * (w - 38), y = h - 14 - v / max * (h - 22); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke();
}

// ---------- W-08 시스템 상태 ----------
function buildSystem() { $('#view').innerHTML = `<div class="card"><h3>점검(SYS) 알림 — 기술 채널, 케어 알람과 별개</h3><div id="flt"></div></div><div class="card"><h3>유닛 상태</h3><div style="overflow:auto"><table class="t" id="ut"></table></div></div>`; view.sig = ''; }
function refreshSystem() {
  const open = snap.faults.filter((f) => !f.closed);
  $('#flt').innerHTML = open.map((f) => `<div class="alert-card lv-SYS" style="--bar:3px;border-left-style:dashed"><div><div class="t"><span class="g">▣ 점검</span> · ${f.code} ${esc(f.title)}</div><div class="m">${esc(rooms.get(f.room)?.name)} · ${mmss(Date.now() - f.opened)} 경과</div></div></div>`).join('') || '<div class="empty" style="padding:8px">열린 점검 알림 없음</div>';
  $('#ut').innerHTML = `<tr><th>유닛 ID</th><th>호실</th><th>구분</th><th>상태</th><th>Wi-Fi</th><th>FPS</th><th>마지막 수신</th></tr>` +
    snap.rooms.map((r) => `<tr><td>${esc(r.unitId)}</td><td>${esc(r.name)}</td><td>${r.mode === 'device' ? '실제 장치' : '시뮬레이션'}</td><td class="lv-${r.online ? 'L1' : 'SYS'}"><span class="g">${r.online ? '▬ 정상' : '▣ 오프라인'}</span></td><td>${r.rssi ? r.rssi + ' dBm' : '-'}</td><td>${r.online ? r.fps : '-'}</td><td>${r.online ? '방금' : mmss(Date.now() - r.lastSeen) + ' 전'}</td></tr>`).join('');
}

// ---------- W-07 로그 (alert_transition) ----------
function buildLog() { $('#view').innerHTML = `<div class="card"><h3>알람 상태 전이 (alert_transition: 알람ID · 상태 · 행위자 · 시각)</h3><div style="overflow:auto"><table class="t" id="tr"></table></div></div><div class="card"><h3>이벤트 로그</h3><div class="log" id="ev" style="max-height:none"></div></div>`;
  const load = async () => { try { const l = await api('/api/log'); $('#tr').innerHTML = '<tr><th>알람 ID</th><th>호실</th><th>상태</th><th>행위자</th><th>시각</th></tr>' + l.transitions.map((t) => `<tr><td>${t.alertId}</td><td>${esc(rooms.get(t.room)?.name)}</td><td>${STATE_KO[t.state] || t.state}</td><td>${esc(t.actor)}</td><td>${new Date(t.t).toLocaleString('ko-KR')}</td></tr>`).join('');
    $('#ev').innerHTML = l.events.map((e) => `${new Date(e.t).toLocaleTimeString('ko-KR')} · <b>${esc(e.msg)}</b>`).join('<br>'); } catch {} };
  load(); view.timer = setInterval(load, 3000);
}

// ---------- W-10 설정 ----------
function buildSettings() {
  const s = snap.settings, unk = facility.rooms.filter((r) => r.beds == null).length;
  $('#view').innerHTML = `<div class="cols"><div><div class="card"><h3>알람 기준</h3>
    <div class="set"><div>장시간 부재 기준<small>재실이 이 시간 이상 없으면 E-01 주의(L3)</small></div><div><input id="absMin" type="number" min="1" max="1440" value="${s.absenceMinutes}" style="width:90px"> 분</div></div>
    <div class="set"><div>Shadow Mode<small>켜면 알림을 보내지 않고 로그만 기록 (파일럿 첫 2주)</small></div><button class="btn sm ${s.shadowMode ? 'on' : ''}" id="shadow">${s.shadowMode ? '켜짐' : '꺼짐'}</button></div>
    <div class="set"><div>경고음<small>긴급(L4)은 반복음, 주의(L3)는 단발음</small></div><button class="btn sm ${s.soundOn ? 'on' : ''}" id="snd">${s.soundOn ? '켜짐' : '꺼짐'}</button></div>
    <div class="set"><div>쿨다운 / 에스컬레이션<small>같은 호실·같은 이벤트 재발 억제 / L4 미확인 시 에스컬레이션</small></div><b>180초 / 3분</b></div>
    <div style="text-align:right;margin-top:10px"><button class="btn primary" id="save">저장</button></div></div>
    <div class="card"><h3>화면</h3><div class="set"><div>테마</div><button class="btn sm" id="theme">라이트 / 다크 전환</button></div>
    <div class="set"><div>로그아웃</div><button class="btn sm" id="out">로그아웃</button></div></div></div>
  <div><div class="card"><h3>공간 마스터 (facility.json)</h3><div class="log" style="max-height:none">${esc(facility.name)} · 구역 ${facility.zones.length}개 · 호실 ${facility.rooms.length}개<br>호실별 침상 수 미확정: <b>${unk}개</b><br>2층(C·D 구역)은 3층 복제 가정값입니다.<br>확정 필요: 침상 수 · 실면적 · 입소자 프로파일 · 복도 실측 길이 · 2층 실제 호실 번호</div></div>
  ${meta.sim ? `<div class="card"><h3>시연 도구 (시뮬레이션 호실)</h3><div class="set"><select id="simRoom">${facility.rooms.map((r) => `<option value="${r.id}">${r.name}</option>`).join('')}</select></div>
    <div class="seg"><button class="btn sm" data-sim="fall">낙상 의심(L4)</button><button class="btn sm" data-sim="absence">장시간 부재(L3)</button><button class="btn sm" data-sim="nomotion">무동작(L3)</button><button class="btn sm" data-sim="watch">야간 각성(L2)</button><button class="btn sm" data-sim="offline">오프라인 토글</button></div></div>` : ''}</div></div>`;
  const cur = () => ({ absenceMinutes: +$('#absMin').value, shadowMode: $('#shadow').textContent === '켜짐', soundOn: $('#snd').textContent === '켜짐' });
  const flip = (b) => { const on = b.textContent !== '켜짐'; b.textContent = on ? '켜짐' : '꺼짐'; b.classList.toggle('on', on); };
  $('#shadow').onclick = (e) => flip(e.target); $('#snd').onclick = (e) => flip(e.target);
  $('#save').onclick = async () => { await api('/api/settings', cur()); toast('저장됨'); };
  $('#theme').onclick = () => { const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = t; LS.set('theme', t); };
  $('#out').onclick = async () => { if (window.DEMO) return toast('데모에서는 로그아웃이 없습니다'); await fetch('/api/logout'); location.href = '/login.html'; };
  document.querySelectorAll('[data-sim]').forEach((b) => (b.onclick = () => api('/api/sim', { room: $('#simRoom').value, type: b.dataset.sim })));
}

// ---------- 배너·사운드·네비 배지 ----------
let seen = new Set(), actx;
document.addEventListener('click', () => { try { actx = actx || new AudioContext(); actx.resume(); } catch {} });
function beep(f) { if (!actx || actx.state !== 'running') return; const o = actx.createOscillator(), g = actx.createGain(); o.frequency.value = f; g.gain.value = .15; o.connect(g); g.connect(actx.destination); o.start(); o.stop(actx.currentTime + .25); }
setInterval(() => { if (snap.settings.soundOn && snap.alerts.some((a) => a.level === 'L4' && a.state === 'NEW')) beep(988); }, 2500);
function refreshBanner() {
  const as = snap.alerts.filter((a) => ['L4', 'L3'].includes(a.level) && ACTIVE.includes(a.state)).sort((a, b) => LEVELS[b.level].rank - LEVELS[a.level].rank || a.created - b.created);
  const sig = as.map((a) => a.id + a.state).join();
  if (sig !== view.bsig) { view.bsig = sig; $('#banner').innerHTML = as.map((a) => `<div class="ban ${a.level} ${a.state}${a.state !== 'NEW' ? ' ack' : ''}" data-room="${a.room}"><span style="font-size:20px">${LEVELS[a.level].glyph}</span><span>${LEVELS[a.level].name} · ${esc(rooms.get(a.room)?.name)} ${esc(a.title)} · <span data-since="${a.created}">${mmss(Date.now() - a.created)}</span> 경과 · ${STATE_KO[a.state]}</span><span class="sp" style="flex:1"></span>${a.state === 'NEW' ? `<button class="btn" data-act="ack" data-id="${a.id}">확인</button>` : ''}<button class="btn" data-go="/room/${a.room}">상세</button></div>`).join(''); }
  const nNew = as.filter((a) => a.state === 'NEW').length; const sys = snap.rooms.filter((r) => !r.online).length;
  const set = (k, n) => { const e = $(`[data-bd=${k}]`); if (e) { e.style.display = n ? 'flex' : 'none'; e.textContent = n; } };
  set('alerts', activeAlerts().length); set('sys', sys); set('board', 0);
  snap.alerts.forEach((a) => { if (!seen.has(a.id)) { seen.add(a.id); if (a.state === 'NEW' && snap.settings.soundOn && a.level === 'L3') beep(660); } });
}
$('#banner').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.act) onAlertAct(e); else if (b.dataset.go) go(b.dataset.go); };
setInterval(() => { $('#clock').textContent = new Date().toLocaleString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  document.querySelectorAll('[data-since]').forEach((e) => (e.textContent = mmss(Date.now() - +e.dataset.since))); }, 1000);

function refresh() {
  if (!snap.rooms.length || !view.ready) return;
  refreshBanner();
  const a = route.split('/')[1];
  if (!a) refreshBoard(); else if (a === 'room') refreshRoom(); else if (a === 'alerts') refreshAlerts(); else if (a === 'system') refreshSystem();
}

// ---------- 실시간 연결 ----------
function onState(m) { snap = m; rooms = new Map(m.rooms.map((r) => [r.id, r])); refresh(); }
function connect() {
  if (window.DEMO) { $('#conn').textContent = '● 데모 (시뮬레이션)'; $('#conn').style.color = 'var(--l1)'; return window.DEMO.start(onState); }
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/ui');
  ws.onopen = () => { $('#conn').textContent = '● 실시간 연결됨'; $('#conn').style.color = 'var(--l1)'; };
  ws.onmessage = (e) => onState(JSON.parse(e.data));
  ws.onclose = () => { $('#conn').textContent = '○ 재연결 중…'; $('#conn').style.color = 'var(--l4)'; setTimeout(connect, 1500); };
}
let wl; async function keepAwake() { try { wl = await navigator.wakeLock?.request('screen'); } catch {} }
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && keepAwake());
document.documentElement.dataset.theme = LS.get('theme', 'light');
(async () => {
  meta = await api('/api/meta'); facility = meta.facility; rhythms = meta.rhythms; $('#fname').textContent = facility.name + ' 관제';
  facility.zones.forEach((z) => (zoneOf[z.id] = z));
  connect(); keepAwake();
  await new Promise((res) => { const t = setInterval(() => { if (snap.rooms.length) { clearInterval(t); res(); } }, 50); });
  onRoute();
})();
