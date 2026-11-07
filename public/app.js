const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let RHYTHMS = [], rooms = [], settings = { absenceMinutes: 30, soundOn: true }, events = [], openId = null, ws, wsOk = false;
const CH = [{ n: 'D0 Green', c: '#4ade80' }, { n: 'D1 Yellow', c: '#facc15' }, { n: 'D2 Blue', c: '#60a5fa' }, { n: 'D3 Red', c: '#f87171' }];
const LS = { get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

function toast(m) { const t = $('#toast'); t.textContent = m; t.style.display = 'block'; clearTimeout(toast.t); toast.t = setTimeout(() => (t.style.display = 'none'), 2500); }
async function api(path, body) {
  if (window.DEMO) return window.DEMO.api(path, body);
  const r = await fetch(path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
  if (r.status === 401) { location.href = '/login.html'; throw 0; }
  if (!r.ok) { toast('요청 실패'); throw 0; }
  return r.json();
}
const status = (r) => !r.online ? 'off' : r.alert?.type === 'fall' ? 'bad' : r.alert ? 'warn' : 'ok';
const STX = { off: '오프라인', bad: '낙상 의심', warn: '장시간 부재', ok: '정상' };
const rhName = (r) => (r.rhythm >= 0 ? RHYTHMS[r.rhythm].name : r.rhythm === -1 ? '소등' : '수동 조절');
const mmss = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return s >= 3600 ? `${Math.floor(s / 3600)}시간 ${Math.floor((s % 3600) / 60)}분` : `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

// ---------- 시뮬레이션 영상(장치 없는 호실) ----------
function drawScene(cv, r) {
  const w = cv.width = 320, h = cv.height = 240, g = cv.getContext('2d');
  g.fillStyle = r.online ? '#FAF4C0' : '#e9e6d6'; g.fillRect(0, 0, w, h);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = r.online ? '#7a5c00' : '#8d887a'; g.font = '700 64px "Noto Sans KR",sans-serif'; g.fillText(r.name, w / 2, h / 2 - 8);
  g.font = '500 16px "Noto Sans KR",sans-serif'; g.fillStyle = r.online ? '#9a7b12' : '#a09b8c'; g.fillText(r.online ? '카메라 영상 영역' : '신호 없음', w / 2, h / 2 + 40);
}
const isRealCam = (r) => r.mode === 'device';

// ---------- 상단 ----------
function renderTop() {
  const c = { ok: 0, warn: 0, bad: 0, off: 0 }; rooms.forEach((r) => c[status(r)]++);
  $('#sums').innerHTML = `<span class="chip"><span class="dot ok"></span>정상 <b>${c.ok}</b></span><span class="chip"><span class="dot warn"></span>주의 <b>${c.warn}</b></span><span class="chip"><span class="dot bad"></span>경고 <b>${c.bad}</b></span><span class="chip"><span class="dot"></span>오프라인 <b>${c.off}</b></span>`;
  $('#cnt').textContent = `총 ${rooms.length}개 호실`;
  $('#snd').classList.toggle('on', settings.soundOn); $('#snd').textContent = settings.soundOn ? '🔔 경고음 켜짐' : '🔕 경고음 꺼짐';
}
function renderAlerts() {
  const list = rooms.filter((r) => r.alert).sort((a, b) => a.alert.since - b.alert.since);
  $('#alerts').innerHTML = list.map((r) => `<div class="alert ${r.alert.type} ${r.alert.acked ? 'acked' : ''}" data-r="${r.id}">
    <span class="ic">${r.alert.type === 'fall' ? '🚨' : '⚠️'}</span><span>${r.name} ${r.alert.type === 'fall' ? '낙상 의심' : '장시간 부재'} · ${mmss(Date.now() - r.alert.since)} 경과${r.alert.acked ? ' (확인됨)' : ''}</span><span class="sp" style="flex:1"></span>
    <button class="btn sm" data-a="view">영상 보기</button>${r.alert.acked ? '' : '<button class="btn sm" data-a="ack">확인</button>'}<button class="btn sm" data-a="resolve">조치 완료</button></div>`).join('');
}
$('#alerts').onclick = async (e) => {
  const b = e.target.closest('button'); if (!b) return; const id = b.closest('.alert').dataset.r;
  if (b.dataset.a === 'view') openRoom(id); else await api(`/api/rooms/${id}/${b.dataset.a}`, {});
};

// ---------- 카드 그리드 ----------
function cardHTML(r) {
  const s = status(r); const dc = { ok: 'ok', warn: 'warn', bad: 'bad', off: '' }[s];
  const bars = r.ch.map((v, i) => `<i><span style="width:${Math.min(100, v / 160 * 100)}%;background:${CH[i].c}"></span></i>`).join('');
  return `<div class="card ${r.alert ? 'alert-' + r.alert.type : ''} ${r.online ? '' : 'offline'}" data-r="${r.id}">
  <div class="thumb">${isRealCam(r) ? `<img alt="" data-th="${r.id}">` : `<canvas data-cv="${r.id}"></canvas><span class="sim">시뮬레이션</span>`}
    ${r.alert ? `<span class="tag ${r.alert.type === 'fall' ? 'bad' : 'warn'}">${r.alert.type === 'fall' ? '🚨 낙상 의심' : '⚠ 장시간 부재'}</span>` : ''}</div>
  <div class="cbody"><div class="chead"><strong>${esc(r.name)}</strong><span class="st"><span class="dot ${dc}"></span>${STX[s]}</span></div>
  <div class="kv"><div>조도<b>${r.online ? r.lux + ' lx' : '-'}</b></div><div>재실<b>${!r.online ? '-' : r.present ? '재실' : '부재 ' + mmss(Date.now() - r.absentSince)}</b></div>
  <div style="grid-column:span 2">조명<b>${r.online ? esc(rhName(r)) : '-'}</b></div></div><div class="bars">${bars}</div></div></div>`;
}
function renderGrid() {
  const order = (r) => (r.alert && !r.alert.acked ? 0 : r.alert ? 1 : r.online ? 2 : 3);
  const sorted = [...rooms].sort((a, b) => order(a) - order(b) || a.id - b.id);
  const g = $('#grid'); const sig = sorted.map((r) => r.id + status(r) + r.mode).join();
  if (g.dataset.sig !== sig) { g.innerHTML = sorted.map(cardHTML).join(''); g.dataset.sig = sig; }
  else sorted.forEach((r) => { const el = g.querySelector(`[data-r="${r.id}"]`); const t = document.createElement('div'); t.innerHTML = cardHTML(r); const n = t.firstElementChild;
    el.querySelector('.cbody').replaceWith(n.querySelector('.cbody')); });
  g.querySelectorAll('canvas[data-cv]').forEach((cv) => drawScene(cv, rooms.find((r) => r.id === cv.dataset.cv)));
}
$('#grid').onclick = (e) => { const c = e.target.closest('.card'); if (c) openRoom(c.dataset.r); };
setInterval(() => { document.querySelectorAll('img[data-th]').forEach((im) => { const u = `/api/rooms/${im.dataset.th}/thumb?t=${Date.now()}`; const t = new Image(); t.onload = () => (im.src = u); t.src = u; }); }, 2000);

// ---------- 상세 모달 ----------
const ROWH = (r) => `<div class="video" id="vid">${isRealCam(r) ? `<img id="vimg" alt="">` : '<canvas id="vcv"></canvas>'}<div class="msg">영상 없음 · 장치 오프라인</div></div><div class="lat" id="lat"></div>
<div class="sec" style="margin-top:12px"><h4>조도 추이 (BH1750 · 최근 3분)</h4><canvas class="chart" id="chart"></canvas></div>
<div class="sec"><h4>호실 이벤트</h4><div class="log" id="elog"></div></div>`;
function openRoom(id) {
  const r = rooms.find((x) => x.id === id); if (!r) return; openId = id;
  $('#sheet').innerHTML = `<header><h3>${esc(r.name)}</h3><span class="st" id="mst"></span><span class="sp" style="flex:1"></span><span id="mact"></span><button class="btn sm" id="close">닫기 ✕</button></header>
  <div class="sbody"><div>${ROWH(r)}</div><div>
   <div class="sec"><h4>간단 조절</h4>
    <div class="sl"><label>밝기</label><input type="range" id="bri" min="0" max="100" value="${LS.get('bri' + id, 50)}"><span class="v" id="briV"></span></div>
    <div class="cct"></div><div class="sl"><label>색온도</label><input type="range" id="cct" min="0" max="100" value="${LS.get('cct' + id, 30)}"><span class="v" id="cctV"></span></div></div>
   <div class="sec"><h4>생체리듬 모드</h4><div class="rg" id="rg">${RHYTHMS.map((h, i) => `<button class="btn" data-i="${i}">${h.name}<small>${h.en}</small></button>`).join('')}<button class="btn danger wide" data-i="-1">전체 소등</button></div></div>
   <div class="sec"><details><summary>채널 직접 조절 (전문가)</summary>${CH.map((c, i) => `<div class="sl"><label><span class="dot" style="background:${c.c}"></span> ${c.n}</label><input type="range" min="0" max="255" id="s${i}"><span class="v" id="v${i}">0</span></div>`).join('')}</details></div>
  </div></div>`;
  $('#modal').classList.add('open'); $('#close').onclick = closeRoom;
  const vimg = $('#vimg'); if (vimg) { vimg.onerror = () => { $('#vid').classList.add('dead'); setTimeout(() => openId && (vimg.src = `/api/rooms/${id}/stream?t=${Date.now()}`), 2000); }; vimg.onload = () => $('#vid').classList.remove('dead'); vimg.src = `/api/rooms/${id}/stream`; } // 끊김 시 자동 재연결
  const simple = () => {
    const b = +$('#bri').value, t = +$('#cct').value; $('#briV').textContent = b + '%'; $('#cctV').textContent = t < 34 ? '따뜻함' : t < 67 ? '중간' : '차가움';
    LS.set('bri' + id, b); LS.set('cct' + id, t); const m = t / 100, warm = [.35, 1, 0, .9], cool = [1, .25, 1, .1], mx = [160, 70, 90, 60];
    return warm.map((w, i) => Math.round((w * (1 - m) + cool[i] * m) * mx[i] * b / 100));
  };
  let timer; const pushAll = () => { const v = simple(); clearTimeout(timer); timer = setTimeout(() => v.forEach((x, i) => api(`/api/rooms/${id}/set`, { ch: i, val: x })), 120); };
  $('#bri').oninput = $('#cct').oninput = pushAll; simple();
  $('#rg').onclick = async (e) => { const b = e.target.closest('button'); if (!b) return; const t0 = performance.now(); await api(`/api/rooms/${id}/rhythm`, { id: +b.dataset.i }); $('#lat').textContent = `명령 응답 ${Math.round(performance.now() - t0)} ms (목표: 1초 이내)`; };
  for (let i = 0; i < 4; i++) { let t; $('#s' + i).oninput = (e) => { $('#v' + i).textContent = e.target.value; clearTimeout(t); t = setTimeout(() => api(`/api/rooms/${id}/set`, { ch: i, val: +e.target.value }), 60); dragUntil = Date.now() + 1500; }; }
  refreshModal();
}
let dragUntil = 0;
function closeRoom() { openId = null; $('#modal').classList.remove('open'); $('#sheet').innerHTML = ''; }
$('#modal').onclick = (e) => { if (e.target.id === 'modal') closeRoom(); };
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeRoom());

function refreshModal() {
  if (!openId) return; const r = rooms.find((x) => x.id === openId); if (!r) return; const s = status(r);
  $('#mst').innerHTML = `<span class="dot ${{ ok: 'ok', warn: 'warn', bad: 'bad', off: '' }[s]}"></span>${STX[s]} · ${r.online ? `조도 ${r.lux} lx · ${r.present ? '재실' : '부재'}` : ''}${r.rssi ? ` · Wi-Fi ${r.rssi} dBm` : ''}`;
  $('#mact').innerHTML = r.alert ? `${r.alert.acked ? '' : '<button class="btn sm danger" data-a="ack">확인</button> '}<button class="btn sm" data-a="resolve">조치 완료</button>` : '';
  $('#mact').onclick = async (e) => { const b = e.target.closest('button'); if (b) await api(`/api/rooms/${openId}/${b.dataset.a}`, {}); };
  $('#rg').querySelectorAll('button').forEach((b) => b.classList.toggle('active', +b.dataset.i === r.rhythm));
  if (Date.now() > dragUntil) r.ch.forEach((v, i) => { $('#s' + i).value = v; $('#v' + i).textContent = v; });
  if (!isRealCam(r)) { drawScene($('#vcv'), r); $('#vid').classList.toggle('dead', !r.online); } else if (!r.online) $('#vid').classList.add('dead');
  drawChart($('#chart'), r.luxHist);
  $('#elog').innerHTML = events.filter((e) => e.room === openId || e.room === 'all').slice(0, 30).map((e) => `${new Date(e.t).toLocaleTimeString('ko-KR')} · <b>${esc(e.msg)}</b>`).join('<br>') || '이벤트 없음';
}
function drawChart(cv, d) {
  const dpr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight; cv.width = w * dpr; cv.height = h * dpr; const g = cv.getContext('2d'); g.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement), acc = css.getPropertyValue('--acc'), line = css.getPropertyValue('--line'), mute = css.getPropertyValue('--mute');
  const max = Math.max(50, ...d) * 1.15; g.strokeStyle = line; g.lineWidth = 1; g.fillStyle = mute; g.font = '11px sans-serif';
  [0, .5, 1].forEach((f) => { const y = h - 14 - f * (h - 22); g.beginPath(); g.moveTo(34, y); g.lineTo(w, y); g.stroke(); g.fillText(Math.round(max * f), 2, y + 4); });
  if (d.length < 2) return; g.strokeStyle = acc; g.lineWidth = 2; g.beginPath();
  d.forEach((v, i) => { const x = 34 + i / (d.length - 1) * (w - 38), y = h - 14 - v / max * (h - 22); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke();
}

// ---------- 소리 ----------
let actx; document.addEventListener('click', () => { try { actx = actx || new AudioContext(); actx.resume(); } catch {} }, { once: false });
function beep(f = 880) { if (!actx || actx.state !== 'running') return; const o = actx.createOscillator(), g = actx.createGain(); o.frequency.value = f; g.gain.value = .15; o.connect(g); g.connect(actx.destination); o.start(); o.stop(actx.currentTime + .25); }
setInterval(() => { if (settings.soundOn && rooms.some((r) => r.alert && !r.alert.acked)) { beep(rooms.some((r) => r.alert?.type === 'fall' && !r.alert.acked) ? 988 : 660); } }, 2500);

// ---------- 설정/상단 버튼 ----------
$('#setb').onclick = () => { $('#absMin').value = settings.absenceMinutes; $('#pop').classList.toggle('open'); };
$('#saveSet').onclick = async () => { settings = await api('/api/settings', { absenceMinutes: +$('#absMin').value, soundOn: settings.soundOn }); toast('저장됨'); };
$('#snd').onclick = async () => { settings = await api('/api/settings', { absenceMinutes: settings.absenceMinutes, soundOn: !settings.soundOn }); renderTop(); };
$('#out').onclick = async () => { if (window.DEMO) return toast('데모 화면에서는 로그아웃이 없습니다'); await fetch('/api/logout'); location.href = '/login.html'; };
$('#theme').onclick = () => { const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = t; LS.set('theme', t); };
document.documentElement.dataset.theme = LS.get('theme', 'light');
document.querySelectorAll('[data-sim]').forEach((b) => (b.onclick = () => api('/api/sim/event', { room: $('#simRoom').value, type: b.dataset.sim })));
$('#allGo').onclick = async () => { const v = +$('#allR').value; if (confirm(`온라인 전체 호실에 '${v < 0 ? '전체 소등' : RHYTHMS[v].name}'을(를) 적용할까요?`)) { await api('/api/all/rhythm', { id: v }); toast('전체 적용됨'); } };

// ---------- 실시간 연결 ----------
function connect() {
  if (window.DEMO) { $('#conn').textContent = '● 데모 (시뮬레이션)'; $('#conn').style.color = 'var(--ok)'; return window.DEMO.start((m) => { if (m.type === 'rooms') { rooms = m.rooms; settings = m.settings; renderTop(); renderAlerts(); renderGrid(); refreshModal(); } else if (m.type === 'event') { events.unshift(m.event); events.length = Math.min(events.length, 200); } }); }
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/ui');
  ws.onopen = () => { wsOk = true; $('#conn').textContent = '● 실시간 연결됨'; $('#conn').style.color = 'var(--ok)'; };
  ws.onmessage = (e) => { const m = JSON.parse(e.data);
    if (m.type === 'rooms') { rooms = m.rooms; settings = m.settings; renderTop(); renderAlerts(); renderGrid(); refreshModal(); }
    else if (m.type === 'event') { events.unshift(m.event); events.length = Math.min(events.length, 200); } };
  ws.onclose = () => { wsOk = false; $('#conn').textContent = '○ 재연결 중…'; $('#conn').style.color = 'var(--bad)'; setTimeout(connect, 1500); };
}
(async () => {
  const meta = await api('/api/meta'); RHYTHMS = meta.rhythms; events = await api('/api/events');
  $('#allR').innerHTML = RHYTHMS.map((h, i) => `<option value="${i}">${h.name}</option>`).join('') + '<option value="-1">전체 소등</option>';
  $('#simRoom').innerHTML = Array.from({ length: meta.rooms }, (_, i) => `<option>${101 + i}</option>`).join('');
  $('#simTools').style.display = meta.sim ? '' : 'none';
  connect(); keepAwake();
})();
setInterval(() => { if (rooms.length) renderAlerts(); }, 1000);

// 관제 태블릿 화면 꺼짐 방지
let wl; async function keepAwake() { try { wl = await navigator.wakeLock?.request('screen'); } catch {} }
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && keepAwake());
