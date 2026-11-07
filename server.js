// Rhyturn 요양시설 관리자 대시보드 서버 (클라우드 배포용)
//   브라우저 <-HTTP/WS-> 이 서버 <-WS(장치가 먼저 접속)-> ESP32-S3 (호실별 1대)
// 영상은 메모리에서만 중계하며 디스크에 저장하지 않는다 (과업지시서 7-(1)).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = +process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'rhyturn1234';
const DEVICE_TOKEN = process.env.DEVICE_TOKEN || 'device-secret';
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(16).toString('hex');
const SIM = process.env.SIM !== '0'; // 장치가 없는 호실은 시뮬레이션
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

const RHYTHMS = [
  { name: '기상 유도', en: 'Dawn', ch: [22, 24, 4, 26] },
  { name: '아침 각성', en: 'Morning', ch: [76, 23, 27, 26] },
  { name: '주간 피크', en: 'Daytime', ch: [132, 33, 61, 28] },
  { name: '정오', en: 'Midday', ch: [106, 26, 49, 22] },
  { name: '오후 활동', en: 'Afternoon', ch: [89, 26, 32, 30] },
  { name: '일몰 전환', en: 'Wind-down', ch: [51, 31, 12, 31] },
  { name: '저녁', en: 'Evening', ch: [26, 23, 6, 23] },
  { name: '취침 준비', en: 'Pre-sleep', ch: [11, 13, 2, 13] },
  { name: '야간 수면', en: 'Night', ch: [1, 1, 0, 1] },
  { name: '야간 이동', en: 'Night nav', ch: [1, 5, 0, 5] },
]; // ch 순서: D0 Green, D1 Yellow, D2 Blue, D3 Red (펌웨어와 동일)

let settings = { absenceMinutes: 30, soundOn: true };
try { settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch {}

// ---------- 호실 모델 ----------
const ROOM_COUNT = Math.min(60, +process.env.ROOM_COUNT || 10); // 호실(장치) 수
const MAX_LIVE = +process.env.MAX_LIVE || 4; // 동시에 실시간 영상을 보낼 수 있는 호실 수 (Wi-Fi/서버 대역폭 보호)
const rooms = new Map();
for (let i = 1; i <= ROOM_COUNT; i++) {
  const id = String(100 + i);
  rooms.set(id, {
    id, name: id + '호', mode: 'sim', online: SIM, lastSeen: Date.now(),
    rhythm: 2, ch: [...RHYTHMS[2].ch], lux: 0, luxHist: [],
    present: true, absentSince: null, fps: 0, rssi: null,
    alert: null, // {type:'fall'|'absence', since, acked}
    fallPose: false,
  });
}
if (SIM && rooms.get('107')) { rooms.get('107').online = false; rooms.get('107').lastSeen = Date.now() - 3600e3; } // 시연용: 오프라인 호실

const events = [];
function addEvent(room, type, msg) {
  events.unshift({ t: Date.now(), room, type, msg }); if (events.length > 200) events.length = 200;
  broadcastEvent(events[0]);
}

// ---------- 장치(ESP32) 연결 ----------
const devices = new Map(); // roomId -> ws
const frames = new Map();  // roomId -> Buffer (메모리 전용)
const streamSubs = new Map(); // roomId -> Set(res)
const watchCount = (id) => (streamSubs.get(id)?.size || 0);

// HTTP 연결 장치 (핫스팟/AP 모드 ESP32): 서버가 장치 주소로 접속해 영상·상태를 가져오고 명령을 보낸다
const httpDev = new Map(); // roomId -> base URL
const hget = (base, p, ms = 3000) => fetch(base + p, { signal: AbortSignal.timeout(ms), cache: 'no-store' });
function toDevice(id, msg) {
  const base = httpDev.get(id);
  if (base) {
    if (msg.type === 'rhythm') hget(base, '/rhythm?id=' + msg.id).catch(() => {});
    else if (msg.type === 'set') hget(base, `/set?ch=${msg.ch}&val=${msg.val}`).catch(() => {});
    return true; // stream 수요는 폴링 루프가 watchCount로 직접 판단
  }
  const ws = devices.get(id);
  if (ws && ws.readyState === 1) { ws.send(JSON.stringify(msg)); return true; }
  return false;
}

// ---------- 알림 로직 ----------
function raise(room, type) {
  if (room.alert && room.alert.type === type) return;
  room.alert = { type, since: Date.now(), acked: false };
  addEvent(room.id, type, type === 'fall' ? `${room.name} 낙상 의심 감지` : `${room.name} 장시간 부재 감지`);
}
function clearAlert(room, why) {
  if (!room.alert) return;
  addEvent(room.id, 'info', `${room.name} 경고 해제 (${why})`);
  room.alert = null;
}
// 장치가 보낸 vision 결과 또는 시뮬레이터가 호출
function setPresence(room, present, fall) {
  room.present = present;
  if (present) { room.absentSince = null; if (room.alert?.type === 'absence') clearAlert(room, '재실 확인'); }
  else if (!room.absentSince) room.absentSince = Date.now();
  if (fall) raise(room, 'fall');
}
setInterval(() => {
  for (const r of rooms.values()) {
    if (r.online && !r.present && r.absentSince && Date.now() - r.absentSince > settings.absenceMinutes * 60e3) raise(r, 'absence');
    if (r.mode === 'device' && r.online && Date.now() - r.lastSeen > 8000) { r.online = false; addEvent(r.id, 'offline', `${r.name} 장치 연결 끊김`); }
  }
}, 1000);

// ---------- 시뮬레이터 (장치 없는 호실) ----------
function simLux(r) {
  // BH1750 값 흉내: 채널 합에 비례 + 잡음 (실측 보정 전 임시식)
  const k = r.ch[0] * 0.9 + r.ch[1] * 0.6 + r.ch[2] * 0.5 + r.ch[3] * 0.3;
  return Math.max(0, Math.round(k * 1.1 + (Math.random() - 0.5) * 4));
}
const simTarget = new Map();
setInterval(() => {
  for (const r of rooms.values()) {
    if (r.mode !== 'sim') continue;
    if (!r.online) continue;
    r.lastSeen = Date.now();
    const tg = simTarget.get(r.id);
    if (tg) for (let i = 0; i < 4; i++) { const d = tg[i] - r.ch[i]; r.ch[i] += Math.sign(d) * Math.min(Math.abs(d), 12); }
    r.lux = simLux(r);
    r.fps = 8 + Math.round(Math.random() * 2); r.rssi = -50 - Math.round(Math.random() * 15);
    if (Math.random() < 0.004 && r.present && !r.alert) setPresence(r, false); // 화장실 등 일시 부재
    else if (!r.present && Math.random() < 0.08 && !r.alert) setPresence(r, true);
  }
}, 500);
setInterval(() => { for (const r of rooms.values()) { r.luxHist.push(r.lux); if (r.luxHist.length > 90) r.luxHist.shift(); } }, 2000);
for (const r of rooms.values()) { const i = [2, 2, 3, 2, 1, 4, 2, 8, 2, 5][(+r.id - 101) % 10]; r.rhythm = i; r.ch = [...RHYTHMS[i].ch]; r.lux = simLux(r); }

// ---------- 제어 ----------
function applyRhythm(r, id) {
  if (id === -1) { r.rhythm = -1; setCh(r, [0, 0, 0, 0], false); return; }
  r.rhythm = id; setCh(r, RHYTHMS[id].ch, true);
  if (r.mode === 'device') toDevice(r.id, { type: 'rhythm', id });
}
function setCh(r, ch, viaRhythm) {
  if (r.mode === 'sim') simTarget.set(r.id, ch);
  else if (!viaRhythm) toDevice(r.id, { type: 'rhythm', id: -1 });
}
function setChannel(r, c, v) {
  r.rhythm = -2;
  if (r.mode === 'sim') { const t = simTarget.get(r.id) || [...r.ch]; t[c] = v; simTarget.set(r.id, t); }
  else toDevice(r.id, { type: 'set', ch: c, val: v });
}

// ---------- 브라우저 WS ----------
const uiClients = new Set();
const publicRoom = (r) => ({ id: r.id, name: r.name, mode: r.mode, online: r.online, rhythm: r.rhythm, ch: r.ch.map(Math.round),
  lux: r.lux, luxHist: r.luxHist, fallPose: r.fallPose, present: r.present, absentSince: r.absentSince, fps: r.fps, rssi: r.rssi, alert: r.alert, lastSeen: r.lastSeen });
const snapshot = () => JSON.stringify({ type: 'rooms', rooms: [...rooms.values()].map(publicRoom), settings, t: Date.now() });
function broadcastEvent(e) { const s = JSON.stringify({ type: 'event', event: e }); for (const c of uiClients) if (c.readyState === 1) c.send(s); }
let dirty = true;
setInterval(() => { if (!uiClients.size) return; const s = snapshot(); for (const c of uiClients) if (c.readyState === 1) c.send(s); }, 500);

// ---------- 인증 (관리자 1종) ----------
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('hex');
const makeToken = () => { const exp = Date.now() + 12 * 3600e3; return `${exp}.${sign(String(exp))}`; };
const validToken = (t) => { if (!t) return false; const [exp, sig] = t.split('.'); return +exp > Date.now() && sig === sign(exp); };
const cookie = (req, k) => (req.headers.cookie || '').split(/;\s*/).map((c) => c.split('=')).find(([n]) => n === k)?.[1];
const isAuthed = (req) => validToken(cookie(req, 'rt'));
const safeEq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((r) => { let s = ''; req.on('data', (c) => { s += c; if (s.length > 1e5) req.destroy(); }); req.on('end', () => r(s)); });
const PUBLIC = path.join(__dirname, 'public');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'); const p = url.pathname;
  try {
    if (p === '/api/login' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)) || '{}');
      if (safeEq(String(b.user || ''), ADMIN_USER) && safeEq(String(b.pass || ''), ADMIN_PASS)) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `rt=${makeToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200` });
        return res.end('{"ok":true}');
      }
      return json(res, 401, { error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    }
    if (p === '/api/logout') { res.writeHead(200, { 'Set-Cookie': 'rt=; Path=/; Max-Age=0' }); return res.end('{}'); }
    if (['/login.html', '/login.js', '/style.css', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png', '/sw.js'].includes(p)) return serveStatic(res, p);
    if (!isAuthed(req)) {
      if (p.startsWith('/api/')) return json(res, 401, { error: 'unauthorized' });
      res.writeHead(302, { Location: '/login.html' }); return res.end();
    }

    if (p === '/api/meta') return json(res, 200, { rhythms: RHYTHMS, rooms: ROOM_COUNT, sim: SIM, maxLive: MAX_LIVE });
    let m;
    if ((m = p.match(/^\/api\/rooms\/(\d+)\/(thumb|stream)$/))) {
      const id = m[1]; const r = rooms.get(id);
      if (!r) return json(res, 404, { error: 'no room' });
      if (m[2] === 'thumb') {
        const f = frames.get(id); if (!f) { res.writeHead(204); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' }); return res.end(f);
      }
      const live = [...streamSubs.entries()].filter(([k, v]) => k !== id && v.size > 0).length;
      if (live >= MAX_LIVE) return json(res, 429, { error: `동시 실시간 영상은 ${MAX_LIVE}개 호실까지 가능합니다.` });
      res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame', 'Cache-Control': 'no-store' });
      if (!streamSubs.has(id)) streamSubs.set(id, new Set());
      streamSubs.get(id).add(res); updateStreamDemand(id);
      const f = frames.get(id); if (f) pushFrame(res, f);
      req.on('close', () => { streamSubs.get(id)?.delete(res); updateStreamDemand(id); });
      return;
    }
    if (req.method === 'POST') {
      const b = JSON.parse((await readBody(req)) || '{}');
      if ((m = p.match(/^\/api\/rooms\/(\d+)\/rhythm$/))) {
        const r = rooms.get(m[1]); if (!r || !(b.id >= -1 && b.id <= 9)) return json(res, 400, { error: 'bad' });
        applyRhythm(r, b.id); addEvent(r.id, 'control', `${r.name} 리듬: ${b.id < 0 ? '소등' : RHYTHMS[b.id].name}`); return json(res, 200, { ok: true });
      }
      if ((m = p.match(/^\/api\/rooms\/(\d+)\/set$/))) {
        const r = rooms.get(m[1]); if (!r || !(b.ch >= 0 && b.ch <= 3 && b.val >= 0 && b.val <= 255)) return json(res, 400, { error: 'bad' });
        setChannel(r, b.ch | 0, b.val | 0); return json(res, 200, { ok: true });
      }
      if ((m = p.match(/^\/api\/rooms\/(\d+)\/ack$/))) {
        const r = rooms.get(m[1]); if (!r?.alert) return json(res, 400, { error: 'no alert' });
        if (r.alert.type === 'fall' || r.alert.type === 'absence') { addEvent(r.id, 'info', `${r.name} 경고 확인 처리`); r.alert.acked = true; }
        return json(res, 200, { ok: true });
      }
      if ((m = p.match(/^\/api\/rooms\/(\d+)\/resolve$/))) {
        const r = rooms.get(m[1]); if (!r) return json(res, 400, { error: 'bad' });
        r.fallPose = false; if (!r.present) setPresence(r, true); clearAlert(r, '관리자 조치 완료'); return json(res, 200, { ok: true });
      }
      if (p === '/api/all/rhythm') {
        if (!(b.id >= -1 && b.id <= 9)) return json(res, 400, { error: 'bad' });
        for (const r of rooms.values()) if (r.online) applyRhythm(r, b.id);
        addEvent('all', 'control', `전체 호실 리듬: ${b.id < 0 ? '소등' : RHYTHMS[b.id].name}`); return json(res, 200, { ok: true });
      }
      if (p === '/api/settings') {
        settings = { absenceMinutes: Math.min(1440, Math.max(1, +b.absenceMinutes || 30)), soundOn: !!b.soundOn };
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings)); return json(res, 200, settings);
      }
      if (p === '/api/sim/event' && SIM) { // 시연 도구
        const r = rooms.get(String(b.room)); if (!r || r.mode !== 'sim') return json(res, 400, { error: 'bad' });
        if (b.type === 'fall') { r.fallPose = true; setPresence(r, true, true); }
        if (b.type === 'absence') { setPresence(r, false); r.absentSince = Date.now() - settings.absenceMinutes * 60e3 - 1000; }
        if (b.type === 'offline') { r.online = !r.online; r.lastSeen = Date.now(); addEvent(r.id, r.online ? 'info' : 'offline', `${r.name} ${r.online ? '장치 재연결' : '장치 연결 끊김'}`); }
        return json(res, 200, { ok: true });
      }
    }
    if (p === '/api/events') return json(res, 200, events.slice(0, 100));
    return serveStatic(res, p === '/' ? '/index.html' : p);
  } catch (e) { json(res, 500, { error: e.message }); }
});

function serveStatic(res, p) {
  const f = path.join(PUBLIC, path.normalize(p));
  if (!f.startsWith(PUBLIC) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
}
function pushFrame(res, b) { res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${b.length}\r\n\r\n`); res.write(b); res.write('\r\n'); }
// 보는 사람이 없으면 저속(1fps, VGA)으로 AI 분석/썸네일용 프레임만, 보면 고속(10fps, SVGA)
function updateStreamDemand(id) { const w = watchCount(id) > 0; toDevice(id, { type: 'stream', fps: w ? 10 : 1, size: w ? 'hi' : 'lo' }); }

// ---------- WebSocket: 브라우저(/ws/ui), 장치(/ws/device) ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/ws/ui' && isAuthed(req)) return wss.handleUpgrade(req, socket, head, (ws) => { uiClients.add(ws); ws.send(snapshot()); ws.on('close', () => uiClients.delete(ws)); ws.on('error', () => {}); });
  if (url.pathname === '/ws/device' && safeEq(url.searchParams.get('token') || '', DEVICE_TOKEN)) {
    const id = url.searchParams.get('room'); const r = rooms.get(id);
    if (!r) { socket.destroy(); return; }
    return wss.handleUpgrade(req, socket, head, (ws) => {
      devices.get(id)?.close(); devices.set(id, ws);
      r.mode = 'device'; r.online = true; r.lastSeen = Date.now(); simTarget.delete(id);
      addEvent(id, 'info', `${r.name} 장치 연결됨`); updateStreamDemand(id);
      ws.isAlive = true; ws.on('pong', () => (ws.isAlive = true));
      const hb = setInterval(() => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; try { ws.ping(); } catch {} }, 10000); // 끊긴 Wi-Fi 감지
      ws.on('close', () => clearInterval(hb));
      ws.on('message', (data, isBin) => {
        r.lastSeen = Date.now(); r.online = true;
        if (isBin) { // JPEG 프레임 (메모리에만 보관)
          frames.set(id, data); streamSubs.get(id)?.forEach((s) => pushFrame(s, data)); return;
        }
        let m; try { m = JSON.parse(data.toString()); } catch { return; }
        if (m.type === 'state') {
          if (Array.isArray(m.ch)) r.ch = m.ch; if (m.rhythm !== undefined) r.rhythm = m.rhythm;
          if (typeof m.lux === 'number') r.lux = m.lux; if (m.fps !== undefined) r.fps = m.fps; if (m.rssi !== undefined) r.rssi = m.rssi;
        } else if (m.type === 'vision') setPresence(r, !!m.present, !!m.fall); // 낙상/재실 판정 결과 (분석 모듈 연동 지점)
      });
      ws.on('close', () => { if (devices.get(id) === ws) { devices.delete(id); r.online = false; addEvent(id, 'offline', `${r.name} 장치 연결 끊김`); } });
      ws.on('error', () => {});
    });
  }
  socket.destroy();
});
setInterval(() => { for (const r of rooms.values()) if (r.luxHist.length === 0) r.luxHist.push(r.lux); }, 5000);

server.listen(PORT, () => {
  console.log(`Rhyturn 대시보드: http://localhost:${PORT}  (관리자 ${ADMIN_USER})`);
  if (!process.env.ADMIN_PASS) console.log('⚠ 기본 비밀번호 사용 중. 운영 시 ADMIN_PASS, DEVICE_TOKEN, SESSION_SECRET을 설정하세요.');
});

// ---------- HTTP(AP 모드) 장치 연결: DEVICES="105=http://192.168.4.1,106=http://192.168.4.2" ----------
function startHttpDevice(id, base) {
  const r = rooms.get(id);
  if (!r) return console.log('[장치] 없는 호실:', id);
  base = base.replace(/\/$/, ''); httpDev.set(id, base);
  r.mode = 'device'; r.online = false; r.lastSeen = 0; r.luxHist = [];
  const mark = (on) => { if (on) { r.lastSeen = Date.now(); if (!r.online) { r.online = true; addEvent(id, 'info', `${r.name} 장치 연결됨`); } } };
  (async function stateLoop() {
    try {
      const j = await (await hget(base, '/state')).json();
      if (Array.isArray(j.ch)) r.ch = j.ch; if (j.rhythm !== undefined) r.rhythm = j.rhythm;
      if (typeof j.lux === 'number') r.lux = j.lux; if (j.fps !== undefined) r.fps = j.fps;
      r.rssi = null; mark(true);
    } catch {}
    setTimeout(stateLoop, 1000);
  })();
  let n = 0, t0 = Date.now();
  (async function frameLoop() {
    const live = watchCount(id) > 0; let wait = live ? 80 : 1000;
    try {
      const res = await hget(base, '/snapshot?size=' + (live ? 'hi' : 'lo'), 5000);
      if (!res.ok) throw new Error('http ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      frames.set(id, buf); streamSubs.get(id)?.forEach((s) => pushFrame(s, buf)); mark(true);
      if (++n >= 10) { r.fps = +(n * 1000 / (Date.now() - t0)).toFixed(1); n = 0; t0 = Date.now(); }
    } catch { wait = 2000; }
    setTimeout(frameLoop, wait);
  })();
  console.log(`[장치] ${r.name} ← ${base} (HTTP)`);
}
for (const pair of (process.env.DEVICES || '').split(',').map((x) => x.trim()).filter(Boolean)) {
  const [id, url] = pair.split('='); if (id && url) startHttpDevice(id.trim(), url.trim());
}
