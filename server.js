// Rhyturn 서버 (설계서 L1 엣지 역할의 MVP): 장치 수집 → 판정(engine.js) → 대시보드
//   태블릿/브라우저 <-HTTP/WS-> 이 서버 <-(WS: 장치가 접속 | HTTP: 서버가 장치에 접속)-> ESP32-S3
// 영상은 메모리에서만 중계하고 디스크에 저장하지 않는다 (과업지시서 7-(1), 설계서 P1).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { createEngine, RHYTHMS } = require('./public/engine.js');

const PORT = +process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'rhyturn1234';
const DEVICE_TOKEN = process.env.DEVICE_TOKEN || 'device-secret';
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(16).toString('hex');
const SIM = process.env.SIM !== '0';
const MAX_LIVE = +process.env.MAX_LIVE || 4;
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const facility = JSON.parse(fs.readFileSync(process.env.FACILITY || path.join(__dirname, 'config', 'facility.json'), 'utf8'));

let saved = {}; try { saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch {}
const engine = createEngine(facility, { sim: SIM, settings: saved });
if (SIM && engine.rooms.has('204')) engine.setOnline(engine.rooms.get('204'), false, '시연'); // 시연: 오프라인 유닛 1개
setInterval(() => engine.tick(), 500);
setInterval(() => engine.trackHist(), 2000);

// ---------- 장치 연결 ----------
const devices = new Map();     // roomId -> ws (장치가 접속)
const httpDev = new Map();     // roomId -> base URL (서버가 접속)
const frames = new Map();      // roomId -> Buffer (메모리 전용)
const streamSubs = new Map();  // roomId -> Set(res)
const watchCount = (id) => streamSubs.get(id)?.size || 0;
const hget = (base, p, ms = 3000) => fetch(base + p, { signal: AbortSignal.timeout(ms), cache: 'no-store' });
function toDevice(id, msg) {
  const base = httpDev.get(id);
  if (base) {
    if (msg.type === 'rhythm') hget(base, '/rhythm?id=' + msg.id).catch(() => {});
    else if (msg.type === 'set') hget(base, `/set?ch=${msg.ch}&val=${msg.val}`).catch(() => {});
    return true;
  }
  const ws = devices.get(id); if (ws && ws.readyState === 1) { ws.send(JSON.stringify(msg)); return true; } return false;
}
// 보는 사람이 없으면 저속(VGA 1fps, 판정/썸네일용), 보면 고속(SVGA 10fps)
function updateStreamDemand(id) { const w = watchCount(id) > 0; toDevice(id, { type: 'stream', fps: w ? 10 : 1, size: w ? 'hi' : 'lo' }); }
function pushFrame(res, b) { res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${b.length}\r\n\r\n`); res.write(b); res.write('\r\n'); }

// HTTP(AP 핫스팟 모드) 장치: DEVICES="308=http://192.168.4.1"
function startHttpDevice(id, base) {
  const r = engine.rooms.get(id); if (!r) return console.log('[장치] 없는 호실:', id);
  base = base.replace(/\/$/, ''); httpDev.set(id, base); r.mode = 'device'; r.online = false; r.lastSeen = 0; r.luxHist = [];
  (async function stateLoop() {
    try { const j = await (await hget(base, '/state')).json(); engine.devicePatch(id, { ch: j.ch, rhythm: j.rhythm, lux: j.lux, fps: j.fps }); } catch {}
    setTimeout(stateLoop, 1000);
  })();
  let n = 0, t0 = Date.now();
  (async function frameLoop() {
    const live = watchCount(id) > 0; let wait = live ? 80 : 1000;
    try {
      const res = await hget(base, '/snapshot?size=' + (live ? 'hi' : 'lo'), 5000); if (!res.ok) throw 0;
      const buf = Buffer.from(await res.arrayBuffer()); frames.set(id, buf); streamSubs.get(id)?.forEach((s) => pushFrame(s, buf));
      engine.devicePatch(id, {}); if (++n >= 10) { engine.devicePatch(id, { fps: +(n * 1000 / (Date.now() - t0)).toFixed(1) }); n = 0; t0 = Date.now(); }
    } catch { wait = 2000; }
    setTimeout(frameLoop, wait);
  })();
  console.log(`[장치] ${r.name} ← ${base} (HTTP)`);
}
for (const pair of (process.env.DEVICES || '').split(',').map((x) => x.trim()).filter(Boolean)) { const [id, url] = pair.split('='); if (id && url) startHttpDevice(id.trim(), url.trim()); }

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
const OPEN = ['/login.html', '/login.js', '/style.css', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png', '/sw.js'];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'); const p = url.pathname;
  try {
    if (p === '/api/login' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)) || '{}');
      if (safeEq(String(b.user || ''), ADMIN_USER) && safeEq(String(b.pass || ''), ADMIN_PASS)) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `rt=${makeToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200` }); return res.end('{"ok":true}');
      }
      return json(res, 401, { error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    }
    if (p === '/api/logout') { res.writeHead(200, { 'Set-Cookie': 'rt=; Path=/; Max-Age=0' }); return res.end('{}'); }
    if (OPEN.includes(p)) return serveStatic(res, p);
    if (!isAuthed(req)) { if (p.startsWith('/api/')) return json(res, 401, { error: 'unauthorized' }); res.writeHead(302, { Location: '/login.html' }); return res.end(); }

    if (p === '/api/meta') return json(res, 200, { facility, rhythms: RHYTHMS, sim: SIM, maxLive: MAX_LIVE, deviceRooms: [...httpDev.keys(), ...devices.keys()] });
    if (p === '/api/log') return json(res, 200, engine.log());
    let m;
    if ((m = p.match(/^\/api\/rooms\/(\d+)\/(thumb|stream)$/))) {
      const id = m[1]; if (!engine.rooms.has(id)) return json(res, 404, { error: 'no room' });
      if (m[2] === 'thumb') { const f = frames.get(id); if (!f) { res.writeHead(204); return res.end(); } res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' }); return res.end(f); }
      const live = [...streamSubs.entries()].filter(([k, v]) => k !== id && v.size > 0).length;
      if (live >= MAX_LIVE) return json(res, 429, { error: `동시 실시간 영상은 ${MAX_LIVE}개 호실까지 가능합니다.` });
      res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame', 'Cache-Control': 'no-store' });
      if (!streamSubs.has(id)) streamSubs.set(id, new Set()); streamSubs.get(id).add(res); updateStreamDemand(id);
      const f = frames.get(id); if (f) pushFrame(res, f);
      req.on('close', () => { streamSubs.get(id)?.delete(res); updateStreamDemand(id); }); return;
    }
    if (req.method === 'POST') {
      const b = JSON.parse((await readBody(req)) || '{}');
      if ((m = p.match(/^\/api\/alerts\/(A-\d+)\/(ack|dispatch|resolve|false-alarm)$/))) { const r = engine.act(m[1], m[2], 'admin'); return json(res, r.error ? 400 : 200, r); }
      if (p === '/api/handover') return json(res, 200, engine.handover('admin'));
      if ((m = p.match(/^\/api\/rooms\/(\d+)\/(rhythm|set)$/))) {
        const r = engine.control(m[1], m[2] === 'rhythm' ? { type: 'rhythm', id: b.id } : { type: 'set', ch: b.ch, val: b.val });
        if (r.error) return json(res, 400, r); if (r.device) toDevice(m[1], r.msg); return json(res, 200, { ok: true });
      }
      if (p === '/api/settings') { const s = engine.setSettings(b); fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s)); return json(res, 200, s); }
      if (p === '/api/sim' && SIM) { const r = engine.simEvent(String(b.room), b.type); return json(res, r.error ? 400 : 200, r); }
    }
    return serveStatic(res, p === '/' ? '/index.html' : p);
  } catch (e) { json(res, 500, { error: e.message }); }
});
function serveStatic(res, p) {
  const f = path.join(PUBLIC, path.normalize(p));
  if (!f.startsWith(PUBLIC) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
}

// ---------- WebSocket: 브라우저(/ws/ui), 장치(/ws/device) ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
const uiClients = new Set();
const pushState = () => { if (!uiClients.size) return; const s = JSON.stringify(engine.snapshot()); for (const c of uiClients) if (c.readyState === 1) c.send(s); };
let pend = false; engine.onChange(() => { if (pend) return; pend = true; setTimeout(() => { pend = false; pushState(); }, 50); }); // 알람/제어는 즉시 반영
setInterval(pushState, 500);

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/ws/ui' && isAuthed(req)) return wss.handleUpgrade(req, socket, head, (ws) => { uiClients.add(ws); ws.send(JSON.stringify(engine.snapshot())); ws.on('close', () => uiClients.delete(ws)); ws.on('error', () => {}); });
  if (url.pathname === '/ws/device' && safeEq(url.searchParams.get('token') || '', DEVICE_TOKEN)) {
    const id = url.searchParams.get('room'); if (!engine.rooms.has(id)) { socket.destroy(); return; }
    return wss.handleUpgrade(req, socket, head, (ws) => {
      devices.get(id)?.close(); devices.set(id, ws); engine.devicePatch(id, {}); updateStreamDemand(id);
      ws.isAlive = true; ws.on('pong', () => (ws.isAlive = true));
      const hb = setInterval(() => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; try { ws.ping(); } catch {} }, 10000);
      ws.on('message', (data, isBin) => {
        if (isBin) { engine.devicePatch(id, {}); frames.set(id, data); streamSubs.get(id)?.forEach((s) => pushFrame(s, data)); return; }
        let m; try { m = JSON.parse(data.toString()); } catch { return; }
        if (m.type === 'state') engine.devicePatch(id, m); else if (m.type === 'vision') engine.vision(id, m); // 낙상/재실 판정 입력 지점
      });
      ws.on('close', () => { clearInterval(hb); if (devices.get(id) === ws) devices.delete(id); });
      ws.on('error', () => {});
    });
  }
  socket.destroy();
});

server.listen(PORT, () => {
  console.log(`Rhyturn: http://localhost:${PORT}  (${facility.name}, 호실 ${facility.rooms.length}개, 관리자 ${ADMIN_USER})`);
  if (!process.env.ADMIN_PASS) console.log('⚠ 기본 비밀번호 사용 중. 운영 시 ADMIN_PASS, DEVICE_TOKEN, SESSION_SECRET을 설정하세요.');
});
