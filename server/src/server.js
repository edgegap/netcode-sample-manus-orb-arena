#!/usr/bin/env node
'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const edgegap = require('./edgegap');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const TICK_RATE = 30;
const SNAPSHOT_RATE = 15;
const MATCH_MS = 180000;
const ROOM_TTL_MS = 15 * 60 * 1000;
const MAX_ROOMS = 256;
const MAX_CONNECTIONS = 2048;
const MAX_ORBS = 18;
const ARENA = { width: 1600, height: 900, margin: 70 };
const BUILD = 'orb-arena-0.1';

const COLORS = ['#5cf6ff', '#ff5ccf', '#b8ff5c', '#ffd45c'];
const rooms = new Map();
const connections = new Set();

function id(prefix = '') { return prefix + crypto.randomBytes(5).toString('hex'); }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function finite(value, fallback = 0) { return Number.isFinite(value) ? value : fallback; }
function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function safeRoomCode(value) { return typeof value === 'string' && /^[A-Z0-9]{4,8}$/.test(value); }

function makeRoom(code) {
  return {
    code,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    phase: 'lobby',
    startedAt: null,
    endsAt: null,
    revision: 0,
    players: new Map(),
    orbs: [],
    lastOrbAt: 0,
    winner: null
  };
}

function spawnOrb(room) {
  if (room.orbs.length >= MAX_ORBS) return;
  const edge = Math.floor(Math.random() * 4);
  const point = edge === 0 ? { x: ARENA.margin, y: ARENA.margin + Math.random() * (ARENA.height - ARENA.margin * 2) }
    : edge === 1 ? { x: ARENA.width - ARENA.margin, y: ARENA.margin + Math.random() * (ARENA.height - ARENA.margin * 2) }
      : edge === 2 ? { x: ARENA.margin + Math.random() * (ARENA.width - ARENA.margin * 2), y: ARENA.margin }
        : { x: ARENA.margin + Math.random() * (ARENA.width - ARENA.margin * 2), y: ARENA.height - ARENA.margin };
  room.orbs.push({ id: id('o_'), x: point.x, y: point.y, vx: 0, vy: 0, radius: 16, value: 1 });
}

function playerView(player) {
  return {
    id: player.id,
    name: player.name,
    color: player.color,
    seat: player.seat,
    x: Math.round(player.x * 10) / 10,
    y: Math.round(player.y * 10) / 10,
    angle: Math.round(player.angle * 1000) / 1000,
    score: player.score,
    stunnedUntil: player.stunnedUntil,
    dashUntil: player.dashUntil,
    connected: Boolean(player.ws && player.ws.readyState === 1)
  };
}

function roomView(room) {
  const now = Date.now();
  return {
    type: 'snapshot',
    build: BUILD,
    room: room.code,
    phase: room.phase,
    revision: room.revision,
    serverTime: now,
    remainingMs: room.phase === 'match' ? Math.max(0, room.endsAt - now) : 0,
    players: [...room.players.values()].map(playerView),
    orbs: room.orbs.map(orb => ({ id: orb.id, x: Math.round(orb.x * 10) / 10, y: Math.round(orb.y * 10) / 10, vx: Math.round(orb.vx * 10) / 10, vy: Math.round(orb.vy * 10) / 10, radius: orb.radius, value: orb.value })),
    winner: room.winner
  };
}

function send(ws, payload) {
  if (ws.readyState === 1) ws.send(JSON.stringify(payload));
}
function broadcast(room, payload) {
  for (const player of room.players.values()) if (player.ws) send(player.ws, payload);
}
function playersOnline() { let n = 0; for (const ws of connections) if (ws.player) n++; return n; }
function broadcastSnapshot(room) { room.revision += 1; broadcast(room, roomView(room)); }

function resetMatch(room) {
  edgegap.matchStarted();
  room.phase = 'match';
  room.startedAt = Date.now();
  room.endsAt = room.startedAt + MATCH_MS;
  room.winner = null;
  room.orbs = [];
  room.lastOrbAt = 0;
  for (const p of room.players.values()) {
    p.score = 0; p.stunnedUntil = 0; p.dashUntil = 0; p.cooldownUntil = 0;
    const angle = (p.seat / 4) * Math.PI * 2;
    p.x = ARENA.width / 2 + Math.cos(angle) * 280;
    p.y = ARENA.height / 2 + Math.sin(angle) * 220;
  }
  for (let i = 0; i < 8; i++) spawnOrb(room);
}

function maybeStart(room) {
  if (room.phase === 'lobby' && room.players.size >= 2) {
    resetMatch(room);
    broadcast(room, { type: 'match_start', endsAt: room.endsAt, matchMs: MATCH_MS });
  }
}

function finishMatch(room) {
  edgegap.matchEnded();
  room.phase = 'results';
  const standings = [...room.players.values()].sort((a, b) => b.score - a.score);
  room.winner = standings[0] ? { id: standings[0].id, name: standings[0].name, score: standings[0].score } : null;
  broadcast(room, { type: 'match_end', winner: room.winner, standings: standings.map(p => ({ id: p.id, name: p.name, score: p.score })) });
}

function findSpawnSeat(room) {
  const used = new Set([...room.players.values()].map(p => p.seat));
  return [0, 1, 2, 3].find(seat => !used.has(seat));
}

function createPlayer(room, ws, name, resumeToken) {
  const seat = findSpawnSeat(room);
  if (seat === undefined) return null;
  const player = {
    id: id('p_'), resumeToken: resumeToken || id('r_'), ws, seat,
    name: String(name || `DRONE ${seat + 1}`).slice(0, 18), color: COLORS[seat],
    x: ARENA.width / 2, y: ARENA.height / 2, angle: 0, score: 0,
    input: { x: 0, y: 0, angle: 0 }, lastInputAt: 0,
    stunnedUntil: 0, dashUntil: 0, cooldownUntil: 0
  };
  room.players.set(player.id, player);
  ws.player = player;
  ws.room = room;
  send(ws, { type: 'joined', build: BUILD, room: room.code, playerId: player.id, resumeToken: player.resumeToken, seat: player.seat, arena: ARENA, matchMs: MATCH_MS });
  edgegap.connectedChanged(playersOnline());
  broadcastSnapshot(room);
  maybeStart(room);
  return player;
}

function reconnectPlayer(room, ws, token) {
  const player = [...room.players.values()].find(p => p.resumeToken === token);
  if (!player) return null;
  if (player.ws && player.ws !== ws) player.ws.close(4002, 'replaced');
  player.ws = ws; ws.player = player; ws.room = room;
  send(ws, { type: 'joined', build: BUILD, room: room.code, playerId: player.id, resumeToken: player.resumeToken, seat: player.seat, arena: ARENA, matchMs: MATCH_MS, resumed: true });
  edgegap.connectedChanged(playersOnline());
  broadcastSnapshot(room);
  return player;
}

function applyInput(player, message) {
  const now = Date.now();
  if (now - player.lastInputAt < 20) return;
  player.lastInputAt = now;
  player.input.x = clamp(finite(message.x), -1, 1);
  player.input.y = clamp(finite(message.y), -1, 1);
  player.input.angle = finite(message.angle);
}

function applyDash(room, player) {
  const now = Date.now();
  if (room.phase !== 'match' || now < player.stunnedUntil || now < player.cooldownUntil) return;
  player.cooldownUntil = now + 950;
  player.dashUntil = now + 180;
  const length = Math.hypot(player.input.x, player.input.y) || 1;
  player.x = clamp(player.x + (player.input.x / length) * 115, ARENA.margin, ARENA.width - ARENA.margin);
  player.y = clamp(player.y + (player.input.y / length) * 115, ARENA.margin, ARENA.height - ARENA.margin);
  for (const target of room.players.values()) {
    if (target === player || target.stunnedUntil > now) continue;
    if (distance(player, target) < 112) target.stunnedUntil = now + 1050;
  }
}

function simulate(room, dt) {
  const now = Date.now();
  if (room.phase === 'match' && now >= room.endsAt) finishMatch(room);
  if (room.phase !== 'match') return;

  if (now - room.lastOrbAt > 900 && room.orbs.length < MAX_ORBS) { spawnOrb(room); room.lastOrbAt = now; }

  for (const p of room.players.values()) {
    if (now < p.stunnedUntil) continue;
    const boost = now < p.dashUntil ? 2.8 : 1;
    const speed = 290 * boost;
    const mag = Math.hypot(p.input.x, p.input.y);
    if (mag > 0.01) {
      p.x = clamp(p.x + (p.input.x / Math.max(1, mag)) * speed * dt, ARENA.margin, ARENA.width - ARENA.margin);
      p.y = clamp(p.y + (p.input.y / Math.max(1, mag)) * speed * dt, ARENA.margin, ARENA.height - ARENA.margin);
      p.angle = Math.atan2(p.input.y, p.input.x);
    }
  }

  for (const orb of room.orbs) {
    orb.x += orb.vx * dt; orb.y += orb.vy * dt;
    orb.vx *= Math.pow(0.02, dt); orb.vy *= Math.pow(0.02, dt);
    if (orb.x < ARENA.margin || orb.x > ARENA.width - ARENA.margin) { orb.x = clamp(orb.x, ARENA.margin, ARENA.width - ARENA.margin); orb.vx *= -0.6; }
    if (orb.y < ARENA.margin || orb.y > ARENA.height - ARENA.margin) { orb.y = clamp(orb.y, ARENA.margin, ARENA.height - ARENA.margin); orb.vy *= -0.6; }
    for (const p of room.players.values()) {
      const d = distance(orb, p);
      if (d < orb.radius + 24) {
        const nx = (orb.x - p.x) / Math.max(1, d); const ny = (orb.y - p.y) / Math.max(1, d);
        orb.vx += nx * 360; orb.vy += ny * 360;
        orb.x = p.x + nx * (orb.radius + 25); orb.y = p.y + ny * (orb.radius + 25);
      }
    }
    // Each seat owns a goal on the matching arena edge. Score when the orb reaches it.
    for (const p of room.players.values()) {
      const goal = goalForSeat(p.seat);
      if (Math.hypot(orb.x - goal.x, orb.y - goal.y) < 62) {
        p.score += orb.value;
        orb._scored = true;
        broadcast(room, { type: 'score', playerId: p.id, value: orb.value, score: p.score });
        break;
      }
    }
  }
  room.orbs = room.orbs.filter(orb => !orb._scored);
}

function goalForSeat(seat) {
  return [
    { x: ARENA.margin, y: ARENA.height / 2 },
    { x: ARENA.width - ARENA.margin, y: ARENA.height / 2 },
    { x: ARENA.width / 2, y: ARENA.margin },
    { x: ARENA.width / 2, y: ARENA.height - ARENA.margin }
  ][seat];
}

function handleMessage(ws, raw) {
  if (raw.length > 8192) return ws.close(1009, 'message too large');
  let message;
  try { message = JSON.parse(raw); } catch { return send(ws, { type: 'error', code: 'BAD_JSON' }); }
  if (!message || typeof message.type !== 'string') return send(ws, { type: 'error', code: 'BAD_MESSAGE' });

  if (message.type === 'join') {
    if (ws.room) return;
    const code = safeRoomCode(message.room) ? message.room : String(message.room || '').toUpperCase();
    if (!safeRoomCode(code)) return send(ws, { type: 'error', code: 'BAD_ROOM', message: 'Room codes are 4–8 letters or numbers.' });
    let room = rooms.get(code);
    if (!room) { if (rooms.size >= MAX_ROOMS) return send(ws, { type: 'error', code: 'ROOM_LIMIT' }); room = makeRoom(code); rooms.set(code, room); }
    room.lastActiveAt = Date.now();
    if (message.resumeToken && reconnectPlayer(room, ws, message.resumeToken)) return;
    if (room.players.size >= 4) return send(ws, { type: 'error', code: 'ROOM_FULL' });
    createPlayer(room, ws, message.name, null);
    return;
  }

  const player = ws.player; const room = ws.room;
  if (!player || !room) return send(ws, { type: 'error', code: 'NOT_JOINED' });
  room.lastActiveAt = Date.now();
  if (message.type === 'input') return applyInput(player, message);
  if (message.type === 'dash') return applyDash(room, player);
  if (message.type === 'restart') { if (room.phase === 'results' && room.players.size >= 2) { resetMatch(room); broadcast(room, { type: 'match_start', endsAt: room.endsAt, matchMs: MATCH_MS }); } return; }
  if (message.type === 'ping') return send(ws, { type: 'pong', serverTime: Date.now() });
  send(ws, { type: 'error', code: 'UNKNOWN_TYPE' });
}

const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    const body = JSON.stringify({ ok: true, build: BUILD, rooms: rooms.size, connections: connections.size, uptimeSec: Math.floor(process.uptime()) });
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(body); return;
  }
  if (req.url === '/ready') { res.writeHead(200); res.end('ready\n'); return; }
  res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Orb Arena server\n');
});

const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: 8192 });
wss.on('connection', ws => {
  if (connections.size >= MAX_CONNECTIONS) return ws.close(1013, 'server busy');
  connections.add(ws); ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', data => handleMessage(ws, data.toString()));
  ws.on('close', () => { connections.delete(ws); if (ws.player) { if (ws.player.ws === ws) ws.player.ws = null; if (ws.room) broadcastSnapshot(ws.room); edgegap.connectedChanged(playersOnline()); } });
  ws.on('error', () => {});
  send(ws, { type: 'hello', build: BUILD, protocol: 1 });
});

let tickCount = 0;
setInterval(() => {
  const dt = 1 / TICK_RATE;
  tickCount += 1;
  for (const room of rooms.values()) {
    simulate(room, dt);
    // Fix: was `room.revision % 2 === 0`, but broadcastSnapshot() bumps revision, so snapshots
    // stopped after the first one. Send every (TICK_RATE / SNAPSHOT_RATE)th tick instead.
    if (room.phase === 'match' && tickCount % Math.round(TICK_RATE / SNAPSHOT_RATE) === 0) broadcastSnapshot(room);
    if (room.players.size === 0 && Date.now() - room.lastActiveAt > ROOM_TTL_MS) rooms.delete(room.code);
  }
}, 1000 / TICK_RATE);
setInterval(() => { for (const ws of connections) { if (!ws.isAlive) ws.terminate(); ws.isAlive = false; ws.ping(); } }, 30000);

httpServer.listen(PORT, HOST, () => { console.log(`Orb Arena server ${BUILD} listening on http://${HOST}:${PORT} (ws path /ws)`); edgegap.started(); });
