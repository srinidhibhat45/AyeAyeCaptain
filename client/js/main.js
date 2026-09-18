// ============================================================================
//  Client entry point: prediction, interpolation, camera and the frame loop.
// ============================================================================
import { Scene, WHITE } from './gl/scene.js';
import { Particles, WorldView, emit } from './draw.js';
import { HUD } from './ui/hud.js';
import { Net, safeSet } from './net.js';
import { Input } from './input.js';
import { Audio } from './audio.js';
import { stepShip, visionRadius } from '/shared/physics.js';
import {
  PHASE, TEAM, HULLS, FLAGSHIP, GUN, HOLD, SHOT_IDS, STANCES, PINGS, INPUT_HZ, SHIP,
  SQUALL,
} from '/shared/constants.js';
import { clamp, lerp, damp, dampAngle, wrapAngle, angleDiff, dist, TAU } from '/shared/math.js';

const glCanvas = document.getElementById('gl');
const hudCanvas = document.getElementById('hud');

const scene = new Scene(glCanvas);
if (!scene.ok) {
  document.getElementById('nogl').style.display = 'flex';
  throw new Error('WebGL2 unavailable');
}
const P = new Particles();
const view = new WorldView(scene, P);
const input = new Input(glCanvas);
const audio = new Audio();
const hud = new HUD(scene, hudCanvas);

// ---------------------------------------------------------------------------
//  State
// ---------------------------------------------------------------------------
const G = {
  you: null, room: 'main', rules: null, world: null,
  snaps: [],            // recent snapshots, for interpolation
  last: null,           // most recent snapshot
  me: null,             // private slice
  pred: null,           // locally predicted ship
  seq: 0,
  wind: { dir: 0, speed: 1 },
  windVis: { dir: 0, speed: 1 },
  aimA: 0, aimD: 620,
  shot: 'round',
  cam: { x: 0, y: 0, zoom: 0.55 },
  zoomAdj: 1, tactical: false,
  holdSig: '',
  board: [], log: [], chat: [], roster: null, team: null,
  lock: null,                 // the target the guns are laid on
};

const INTERP_MS = 110;        // render remote ships this far in the past

// How much water you can see. Framed in WORLD units rather than pixels, so a
// ship is the same readable size on a laptop and on a big retina display —
// before this the view was sized off the raw canvas and a brigantine came out
// twenty-four pixels long, which is most of the reason nothing on screen read
// as anything.
const VIEW_H   = 1150;        // world units of sea from top to bottom
const VIEW_W   = 2400;        // ... and the widest it may get on an ultrawide
const SHIP_UP  = 0.10;        // sit your own ship this far above centre
const SQUALL_PUSH = SQUALL.driftPush;

// ---------------------------------------------------------------------------
//  Networking and joining
//
//  A first visit asks for a name and a side, then remembers both; everyone
//  after that goes straight to sea. An explicit ?name= or ?team= skips the card
//  entirely, so a shared link still drops you in with no ceremony.
// ---------------------------------------------------------------------------
const query = new URLSearchParams(location.search);
document.getElementById('join-roomid').textContent = query.get('room') || 'main';

function stored(k) { try { return localStorage.getItem(k); } catch { return null; } }
const needJoin = !query.get('name') && !stored('aac_name');

// Can this machine actually sail her? The helm is on the keyboard and the guns
// follow a pointer, so a phone has nothing to play with — and because the game
// is all canvas it would otherwise load perfectly, look inviting, and then
// ignore every tap. Better to say so and send them to a real desk.
//
// A touchscreen laptop reports BOTH a coarse pointer and a fine one, as does a
// tablet with a trackpad attached, and those are fine to sail. Only a device
// with no fine pointer at all is turned back — and even then there is a way
// through, because someone may have a keyboard we cannot see.
function handheld() {
  try {
    return matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches;
  } catch { return false; }
}
const warnTouch = handheld() && !stored('aac_touch_ok');

const net = new Net({
  autoConnect: !needJoin && !warnTouch,
  status: (s, info) => hud.setConn(s, info),
  msg: (m) => {
    if (m.k === 'world') {
      G.you = m.you; G.rules = m.rules; G.room = m.room || G.room;
      G.world = m.world;
      scene.setWorld(m.world);
      hud.setWorld(m.world, m.rules, m.you, G.room);
      G.pred = null; G.snaps.length = 0; G.holdSig = '';
      // A new match is a clean slate. The last thing the old one sent was its
      // final board, which is deliberately unredacted — carrying that into the
      // new action would hand you the enemy's opening hand.
      G.board = []; G.chat = []; G.log = []; G.roster = null; G.team = null;
      return;
    }
    if (m.k === 'deny') { hud.toast(m.why); return; }
    if (m.k === 'full')  { net.stop(); document.getElementById('full').style.display = 'flex'; return; }
    if (m.k === 'snap')  { onSnap(m); }
  },
});

function showJoin() {
  const card = document.getElementById('joincard');
  const name = document.getElementById('join-name');
  const sides = [...document.querySelectorAll('.js')];
  card.style.display = 'flex';
  name.focus();
  let team = '';
  for (const b of sides) {
    b.addEventListener('click', () => {
      team = b.dataset.team;
      for (const o of sides) o.classList.toggle('on', o === b);
    });
  }
  const go = () => {
    const n = name.value.trim().slice(0, 18);
    safeSet('aac_name', n || `Hand ${Math.floor(Math.random() * 900 + 100)}`);
    safeSet('aac_team', team);
    card.style.display = 'none';
    net.connect();
  };
  document.getElementById('join-go').addEventListener('click', go);
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}

if (warnTouch) {
  const warn = document.getElementById('touchwarn');
  warn.style.display = 'flex';
  document.getElementById('tw-go').addEventListener('click', () => {
    safeSet('aac_touch_ok', '1');
    warn.style.display = 'none';
    if (needJoin) showJoin(); else net.connect();
  });
} else if (needJoin) {
  showJoin();
}

function onSnap(s) {
  s.recv = performance.now();
  // The roster, killfeed and fleet channel arrive at a lower rate than the rest,
  // so the last set is carried forward between them — but only while it is
  // still yours. Changing sides changes what you are entitled to see, and a
  // quarter of a second of the old fleet's view is a quarter of a second of
  // reading the enemy's roster.
  if (s.team !== G.team) { G.team = s.team; G.board = []; G.chat = []; G.log = []; }
  if (s.board) G.board = s.board; else s.board = G.board || [];
  if (s.log) G.log = s.log; else s.log = G.log || [];
  if (s.chat) G.chat = s.chat; else s.chat = G.chat || [];
  if (s.roster) G.roster = s.roster; else s.roster = G.roster || null;
  G.snaps.push(s);
  while (G.snaps.length > 24) G.snaps.shift();
  G.last = s;
  G.me = s.me;
  G.wind.dir = s.wind.d; G.wind.speed = s.wind.s;

  // Territory only needs repainting when a hold actually changes hands.
  const sig = s.holds.map(h => h.o || '-').join('');
  if (sig !== G.holdSig) { G.holdSig = sig; scene.buildControl(s.holds); }

  reconcile(s);
  playEvents(s);
  hud.onSnap(s);
}

/** Fold the server's truth back into the locally predicted ship. */
function reconcile(s) {
  const me = s.me;
  if (!me || !me.alive) { G.pred = null; return; }
  if (!G.pred) { G.pred = makePred(me); return; }
  const p = G.pred;
  const err = dist(p.x, p.y, me.x, me.y);
  if (err > 260) {
    // A real divergence (respawn, a mine, a shove). Accept the server outright.
    Object.assign(p, makePred(me));
  } else {
    p.x = lerp(p.x, me.x, 0.22);
    p.y = lerp(p.y, me.y, 0.22);
    p.heading = p.heading + angleDiff(p.heading, me.heading) * 0.30;
    p.speed = lerp(p.speed, me.speed, 0.30);
  }
  // Everything the server owns outright is copied straight across.
  p.hull = me.hull; p.hullMax = me.hullMax;
  p.sail = me.sail; p.sailMax = me.sailMax;
  p.crew = me.crew; p.crewMax = me.crewMax;
  p.alloc = me.alloc; p.stamina = me.stamina;
  p.rallyUntil = me.rallyUntil; p.slowUntil = me.slowUntil;
  p.upg = s.us.upg;
  p.hullId = me.hullId;
  p.stats = me.hullId === 'flagship' ? FLAGSHIP : (HULLS[me.hullId] || HULLS.brigantine);
}

function makePred(me) {
  return {
    x: me.x, y: me.y, heading: me.heading, speed: me.speed,
    rudder: me.rudder, rudderPos: me.rudderPos, sails: me.sails,
    sweeps: me.sweeps, stamina: me.stamina, groundCd: 0,
    hull: me.hull, hullMax: me.hullMax, sail: me.sail, sailMax: me.sailMax,
    crew: me.crew, crewMax: me.crewMax, alloc: me.alloc,
    stats: me.hullId === 'flagship' ? FLAGSHIP : (HULLS[me.hullId] || HULLS.brigantine),
    hullId: me.hullId, upg: {}, rallyUntil: 0, slowUntil: 0, fireT: 0,
  };
}

// ---------------------------------------------------------------------------
//  Effects driven by server events
// ---------------------------------------------------------------------------
function playEvents(s) {
  const meShip = G.pred || s.me;
  for (const f of s.fx) {
    const near = meShip ? dist(f.x, f.y, meShip.x, meShip.y) : 1e9;
    switch (f.k) {
      case 'broadside': {
        const n = f.n || 4;
        const beam = f.a;
        for (let i = 0; i < Math.min(n, 6); i++) {
          const sp = (i / Math.max(1, n - 1) - 0.5) * 40;
          emit.muzzle(P, f.x + Math.cos(beam + Math.PI / 2) * sp, f.y + Math.sin(beam + Math.PI / 2) * sp, beam, 3);
        }
        audio.broadside(near, n, panAt(f.x, f.y));
        if (f.id === G.you) { scene.shock(...scene.toScreen(f.x, f.y), 0.30); shake(2.6); }
        break;
      }
      case 'hit': {
        emit.hit(P, f.x, f.y, f.shot);
        const pan = panAt(f.x, f.y);
        // Three different things can happen when a shot lands, and until now
        // all three sounded and looked identical. They are the whole feedback
        // loop of a gunfight: did I hit, did they hit me, or is this someone
        // else's fight happening nearby?
        if (f.by === G.you) {
          audio.hitDealt(pan);
          hud.floater(f.x, f.y, `${f.v}`, '#ffd76a');
          hud.hitMark();
        } else if (f.id === G.you) {
          audio.hitTaken();
          shake(4.6);
          scene.damage = Math.min(0.5, scene.damage + 0.22);
          hud.tookHit(f.x, f.y, f.v);
        } else {
          audio.hit(near, pan);
        }
        break;
      }
      case 'fhit':      emit.hit(P, f.x, f.y, 'round');
                        if (f.by === G.you) { hud.floater(f.x, f.y, `${f.v}`, '#ffc44d'); hud.hitMark(); audio.hitDealt(panAt(f.x, f.y)); }
                        break;
      case 'splash':    emit.splash(P, f.x, f.y, 0.8); audio.splash(near, panAt(f.x, f.y)); break;
      case 'dirt':      emit.splash(P, f.x, f.y, 0.6); break;
      case 'scrape':    emit.splash(P, f.x, f.y, 0.5); break;
      case 'sink': {
        emit.sink(P, f.x, f.y);
        audio.sink(near, panAt(f.x, f.y));
        scene.shock(...scene.toScreen(f.x, f.y), 0.8);
        if (f.by === G.you) { hud.banner(`SHE'S YOURS — ${f.n} SUNK`, '#ffd76a'); audio.prize(); }
        break;
      }
      case 'shellburst':emit.explode(P, f.x, f.y, 1.0); audio.boom(near, 0.8, panAt(f.x, f.y)); scene.shock(...scene.toScreen(f.x, f.y), 0.5); break;
      case 'bomb':      emit.explode(P, f.x, f.y, 1.3); audio.boom(near, 1.0, panAt(f.x, f.y)); scene.shock(...scene.toScreen(f.x, f.y), 0.7); break;
      case 'mineboom':  emit.explode(P, f.x, f.y, 1.6); audio.boom(near, 1.2, panAt(f.x, f.y)); scene.shock(...scene.toScreen(f.x, f.y), 0.9); break;
      case 'fortfire':  emit.muzzle(P, f.x, f.y, Math.random() * TAU, 4); audio.fortFire(near, panAt(f.x, f.y)); break;
      case 'fortdown':  emit.explode(P, f.x, f.y, 2.2); audio.boom(near, 1.4, panAt(f.x, f.y)); scene.shock(...scene.toScreen(f.x, f.y), 1.0); break;
      case 'capture':   emit.capture(P, f.x, f.y, TEAM[f.team].rgb); audio.capture(f.team === s.team); break;
      case 'spawn':     if (f.team === s.team) emit.capture(P, f.x, f.y, TEAM[f.team].rgb); break;
      case 'bolt':      lightning(f.x, f.y); break;
      case 'prize':     hud.floater(f.x, f.y, `+${f.v}`, '#ffd76a'); break;
      case 'assist':    if (f.id === G.you) hud.floater(f.x, f.y, `ASSIST +${f.v}`, '#8affa0'); break;
      case 'pickup':    hud.floater(f.x, f.y, `+${f.v}`, '#ffd76a'); emit.splash(P, f.x, f.y, 0.5); break;
      case 'bullion':   hud.floater(f.x, f.y, 'BULLION TAKEN', '#ffd76a'); emit.explode(P, f.x, f.y, 2); break;
      case 'smokepop':  audio.whoosh(near); break;
      case 'raidwarn':  audio.alarm(near); break;
      case 'works':     emit.capture(P, f.x, f.y, TEAM[f.team].rgb); break;
      case 'cantbear':  if (f.id === G.you) hud.wontBear(angleDiff(meShip.heading ?? meShip.a ?? 0, G.aimA)); break;
      case 'dry':       if (f.id === G.you) { hud.banner('MAGAZINE EMPTY — RUN FOR A FRIENDLY HOLD', '#ff6a52'); audio.dry(); } break;
      case 'upgrade':   audio.chime(); break;
      case 'refit':
        // Command has changed hands and a hull has changed under someone. Mark
        // it, so the rest of the fleet sees the flagship move.
        emit.capture(P, f.x, f.y, TEAM[f.team].rgb);
        audio.rope();
        if (f.id === G.you) hud.toast('she is refitting under you — new hull, same water');
        break;
    }
  }
}

let shakeAmt = 0;
function shake(v) { shakeAmt = Math.min(16, shakeAmt + v); }
function lightning(x, y) {
  scene.flash = Math.min(1, scene.flash + 0.55);
  scene.flashCol = [0.80, 0.86, 1.0];
  audio.thunder();
  for (let i = 0; i < 6; i++) {
    P.spawn({ sprite: 'spark', x: x + (Math.random() - 0.5) * 120, y: y + (Math.random() - 0.5) * 120,
              vx: 0, vy: 0, life: 0.16, size: 90, col: [0.85, 0.92, 1, 1], add: true, glow: 3, drag: 1 });
  }
}

// ---------------------------------------------------------------------------
//  Laying the guns
//
//  Pointing at a ship used to set a bearing and a range straight off the raw
//  cursor: the range readout moved every time your hand did, and hitting a
//  moving target meant eyeballing the lead. Now the nearest enemy to the
//  cursor is LOCKED — the guns are laid where she will be when the shot gets
//  there, and the range is hers. Point at a ship, and you are shooting at it.
// ---------------------------------------------------------------------------
const LOCK_PX   = 80;      // how near the cursor must come to take a lock
const LOCK_KEEP = 1.8;     // ... and how far it may stray before it drops

function pickTarget(S, p) {
  if (!S || !p || !G.world) return null;
  const cx = input.mx * scene.dpr, cy = input.my * scene.dpr;
  const keepId = G.lock?.id;
  let best = null, bestScore = Infinity;

  const consider = (o) => {
    if (dist(p.x, p.y, o.x, o.y) > GUN.maxRange * 1.3) return;
    const [sx, sy] = scene.toScreen(o.x, o.y);
    const sd = Math.hypot(sx - cx, sy - cy);
    // A lock you already hold is stickier than one you do not, so the reticle
    // does not flick between two ships that happen to overlap.
    const reach = LOCK_PX * scene.dpr * (o.id === keepId ? LOCK_KEEP : 1);
    if (sd > reach) return;
    const score = sd - (o.id === keepId ? 34 * scene.dpr : 0);
    if (score < bestScore) { bestScore = score; best = o; }
  };

  for (const t of S.ships) {
    if (t.t === S.team || t.id === G.you) continue;
    consider({ id: t.id, x: t.x, y: t.y, vx: Math.cos(t.a) * t.v, vy: Math.sin(t.a) * t.v,
               kind: 'ship', name: t.n, hp: t.hp, cap: t.r === 'captain' });
  }
  for (const h of G.world.holds) {
    const st = S.holds.find(q => q.id === h.id);
    if (!st || !st.o || st.o === S.team || st.hp <= 0) continue;
    consider({ id: 'fort:' + h.id, x: h.x, y: h.y, vx: 0, vy: 0, kind: 'fort',
               name: h.name, hp: Math.round(100 * st.hp / Math.max(1, st.hm)) });
  }
  return best;
}

/** Where to lay the guns so that shot and target arrive together. */
function leadPoint(p, t) {
  let tx = t.x, ty = t.y;
  for (let i = 0; i < 3; i++) {
    const flight = dist(p.x, p.y, tx, ty) / GUN.ballSpeed;
    tx = t.x + t.vx * flight;
    ty = t.y + t.vy * flight;
  }
  return [tx, ty];
}

/** Stereo placement for a world point: sounds come from where they happen. */
function panAt(x, y) {
  const [sx] = scene.toScreen(x, y);
  return clamp((sx / Math.max(1, scene.w)) * 2 - 1, -1, 1);
}

// ---------------------------------------------------------------------------
//  Input -> server
// ---------------------------------------------------------------------------
let inputAcc = 0;
function gatherInput(dt, S) {
  const me = G.me;
  const p = G.pred;
  const alive = !!(me && me.alive && p);

  // --- aim -----------------------------------------------------------------
  if (p) {
    const [wx, wy] = scene.toWorld(input.mx * scene.dpr, input.my * scene.dpr);
    const t = (alive && !hud.pendingOrder) ? pickTarget(S, p) : null;
    if (t) {
      const [lx, ly] = leadPoint(p, t);
      t.lx = lx; t.ly = ly;
      t.range = Math.round(dist(p.x, p.y, t.x, t.y));
      G.aimA = Math.atan2(ly - p.y, lx - p.x);
      G.aimD = clamp(dist(p.x, p.y, lx, ly), GUN.minRange, GUN.maxRange);
    } else {
      G.aimA = Math.atan2(wy - p.y, wx - p.x);
      G.aimD = clamp(dist(p.x, p.y, wx, wy), GUN.minRange, GUN.maxRange);
    }
    if (t && (!G.lock || G.lock.id !== t.id)) audio.lock();
    G.lock = t;
  } else G.lock = null;

  // --- helm ----------------------------------------------------------------
  // The helm holds its last order while the player types, rather than
  // slamming amidships mid-turn.
  let rud = 0;
  if (input.has('A', 'ArrowLeft')) rud -= 1;
  if (input.has('D', 'ArrowRight')) rud += 1;
  if (hud.chatOpen) rud = p ? clamp(p.rudder ?? 0, -1, 1) : 0;

  if (input.tapped('W') || input.tapped('ArrowUp')) setSails(+1);
  if (input.tapped('S') || input.tapped('ArrowDown')) setSails(-1);

  // --- guns ----------------------------------------------------------------
  const pk = { fL: false, fR: false, fC: false };
  if (alive) {
    const bearsPort = Math.abs(angleDiff(p.heading - Math.PI / 2, G.aimA)) <= GUN.arc;
    const bearsStbd = Math.abs(angleDiff(p.heading + Math.PI / 2, G.aimA)) <= GUN.arc;
    if (input.clicked.L) {
      // Fire whichever battery can actually bear. Explicit keys still work.
      //
      // A click on a battery that is still being run out used to be swallowed
      // in silence: the packet went up, the server dropped it, and the player
      // was left clicking at nothing with no idea why. Every click now gets an
      // answer — the shot, "she will not bear", or how long the reload has left.
      const pick = (bearsPort && (!bearsStbd || me.rlL <= me.rlR)) ? 'L' : bearsStbd ? 'R' : null;
      if (!pick) hud.wontBear(angleDiff(p.heading, G.aimA));
      else {
        const rl = pick === 'L' ? me.rlL : me.rlR;
        if (rl > 0.001) { hud.stillLoading(rl * (me.reload || GUN.reloadBase), pick); audio.notLoaded(); }
        else if (pick === 'L') pk.fL = true;
        else pk.fR = true;
      }
    }
    if (input.clicked.R && me.chase) pk.fC = true;
    if (input.tapped('Q')) pk.fL = true;
    if (input.tapped('E')) pk.fR = true;
  }

  // --- shot, stance, mines -------------------------------------------------
  let shot = null, stance = null, mine = false;
  for (let i = 0; i < 3; i++) if (input.tapped(String(i + 1))) shot = SHOT_IDS[i];
  const stKeys = ['Z', 'X', 'C', 'V'], stIds = ['battle', 'chase', 'repair', 'scout'];
  for (let i = 0; i < 4; i++) if (input.tapped(stKeys[i])) stance = stIds[i];
  if (input.tapped('R')) mine = true;
  if (shot) G.shot = shot;

  // --- signals and fleet talk ----------------------------------------------
  if (input.tapped('G') && p) sendPing('attack');
  if (input.has('T')) hud.signalWheel = true;
  else if (hud.signalWheel) {
    const pick = hud.closeSignalWheel(input.mx * scene.dpr, input.my * scene.dpr);
    if (pick) sendPing(pick);
  }
  if (input.has('Y')) hud.chatWheel = true;
  else if (hud.chatWheel) {
    const pick = hud.closeChatWheel(input.mx * scene.dpr, input.my * scene.dpr);
    if (pick) { net.send({ k: 'chat', q: pick }); audio.rope(); }
  }
  if (input.tapped('Enter')) hud.openChat();

  // --- captain's orders ----------------------------------------------------
  if (me && me.isCaptain) {
    for (let i = 1; i <= 5; i++) if (input.chord(i)) hud.selectOrderByIndex(i - 1);
    if (input.clicked.L && hud.pendingOrder) {
      const [wx, wy] = scene.toWorld(input.mx * scene.dpr, input.my * scene.dpr);
      placeOrder(hud.pendingOrder, wx, wy);
      pk.fL = false;
    }
  }

  // --- view ----------------------------------------------------------------
  if (input.tapped('M')) G.tactical = !G.tactical;
  if (input.tapped('H')) hud.toggleHelp();
  if (input.tapped('F1')) hud.toggleBriefing();
  if (input.wheel) G.zoomAdj = clamp(G.zoomAdj * (input.wheel > 0 ? 0.88 : 1.14), 0.42, 2.4);
  // The roster is a toggle rather than hold-to-peek: it carries the buttons for
  // taking command and changing sides, and you cannot click one of those with
  // a finger still on Tab.
  if (input.tapped('Tab')) hud.scoreboard = !hud.scoreboard;
  if (input.tapped('Escape')) {
    if (hud.briefing) hud.closeBriefing();
    else { hud.scoreboard = false; hud.pendingOrder = null; hud.hideCoach(); }
  }

  // --- predict locally -----------------------------------------------------
  if (alive) {
    p.rudder = rud;
    // Predict the squall too. Leaving it out made the client and the server
    // disagree by metres every tick in bad weather, which reads as the ship
    // juddering exactly when you most need her to answer the helm.
    const sq = squallAt(p.x, p.y);
    stepShip(p, G.wind, dt, {
      islands: G.world.islands, worldW: G.world.w, worldH: G.world.h,
      now: (G.last?.now || 0),
      inSquall: !!sq, squallPush: sq ? { x: sq.px, y: sq.py } : null,
      inSupply: me.inSupply, supplyRepair: 0,
    });
  }

  // --- packet --------------------------------------------------------------
  inputAcc += dt;
  const due = inputAcc >= 1 / INPUT_HZ;
  if (due || pk.fL || pk.fR || pk.fC || mine || shot || stance || hud.shiftQueue) {
    inputAcc = 0;
    net.send({
      k: 'in', seq: ++G.seq,
      rudder: rud, sails: p ? p.sails : 2, sweeps: input.has(' '),
      shot: G.shot, aimA: G.aimA, aimD: G.aimD,
      fL: pk.fL, fR: pk.fR, fC: pk.fC, mine,
      stance, hull: hud.pickedHull,
      shift: hud.takeShift(),
    });
  }
  if (p) p.sweeps = input.has(' ');
  input.drain();
}

/** The squall over a point, matching the server's own reckoning. */
function squallAt(x, y) {
  const list = G.last?.squalls || [];
  let best = 0, dir = 0;
  for (const q of list) {
    if (!q.r) continue;
    const d = dist(x, y, q.x, q.y);
    if (d > q.r) continue;
    const k = 1 - d / q.r;
    if (k > best) { best = k; dir = q.d; }
  }
  if (best <= 0) return null;
  const push = SQUALL_PUSH * best;
  return { k: best, px: Math.cos(dir) * push, py: Math.sin(dir) * push };
}

function setSails(d) {
  if (!G.pred) return;
  G.pred.sails = clamp(G.pred.sails + d, 0, 3);
  audio.rope();
}
function sendPing(id) {
  const [wx, wy] = scene.toWorld(input.mx * scene.dpr, input.my * scene.dpr);
  net.send({ k: 'ping', id, x: wx, y: wy });
}
function placeOrder(id, x, y) {
  const ord = G.rules.ORDERS[id];
  if (ord && ord.target === 'hold') {
    const h = G.world.holds.reduce((b, hh) => dist(hh.x, hh.y, x, y) < dist(b.x, b.y, x, y) ? hh : b, G.world.holds[0]);
    net.send({ k: 'order', id, hold: h.id });
  } else {
    net.send({ k: 'order', id, x, y });
  }
  hud.pendingOrder = null;
  audio.chime();
}
hud.onBuy  = (id) => net.send({ k: 'buy', id });
hud.onSell = (id) => net.send({ k: 'sell', id });
hud.onOrderAtHold = (id, holdId) => { net.send({ k: 'order', id, hold: holdId }); hud.pendingOrder = null; };
hud.onSay  = (msg) => net.send({ k: 'chat', ...msg });
hud.onCommand = (act) => net.send({ k: 'cmd', act });
hud.onSide = () => net.send({ k: 'side' });
hud.onHail = (fromCaptain) => audio.hail(fromCaptain);
hud.onReady = () => audio.ready();
hud.onBilge = () => audio.bilge();

// ---------------------------------------------------------------------------
//  Interpolated view of everything the server owns
// ---------------------------------------------------------------------------
function buildView() {
  const now = performance.now() - INTERP_MS;
  let a = null, b = null;
  for (let i = G.snaps.length - 1; i >= 0; i--) {
    if (G.snaps[i].recv <= now) { a = G.snaps[i]; b = G.snaps[i + 1] || null; break; }
  }
  if (!a) a = G.snaps[0];
  if (!a) return null;
  const t = b ? clamp((now - a.recv) / Math.max(1, b.recv - a.recv), 0, 1) : 0;

  // Shot in flight, walked on to the same moment the ships are drawn at.
  // Taking these from the newest packet while the ships came from one a tenth
  // of a second older put every tracer eighty metres ahead of the broadside
  // that fired it.
  const ballDt = (now - a.recv) / 1000;
  const balls = (a.balls || []).map(q => ({
    ...q,
    x: q.x + Math.cos(q.a || 0) * GUN.ballSpeed * ballDt,
    y: q.y + Math.sin(q.a || 0) * GUN.ballSpeed * ballDt,
  }));

  const ships = [];
  const bMap = b ? new Map(b.ships.map(s => [s.id, s])) : null;
  for (const s of a.ships) {
    const n = bMap ? bMap.get(s.id) : null;
    if (!n) { ships.push(s); continue; }
    ships.push({
      ...s,
      x: lerp(s.x, n.x, t), y: lerp(s.y, n.y, t),
      a: s.a + angleDiff(s.a, n.a) * t,
      v: lerp(s.v, n.v, t),
      al: s.al + angleDiff(s.al, n.al) * t,
    });
  }
  return { ...(G.last || a), ships, balls };
}

// ---------------------------------------------------------------------------
//  Frame
// ---------------------------------------------------------------------------
let prev = performance.now();
function frame(t) {
  requestAnimationFrame(frame);
  let dt = (t - prev) / 1000;
  prev = t;
  if (dt > 0.1) dt = 0.1;

  const dpr = Math.min(devicePixelRatio || 1, 2);
  scene.resize(Math.round(innerWidth * dpr), Math.round(innerHeight * dpr), dpr);
  hud.resize(innerWidth, innerHeight, dpr);

  if (!G.world) { hud.drawBoot(); return; }

  const S = buildView();
  const me = G.me;
  const p = G.pred;

  gatherInput(dt, S);

  // --- wind, smoothed for the gauges --------------------------------------
  G.windVis.dir = dampAngle(G.windVis.dir, G.wind.dir, 6, dt);
  G.windVis.speed = damp(G.windVis.speed, G.wind.speed, 6, dt);

  // --- camera --------------------------------------------------------------
  const anchor = p || (me && { x: me.x, y: me.y }) || { x: G.world.w / 2, y: G.world.h / 2 };
  const lookX = p ? Math.cos(G.aimA) * Math.min(G.aimD, 700) * 0.16 : 0;
  const lookY = p ? Math.sin(G.aimA) * Math.min(G.aimD, 700) * 0.16 : 0;
  const leadX = p ? Math.cos(p.heading) * p.speed * 0.55 : 0;
  const leadY = p ? Math.sin(p.heading) * p.speed * 0.55 : 0;

  const fit = Math.min(scene.w / G.world.w, scene.h / G.world.h) * 0.94;
  const baseZ = Math.max(scene.h / VIEW_H, scene.w / VIEW_W) * G.zoomAdj;
  const wantZ = G.tactical ? fit : baseZ;
  G.cam.zoom = damp(G.cam.zoom, wantZ, G.tactical ? 6 : 4, dt);

  // Push the camera down the screen so your own ship rides above the middle,
  // clear of the point-of-sail gauge that used to sit right on top of her.
  const up = G.tactical ? 0 : (scene.h / G.cam.zoom) * SHIP_UP;
  const wantX = G.tactical ? G.world.w / 2 : anchor.x + lookX + leadX;
  const wantY = G.tactical ? G.world.h / 2 : anchor.y + lookY + leadY + up;
  G.cam.x = damp(G.cam.x, wantX, 7, dt);
  G.cam.y = damp(G.cam.y, wantY, 7, dt);

  shakeAmt = Math.max(0, shakeAmt - dt * 26);
  scene.cam.x = G.cam.x + (Math.random() - 0.5) * shakeAmt;
  scene.cam.y = G.cam.y + (Math.random() - 0.5) * shakeAmt;
  scene.cam.zoom = G.cam.zoom;

  // --- render --------------------------------------------------------------
  const squalls = (S?.squalls || []).map(q => ({ x: q.x, y: q.y, r: q.r, k: 1 }));
  scene.damage = Math.max(0, scene.damage - dt * 1.6);
  scene.desat = damp(scene.desat, me && !me.alive ? 0.85 : 0, 5, dt);
  scene.beginFrame(dt, {
    windDir: G.wind.dir, windSpeed: G.wind.speed, squalls,
    dawn: clamp((S?.now || 0) / 900000, 0, 1),
  });
  scene.drawWorld();

  view.t = scene.time;
  P.step(dt, G.wind);

  if (S) drawScene(S, me);
  P.render(scene);
  scene.endFrame();

  if (S && p) nearMisses(S, p);

  hud.draw(S, me, {
    pred: p, wind: G.windVis, aimA: G.aimA, aimD: G.aimD, shot: G.shot,
    tactical: G.tactical, net, particles: P.live, dt, lock: G.lock,
    mx: input.mx * scene.dpr, my: input.my * scene.dpr,
  });
}

/**
 * A round going past your ear. Shot that misses is most of the shot in the
 * game, and it was completely silent — so being under fire and being ignored
 * felt exactly the same. It does not any more.
 */
function nearMisses(S, p) {
  let closest = 1e9;
  for (const b of S.balls || []) {
    if (b.t === S.team) continue;
    const d = dist(b.x, b.y, p.x, p.y);
    if (d < closest) closest = d;
  }
  if (closest < 190) audio.whistle(closest, panAt(p.x, p.y));
}

function drawScene(S, me) {
  const env = {
    now: S.now, windDir: G.wind.dir, windSpeed: G.wind.speed,
    hullLen: G.rules ? Object.fromEntries([
      ...Object.entries(G.rules.HULLS).map(([k, v]) => [k, v.len]), ['flagship', FLAGSHIP.len],
    ]) : {},
  };

  // --- ground-level markers, under everything -----------------------------
  for (const h of G.world.holds) {
    const st = S.holds.find(x => x.id === h.id);
    if (st) view.hold(h, st, env, S.team);
  }
  for (const r of S.rallies || []) {
    scene.draw('ring', r.x, r.y, r.r * 2, r.r * 2, scene.time * 0.25,
               [1, 0.84, 0.36, 0.22 + 0.10 * Math.sin(scene.time * 3)], 0.6, true);
  }
  for (const g of S.salvage || []) {
    const bob = Math.sin(scene.time * 2.4 + g.x * 0.01) * 3;
    scene.draw('glow', g.x, g.y, 130, 130, 0, [1, 0.82, 0.35, 0.30], 1.0, true);
    scene.draw('salvage', g.x, g.y + bob, 46, 46, Math.sin(scene.time + g.x) * 0.15, WHITE, 0.15);
  }
  for (const m of S.mines || []) {
    const own = m.t === S.team;
    scene.draw('mine', m.x, m.y, 40, 40, scene.time * 0.4 + m.x,
               own ? [0.7, 0.9, 1, 0.85] : [1, 0.75, 0.75, 0.95], m.a ? 0.25 : 0);
    if (own) scene.draw('ring', m.x, m.y, 120, 120, 0, [0.4, 0.7, 1, 0.16], 0.3, true);
  }

  // --- the Bullion Run -----------------------------------------------------
  if (S.convoy) {
    const c = S.convoy;
    scene.draw('glow', c.x, c.y, 420, 420, 0, [1, 0.84, 0.36, 0.28], 1.2, true);
    scene.draw('ship_barque', c.x + 5, c.y + 7, 190, 84, c.a, [0, 0, 0, 0.35]);
    scene.draw('ship_barque', c.x, c.y, 190, 84, c.a, [1, 0.97, 0.88, 1], 0.1);
    scene.draw('sail', c.x + Math.cos(c.a) * 22, c.y + Math.sin(c.a) * 22, 58, 92,
               G.wind.dir, [1, 1, 1, 0.95], 0.05, false, 0.30, 0);
  }

  // --- ships ---------------------------------------------------------------
  // Your own hull is held back and drawn after the weather. A smoke screen is
  // meant to hide you from THEM; laid over your own deck it hid the ship from
  // the person sailing her, which is the one thing the screen must never do.
  let self = null;
  for (const s of S.ships) {
    if (s.id === G.you) { self = s; continue; }
    view.ship(s, env, false);
  }

  // --- shot in flight ------------------------------------------------------
  // Drawn as a streak, sized in SCREEN space so it stays legible at every
  // zoom, and coloured by whose it is: gold going out, hot white-red coming
  // in. You should never have to wonder whether you are being shot at.
  const zk = 1 / Math.max(0.0001, scene.cam.zoom);
  const trLen = Math.max(52, 46 * zk);
  const trWid = Math.max(11, 9 * zk);
  for (const b of S.balls || []) {
    const mine = b.t === S.team;
    const a = b.a || 0;
    const col = b.s === 'chain' ? (mine ? [1, 0.96, 0.86, 0.95] : [1, 0.58, 0.52, 1])
              : b.s === 'grape' ? (mine ? [1, 0.88, 0.52, 0.95] : [1, 0.46, 0.34, 1])
              : (mine ? [1, 0.86, 0.46, 0.95] : [1, 0.32, 0.24, 1]);
    // the halo first, so the streak reads over bright water and pale sand
    scene.draw('glow', b.x, b.y, trLen * 1.5, trLen * 1.5, 0,
               [col[0], col[1], col[2], mine ? 0.16 : 0.26], 1.0, true);
    scene.draw('tracer', b.x, b.y, trLen, trWid, a, col, 1.6, true, 0.38, 0);
  }
  for (const sh of S.shells || []) {
    // A fort shell arcs: it rises and falls, with its shadow marking the fall.
    const arc = Math.sin(sh.k * Math.PI);
    const lift = arc * 70;
    // The ring on the water is where it is going to land, and it tightens as
    // the shell falls: a shore battery should never kill you out of nowhere.
    const closing = 1 - sh.k;
    scene.draw('ring', sh.tx, sh.ty, 190 + closing * 230, 190 + closing * 230, 0,
               [1, 0.35, 0.2, 0.26 + 0.44 * sh.k], 0.9, true);
    scene.draw('ball', sh.x, sh.y + 6 + arc * 4, 12, 12, 0, [0, 0, 0, 0.35]);
    scene.draw('ball', sh.x, sh.y - lift, 15 + arc * 6, 15 + arc * 6, 0, [1, 0.72, 0.42, 1], 0.5);
    scene.draw('glow', sh.x, sh.y - lift, 66, 66, 0, [1, 0.6, 0.25, 0.35], 1.2, true);
  }
  for (const b of S.bombs || []) {
    scene.draw('ball', b.x, b.y, 14, 14, 0, [0.2, 0.2, 0.22, 1]);
  }

  // --- telegraphed sky raids ----------------------------------------------
  for (const r of S.raids || []) {
    const k = clamp(1 - (r.at - S.now) / 4000, 0, 1);
    const col = TEAM[r.t].rgb;
    const n = 9;
    for (let i = 0; i < n; i++) {
      const t = (i / (n - 1) - 0.5) * r.L;
      const x = r.x + Math.cos(r.a) * t, y = r.y + Math.sin(r.a) * t;
      scene.draw('ring', x, y, r.W * 2.2, r.W * 2.2, 0,
                 [col[0], col[1], col[2], 0.16 + 0.34 * Math.abs(Math.sin(scene.time * 7 + i))], 0.8, true);
    }
    // the balloon itself, running in
    const bx = r.x - Math.cos(r.a) * (1 - k) * 2600, by = r.y - Math.sin(r.a) * (1 - k) * 2600;
    scene.draw('glow', bx, by, 260, 260, 0, [0.9, 0.9, 0.95, 0.30], 0.6, true);
    scene.draw('smoke', bx, by, 190, 130, r.a, [0.85, 0.83, 0.80, 0.85], 0.2);
  }

  // --- weather -------------------------------------------------------------
  for (const q of S.squalls || []) if (q.r > 0) view.squall(q);
  for (const sm of S.smokes || []) view.smoke(sm);

  // ... and here she is, on top of all of it.
  if (self) view.ship(self, env, true);

  // --- vague contacts a lookout has reported -------------------------------
  for (const g of S.ghosts || []) {
    scene.draw('glow', g.x, g.y, 220, 220, 0, [1, 0.9, 0.6, 0.10], 0.4, true);
  }
}

// Handy for poking at the renderer from the console while tuning.
window.__game = { scene, G, P, view, hud, net };

requestAnimationFrame(frame);

addEventListener('pointerdown', () => audio.resume(), { once: true });
addEventListener('keydown', () => audio.resume(), { once: true });
