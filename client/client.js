import baseConfig from './config.js';

const params = new URLSearchParams(location.search);
const defaultServer = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.hostname || 'localhost'}:8787/ws`;
const serverUrl = params.get('server') || defaultServer;
const $ = id => document.getElementById(id);
const canvas = $('arena');
const ctx = canvas.getContext('2d');
const W = canvas.width, H = canvas.height;
const state = { ws: null, url: '', ticket: '', room: '', name: '', playerId: '', resumeToken: '', phase: 'lobby', players: [], orbs: [], winner: null, remainingMs: 0, endsAt: 0, lastSnapshotAt: 0, keys: new Set(), lastInputSent: 0, toastUntil: 0 };

$('server-copy').textContent = `SERVER TARGET  ${serverUrl}  ·  change with ?server=ws://host:port/ws`;

function setStatus(kind, label) { const el = $('connection-status'); el.className = `status-pill ${kind}`; $('status-label').textContent = label; }
function showError(message) { $('error-box').textContent = message; $('error-box').hidden = false; }
function clearError() { $('error-box').hidden = true; }
function showToast(message, duration = 1800) { $('toast').textContent = message; $('toast').hidden = false; state.toastUntil = performance.now() + duration; }
function hideToastIfReady(now) { if (!state.toastUntil || now < state.toastUntil) return; $('toast').hidden = true; state.toastUntil = 0; }
function send(message) { if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(message)); }
function normalizedRoom(value) { return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8); }

$('join-form').addEventListener('submit', event => { event.preventDefault(); clearError(); state.room = normalizedRoom($('room-input').value); state.name = $('name-input').value.trim().slice(0, 18) || 'PLAYER'; if (state.room.length < 4) return showError('Use a room code with 4–8 letters or numbers.'); connect(); });

// attempts > 1 retries a connection that never opened: a server the matchmaker just started can
// refuse connections (or answer 502 through the TLS proxy) for a few seconds.
function connect(url = serverUrl, attempts = 1) {
  if (state.ws) state.ws.close();
  state.url = url;
  setStatus('busy', 'CONNECTING');
  let ws;
  try { ws = new WebSocket(url); } catch { return showError('That server address is not a valid WebSocket URL.'); }
  state.ws = ws;
  let opened = false;
  ws.addEventListener('open', () => { opened = true; setStatus('online', 'CONNECTED'); send({ type: 'join', room: state.room, name: state.name, ticket: state.ticket || undefined, resumeToken: state.resumeToken || undefined }); });
  ws.addEventListener('message', event => { try { handleMessage(JSON.parse(event.data)); } catch { showError('Received an invalid message from the server.'); } });
  ws.addEventListener('error', () => { if (!opened && attempts > 1) return; setStatus('offline', 'ERROR'); showError(`Could not connect to ${url}. Check that the server is running and reachable.`); });
  ws.addEventListener('close', () => {
    if (!opened && attempts > 1 && state.ws === ws) { $('mm-status').textContent = `Server starting, connecting (${attempts - 1} tries left)...`; return setTimeout(() => connect(url, attempts - 1), 1000); }
    setStatus('offline', 'OFFLINE'); if (!$('game').hidden) showToast('CONNECTION LOST — REFRESH TO RETRY', 100000);
  });
}

// ---- Optional Edgegap matchmaker (config.js or ?mm=&token=) ----------------------------------
// Each player queues as a group of one through @edgegap/sdk. When a match is found the matchmaker
// starts one Edgegap server near the players; the page connects to it with its ticket ID, which
// the server checks against MM_TICKET_IDS. The page's origin must be in the matchmaker config's
// allowed_cors_origins, or the browser blocks the request (CORS error, no HTTP status).
const config = { ...baseConfig };
try { Object.assign(config, (await import('./config.local.js')).default); } catch {}
if (params.get('mm')) config.matchmakerUrl = params.get('mm');
if (params.get('token')) config.matchmakerToken = params.get('token');
if (params.get('profile')) config.matchmakerProfile = params.get('profile');
const MM_STATUS = { SEARCHING: 'Searching for players...', TEAM_FOUND: 'Match found! Starting a server near you...', MATCH_FOUND: 'Match found! Starting a server near you...', HOST_ASSIGNED: 'Server ready, connecting...' };
let mm = null;

if (config.matchmakerUrl && config.matchmakerToken) {
  $('matchmaking').hidden = false;
  $('find-button').addEventListener('click', findMatch);
  $('cancel-button').addEventListener('click', () => { mm?.stopMatchmaking(); mm = null; $('cancel-button').hidden = true; $('find-button').disabled = false; $('mm-status').textContent = 'Cancelled.'; });
  addEventListener('pagehide', () => mm?.stopMatchmaking());
}

async function findMatch() {
  clearError();
  $('find-button').disabled = true; $('cancel-button').hidden = false;
  $('mm-status').textContent = 'Joining queue...';
  try {
    const { matchmaking, getConnectionUrl } = await import('@edgegap/sdk');
    mm?.dispose();
    mm = new matchmaking.GroupAgent({ baseUrl: config.matchmakerUrl, authToken: config.matchmakerToken, logGroupUpdates: false });
    mm.initialize(undefined, ({ current }) => { if (MM_STATUS[current?.status]) $('mm-status').textContent = MM_STATUS[current.status]; });
    mm.createGroup({ profile: config.matchmakerProfile || 'arena', attributes: {}, is_ready: true }, true);
    const assignment = await mm.nextAssignment();
    state.ticket = mm.group.current.ticket_id;
    mm.dispose(); mm = null; // matched: leaving the group now would only get a 409
    // One server per match, so the room code doesn't matter there. TLS Upgrade is on for the
    // port: connect by fqdn (the certificate matches it) and add the server's /ws path.
    state.room = 'MATCH';
    state.name = $('name-input').value.trim().slice(0, 18) || 'PLAYER';
    connect(`${getConnectionUrl(assignment, 'gameport')}/ws`, 10);
  } catch (err) {
    $('mm-status').textContent = '';
    showError(`Matchmaking failed: ${err?.message ?? err}`);
  } finally {
    $('find-button').disabled = false; $('cancel-button').hidden = true;
  }
}

function handleMessage(message) {
  if (message.type === 'hello') return;
  if (message.type === 'joined') {
    state.playerId = message.playerId; state.resumeToken = message.resumeToken || state.resumeToken; state.phase = 'lobby';
    sessionStorage.setItem(`orb-arena:${state.room}:resume`, state.resumeToken);
    $('lobby').hidden = true; $('game').hidden = false; $('room-label').textContent = state.room;
    showToast(message.resumed ? 'RECONNECTED' : 'ROOM JOINED', 1200);
    return;
  }
  if (message.type === 'match_start') { state.phase = 'match'; state.endsAt = message.endsAt; state.remainingMs = message.matchMs; showToast('MATCH START', 1100); return; }
  if (message.type === 'snapshot') { state.phase = message.phase; state.players = message.players || []; state.orbs = message.orbs || []; state.winner = message.winner; state.remainingMs = message.remainingMs || 0; state.endsAt = state.remainingMs ? Date.now() + state.remainingMs : 0; state.lastSnapshotAt = performance.now(); return; }
  if (message.type === 'score') { const player = state.players.find(p => p.id === message.playerId); if (player) player.score = message.score; if (message.playerId === state.playerId) showToast(`+${message.value} ORB`, 650); return; }
  if (message.type === 'match_end') { state.phase = 'results'; state.winner = message.winner; state.remainingMs = 0; const winnerText = message.winner ? `${message.winner.name} WINS` : 'MATCH COMPLETE'; showToast(winnerText, 100000); return; }
  if (message.type === 'error') { showError(message.message || message.code || 'Server error.'); setStatus('offline', 'ERROR'); }
}

function player() { return state.players.find(p => p.id === state.playerId); }
function inputVector() { let x = 0, y = 0; if (state.keys.has('ArrowLeft') || state.keys.has('a')) x -= 1; if (state.keys.has('ArrowRight') || state.keys.has('d')) x += 1; if (state.keys.has('ArrowUp') || state.keys.has('w')) y -= 1; if (state.keys.has('ArrowDown') || state.keys.has('s')) y += 1; return { x, y }; }
function sendInput(now) { if (now - state.lastInputSent < 50 || state.phase !== 'match') return; state.lastInputSent = now; const v = inputVector(); send({ type: 'input', x: v.x, y: v.y, angle: Math.atan2(v.y, v.x) || 0 }); }
function dash() { if (state.phase === 'match') send({ type: 'dash' }); }

window.addEventListener('keydown', event => { const key = event.key.length === 1 ? event.key.toLowerCase() : event.key; if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' ','w','a','s','d'].includes(key)) event.preventDefault(); if (key === ' ') return dash(); if (key === 'r' && state.phase === 'results') return send({ type: 'restart' }); state.keys.add(key); });
window.addEventListener('keyup', event => { const key = event.key.length === 1 ? event.key.toLowerCase() : event.key; state.keys.delete(key); });
document.querySelectorAll('.mobile-controls button').forEach(button => { const key = button.dataset.key; const down = event => { event.preventDefault(); if (key === 'Space') dash(); else state.keys.add(key); }; const up = event => { event.preventDefault(); state.keys.delete(key); }; button.addEventListener('pointerdown', down); button.addEventListener('pointerup', up); button.addEventListener('pointercancel', up); button.addEventListener('pointerleave', up); });

function roundedRect(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }
function glowCircle(x, y, radius, color, alpha = 1) { ctx.save(); ctx.globalAlpha = alpha; ctx.shadowBlur = radius * 2.5; ctx.shadowColor = color; ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill(); ctx.restore(); }
function goalForSeat(seat) { return [{x:70,y:450},{x:1530,y:450},{x:800,y:70},{x:800,y:830}][seat] || {x:800,y:450}; }
function drawArena(now) {
  const t = now / 1000; ctx.clearRect(0, 0, W, H);
  const bg = ctx.createRadialGradient(W/2, H/2, 0, W/2, H/2, W*.7); bg.addColorStop(0, '#161944'); bg.addColorStop(1, '#050611'); ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(117,133,255,.08)'; ctx.lineWidth = 1; for (let x=70; x<W-70; x+=80) { ctx.beginPath(); ctx.moveTo(x,70); ctx.lineTo(x,H-70); ctx.stroke(); } for (let y=70; y<H-70; y+=80) { ctx.beginPath(); ctx.moveTo(70,y); ctx.lineTo(W-70,y); ctx.stroke(); }
  ctx.strokeStyle = 'rgba(92,246,255,.28)'; ctx.lineWidth = 2; roundedRect(70,70,W-140,H-140,22); ctx.stroke();
  [{seat:0,color:'#5cf6ff'},{seat:1,color:'#ff5ccf'},{seat:2,color:'#b8ff5c'},{seat:3,color:'#ffd45c'}].forEach(g => { const p = goalForSeat(g.seat); ctx.save(); ctx.globalAlpha=.32; ctx.strokeStyle=g.color; ctx.shadowBlur=20; ctx.shadowColor=g.color; ctx.lineWidth=3; ctx.beginPath(); ctx.arc(p.x,p.y,54,0,Math.PI*2); ctx.stroke(); ctx.globalAlpha=.08; ctx.fillStyle=g.color; ctx.beginPath(); ctx.arc(p.x,p.y,44,0,Math.PI*2); ctx.fill(); ctx.restore(); });
  for (const orb of state.orbs) { const pulse = 1 + Math.sin(t*5 + orb.x*.01)*.1; glowCircle(orb.x, orb.y, orb.radius * pulse, '#f4f7ff', .2); glowCircle(orb.x, orb.y, orb.radius * .45, '#ffffff', 1); }
  for (const p of state.players) { const stunned = p.stunnedUntil && p.stunnedUntil > Date.now(); const color = p.color || '#fff'; ctx.save(); ctx.translate(p.x,p.y); ctx.rotate(p.angle || 0); ctx.globalAlpha = stunned ? .55 : 1; ctx.shadowBlur = p.id === state.playerId ? 30 : 18; ctx.shadowColor = color; ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(28,0); ctx.lineTo(-18,-16); ctx.lineTo(-10,0); ctx.lineTo(-18,16); ctx.closePath(); ctx.fill(); ctx.fillStyle = '#080a14'; ctx.beginPath(); ctx.arc(3,0,7,0,Math.PI*2); ctx.fill(); ctx.restore(); if (stunned) { ctx.strokeStyle = '#fff'; ctx.globalAlpha=.7; ctx.beginPath(); ctx.arc(p.x,p.y,32 + Math.sin(t*12)*4,0,Math.PI*2); ctx.stroke(); } if (p.id === state.playerId) { ctx.strokeStyle = color; ctx.globalAlpha=.28; ctx.beginPath(); ctx.arc(p.x,p.y,40,0,Math.PI*2); ctx.stroke(); } }
}

function renderScoreboard() { $('scoreboard').innerHTML = state.players.slice().sort((a,b) => b.score-a.score).map(p => `<div class="score-card ${p.id === state.playerId ? 'me' : ''}"><div class="score-top"><span><i class="score-swatch" style="color:${p.color};background:${p.color}"></i>${escapeHtml(p.name)}</span><span>${p.connected ? 'LIVE' : '—'}</span></div><div class="score-value">${p.score}</div></div>`).join(''); }
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function updateHud() { const remaining = state.phase === 'match' ? Math.max(0, state.endsAt - Date.now()) : 0; const sec = Math.ceil(remaining / 1000); $('timer').textContent = `${String(Math.floor(sec/60)).padStart(2,'0')}:${String(sec%60).padStart(2,'0')}`; $('phase-label').textContent = state.phase === 'match' ? 'PUSH THE ORBS' : state.phase === 'results' ? 'MATCH COMPLETE · PRESS R TO REMATCH' : 'WAITING FOR RIVALS'; renderScoreboard(); }
function frame(now) { sendInput(now); drawArena(now); updateHud(); hideToastIfReady(now); requestAnimationFrame(frame); }
// Close the socket cleanly when the page goes away, so the server sees the player leave at once
// (otherwise only its 30 s ping notices, and an empty Edgegap server runs that much longer).
addEventListener('pagehide', () => state.ws?.close(1001, 'page closed'));
const savedRoom = normalizedRoom(params.get('room')); if (savedRoom) $('room-input').value = savedRoom;
state.resumeToken = sessionStorage.getItem(`orb-arena:${$('room-input').value}`) || '';
requestAnimationFrame(frame);
