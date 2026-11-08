// Rhyturn 판정/알람 엔진 — 브라우저(데모)와 Node(서버)에서 동일하게 동작 (설계서 §3~§4)
// RAW → FEATURE → STATE → EVENT → 합의 게이트 → ALERT. 이 MVP는 카메라·조도·장치 상태 기반 규칙만 구현한다.
(function (root) {
  // 알람 등급 6단계 (packages/tokens/status.ts 대응): 색은 상태만 표현, 도형·좌측바·문구로 3중 인코딩
  const LEVELS = {
    L4: { rank: 4, glyph: '▲', name: '긴급', en: 'CRITICAL', bar: 6 },
    L3: { rank: 3, glyph: '●', name: '주의', en: 'WARNING', bar: 4 },
    L2: { rank: 2, glyph: '◆', name: '관찰', en: 'WATCH', bar: 3 },
    L1: { rank: 1, glyph: '▬', name: '안정', en: 'NORMAL', bar: 2 },
    L0: { rank: 0, glyph: '○', name: '부재', en: 'ABSENT', bar: 2 },
    SYS: { rank: -1, glyph: '▣', name: '점검', en: 'FAULT', bar: 3 },
  };
  // 케어 이벤트 (설계서 §3). 이 MVP 구현 범위: E-01(장시간 부재), E-02, E-03, E-07
  const EVENTS = {
    'E-01': { level: 'L3', title: '침대 이탈·장시간 부재' },
    'E-02': { level: 'L4', title: '낙상 의심' },
    'E-03': { level: 'L3', title: '장시간 무동작' },
    'E-07': { level: 'L2', title: '야간 각성' },
  };
  const ACTIVE = ['NEW', 'ACKNOWLEDGED', 'DISPATCHED'];
  const NEXT = { // 알람 상태 흐름: NEW → ACKNOWLEDGED → DISPATCHED → RESOLVED → HANDED_OVER, 분기 FALSE_ALARM
    ack: { from: ['NEW'], to: 'ACKNOWLEDGED' },
    dispatch: { from: ['NEW', 'ACKNOWLEDGED'], to: 'DISPATCHED' },
    resolve: { from: ['NEW', 'ACKNOWLEDGED', 'DISPATCHED'], to: 'RESOLVED' },
    'false-alarm': { from: ['NEW', 'ACKNOWLEDGED', 'DISPATCHED'], to: 'FALSE_ALARM' },
  };
  const RHYTHMS = [
    ['기상 유도', 'Dawn', [22, 24, 4, 26]], ['아침 각성', 'Morning', [76, 23, 27, 26]], ['주간 피크', 'Daytime', [132, 33, 61, 28]],
    ['정오', 'Midday', [106, 26, 49, 22]], ['오후 활동', 'Afternoon', [89, 26, 32, 30]], ['일몰 전환', 'Wind-down', [51, 31, 12, 31]],
    ['저녁', 'Evening', [26, 23, 6, 23]], ['취침 준비', 'Pre-sleep', [11, 13, 2, 13]], ['야간 수면', 'Night', [1, 1, 0, 1]], ['야간 이동', 'Night nav', [1, 5, 0, 5]],
  ].map(([name, en, ch]) => ({ name, en, ch })); // ch: D0 Green, D1 Yellow, D2 Blue, D3 Red
  const COOLDOWN_MS = 180e3, ESCALATE_MS = 180e3, OFFLINE_MS = 15e3, L2_AUTOCLOSE_MS = 300e3;

  function createEngine(facility, opts = {}) {
    const SIM = opts.sim !== false;
    let settings = { absenceMinutes: 30, shadowMode: false, soundOn: true, ...(opts.settings || {}) };
    const rooms = new Map(), alerts = [], transitions = [], events = [], faults = [];
    const target = new Map(), lastRaised = new Map();
    let aseq = 0, fseq = 0, onChange = () => {};
    const now = () => Date.now();
    const changed = () => onChange();

    const initR = [2, 2, 3, 2, 1, 4, 2, 8, 2, 5, 3];
    const lux = (r) => Math.max(0, Math.round((r.ch[0] * .9 + r.ch[1] * .6 + r.ch[2] * .5 + r.ch[3] * .3) * 1.1 + (Math.random() - .5) * 4));
    facility.rooms.forEach((fr, i) => {
      const rh = initR[i % initR.length];
      const r = { id: fr.id, name: fr.name, floor: fr.floor, zone: fr.zone, unitId: fr.units[0], beds: fr.beds, mode: 'sim', online: SIM, present: SIM,
        absentSince: null, lastSeen: now(), rhythm: rh, ch: [...RHYTHMS[rh].ch], lux: 0, luxHist: [], fps: 0, rssi: null, fw: null, fall: false, lastMotion: now() };
      r.lux = lux(r); for (let k = 0; k < 40; k++) r.luxHist.push(r.lux + Math.round((Math.random() - .5) * 6));
      rooms.set(r.id, r);
    });

    function addEvent(room, type, msg, extra) { const e = { t: now(), room, type, msg, ...extra }; events.unshift(e); if (events.length > 300) events.length = 300; changed(); return e; }
    function transition(a, state, actor) { a.state = state; const tr = { alertId: a.id, room: a.room, state, actor, t: now() }; a.transitions.push(tr); transitions.unshift(tr); if (transitions.length > 500) transitions.length = 500; }
    const roomName = (id) => rooms.get(id)?.name || id;

    function raise(room, code, extra = {}) {
      const def = EVENTS[code], key = room.id + code;
      if (now() - (lastRaised.get(key) || 0) < COOLDOWN_MS) return null;                  // 쿨다운 180초
      lastRaised.set(key, now());
      if (settings.shadowMode) { addEvent(room.id, 'shadow', `[Shadow] ${room.name} ${def.title} (알림 미발송, 로그만 기록)`, { code, level: def.level }); return null; }
      const a = { id: 'A-' + String(++aseq).padStart(4, '0'), room: room.id, code, level: def.level, title: def.title, created: now(), escalated: false, state: 'NEW', transitions: [], ...extra };
      transition(a, 'NEW', 'system'); alerts.unshift(a);
      addEvent(room.id, 'alert', `${room.name} ${code} ${def.title} (${def.level})`, { alertId: a.id, level: def.level });
      return a;
    }
    function act(id, action, actor = 'admin') {
      const a = alerts.find((x) => x.id === id), rule = NEXT[action];
      if (!a || !rule || !rule.from.includes(a.state)) return { error: '허용되지 않는 상태 전이' };
      if (action === 'dispatch' && a.state === 'NEW') transition(a, 'ACKNOWLEDGED', actor);
      transition(a, rule.to, actor);
      if (rule.to === 'RESOLVED' || rule.to === 'FALSE_ALARM') { const r = rooms.get(a.room); if (a.code === 'E-02' && r) r.fall = false; }
      addEvent(a.room, 'alert', `${roomName(a.room)} ${a.title} → ${rule.to}`, { alertId: a.id }); return { ok: true };
    }
    function handover(actor = 'admin') { let n = 0; alerts.forEach((a) => { if (a.state === 'RESOLVED') { transition(a, 'HANDED_OVER', actor); n++; } }); if (n) addEvent('all', 'info', `근무 인계: 해소 알람 ${n}건 인계`); return { ok: true, count: n }; }

    function setOnline(r, on, why) {
      if (r.online === on) return; r.online = on; r.lastSeen = now();
      if (!on) { faults.unshift({ id: 'F-' + String(++fseq).padStart(3, '0'), code: 'S-01', room: r.id, title: '유닛 오프라인', opened: now(), closed: null }); addEvent(r.id, 'fault', `${r.name} S-01 유닛 오프라인${why ? ' (' + why + ')' : ''}`); }
      else { const f = faults.find((x) => x.room === r.id && !x.closed); if (f) f.closed = now(); addEvent(r.id, 'info', `${r.name} 유닛 연결됨`); }
    }
    function setPresent(r, p) {
      r.present = p;
      if (p) { r.absentSince = null; r.lastMotion = now(); } else if (!r.absentSince) r.absentSince = now();
    }

    // 장치(ESP32)에서 들어오는 값
    function devicePatch(id, p) {
      const r = rooms.get(id); if (!r) return; r.mode = 'device'; r.lastSeen = now();
      if (Array.isArray(p.ch)) r.ch = p.ch; if (p.rhythm !== undefined) r.rhythm = p.rhythm;
      if (typeof p.lux === 'number') r.lux = p.lux; if (p.fps !== undefined) r.fps = p.fps; if (p.rssi !== undefined) r.rssi = p.rssi; if (p.fw) r.fw = p.fw;
      if (!r.online) { setOnline(r, true); if (r.present === false && !r.absentSince) setPresent(r, true); }
    }
    function vision(id, v) { const r = rooms.get(id); if (!r) return; setPresent(r, !!v.present); if (v.fall) { r.fall = true; raise(r, 'E-02'); } }

    // 조명 제어: 시뮬레이션 호실은 즉시 반영, 장치 호실은 전송할 메시지를 반환
    function control(id, cmd) {
      const r = rooms.get(id); if (!r) return { error: 'no room' };
      let msg;
      if (cmd.type === 'rhythm') {
        if (!(cmd.id >= -1 && cmd.id <= 9)) return { error: 'bad id' };
        r.rhythm = cmd.id; target.set(id, cmd.id < 0 ? [0, 0, 0, 0] : [...RHYTHMS[cmd.id].ch]); msg = { type: 'rhythm', id: cmd.id };
        addEvent(id, 'control', `${r.name} 조명: ${cmd.id < 0 ? '소등' : RHYTHMS[cmd.id].name}`);
      } else if (cmd.type === 'set') {
        if (!(cmd.ch >= 0 && cmd.ch <= 3 && cmd.val >= 0 && cmd.val <= 255)) return { error: 'bad' };
        r.rhythm = -2; const t = target.get(id) || [...r.ch]; t[cmd.ch] = cmd.val; target.set(id, t); msg = { type: 'set', ch: cmd.ch, val: cmd.val };
      } else return { error: 'bad cmd' };
      changed(); return { ok: true, device: r.mode === 'device', msg };
    }

    // 데모/시험용 이벤트 주입
    function simEvent(id, type) {
      const r = rooms.get(id); if (!r) return { error: 'no room' };
      if (type === 'fall') { r.fall = true; setPresent(r, true); raise(r, 'E-02'); }
      else if (type === 'absence') { setPresent(r, false); r.absentSince = now() - settings.absenceMinutes * 60e3 - 1000; }
      else if (type === 'nomotion') { setPresent(r, true); r.still = true; r.lastMotion = now() - 6 * 60e3; }
      else if (type === 'watch') raise(r, 'E-07');
      else if (type === 'offline') { setOnline(r, !r.online, '시험'); }
      changed(); return { ok: true };
    }

    function tick() {
      const t = now();
      rooms.forEach((r) => {
        if (r.mode === 'device' && r.online && t - r.lastSeen > OFFLINE_MS) setOnline(r, false, '응답 없음');
        if (r.mode === 'sim' && r.online) {
          r.lastSeen = t;
          const tg = target.get(r.id); if (tg) for (let i = 0; i < 4; i++) { const d = tg[i] - r.ch[i]; r.ch[i] += Math.sign(d) * Math.min(Math.abs(d), 12); }
          r.lux = lux(r); r.fps = 8 + Math.round(Math.random() * 2); r.rssi = -50 - Math.round(Math.random() * 15);
          if (r.present && !r.still) r.lastMotion = t;
          if (SIM && !r.fall) {
            if (r.present && Math.random() < .0008) setPresent(r, false);
            else if (!r.present && Math.random() < .03 && t - r.absentSince < 3 * 60e3) setPresent(r, true);
            if (r.present && Math.random() < .0004) raise(r, 'E-07');
          }
        }
        if (r.online && !r.present && r.absentSince && t - r.absentSince > settings.absenceMinutes * 60e3) raise(r, 'E-01');
        if (r.online && r.present && t - r.lastMotion > 5 * 60e3 && r.mode === 'sim') { raise(r, 'E-03'); r.still = false; r.lastMotion = t; }
      });
      alerts.forEach((a) => {
        if (a.level === 'L4' && a.state === 'NEW' && !a.escalated && t - a.created > ESCALATE_MS) { a.escalated = true; a.transitions.push({ alertId: a.id, room: a.room, state: 'ESCALATED', actor: 'system', t }); transitions.unshift(a.transitions[a.transitions.length - 1]); addEvent(a.room, 'alert', `${roomName(a.room)} ${a.title} 3분 미확인 → 에스컬레이션`, { alertId: a.id }); }
        if (a.level === 'L2' && ACTIVE.includes(a.state) && t - a.created > L2_AUTOCLOSE_MS) transition(a, 'RESOLVED', 'system');
      });
    }
    let tickN = 0;
    function trackHist() { rooms.forEach((r) => { r.luxHist.push(r.lux); if (r.luxHist.length > 90) r.luxHist.shift(); }); }

    function snapshot() {
      const act_ = alerts.filter((a) => ACTIVE.includes(a.state)), recent = alerts.filter((a) => !ACTIVE.includes(a.state)).slice(0, 40);
      return { type: 'state', t: now(), settings, alerts: [...act_, ...recent].map((a) => ({ ...a, transitions: undefined, last: a.transitions[a.transitions.length - 1] })),
        faults: faults.slice(0, 40), rooms: [...rooms.values()].map((r) => ({ ...r, ch: r.ch.map(Math.round), luxHist: r.luxHist.slice(-60) })) };
    }
    return { rooms, snapshot, tick, trackHist, act, handover, devicePatch, vision, control, simEvent, raise,
      log: () => ({ transitions: transitions.slice(0, 150), events: events.slice(0, 150) }),
      getSettings: () => settings, setSettings: (s) => { settings = { absenceMinutes: Math.min(1440, Math.max(1, +s.absenceMinutes || 30)), shadowMode: !!s.shadowMode, soundOn: !!s.soundOn }; changed(); return settings; },
      onChange: (f) => (onChange = f), setOnline, addEvent, sim: SIM };
  }
  const api = { createEngine, LEVELS, EVENTS, RHYTHMS, ACTIVE };
  if (typeof module !== 'undefined') module.exports = api; else root.RhyEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
