// ============================================================================
//  Turning game state into draw calls: ships, sails, forts, weather, and the
//  particle system that sells every one of them.
// ============================================================================
import { HULL_ART } from './gl/art.js';
import { TEAM, HOLD, GUN, SHOT, MINE, RALLY, SMOKE, SKYRAID } from '/shared/constants.js';
import { clamp, lerp, wrapAngle, angleDiff, TAU } from '/shared/math.js';

const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[(Math.random() * a.length) | 0];

// ---------------------------------------------------------------------------
//  Particles
// ---------------------------------------------------------------------------
const MAX_P = 3200;

export class Particles {
  constructor() {
    this.p = [];
    for (let i = 0; i < MAX_P; i++) this.p.push({ on: false });
    this.next = 0;
  }
  spawn(o) {
    // Ring allocation: at full tilt the oldest particle is simply reused.
    for (let i = 0; i < 24; i++) {
      const q = this.p[this.next];
      this.next = (this.next + 1) % MAX_P;
      if (!q.on) return Object.assign(q, o, { on: true, age: 0 });
    }
    const q = this.p[this.next];
    this.next = (this.next + 1) % MAX_P;
    return Object.assign(q, o, { on: true, age: 0 });
  }
  step(dt, wind) {
    for (const q of this.p) {
      if (!q.on) continue;
      q.age += dt;
      if (q.age >= q.life) { q.on = false; continue; }
      const k = q.age / q.life;
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      if (q.windK) { q.vx += Math.cos(wind.dir) * wind.speed * q.windK * dt * 30; q.vy += Math.sin(wind.dir) * wind.speed * q.windK * dt * 30; }
      const dr = Math.exp(-(q.drag || 1.6) * dt);
      q.vx *= dr; q.vy *= dr;
      if (q.spin) q.rot += q.spin * dt;
      q.k = k;
    }
  }
  render(scene) {
    for (const q of this.p) {
      if (!q.on) continue;
      const k = q.k;
      const fade = q.fade ? q.fade(k) : (1 - k);
      const size = q.size * (q.grow ? lerp(1, q.grow, k) : 1);
      const c = q.col;
      scene.draw(q.sprite, q.x, q.y, size, size * (q.aspect || 1), q.rot || 0,
                 [c[0], c[1], c[2], c[3] * fade], q.glow || 0, !!q.add);
    }
  }
  get live() { let n = 0; for (const q of this.p) if (q.on) n++; return n; }
}

// ---------------------------------------------------------------------------
//  Emitters
// ---------------------------------------------------------------------------
const SMOKE_COL = [0.80, 0.80, 0.82, 1];
const DARK_SMOKE = [0.18, 0.17, 0.17, 1];
const FIRE_COL = [1.0, 0.55, 0.18, 1];
const SPRAY = [0.86, 0.95, 0.98, 1];

export const emit = {
  muzzle(P, x, y, a, n = 4) {
    for (let i = 0; i < n; i++) {
      const sp = rnd(90, 230), ang = a + rnd(-0.22, 0.22);
      P.spawn({ sprite: 'smoke', x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
                life: rnd(1.5, 2.6), size: rnd(46, 86), grow: 3.2, drag: 1.5,
                col: SMOKE_COL.slice(), rot: rnd(0, TAU), spin: rnd(-0.6, 0.6), windK: 0.5 });
    }
    P.spawn({ sprite: 'flash', x: x + Math.cos(a) * 14, y: y + Math.sin(a) * 14,
              vx: Math.cos(a) * 40, vy: Math.sin(a) * 40, life: 0.13, size: 210, aspect: 0.75,
              rot: a, col: [1, 0.92, 0.72, 1], add: true, glow: 2.2, drag: 6,
              fade: k => 1 - k * k });
    for (let i = 0; i < 5; i++) {
      const ang = a + rnd(-0.5, 0.5);
      P.spawn({ sprite: 'spark', x, y, vx: Math.cos(ang) * rnd(200, 520), vy: Math.sin(ang) * rnd(200, 520),
                life: rnd(0.2, 0.5), size: rnd(5, 11), col: [1, 0.82, 0.42, 1], add: true, glow: 1.6, drag: 3.4 });
    }
  },

  splash(P, x, y, scale = 1) {
    for (let i = 0; i < 6; i++) {
      const a = rnd(0, TAU);
      P.spawn({ sprite: 'foam', x, y, vx: Math.cos(a) * rnd(30, 120) * scale, vy: Math.sin(a) * rnd(30, 120) * scale,
                life: rnd(0.5, 1.0), size: rnd(22, 44) * scale, grow: 2.1, drag: 3.2,
                col: SPRAY.slice(), rot: rnd(0, TAU) });
    }
  },

  hit(P, x, y, shot = 'round') {
    const col = shot === 'chain' ? [0.85, 0.86, 0.9, 1] : shot === 'grape' ? [1, 0.75, 0.4, 1] : [1, 0.62, 0.26, 1];
    P.spawn({ sprite: 'glow', x, y, life: 0.22, size: 120, col: col.slice(), add: true, glow: 2.4, drag: 8,
              fade: k => 1 - k });
    for (let i = 0; i < 9; i++) {
      const a = rnd(0, TAU);
      P.spawn({ sprite: 'spark', x, y, vx: Math.cos(a) * rnd(120, 420), vy: Math.sin(a) * rnd(120, 420),
                life: rnd(0.25, 0.7), size: rnd(4, 10), col: [1, 0.78, 0.36, 1], add: true, glow: 1.4, drag: 2.6 });
    }
    for (let i = 0; i < 4; i++) {
      const a = rnd(0, TAU);
      P.spawn({ sprite: 'smoke', x, y, vx: Math.cos(a) * rnd(20, 90), vy: Math.sin(a) * rnd(20, 90),
                life: rnd(0.8, 1.6), size: rnd(24, 48), grow: 2.4, drag: 2.0,
                col: DARK_SMOKE.slice(), rot: rnd(0, TAU), spin: rnd(-1, 1), windK: 0.4 });
    }
  },

  explode(P, x, y, power = 1) {
    P.spawn({ sprite: 'glow', x, y, life: 0.42, size: 260 * power, col: [1, 0.86, 0.55, 1],
              add: true, glow: 3.2, drag: 7, grow: 1.9, fade: k => Math.pow(1 - k, 1.6) });
    for (let i = 0; i < 14 * power; i++) {
      const a = rnd(0, TAU), sp = rnd(120, 520) * power;
      P.spawn({ sprite: 'spark', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
                life: rnd(0.35, 1.0), size: rnd(5, 14), col: [1, pick([0.5, 0.7, 0.85]), 0.28, 1],
                add: true, glow: 1.8, drag: 2.0 });
    }
    for (let i = 0; i < 9 * power; i++) {
      const a = rnd(0, TAU), sp = rnd(40, 180) * power;
      P.spawn({ sprite: 'smoke', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
                life: rnd(1.6, 3.4), size: rnd(50, 110) * power, grow: 2.8, drag: 1.3,
                col: DARK_SMOKE.slice(), rot: rnd(0, TAU), spin: rnd(-0.7, 0.7), windK: 0.7 });
    }
    emit.splash(P, x, y, power * 1.4);
  },

  fire(P, x, y, vx = 0, vy = 0) {
    P.spawn({ sprite: 'glow', x: x + rnd(-8, 8), y: y + rnd(-8, 8), vx: vx * 0.3 + rnd(-14, 14), vy: vy * 0.3 - rnd(8, 30),
              life: rnd(0.3, 0.6), size: rnd(30, 62), col: FIRE_COL.slice(), add: true, glow: 2.6, drag: 2.4,
              grow: 0.5, fade: k => Math.pow(1 - k, 1.4) });
    if (Math.random() < 0.55) {
      P.spawn({ sprite: 'smoke', x, y, vx: vx * 0.2, vy: vy * 0.2 - rnd(10, 26),
                life: rnd(1.6, 3.2), size: rnd(34, 70), grow: 3.0, drag: 1.1,
                col: [0.12, 0.11, 0.11, 1], rot: rnd(0, TAU), spin: rnd(-0.5, 0.5), windK: 0.9 });
    }
  },

  wake(P, x, y, a, speed) {
    const s = clamp(speed / 130, 0, 1.4);
    P.spawn({ sprite: 'foam', x, y, vx: rnd(-6, 6), vy: rnd(-6, 6),
              life: rnd(1.1, 2.0), size: rnd(11, 18) * (0.5 + s), grow: 2.2, drag: 1.5,
              col: [0.78, 0.89, 0.93, 0.22 * s], rot: rnd(0, TAU) });
  },

  bow(P, x, y, a, speed) {
    const s = clamp(speed / 150, 0, 1);
    if (s < 0.25) return;
    for (let i = 0; i < 2; i++) {
      const side = i ? 1 : -1;
      const ang = a + side * rnd(0.5, 1.0);
      P.spawn({ sprite: 'foam', x, y, vx: Math.cos(ang) * rnd(24, 70) * s, vy: Math.sin(ang) * rnd(24, 70) * s,
                life: rnd(0.4, 0.9), size: rnd(8, 16) * s, grow: 2.2, drag: 2.6,
                col: [0.90, 0.96, 1, 0.34 * s], rot: rnd(0, TAU) });
    }
  },

  sink(P, x, y) {
    emit.explode(P, x, y, 1.5);
    for (let i = 0; i < 18; i++) {
      const a = rnd(0, TAU);
      P.spawn({ sprite: 'smoke', x, y, vx: Math.cos(a) * rnd(10, 60), vy: Math.sin(a) * rnd(10, 60),
                life: rnd(3, 6), size: rnd(60, 140), grow: 2.4, drag: 0.9,
                col: [0.10, 0.10, 0.11, 1], rot: rnd(0, TAU), spin: rnd(-0.4, 0.4), windK: 1.0 });
    }
  },

  capture(P, x, y, col) {
    for (let i = 0; i < 40; i++) {
      const a = rnd(0, TAU), r = rnd(0, HOLD.captureR);
      P.spawn({ sprite: 'spark', x: x + Math.cos(a) * r, y: y + Math.sin(a) * r,
                vx: Math.cos(a) * 60, vy: Math.sin(a) * 60 - 40,
                life: rnd(0.8, 1.8), size: rnd(8, 18), col: [...col, 1], add: true, glow: 2.0, drag: 1.2 });
    }
    P.spawn({ sprite: 'ring', x, y, life: 1.1, size: HOLD.captureR * 2, grow: 1.5,
              col: [...col, 0.9], add: true, glow: 1.5, fade: k => 1 - k });
  },
};

// ---------------------------------------------------------------------------
//  Drawing the world
// ---------------------------------------------------------------------------
const SAIL_SPREAD = [0, 0.52, 0.86, 1.0];

export class WorldView {
  constructor(scene, particles) {
    this.scene = scene;
    this.P = particles;
    this.trail = new Map();     // ship id -> wake bookkeeping
    this.t = 0;
  }

  teamCol(t, a = 1) { const c = TEAM[t].rgb; return [c[0], c[1], c[2], a]; }

  /** One ship: shadow, hull, trimmed sails, damage, team marking. */
  ship(s, env, isMe) {
    const S = this.scene;
    const art = HULL_ART[s.h] || HULL_ART.brigantine;
    const key = HULL_ART[s.h] ? s.h : 'brigantine';

    // The sprite cell holds the hull plus room for the bowsprit, so size the
    // quad from the fraction the hull actually occupies. The drawn ship then
    // matches the length the physics uses.
    const realLen = (env.hullLen[s.h] || 60) * 1.06;
    const cellAspect = art.cell ? art.cell[1] / art.cell[0] : 224 / 640;
    const qw = realLen / (art.frac || 0.72);
    const qh = qw * cellAspect;
    const beam = realLen * (art.B / art.L);
    const a = s.a;

    const heel = Math.sin(this.t * 1.7 + s.x * 0.01) * 0.010;
    const bob = 1 + Math.sin(this.t * 2.3 + s.y * 0.013) * 0.010;

    // --- team light on the water, so friend and foe read instantly ---------
    S.draw('glow', s.x, s.y, realLen * 2.1, realLen * 2.1, 0,
           this.teamCol(s.t, isMe ? 0.20 : 0.15), 0.5, true);

    // --- shadow ------------------------------------------------------------
    S.draw('ship_' + key, s.x + realLen * 0.04, s.y + realLen * 0.05, qw, qh, a, [0, 0, 0, 0.32]);

    // --- hull --------------------------------------------------------------
    const dmg = clamp(s.hp / 100, 0, 1);
    const tint = [lerp(0.70, 1, dmg), lerp(0.60, 1, dmg), lerp(0.56, 1, dmg), 1];
    S.draw('ship_' + key, s.x, s.y, qw * bob, qh * bob, a + heel, tint);

    // --- yards and sails, trimmed to the wind ------------------------------
    // A yard wants to lie square to the wind; the shrouds stop it bracing any
    // closer than about twenty degrees to the keel. The sail then bellies
    // straight to leeward off that yard. Watching the yards swing as you tack
    // is most of what makes a ship feel like a ship.
    const spread = SAIL_SPREAD[s.s] * clamp(s.sp / 100, 0.25, 1);
    // Brace the yards to bisect the angle between the wind and the keel: square
    // when running, about 45 degrees on a beam reach, hard round close-hauled.
    // The shrouds stop them coming closer than roughly twenty degrees.
    const windFrom = env.windDir + Math.PI;
    const rel = angleDiff(a, windFrom);
    const theta = Math.abs(rel);                       // 0 = in irons, PI = running
    const side = rel >= 0 ? 1 : -1;                    // which side the wind is on
    const yardA = a + side * clamp(theta / 2, 0.36, Math.PI / 2);
    // The canvas then bellies to leeward off that yard.
    const sailA = yardA + (angleDiff(yardA, env.windDir) > 0 ? 1 : -1) * Math.PI / 2;

    for (const m of art.masts) {
      const mx = s.x + Math.cos(a) * (m.at * realLen);
      const my = s.y + Math.sin(a) * (m.at * realLen);
      const yardLen = beam * m.yard * 2;
      if (spread > 0.02) {
        // A sail braced hard round is sheeted flat; running, it bags right out.
        const belly = lerp(0.30, 0.58, clamp(theta / Math.PI, 0, 1));
        const sh = yardLen * 0.92;
        const sw = sh * belly * lerp(0.40, 1, spread);
        S.draw('sail', mx, my, sw, sh, sailA, [1, 1, 1, 0.86], 0.04, false, 0.36, 0);
      }
      S.draw('yard', mx, my, yardLen, yardLen * 0.10, yardA, [1, 1, 1, 1], 0);
    }

    // --- pennant -----------------------------------------------------------
    const px = s.x + Math.cos(a) * (-realLen * 0.44), py = s.y + Math.sin(a) * (-realLen * 0.44);
    S.draw('banner', px, py, beam * 0.70, beam * 0.70, a, this.teamCol(s.t, 0.95), 0.3);

    // --- condition ---------------------------------------------------------
    if (s.hp < 55 && Math.random() < 0.30) {
      this.P.spawn({ sprite: 'smoke', x: s.x + rnd(-beam * 0.4, beam * 0.4), y: s.y + rnd(-beam * 0.4, beam * 0.4),
                     vx: rnd(-10, 10), vy: rnd(-24, -6), life: rnd(1.6, 3.2),
                     size: rnd(28, 60), grow: 2.8, drag: 1.1,
                     col: [0.17, 0.16, 0.16, s.hp < 28 ? 0.9 : 0.5], rot: rnd(0, TAU), windK: 0.9 });
    }
    if (s.f) emit.fire(this.P, s.x + rnd(-beam * 0.4, beam * 0.4), s.y + rnd(-beam * 0.4, beam * 0.4));

    // --- wake --------------------------------------------------------------
    let tr = this.trail.get(s.id);
    if (!tr) { tr = { d: 0, lx: s.x, ly: s.y }; this.trail.set(s.id, tr); }
    tr.d += Math.hypot(s.x - tr.lx, s.y - tr.ly);
    tr.lx = s.x; tr.ly = s.y;
    if (tr.d > 30 && s.v > 12) {
      tr.d = 0;
      const stern = -realLen * 0.48;
      emit.wake(this.P, s.x + Math.cos(a) * stern, s.y + Math.sin(a) * stern, a, s.v);
      emit.bow(this.P, s.x + Math.cos(a) * realLen * 0.46, s.y + Math.sin(a) * realLen * 0.46, a, s.v);
    }

    // --- states worth showing ----------------------------------------------
    if (s.iv > env.now) {
      const k = clamp((s.iv - env.now) / 3200, 0, 1);
      S.draw('ring', s.x, s.y, realLen * 2.4, realLen * 2.4, 0, this.teamCol(s.t, 0.32 * k), 0.8, true);
    }
    if (s.ra > env.now) {
      S.draw('ring', s.x, s.y, realLen * 2.0, realLen * 2.0, this.t * 0.6, [1, 0.86, 0.4, 0.38], 1.2, true);
    }
  }

  /** A hold: fort, banner, capture ring, danger circle. */
  hold(h, st, env, myTeam) {
    const S = this.scene;
    const R = h.r;
    const owner = st.o;
    const col = owner ? TEAM[owner].rgb : [0.72, 0.70, 0.62];

    // the battery itself
    const alive = st.hp > 0;
    const shake = alive ? 0 : Math.sin(this.t * 3) * 0.01;
    S.draw('fort', h.x, h.y, R * 1.15, R * 1.15, shake,
           alive ? [1, 1, 1, 1] : [0.55, 0.5, 0.48, 1]);
    S.draw('banner', h.x, h.y - R * 0.34, R * 0.40, R * 0.40, 0,
           [col[0], col[1], col[2], alive ? 1 : 0.35], alive ? 0.45 : 0);

    // the water you must hold to take it
    const pulse = 0.5 + 0.5 * Math.sin(this.t * 2.2);
    let ringA = 0.16;
    if (st.x) ringA = 0.30 + pulse * 0.26;
    else if (st.c > 0.01) ringA = 0.24 + pulse * 0.18;
    const ringCol = st.c > 0.01 && st.ct ? TEAM[st.ct].rgb : col;
    S.draw('ring', h.x, h.y, HOLD.captureR * 2, HOLD.captureR * 2, 0,
           [ringCol[0], ringCol[1], ringCol[2], ringA], 0.4, true);

    // The battery's reach is drawn on the interface canvas instead, as a
    // dashed line. Painted here as a soft additive ring it came out as a huge
    // red smear that read like a lens flare rather than "do not go in there".
    if (!alive) {
      // smouldering ruin
      if (Math.random() < 0.5) emit.fire(this.P, h.x + rnd(-R * 0.5, R * 0.5), h.y + rnd(-R * 0.5, R * 0.5));
    }
  }

  squall(q) {
    const S = this.scene;
    // The shader darkens the sea; this adds the visible cloud mass on top.
    const n = 7;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + this.t * 0.06;
      const r = q.r * 0.50;
      S.draw('smoke', q.x + Math.cos(a) * r, q.y + Math.sin(a) * r,
             q.r * 1.05, q.r * 1.05, a * 1.7, [0.12, 0.14, 0.18, 0.16], 0);
    }
    S.draw('smoke', q.x, q.y, q.r * 1.7, q.r * 1.7, this.t * 0.05, [0.10, 0.12, 0.16, 0.18], 0);
  }

  smoke(sm) {
    const S = this.scene;
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * TAU + this.t * 0.12;
      S.draw('smoke', sm.x + Math.cos(a) * sm.r * 0.45, sm.y + Math.sin(a) * sm.r * 0.45,
             sm.r * 1.15, sm.r * 1.15, a, [0.46, 0.46, 0.45, 0.42], 0);
    }
    S.draw('smoke', sm.x, sm.y, sm.r * 1.55, sm.r * 1.55, -this.t * 0.08, [0.52, 0.52, 0.50, 0.38], 0);
  }
}
