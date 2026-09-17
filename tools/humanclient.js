// ============================================================================
//  A headless player.
//
//  This is deliberately NOT the server's BotBrain. It joins over a real
//  WebSocket, sees only what a snapshot tells it, and plays from that — so it
//  exercises the netcode, the fog of war and the whole client contract the way
//  a person at a keyboard would. If something is missing from a snapshot, this
//  notices; the in-process bots never would.
// ============================================================================
import { WebSocket } from 'ws';
import {
  GUN, HOLD, PHASE, SHOT_IDS, UPGRADE_IDS, UPGRADES, ORDER_IDS, ORDERS,
  UPG_MAX, HULL_IDS, QUICKCHAT, INPUT_HZ,
} from '../shared/constants.js';
import { clamp, angleDiff, wrapAngle, dist, makeRng, rngRange, rngPick, TAU } from '../shared/math.js';

export class HumanClient {
  /**
   * @param {object} o  { url, name, team, seed, skill, role, onSnap, onErr }
   *   role: 'auto' | 'captain' | 'helm' — 'captain' asks for the deck on join.
   */
  constructor(o) {
    this.o = o;
    this.name = o.name;
    this.rng = makeRng((o.seed ?? Math.random() * 1e9) >>> 0);
    this.skill = o.skill ?? 1;
    this.snap = null; this.world = null; this.rules = null; this.you = null;
    this.seq = 0;
    this.denies = [];
    this.errors = [];
    this.sawPhases = new Set();
    this.bytesIn = 0; this.bytesOut = 0;
    this.msgs = 0; this.snaps = 0;
    this.closed = false;
    this.aimA = 0; this.aimD = 620;
    this.hold = null; this.holdT = 0;
    this.shot = 'round';
    this.buyT = rngRange(this.rng, 1, 4);
    this.orderT = rngRange(this.rng, 4, 12);
    this.chatT = rngRange(this.rng, 6, 30);
    this.tack = this.rng() < 0.5 ? 1 : -1;
    this.tackT = 0;
    this.aggro = rngRange(this.rng, 0.4, 1);
    this.wasCaptain = null;
    this.capChanges = 0;
    this.hullLosses = 0;
    this.lastHullId = null;
    this.lastAlive = null;
  }

  connect() {
    return new Promise((res, rej) => {
      const ws = new WebSocket(this.o.url);
      this.ws = ws;
      const t = setTimeout(() => rej(new Error(`${this.name}: connect timed out`)), 8000);
      ws.on('open', () => {});
      ws.on('error', (e) => { this.errors.push(String(e.message || e)); clearTimeout(t); rej(e); });
      ws.on('close', () => { this.closed = true; });
      ws.on('message', (raw) => {
        this.bytesIn += raw.length; this.msgs++;
        let m; try { m = JSON.parse(raw); } catch { this.errors.push('bad JSON'); return; }
        if (m.k === 'ping') return this.send({ k: 'pong' });
        if (m.k === 'full') { this.full = true; clearTimeout(t); return rej(new Error('room full')); }
        if (m.k === 'deny') { this.denies.push(m.why); return; }
        if (m.k === 'world') {
          // A fresh match: drop everything the old one left behind, including
          // its final board, which is revealed on purpose once it is over.
          this.board = null; this.chatSeen = null; this.roster = null; this.team = null;
          this.world = m.world; this.rules = m.rules; this.you = m.you;
          clearTimeout(t); res(this);
          if (this.o.role === 'captain') this.send({ k: 'cmd', act: 'claim' });
          return;
        }
        if (m.k === 'snap') { this.onSnap(m); return; }
        this.errors.push(`unknown message ${m.k}`);
      });
    });
  }

  send(o) {
    if (!this.ws || this.ws.readyState !== 1) return;
    const s = JSON.stringify(o);
    this.bytesOut += s.length;
    this.ws.send(s);
  }
  close() { try { this.ws?.close(); } catch {} }

  // -- snapshot ------------------------------------------------------------
  onSnap(s) {
    this.snaps++;
    // Carrying the roster across a change of sides would mean reading the old
    // fleet's unredacted view of what are now enemies — the real client drops
    // it for the same reason.
    if (s.team !== this.team) { this.team = s.team; this.board = null; this.chatSeen = null; }
    if (s.board) this.board = s.board;
    if (s.chat) this.chatSeen = s.chat;
    if (s.roster) this.roster = s.roster;
    this.snap = s;
    this.sawPhases.add(s.phase);

    const me = s.me;
    if (me) {
      const isCap = !!me.isCaptain;
      if (this.wasCaptain !== null && this.wasCaptain !== isCap) this.capChanges++;
      this.wasCaptain = isCap;
      // A hull that vanishes from under a live player is the bug this is here
      // to catch: command changing hands must never sink anybody.
      if (this.lastAlive === true && me.alive === false) this.hullLosses++;
      this.lastAlive = me.alive;
      this.lastHullId = me.hullId;
    }
    this.o.onSnap?.(this, s);
  }

  // -- play ----------------------------------------------------------------
  /** One decision tick. Called by the harness at INPUT_HZ. */
  step(dt) {
    const s = this.snap;
    if (!s || !this.world) return;
    const me = s.me;
    if (!me) return;

    if (!me.alive) {
      // Pick a hull for the next launch, the way the death screen does.
      if (!me.isCaptain && this.rng() < 0.08) {
        this.send({ k: 'in', seq: ++this.seq, hull: rngPick(this.rng, HULL_IDS) });
      }
      if (me.isCaptain) this.captainTurn(s, dt);
      return;
    }

    const goal = this.chooseGoal(s, me);
    const steer = this.steerTo(s, me, goal.x, goal.y);
    const pk = this.layGuns(s, me, goal);

    this.send({
      k: 'in', seq: ++this.seq,
      rudder: steer.rudder, sails: steer.sails, sweeps: steer.sweeps,
      shot: this.shot, aimA: this.aimA, aimD: this.aimD,
      fL: pk.fL, fR: pk.fR, fC: pk.fC, mine: pk.mine,
      stance: steer.stance,
    });

    if (me.isCaptain) this.captainTurn(s, dt);
    else this.crewTurn(s, dt);
  }

  /** Everything this player can actually see, from the snapshot alone. */
  enemies(s) { return s.ships.filter(o => o.t !== s.team); }
  friends(s) { return s.ships.filter(o => o.t === s.team && o.id !== this.you); }

  chooseGoal(s, me) {
    this.holdT -= 1 / INPUT_HZ;
    const foes = this.enemies(s).filter(e => dist(e.x, e.y, me.x, me.y) < 1500);
    const hp = me.hull / Math.max(1, me.hullMax);

    if (hp < 0.3 || me.ammo < 4) {
      const own = s.holds.filter(h => h.o === s.team);
      const h = own.map(h => this.world.holds.find(w => w.id === h.id))
                   .filter(Boolean)
                   .sort((a, b) => dist(a.x, a.y, me.x, me.y) - dist(b.x, b.y, me.x, me.y))[0];
      if (h) return { kind: 'run', x: h.x, y: h.y };
    }
    if (foes.length && (this.rng() < this.aggro || hp > 0.6)) {
      const t = foes.sort((a, b) => (a.hp - b.hp))[0];
      return { kind: 'fight', x: t.x, y: t.y, ship: t };
    }
    if (this.holdT <= 0 || this.hold === null) {
      const want = s.holds.filter(h => h.o !== s.team);
      const pick = want.map(h => ({ h, w: this.world.holds.find(w => w.id === h.id) }))
                       .filter(p => p.w)
                       .sort((a, b) => (b.h.hp <= 0 ? 1e6 : 0) - (a.h.hp <= 0 ? 1e6 : 0)
                                     + dist(a.w.x, a.w.y, me.x, me.y) - dist(b.w.x, b.w.y, me.x, me.y))[0];
      this.hold = pick ? pick.h.id : null;
      this.holdT = rngRange(this.rng, 14, 26);
    }
    const st = s.holds.find(h => h.id === this.hold);
    const w = this.world.holds.find(h => h.id === this.hold);
    if (!st || !w) return { kind: 'roam', x: this.world.w / 2, y: this.world.h / 2 };
    return { kind: st.hp > 0 ? 'siege' : 'land', x: w.x, y: w.y, hold: st, w };
  }

  steerTo(s, me, tx, ty) {
    let want = Math.atan2(ty - me.y, tx - me.x);
    // Tack when the course lies inside the no-go zone.
    const windFrom = s.wind.d + Math.PI;
    const off = Math.abs(angleDiff(want, windFrom));
    this.tackT -= 1 / INPUT_HZ;
    if (off < 0.68) {
      if (this.tackT <= 0) {
        const a1 = wrapAngle(windFrom + 0.82), a2 = wrapAngle(windFrom - 0.82);
        this.tack = Math.abs(angleDiff(a1, want)) < Math.abs(angleDiff(a2, want)) ? 1 : -1;
        this.tackT = rngRange(this.rng, 6, 12);
      }
      want = wrapAngle(windFrom + this.tack * 0.82);
    }
    const d = angleDiff(me.heading, want);
    const inIrons = Math.abs(angleDiff(me.heading, windFrom)) < 0.6 && Math.abs(me.speed) < 14;
    return {
      rudder: clamp(d * 1.9, -1, 1),
      sails: Math.abs(d) > 1.1 ? 2 : 3,
      sweeps: inIrons && me.stamina > 25,
      stance: (me.hull / Math.max(1, me.hullMax)) < 0.4 ? 'repair' : 'battle',
    };
  }

  layGuns(s, me, goal) {
    const pk = { fL: false, fR: false, fC: false, mine: false };
    let tx = null, ty = null, isFort = false;
    if (goal.kind === 'fight' && goal.ship) {
      const t = goal.ship;
      const d = dist(me.x, me.y, t.x, t.y);
      const flight = d / GUN.ballSpeed;
      tx = t.x + Math.cos(t.a) * t.v * flight;
      ty = t.y + Math.sin(t.a) * t.v * flight;
    } else if (goal.kind === 'siege' && goal.hold && goal.hold.hp > 0) {
      tx = goal.x; ty = goal.y; isFort = true;
    } else {
      const foes = this.enemies(s).filter(e => dist(e.x, e.y, me.x, me.y) < GUN.maxRange);
      if (foes[0]) { tx = foes[0].x; ty = foes[0].y; }
    }
    if (tx === null) return pk;

    const d = dist(me.x, me.y, tx, ty);
    if (d > GUN.maxRange || d < GUN.minRange * 0.7) return pk;
    const err = (1 - this.skill) * 0.06;
    this.aimA = wrapAngle(Math.atan2(ty - me.y, tx - me.x) + rngRange(this.rng, -err - 0.01, err + 0.01));
    this.aimD = clamp(d * (1 + rngRange(this.rng, -0.04, 0.04)), GUN.minRange, GUN.maxRange);
    this.shot = isFort ? 'round' : (this.rng() < 0.2 ? 'chain' : 'round');

    const bears = (side, rl) => {
      const beam = side === 0 ? me.heading : me.heading + side * Math.PI / 2;
      const arc = side === 0 ? GUN.chaseArc : GUN.arc;
      return rl <= 0.001 && Math.abs(angleDiff(beam, this.aimA)) <= arc * 0.9;
    };
    if (bears(-1, me.rlL)) pk.fL = true;
    else if (bears(+1, me.rlR)) pk.fR = true;
    else if (me.chase && bears(0, me.rlC)) pk.fC = true;
    if (me.mines > 0 && this.rng() < 0.0015) pk.mine = true;
    return pk;
  }

  /** Crew: signal for what the fleet needs, so the captain has something to do. */
  crewTurn(s, dt) {
    this.chatT -= dt;
    if (this.chatT > 0) return;
    this.chatT = rngRange(this.rng, 20, 55);
    if (this.rng() < 0.5) {
      const q = rngPick(this.rng, QUICKCHAT);
      this.send({ k: 'chat', q: q.id });
    } else {
      this.send({ k: 'ping', id: this.rng() < 0.5 ? 'help' : 'supply',
                  x: this.snap.me.x, y: this.snap.me.y });
    }
  }

  /** Captain: spend the purse, work the orders, answer the fleet. */
  captainTurn(s, dt) {
    const t = s.us;
    this.buyT -= dt;
    if (this.buyT <= 0) {
      this.buyT = rngRange(this.rng, 2, 5);
      const affordable = UPGRADE_IDS.filter(id => (t.upg[id] | 0) < UPG_MAX
                                                && t.doubloons >= UPGRADES[id].cost[t.upg[id] | 0]);
      if (affordable.length) this.send({ k: 'buy', id: rngPick(this.rng, affordable) });
      // Occasionally change the plan and sell something back.
      else if (this.rng() < 0.12) {
        const owned = UPGRADE_IDS.filter(id => (t.upg[id] | 0) > 0);
        if (owned.length) this.send({ k: 'sell', id: rngPick(this.rng, owned) });
      }
    }

    this.orderT -= dt;
    if (this.orderT <= 0 && s.phase !== PHASE.MUSTER) {
      this.orderT = rngRange(this.rng, 5, 12);
      const ready = ORDER_IDS.filter(id => (t.orderCd[id] || 0) <= 0
                                         && t.globalCd <= 0
                                         && t.doubloons >= ORDERS[id].cost);
      if (ready.length) {
        const id = rngPick(this.rng, ready);
        if (ORDERS[id].target === 'hold') {
          const own = s.holds.filter(h => h.o === s.team);
          if (own.length) this.send({ k: 'order', id, hold: rngPick(this.rng, own).id });
        } else {
          const foes = this.enemies(s);
          const p = foes.length ? rngPick(this.rng, foes)
                                : { x: this.world.w / 2, y: this.world.h / 2 };
          this.send({ k: 'order', id, x: p.x, y: p.y });
        }
      }
    }

    this.chatT -= dt;
    if (this.chatT <= 0) {
      this.chatT = rngRange(this.rng, 14, 40);
      this.send({ k: 'chat', t: rngPick(this.rng, [
        'taking the north gate, screen me',
        'saving for frames — hold what we have',
        'powder is bought, press them',
        'fall back to the roads and repair',
      ]) });
    }
  }
}
