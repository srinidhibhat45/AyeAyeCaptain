// ============================================================================
//  HTTP static host + WebSocket game server.
// ============================================================================
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { Match } from './match.js';
import { worldPayload } from './worldgen.js';
import {
  TICK_HZ, SNAP_HZ, PHASE, TEAMS, MAX_PER_TEAM, MAX_PLAYERS, FLEET_SIZE,
  HULLS, ORDERS,
} from '../shared/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CLIENT = path.join(ROOT, 'client');
const PORT = process.env.PORT || 8787;
// Hosts that run a container hand you a port and expect you on every
// interface. Binding explicitly beats relying on the default.
const HOST = process.env.HOST || '0.0.0.0';
// A public address is a public address. One person with a script should not be
// able to open ten thousand matches and walk off.
const MAX_ROOMS = Math.max(1, Number(process.env.MAX_ROOMS ?? 32));
// Set ALLOW_ORIGIN to a comma-separated list of sites that may open a socket —
// your static host — and the rest are turned away at the gangway. Left unset,
// anyone may connect, which is what you want until you know where the client
// will live. Tools send no Origin at all and are always let through.
const ALLOW = (process.env.ALLOW_ORIGIN || '').split(',').map(x => x.trim()).filter(Boolean);
// Hulls per side when nobody is waiting. Bots make up any shortfall, and both
// fleets always sail the same number, however the humans are split.
const FLEET = Math.max(1, Math.min(MAX_PER_TEAM, Number(process.env.BOTS ?? FLEET_SIZE)));
// Bot competence, 0 green .. 1 hard.
const SKILL = Math.max(0, Math.min(1, Number(process.env.SKILL ?? 1)));

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// ---------------------------------------------------------------------------
//  Static files. /shared/* is served from the repo root so the browser can
//  import the exact same physics module the server runs.
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  let url = decodeURIComponent((req.url || '/').split('?')[0]);

  // Every host worth deploying to wants somewhere to poke to see if the thing
  // is alive. It answers with what is actually going on aboard, which makes it
  // useful to a human with curl as well as to a load balancer.
  if (url === '/healthz') {
    let players = 0;
    for (const r of rooms.values()) players += r.clients.size;
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, players, uptime: Math.round(process.uptime()) }));
    return;
  }

  if (url === '/') url = '/index.html';

  const base = url.startsWith('/shared/') ? ROOT : CLIENT;
  const file = path.join(base, url.startsWith('/shared/') ? url : url.replace(/^\//, ''));
  const rel = path.relative(base, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) { res.writeHead(403).end('no'); return; }

  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }).end('404'); return; }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(buf);
  });
});

// ---------------------------------------------------------------------------
//  Rooms
// ---------------------------------------------------------------------------
const rooms = new Map();

function getRoom(id) {
  let r = rooms.get(id);
  if (!r) {
    if (rooms.size >= MAX_ROOMS) return null;
    r = { id, match: new Match(id, { skill: SKILL, fleetSize: FLEET }), clients: new Set() };
    r.match.fillBots(FLEET);
    r.match.begin();
    rooms.set(id, r);
    console.log(`[room ${id}] opened, seed ${r.match.seed}`);
  }
  return r;
}

function restartRoom(r) {
  const humans = [...r.clients].filter(c => c.ws.readyState === 1);
  const m = new Match(r.id, { skill: SKILL, fleetSize: FLEET });
  r.match = m;
  for (const c of humans) {
    // Sides and who wanted the deck both carry over, so a fleet that has just
    // sorted itself out does not have to do it again every fifteen minutes.
    const s = m.addPlayer(c.id, c.name, c.team);
    if (s) { c.team = s.team; s.wantsCommand = !!c.wantsCommand; }
  }
  for (const t of TEAMS) m.assignCaptain(t);
  m.fillBots(FLEET);
  m.begin();
  for (const c of humans) send(c.ws, { k: 'world', world: worldPayload(m.world), you: c.id, rules: RULES, room: r.id });
  console.log(`[room ${r.id}] new match, seed ${m.seed}`);
}

const send = (ws, obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };

// The client imports shared/constants.js directly — the browser and the server
// run the same file — so this only carries what the SERVER could vary at run
// time, and the client reads no more than it is given.
const RULES = { HULLS, ORDERS, MAX_PER_TEAM, MAX_PLAYERS, FLEET };

// ---------------------------------------------------------------------------
//  WebSocket
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({
  server,
  verifyClient: ALLOW.length ? ({ origin }) => !origin || ALLOW.includes(origin) : undefined,
  // Nothing the client legitimately says comes near this, and with deflate in
  // the picture a few compressed bytes could otherwise ask the server to
  // inflate a hundred megabytes. ws applies this to the DECOMPRESSED size,
  // which is exactly the number that matters.
  maxPayload: 8 * 1024,
  // One snapshot looks very nearly like the one before it, so deflate spends
  // its time saying what moved rather than describing the sea again. Keeping
  // the sliding window BETWEEN messages is the whole trick — without context
  // takeover the saving collapses. Measured on the wire against a real match:
  // 93% off, which is 0.56 Mbit/s a player down to 0.038.
  perMessageDeflate: {
    zlibDeflateOptions: { level: 6, memLevel: 8 },
    serverNoContextTakeover: false,
    clientNoContextTakeover: false,
    concurrencyLimit: 16,
    threshold: 256,
  },
});

wss.on('connection', (ws, req) => {
  const q = new URL(req.url, 'http://x');
  const roomId = (q.searchParams.get('room') || 'main').slice(0, 24).toLowerCase();
  const name = (q.searchParams.get('name') || '').slice(0, 18).trim() || `Captain ${Math.floor(Math.random() * 900 + 100)}`;
  const wantTeam = q.searchParams.get('team');

  const room = getRoom(roomId);
  if (!room) { send(ws, { k: 'full', max: MAX_PLAYERS }); ws.close(); return; }
  const id = `p${Math.random().toString(36).slice(2, 9)}`;
  const ship = room.match.addPlayer(id, name, TEAMS.includes(wantTeam) ? wantTeam : null);
  if (!ship) {
    send(ws, { k: 'full', max: MAX_PLAYERS });
    ws.close();
    // This connection never became a client, so nothing else will clean up a
    // room it happened to open.
    if (room.clients.size === 0) rooms.delete(roomId);
    return;
  }

  const client = { id, ws, name, room, team: ship.team, alive: true };
  room.clients.add(client);
  ws.__client = client;

  send(ws, { k: 'world', world: worldPayload(room.match.world), you: id, rules: RULES, room: roomId });
  console.log(`[room ${roomId}] + ${name} (${ship.team}) — ${room.clients.size} aboard`);

  ws.on('message', (raw) => {
    if (raw.length > 4096) return;                 // nothing legitimate is this big
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;
    // One malformed message must never take a room down with it. The handlers
    // validate their own input; this is the belt to that pair of braces.
    try { handle(m); } catch (e) {
      console.error(`[room ${roomId}] bad message from ${name}:`, e.message);
    }
  });

  function handle(m) {
    const match = room.match;
    switch (m.k) {
      case 'in':    match.applyInput(id, m); break;
      case 'buy':   { const e = match.buy(id, m.id);   if (e) send(ws, { k: 'deny', why: e }); break; }
      case 'sell':  { const e = match.sell(id, m.id);  if (e) send(ws, { k: 'deny', why: e }); break; }
      case 'order': { const e = match.issueOrder(id, m.id, m.x, m.y, m.hold); if (e) send(ws, { k: 'deny', why: e }); break; }
      case 'ping':  match.addPing(id, m.id, m.x, m.y); break;
      case 'chat':  { const e = match.say(id, m.t, m.q); if (e) send(ws, { k: 'deny', why: e }); break; }
      case 'cmd':   {
        const e = match.command(id, m.act);
        const me = match.ships.get(id);
        client.wantsCommand = !!me?.wantsCommand;
        if (e) send(ws, { k: 'deny', why: e });
        break;
      }
      case 'side':  {
        const e = match.switchTeam(id);
        if (e) send(ws, { k: 'deny', why: e });
        else { const me = match.ships.get(id); if (me) client.team = me.team; }
        break;
      }
      case 'pong':  client.alive = true; break;
    }
  }

  ws.on('close', () => {
    room.clients.delete(client);
    const s = room.match.ships.get(id);
    if (s) { s.connected = false; room.match.removeShip(id); room.match.balanceBots(FLEET); }
    console.log(`[room ${roomId}] - ${name} — ${room.clients.size} aboard`);
    if (room.clients.size === 0) { rooms.delete(roomId); console.log(`[room ${roomId}] closed`); }
  });
});

// ---------------------------------------------------------------------------
//  Loops
// ---------------------------------------------------------------------------
let last = Date.now();
setInterval(() => {
  const nowMs = Date.now();
  let dt = (nowMs - last) / 1000;
  last = nowMs;
  if (dt > 0.25) dt = 0.25;                 // never let a stall teleport the world
  for (const r of rooms.values()) {
    // A throw in here would otherwise escape the interval, become an uncaught
    // exception, and drop every player on the server over one bad room. Close
    // that room instead; its people reconnect into a fresh one.
    try {
      r.match.step(dt);
      if (r.match.phase === PHASE.OVER && r.match.now >= r.match.phaseEnd) restartRoom(r);
    } catch (e) {
      console.error(`[room ${r.id}] step failed, closing it:`, e);
      for (const c of r.clients) { try { c.ws.close(1011, 'room failed'); } catch {} }
      rooms.delete(r.id);
    }
  }
}, 1000 / TICK_HZ);

setInterval(() => {
  for (const r of rooms.values()) try {
    // One snapshot per team, then a thin private slice per player: teammates
    // share vision, so there is no point recomputing it per client.
    const snaps = {};
    for (const t of TEAMS) snaps[t] = r.match.teamSnapshot(t);
    for (const c of r.clients) {
      const s = r.match.ships.get(c.id);
      if (!s) continue;
      c.team = s.team;
      send(c.ws, r.match.snapshotFor(c.id, snaps[s.team]));
    }
  } catch (e) {
    console.error(`[room ${r.id}] snapshot failed:`, e);
  }
}, 1000 / SNAP_HZ);

setInterval(() => {
  for (const r of rooms.values()) for (const c of r.clients) {
    if (!c.alive) { c.ws.terminate(); continue; }
    c.alive = false;
    send(c.ws, { k: 'ping' });
  }
}, 20_000);

server.listen(PORT, HOST, () => {
  console.log(`\n  AYE AYE, CAPTAIN — Tides of War`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  four to ten players — send them the link, add ?room=<code> for a private action`);
  console.log(`  ${FLEET} hulls a side, AI crewing any empty berth, skill ${SKILL}` +
              `   (BOTS= and SKILL= to change)\n`);
  if (ALLOW.length) console.log(`  sockets accepted only from: ${ALLOW.join(', ')}\n`);
});

// ---------------------------------------------------------------------------
//  Going quietly
//
//  A redeploy sends SIGTERM and then, not long after, SIGKILL. Told nothing,
//  every player sees a dead socket and a long silence. Told 1012 — service
//  restart — the client reconnects of its own accord, and the interruption is
//  a couple of seconds rather than the end of the match.
// ---------------------------------------------------------------------------
let closing = false;
function shutdown(sig) {
  if (closing) return;
  closing = true;
  console.log(`\n  ${sig} — standing down`);
  for (const r of rooms.values()) for (const c of r.clients) {
    try { c.ws.close(1012, 'restart'); } catch {}
  }
  wss.close();
  server.close(() => process.exit(0));
  // If something is wedged, do not make the host reach for SIGKILL.
  setTimeout(() => process.exit(0), 3000).unref();
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => shutdown(sig));
