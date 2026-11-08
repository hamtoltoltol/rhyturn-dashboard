// 데모용 전송 계층: 서버 없이 브라우저 안에서 engine.js를 직접 구동 (화면·기능 확인용)
window.DEMO = (() => {
  const E = window.RhyEngine, facility = window.DEMO_FACILITY;
  const eng = E.createEngine(facility, { sim: true });
  eng.setOnline(eng.rooms.get('204'), false, '시연');
  setInterval(() => eng.tick(), 500); setInterval(() => eng.trackHist(), 2000);
  async function api(path, b) {
    await new Promise((r) => setTimeout(r, 10)); let m;
    if (path === '/api/meta') return { facility, rhythms: E.RHYTHMS, sim: true, maxLive: 4, deviceRooms: [] };
    if (path === '/api/log') return eng.log();
    if ((m = path.match(/^\/api\/alerts\/(A-\d+)\/(.+)$/))) return eng.act(m[1], m[2], 'admin');
    if (path === '/api/handover') return eng.handover('admin');
    if ((m = path.match(/^\/api\/rooms\/(\d+)\/(rhythm|set)$/))) return eng.control(m[1], m[2] === 'rhythm' ? { type: 'rhythm', id: b.id } : { type: 'set', ch: b.ch, val: b.val });
    if (path === '/api/settings') return eng.setSettings(b);
    if (path === '/api/sim') return eng.simEvent(String(b.room), b.type);
    return {};
  }
  function start(f) { const push = () => f(JSON.parse(JSON.stringify(eng.snapshot()))); eng.onChange(() => setTimeout(push, 30)); push(); setInterval(push, 500); }
  return { api, start };
})();
