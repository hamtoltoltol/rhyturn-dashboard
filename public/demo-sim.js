// 브라우저 안에서 동작하는 데모용 시뮬레이터 (서버/ESP32 없이 화면·기능 확인용)
window.DEMO = (() => {
  const RH = [['기상 유도','Dawn',[22,24,4,26]],['아침 각성','Morning',[76,23,27,26]],['주간 피크','Daytime',[132,33,61,28]],['정오','Midday',[106,26,49,22]],['오후 활동','Afternoon',[89,26,32,30]],['일몰 전환','Wind-down',[51,31,12,31]],['저녁','Evening',[26,23,6,23]],['취침 준비','Pre-sleep',[11,13,2,13]],['야간 수면','Night',[1,1,0,1]],['야간 이동','Night nav',[1,5,0,5]]];
  const RHYTHMS = RH.map(([name, en, ch]) => ({ name, en, ch }));
  let settings = { absenceMinutes: 30, soundOn: true }, events = [], cb = () => {};
  const rooms = [], target = {};
  const init = [2, 2, 3, 2, 1, 4, 2, 8, 2, 5];
  const lux = (r) => Math.max(0, Math.round((r.ch[0]*.9 + r.ch[1]*.6 + r.ch[2]*.5 + r.ch[3]*.3) * 1.1 + (Math.random() - .5) * 4));
  for (let i = 1; i <= 10; i++) { const r = { id: String(100 + i), name: (100 + i) + '호', mode: 'sim', online: true, rhythm: init[i-1], ch: [...RHYTHMS[init[i-1]].ch], luxHist: [], present: true, absentSince: null, fps: 9, rssi: -55, alert: null, fallPose: false, lastSeen: Date.now() }; r.lux = lux(r); rooms.push(r); }
  rooms[6].online = false;
  const get = (id) => rooms.find((r) => r.id === id);
  const ev = (room, type, msg) => { const e = { t: Date.now(), room, type, msg }; events.unshift(e); cb({ type: 'event', event: e }); };
  const raise = (r, type) => { if (r.alert?.type === type) return; r.alert = { type, since: Date.now(), acked: false }; ev(r.id, type, type === 'fall' ? `${r.name} 낙상 의심 감지` : `${r.name} 장시간 부재 감지`); };
  const present = (r, p, fall) => { r.present = p; if (p) { r.absentSince = null; if (r.alert?.type === 'absence') { ev(r.id, 'info', `${r.name} 경고 해제 (재실 확인)`); r.alert = null; } } else if (!r.absentSince) r.absentSince = Date.now(); if (fall) raise(r, 'fall'); };
  setInterval(() => rooms.forEach((r) => {
    if (!r.online) return;
    const t = target[r.id]; if (t) for (let i = 0; i < 4; i++) { const d = t[i] - r.ch[i]; r.ch[i] += Math.sign(d) * Math.min(Math.abs(d), 12); }
    r.lux = lux(r); r.fps = 8 + Math.round(Math.random() * 2); r.rssi = -50 - Math.round(Math.random() * 15);
    if (!r.present && r.absentSince && Date.now() - r.absentSince > settings.absenceMinutes * 60e3) raise(r, 'absence');
    if (Math.random() < .002 && r.present && !r.alert) present(r, false); else if (!r.present && !r.alert && Math.random() < .06) present(r, true);
  }), 500);
  setInterval(() => rooms.forEach((r) => { r.luxHist.push(r.lux); if (r.luxHist.length > 90) r.luxHist.shift(); }), 2000);
  rooms.forEach((r) => { for (let i = 0; i < 30; i++) r.luxHist.push(r.lux + Math.round((Math.random() - .5) * 6)); });
  const rhy = (r, id) => { r.rhythm = id; target[r.id] = id < 0 ? [0,0,0,0] : [...RHYTHMS[id].ch]; };
  const label = (id) => id < 0 ? '소등' : RHYTHMS[id].name;
  async function api(path, b) {
    await new Promise((res) => setTimeout(res, 15)); let m;
    if (path === '/api/meta') return { rhythms: RHYTHMS, rooms: 10, sim: true };
    if (path === '/api/events') return events.slice(0, 100);
    if ((m = path.match(/^\/api\/rooms\/(\d+)\/rhythm$/))) { const r = get(m[1]); rhy(r, b.id); ev(r.id, 'control', `${r.name} 리듬: ${label(b.id)}`); return { ok: true }; }
    if ((m = path.match(/^\/api\/rooms\/(\d+)\/set$/))) { const r = get(m[1]); r.rhythm = -2; const t = target[r.id] || [...r.ch]; t[b.ch] = b.val; target[r.id] = t; return { ok: true }; }
    if ((m = path.match(/^\/api\/rooms\/(\d+)\/ack$/))) { const r = get(m[1]); if (r.alert) { r.alert.acked = true; ev(r.id, 'info', `${r.name} 경고 확인 처리`); } return { ok: true }; }
    if ((m = path.match(/^\/api\/rooms\/(\d+)\/resolve$/))) { const r = get(m[1]); r.fallPose = false; if (!r.present) present(r, true); if (r.alert) { ev(r.id, 'info', `${r.name} 경고 해제 (관리자 조치 완료)`); r.alert = null; } return { ok: true }; }
    if (path === '/api/all/rhythm') { rooms.forEach((r) => r.online && rhy(r, b.id)); ev('all', 'control', `전체 호실 리듬: ${label(b.id)}`); return { ok: true }; }
    if (path === '/api/settings') { settings = { absenceMinutes: Math.min(1440, Math.max(1, +b.absenceMinutes || 30)), soundOn: !!b.soundOn }; return settings; }
    if (path === '/api/sim/event') { const r = get(String(b.room)); if (b.type === 'fall') { r.fallPose = true; present(r, true, true); } if (b.type === 'absence') { present(r, false); r.absentSince = Date.now() - settings.absenceMinutes * 60e3 - 1000; } if (b.type === 'offline') { r.online = !r.online; ev(r.id, r.online ? 'info' : 'offline', `${r.name} ${r.online ? '장치 재연결' : '장치 연결 끊김'}`); } return { ok: true }; }
    return {};
  }
  function start(f) { cb = f; const push = () => f({ type: 'rooms', rooms: JSON.parse(JSON.stringify(rooms)).map((r) => ({ ...r, ch: r.ch.map(Math.round) })), settings, t: Date.now() }); push(); setInterval(push, 500); }
  return { api, start };
})();
