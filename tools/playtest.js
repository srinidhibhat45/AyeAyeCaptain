// ============================================================================
//  End-to-end playtest. Boots the real server, connects real WebSocket
//  players, plays real matches, and asserts on the invariants that matter.
//
//    node tools/playtest.js [scenario] [--v]
//    node tools/playtest.js all
//
//  Scenarios cover the whole roster range the game promises — four players up
//  to ten — plus the awkward cases: the captain rage-quitting mid-battle, a
//  fleet everybody piles into, players arriving late, and side switching.
// ============================================================================
import { spawn } from 'node:child_process';
import { HumanClient } from './humanclient.js';
import { PHASE, TEAMS, MAX_PER_TEAM, INPUT_HZ } from '../shared/constants.js';

const VERBOSE = process.argv.includes('--v');
const PORT = 8899 + (Number(process.env.PT_PORT_OFFSET) || 0);
const SPEED = Number(process.env.PT_SPEED || 14);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let FAILS = [];
const fail = (sc, msg) => { FAILS.push(`[${sc}] ${msg}`); console.log(`   ✗ ${msg}`); };
const pass = (msg) => { if (VERBOSE) console.log(`   · ${msg}`); };

// ---------------------------------------------------------------------------
//  Server under test
// ---------------------------------------------------------------------------
async function boot(env = {}) {
  const proc = spawn(process.execPath, ['server/index.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT), AAC_SPEED: String(SPEED), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  proc.stdout.on('data', d => logs.push(String(d)));
  proc.stderr.on('data', d => { logs.push('ERR ' + d); process.stdout.write(String(d)); });
  proc.on('exit', (code, sig) => { if (!proc.__done) console.log(`\n!! server exited: code ${code} signal ${sig}`); });
  for (let i = 0; i < 80; i++) {
    await sleep(100);
    if (logs.join('').includes('http://localhost')) return { proc, logs };
  }
  throw new Error('server did not come up:\n' + logs.join(''));
}

/**
 * Run every connected client for `seconds` of wall time, driving inputs at the
 * real input rate and running the invariant checks on every snapshot.
 */
async function play(clients, seconds, sc, watch = null) {
  const step = 1000 / INPUT_HZ;
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    for (const c of clients) { if (!c.closed) { try { c.step(step / 1000); } catch (e) { fail(sc, `${c.name} threw: ${e.message}`); } } }
    for (const c of clients) if (c.snap) invariants(c, sc);
    watch?.(clients);
    await sleep(step);
  }
}

// ---------------------------------------------------------------------------
//  Invariants — checked against every snapshot every client receives
// ---------------------------------------------------------------------------
const seenBad = new Set();
function once(sc, key, msg) { const k = sc + key; if (seenBad.has(k)) return; seenBad.add(k); fail(sc, msg); }

function invariants(c, sc) {
  const s = c.snap;
  if (!s.me) return once(sc, 'nome', `${c.name}: snapshot with no private slice`);
  const me = s.me;
  if (!Number.isFinite(me.x) || !Number.isFinite(me.y)) once(sc, 'nan', `${c.name}: NaN position`);
  if (me.hull > me.hullMax + 0.5) once(sc, 'over', `${c.name}: hull ${me.hull} over max ${me.hullMax}`);
  if (me.alive && me.hull <= 0) once(sc, 'zombie', `${c.name}: alive at zero hull`);
  if (me.ammo < 0) once(sc, 'ammo', `${c.name}: negative ammo`);
  const hands = ['gun', 'sail', 'rep', 'look'].reduce((n, k) => n + (me.alloc?.[k] | 0), 0);
  if (hands !== 12) once(sc, 'hands', `${c.name}: ${hands} crew hands allocated, expected 12`);

  // Fog of war: never receive an enemy the team could not plausibly see.
  for (const sh of s.ships) if (sh.t !== s.team && sh.hp === undefined) once(sc, 'shipshape', 'ship without condition');

  if (!c.board) return;
  for (const team of TEAMS) {
    const rows = c.board.filter(r => r.t === team);
    const caps = rows.filter(r => r.r === 'captain');
    if (s.phase !== PHASE.OVER && rows.length && caps.length !== 1) {
      once(sc, 'cap' + team, `${team} has ${caps.length} captains (expected exactly 1)`);
    }
    // Hull and live state are only reported for your own fleet — the enemy's
    // are redacted, and asserting on them here would be asserting on a leak.
    // Once the action is over everything is on the table, by design.
    if (team !== s.team && s.phase !== PHASE.OVER) {
      for (const r of rows) {
        if ('h' in r || r.a === 0 || r.rs > 0) {
          once(sc, 'leak' + team, `the enemy roster leaked live state: ${JSON.stringify(r)}`);
        }
      }
      continue;
    }
    for (const r of rows) {
      if (r.r === 'captain' && r.h !== 'flagship' && r.a) {
        once(sc, 'flag' + team, `${team} captain ${r.n} is sailing a ${r.h}, not the flagship`);
      }
    }
  }
  const sizes = TEAMS.map(t => c.board.filter(r => r.t === t).length);
  if (sizes[0] !== sizes[1]) once(sc, 'size', `fleets are uneven: scarlet ${sizes[0]} vs cobalt ${sizes[1]}`);
  if (sizes[0] > MAX_PER_TEAM) once(sc, 'max', `fleet over the ${MAX_PER_TEAM} limit: ${sizes[0]}`);
}

// ---------------------------------------------------------------------------
//  Scenarios
// ---------------------------------------------------------------------------
async function join(n, opts = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const q = new URLSearchParams({ room: opts.room || 'pt', name: opts.names?.[i] || `P${i + 1}` });
    if (opts.teams?.[i]) q.set('team', opts.teams[i]);
    const c = new HumanClient({
      url: `ws://127.0.0.1:${PORT}/?${q}`,
      name: opts.names?.[i] || `P${i + 1}`,
      seed: 1000 + i * 37,
      skill: 1,
      role: opts.roles?.[i] || 'auto',
    });
    try { await c.connect(); } catch (e) {
      if (opts.expectFull) throw e;
      FAILS.push(`[join] ${c.name} could not join: ${e.message}`);
      continue;
    }
    out.push(c);
    await sleep(60);
  }
  return out;
}

const SCENARIOS = {};

SCENARIOS['4-players'] = async () => {
  const sc = '4-players';
  const cs = await join(4, { room: 'r4' });
  await play(cs, 12, sc);
  const b = cs[0].board || [];
  const humans = b.filter(r => !r.b).length;
  if (humans !== 4) fail(sc, `expected 4 humans on the roster, found ${humans}`);
  for (const t of TEAMS) {
    const h = b.filter(r => r.t === t && !r.b).length;
    if (h !== 2) fail(sc, `${t} has ${h} humans, expected 2`);
    const caps = b.filter(r => r.t === t && r.r === 'captain');
    if (caps.length !== 1) fail(sc, `${t} captains: ${caps.length}`);
    if (caps[0] && caps[0].b) fail(sc, `${t} is commanded by a bot while humans are aboard`);
  }
  cs.forEach(c => c.close());
  return cs;
};

SCENARIOS['10-players'] = async () => {
  const sc = '10-players';
  const cs = await join(10, { room: 'r10' });
  await play(cs, 14, sc);
  const b = cs[0].board || [];
  if (b.length !== 10) fail(sc, `expected 10 hulls, found ${b.length}`);
  if (b.filter(r => r.b).length !== 0) fail(sc, `expected no bots at ten players, found ${b.filter(r => r.b).length}`);
  for (const t of TEAMS) {
    const caps = b.filter(r => r.t === t && r.r === 'captain');
    if (caps.length !== 1) fail(sc, `${t} captains: ${caps.length}`);
  }
  cs.forEach(c => c.close());
  return cs;
};

SCENARIOS['11th-refused'] = async () => {
  const sc = '11th-refused';
  const cs = await join(10, { room: 'r11' });
  await play(cs, 3, sc);
  let refused = false;
  try {
    const q = new URLSearchParams({ room: 'r11', name: 'LATE' });
    const c = new HumanClient({ url: `ws://127.0.0.1:${PORT}/?${q}`, name: 'LATE', seed: 7 });
    await c.connect();
    c.close();
  } catch (e) { refused = /full/i.test(e.message); }
  if (!refused) fail(sc, 'an eleventh player was allowed aboard');
  cs.forEach(c => c.close());
  return cs;
};

SCENARIOS['stacked-side'] = async () => {
  const sc = 'stacked-side';
  // Everybody asks for Scarlet. The fleets must still sail equal numbers.
  const cs = await join(6, { room: 'rs', teams: Array(6).fill('scarlet') });
  await play(cs, 10, sc);
  const b = cs[0].board || [];
  const sSize = b.filter(r => r.t === 'scarlet').length;
  const cSize = b.filter(r => r.t === 'cobalt').length;
  if (sSize !== cSize) fail(sc, `uneven fleets after a one-sided join: ${sSize} vs ${cSize}`);
  const sHum = b.filter(r => r.t === 'scarlet' && !r.b).length;
  if (sHum > MAX_PER_TEAM) fail(sc, `scarlet over the human cap: ${sHum}`);
  if (VERBOSE) console.log(`   · split ${sHum} humans scarlet, ${b.filter(r => r.t === 'cobalt' && !r.b).length} cobalt, ${sSize}v${cSize} hulls`);
  cs.forEach(c => c.close());
  return cs;
};

SCENARIOS['captain-quits'] = async () => {
  const sc = 'captain-quits';
  const cs = await join(6, { room: 'rq' });
  await play(cs, 14, sc);          // into BATTLE
  const b = cs[0].board || [];
  const capRow = b.find(r => r.r === 'captain' && !r.b);
  const cap = cs.find(c => c.you === capRow?.id);
  if (!cap) { fail(sc, 'no human captain to remove'); cs.forEach(c => c.close()); return cs; }
  const side = cap.snap.team;
  const mates = cs.filter(c => c !== cap && c.snap?.team === side);
  const before = mates.map(c => c.hullLosses);
  if (VERBOSE) console.log(`   · ${cap.name} (${side}) abandons the deck`);
  cap.close();
  const rest = cs.filter(c => c !== cap);
  await play(rest, 10, sc);

  const b2 = rest[0].board || [];
  const caps = b2.filter(r => r.t === side && r.r === 'captain');
  if (caps.length !== 1) fail(sc, `${side} has ${caps.length} captains after the quit`);
  if (caps[0]?.b) fail(sc, `${side} fell to a bot captain while humans were still aboard`);
  mates.forEach((c, i) => {
    if (c.hullLosses > before[i]) fail(sc, `${c.name} lost a ship because someone else disconnected`);
  });
  const promoted = rest.find(c => c.wasCaptain && c.snap?.team === side);
  if (!promoted) fail(sc, 'no human took over command');
  rest.forEach(c => c.close());
  return cs;
};

SCENARIOS['hand-over'] = async () => {
  const sc = 'hand-over';
  const cs = await join(4, { room: 'rh' });
  await play(cs, 10, sc);
  const cap = cs.find(c => c.snap?.me?.isCaptain);
  if (!cap) { fail(sc, 'nobody is in command'); cs.forEach(c => c.close()); return cs; }
  const side = cap.snap.team;
  const mate = cs.find(c => c !== cap && c.snap?.team === side);
  const lost = mate ? mate.hullLosses : 0;
  cap.send({ k: 'cmd', act: 'standdown' });
  await play(cs, 6, sc);
  if (cap.snap.me.isCaptain) fail(sc, 'the captain stood down and kept the deck');
  if (!mate?.snap?.me?.isCaptain) fail(sc, 'the deck did not pass to the other human');
  if (mate && mate.hullLosses > lost) fail(sc, 'taking command sank the new captain');
  if (cap.hullLosses > 0) fail(sc, 'standing down sank the old captain');
  // ... and take it back.
  cap.send({ k: 'cmd', act: 'claim' });
  await play(cs, 4, sc);
  cs.forEach(c => c.close());
  return cs;
};

SCENARIOS['claim-from-bot'] = async () => {
  const sc = 'claim-from-bot';
  // One human per side: they are the only candidate, so they should already
  // have the deck — and asking for it again must be harmless.
  const cs = await join(2, { room: 'rc' });
  await play(cs, 8, sc);
  for (const c of cs) {
    if (!c.snap?.me?.isCaptain) fail(sc, `${c.name} is the only human on ${c.snap?.team} but is not in command`);
    c.send({ k: 'cmd', act: 'claim' });
  }
  await play(cs, 4, sc);
  for (const c of cs) if (!c.snap?.me?.isCaptain) fail(sc, `${c.name} lost command after claiming it`);
  cs.forEach(c => c.close());
  return cs;
};

SCENARIOS['late-joiners'] = async () => {
  const sc = 'late-joiners';
  const cs = await join(4, { room: 'rl' });
  await play(cs, 16, sc);
  const more = await join(4, { room: 'rl', names: ['L1', 'L2', 'L3', 'L4'] });
  const all = [...cs, ...more];
  await play(all, 12, sc);
  const b = all[0].board || [];
  if (b.filter(r => !r.b).length !== 8) fail(sc, `expected 8 humans, found ${b.filter(r => !r.b).length}`);
  const sizes = TEAMS.map(t => b.filter(r => r.t === t).length);
  if (sizes[0] !== sizes[1]) fail(sc, `uneven after late joins: ${sizes.join(' v ')}`);
  for (const c of more) if (!c.snap) fail(sc, `${c.name} never received a snapshot`);
  all.forEach(c => c.close());
  return all;
};

SCENARIOS['side-switch'] = async () => {
  const sc = 'side-switch';
  const cs = await join(4, { room: 'rw' });
  await play(cs, 10, sc);
  const before = cs[0].snap.team;
  cs[0].send({ k: 'side' });
  await play(cs, 6, sc);
  const after = cs[0].snap.team;
  if (after === before) {
    // A refusal is fine, as long as it says why rather than doing nothing.
    if (!cs[0].denies.length) fail(sc, 'the side switch neither happened nor was refused');
    else pass(`switch refused: ${cs[0].denies.at(-1)}`);
  }
  const b = cs[0].board || [];
  const sizes = TEAMS.map(t => b.filter(r => r.t === t).length);
  if (sizes[0] !== sizes[1]) fail(sc, `uneven after a switch: ${sizes.join(' v ')}`);
  cs.forEach(c => c.close());
  return cs;
};

SCENARIOS['idle-captain'] = async () => {
  const sc = 'idle-captain';
  const cs = await join(4, { room: 'ri' });
  await play(cs, 14, sc);
  const cap = cs.find(c => c.snap?.me?.isCaptain);
  if (!cap) { fail(sc, 'nobody is in command'); cs.forEach(c => c.close()); return cs; }
  const side = cap.snap.team;
  const lost = cap.hullLosses;
  // The captain walks away from the keyboard: still connected, sending nothing.
  const awake = cs.filter(c => c !== cap);
  if (VERBOSE) console.log(`   · ${cap.name} (${side}) stops playing`);
  await play(awake, 22, sc);
  const b = awake[0].board || [];
  const caps = b.filter(r => r.t === side && r.r === 'captain');
  if (caps.length !== 1) fail(sc, `${side} has ${caps.length} captains`);
  if (caps[0]?.id === cap.you) fail(sc, 'an absent captain kept the deck and the fleet spent nothing');
  if (cap.hullLosses > lost) fail(sc, 'being relieved sank the old captain');
  // Coming back must not be a dead end: the deck is now held by a team-mate.
  cap.send({ k: 'cmd', act: 'claim' });
  await play(cs, 5, sc);
  cs.forEach(c => c.close());
  return cs;
};

SCENARIOS['uneven-humans'] = async () => {
  const sc = 'uneven-humans';
  // Three friends on one side against one on the other: bots must even it up.
  const cs = await join(4, { room: 'ru', teams: ['scarlet', 'scarlet', 'scarlet', 'cobalt'] });
  await play(cs, 12, sc);
  const b = cs[0].board || [];
  const s1 = b.filter(r => r.t === 'scarlet'), c1 = b.filter(r => r.t === 'cobalt');
  if (s1.length !== c1.length) fail(sc, `uneven hulls: ${s1.length} v ${c1.length}`);
  if (s1.filter(r => !r.b).length !== 3) fail(sc, 'the three did not sail together');
  if (c1.filter(r => !r.b).length !== 1) fail(sc, 'the lone player was moved');
  for (const t of TEAMS) {
    const caps = b.filter(r => r.t === t && r.r === 'captain');
    if (caps.length !== 1) fail(sc, `${t} captains: ${caps.length}`);
    if (caps[0].b) fail(sc, `${t} is led by a bot with humans aboard`);
  }
  if (VERBOSE) console.log(`   · ${s1.length}v${c1.length} hulls, ${s1.filter(r => !r.b).length}v${c1.filter(r => !r.b).length} humans`);
  cs.forEach(c => c.close());
  return cs;
};

SCENARIOS['full-match'] = async () => {
  const sc = 'full-match';
  const cs = await join(6, { room: 'rf' });
  const phases = new Set();
  let winner = null, overs = 0;
  await play(cs, 140, sc, () => {
    const s = cs[0].snap;
    if (!s) return;
    phases.add(s.phase);
    if (s.phase === PHASE.OVER && !winner) { winner = s.winner || 'draw'; overs++; }
  });
  for (const p of [PHASE.MUSTER, PHASE.BATTLE, PHASE.OVER]) {
    if (!phases.has(p)) fail(sc, `never reached ${p} (saw ${[...phases].join(', ')})`);
  }
  if (!winner) fail(sc, 'the match never resolved');
  // ... and a second match must start cleanly, with the same fleets. Six
  // humans is 3v3, which the standing fleet size tops up to 4v4.
  const b = cs[0].board || [];
  if (b.length !== 8) fail(sc, `roster is ${b.length} after the restart, expected 8`);
  if (b.filter(r => !r.b).length !== 6) fail(sc, `lost a human across the restart`);
  for (const t of TEAMS) {
    if (b.filter(r => r.t === t && r.r === 'captain').length !== 1) fail(sc, `${t} has no captain after the restart`);
  }
  if (VERBOSE) console.log(`   · saw ${[...phases].join(' -> ')}, winner ${winner}`);
  cs.forEach(c => c.close());
  return cs;
};

SCENARIOS['abuse'] = async () => {
  const sc = 'abuse';
  const cs = await join(4, { room: 'ra' });
  await play(cs, 8, sc);
  const c = cs[0];
  // Everything a malformed or malicious client might send.
  const junk = [
    { k: 'in', rudder: 1e9, sails: 99, aimA: NaN, aimD: -5 },
    { k: 'in', rudder: 'left', sails: null, shot: 'grapeshot' },
    { k: 'in', shift: { from: 'gun', to: 'gun' } },
    { k: 'in', shift: { from: 'nope', to: 'gun' } },
    { k: 'in', hull: 'battleship' },
    { k: 'buy', id: '__proto__' },
    { k: 'buy', id: 'copper', level: 99 },
    { k: 'sell', id: 'constructor' },
    { k: 'order', id: 'nuke', x: 1e9, y: -1e9 },
    { k: 'order', id: 'skyraid', x: 'far', y: null },
    { k: 'order', id: 'works', hold: 999 },
    { k: 'ping', id: 'attack', x: 1e12, y: -1e12 },
    { k: 'chat', t: 'x'.repeat(5000) },
    { k: 'chat', t: '<script>alert(1)</script>' },
    { k: 'chat', q: 'nope' },
    { k: 'cmd', act: 'become-admiral' },
    { k: 'side', team: 'neutral' },
    { k: 'nonsense' },
  ];
  for (const j of junk) { c.send(j); await sleep(25); }
  // Then hammer the chat rate limit.
  for (let i = 0; i < 40; i++) c.send({ k: 'chat', t: 'spam ' + i });
  await play(cs, 6, sc);
  if (c.closed) fail(sc, 'the server dropped a client that sent junk');
  const shown = (c.chatSeen || []).filter(l => /^spam /.test(l.t)).length;
  if (shown > 3) fail(sc, `chat rate limit let ${shown} spam lines through`);
  const longLine = (c.chatSeen || []).find(l => l.t.length > 140);
  if (longLine) fail(sc, `a ${longLine.t.length}-character chat line got through`);
  for (const cc of cs) if (!cc.snap) fail(sc, `${cc.name} lost its snapshot stream`);
  cs.forEach(x => x.close());
  return cs;
};

// ---------------------------------------------------------------------------
//  Runner
// ---------------------------------------------------------------------------
const want = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'all';
const names = want === 'all' ? Object.keys(SCENARIOS) : [want];

const { proc, logs } = await boot();
let allClients = [];
try {
  for (const n of names) {
    if (!SCENARIOS[n]) { console.log(`no scenario "${n}"`); continue; }
    const before = FAILS.length;
    process.stdout.write(`\n▸ ${n}\n`);
    const t0 = Date.now();
    const cs = await SCENARIOS[n]();
    allClients = allClients.concat(cs || []);
    await sleep(250);
    const ok = FAILS.length === before;
    console.log(`   ${ok ? '✓ clean' : `✗ ${FAILS.length - before} problem(s)`}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
} catch (e) {
  FAILS.push(`harness threw: ${e.message}`);
  console.log(`\n!! ${e.stack}`);
} finally {
  for (const c of allClients) c.close();
  await sleep(300);
  proc.__done = true;
  proc.kill();
}

const serverErrs = logs.join('').split('\n').filter(l => /ERR |Error|error:|TypeError|undefined is not/.test(l));
console.log(`\n${'─'.repeat(62)}`);
const denies = [...new Set(allClients.flatMap(c => c.denies))];
const cerrs = [...new Set(allClients.flatMap(c => c.errors))];
const snaps = allClients.reduce((n, c) => n + c.snaps, 0);
const bytesIn = allClients.reduce((n, c) => n + c.bytesIn, 0);
const bytesOut = allClients.reduce((n, c) => n + c.bytesOut, 0);
console.log(`clients        ${allClients.length}   snapshots ${snaps}`);
console.log(`bandwidth      ${(bytesIn / Math.max(1, snaps) / 1024).toFixed(2)} KB per snapshot`
          + `   ~${((bytesIn / Math.max(1, snaps)) * 20 * 8 / 1e6).toFixed(2)} Mbit/s down per player`
          + `   ${(bytesOut / Math.max(1, allClients.length) / 1024).toFixed(0)} KB up each`);
if (denies.length) console.log(`server said no to: ${denies.join(' | ')}`);
if (cerrs.length) { console.log(`CLIENT ERRORS: ${cerrs.join(' | ')}`); FAILS.push('client transport errors'); }
if (serverErrs.length) {
  console.log(`\nSERVER ERRORS:\n${serverErrs.slice(0, 20).join('\n')}`);
  FAILS.push('server logged errors');
}
if (FAILS.length) {
  console.log(`\n${FAILS.length} PROBLEM(S):`);
  for (const f of FAILS) console.log('  ' + f);
  process.exit(1);
}
console.log('\nall scenarios clean.');
