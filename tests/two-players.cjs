// Two players join one room, move for N seconds; counts snapshots each receives.
const WebSocket = require(require.resolve('ws', { paths: [__dirname + '/../server'] }));
const url = process.argv[2] || 'ws://127.0.0.1:8787/ws';
const secs = Number(process.argv[3] || 3);
const room = 'TEST' + Math.floor(Math.random() * 900 + 100);
const stats = [0, 1].map(() => ({ snaps: 0, start: 0, lastX: null, firstX: null }));
const socks = [0, 1].map(i => {
  const ws = new WebSocket(url);
  ws.on('open', () => ws.send(JSON.stringify({ type: 'join', room, name: 'BOT' + i })));
  ws.on('message', d => { const m = JSON.parse(d); const s = stats[i];
    if (m.type === 'match_start') s.start++;
    if (m.type === 'snapshot') { s.snaps++; const me = m.players[i]; if (me) { if (s.firstX === null) s.firstX = me.x; s.lastX = me.x; } } });
  ws.on('error', e => console.error('ws error', i, e.message));
  return ws;
});
const mover = setInterval(() => socks.forEach(ws => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'input', x: 1, y: 0, angle: 0 }))), 50);
setTimeout(() => { clearInterval(mover); console.log(JSON.stringify({ url, room, secs, stats })); socks.forEach(s => s.close()); setTimeout(() => process.exit(0), 300); }, secs * 1000);
