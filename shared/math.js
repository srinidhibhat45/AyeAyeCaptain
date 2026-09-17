export const TAU = Math.PI * 2;
export const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
export const lerp  = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b - a) === 0 ? 0 : (v - a) / (b - a);
export const smoothstep = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
export const dist2 = (ax, ay, bx, by) => { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; };
export const dist  = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

/** Wrap an angle into (-PI, PI]. */
export function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}
/** Shortest signed delta from a -> b. */
export const angleDiff = (a, b) => wrapAngle(b - a);
/** Move angle a toward b by at most `max` radians. */
export function turnToward(a, b, max) {
  const d = angleDiff(a, b);
  return Math.abs(d) <= max ? b : a + Math.sign(d) * max;
}
export function lerpAngle(a, b, t) { return a + angleDiff(a, b) * t; }

/** Deterministic seeded PRNG (mulberry32) — same sequence on server + client. */
export function makeRng(seed) {
  let s = seed >>> 0;
  return function rng() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const rngRange = (rng, a, b) => a + rng() * (b - a);
export const rngInt   = (rng, a, b) => Math.floor(a + rng() * (b - a + 1));
export function rngPick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
export function shuffled(rng, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Is point inside a polygon given as a flat [x0,y0,x1,y1,...] array? */
export function pointInPoly(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
    const xi = pts[i], yi = pts[i + 1], xj = pts[j], yj = pts[j + 1];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Closest point on a polygon's edges to (px,py). Returns {x,y,d}. */
export function closestOnPoly(px, py, pts) {
  let bx = pts[0], by = pts[1], bd = Infinity;
  for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
    const ax = pts[j], ay = pts[j + 1], cx = pts[i], cy = pts[i + 1];
    const dx = cx - ax, dy = cy - ay;
    const len2 = dx * dx + dy * dy || 1;
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = clamp(t, 0, 1);
    const qx = ax + dx * t, qy = ay + dy * t;
    const d = dist2(px, py, qx, qy);
    if (d < bd) { bd = d; bx = qx; by = qy; }
  }
  return { x: bx, y: by, d: Math.sqrt(bd) };
}

/** Point vs. oriented ellipse (ship hull footprint). Returns normalised depth (<1 = inside). */
export function ellipseHit(px, py, cx, cy, heading, halfLen, halfBeam) {
  const dx = px - cx, dy = py - cy;
  const c = Math.cos(-heading), s = Math.sin(-heading);
  const lx = dx * c - dy * s, ly = dx * s + dy * c;
  return (lx * lx) / (halfLen * halfLen) + (ly * ly) / (halfBeam * halfBeam);
}

export function fmtTime(ms) {
  if (ms < 0) ms = 0;
  const t = Math.ceil(ms / 1000);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

/** Shortest distance from point p to segment ab. */
export function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

/**
 * Look a client-supplied key up in a lookup table, safely.
 *
 * `UPGRADES['__proto__']` is Object.prototype, which is truthy — so a plain
 * `TABLE[key]` guarded by `if (!v) return` sails straight past the guard and
 * then throws on the first property access. Anyone with a WebSocket could take
 * the server down with one message. Only own keys count.
 */
export function own(table, key) {
  return (typeof key === 'string' && Object.hasOwn(table, key)) ? table[key] : null;
}

/** Deterministic hash -> [0,1) from two integers. Handy for stable scatter. */
export function hash2(x, y) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Exponential smoothing that behaves correctly at any framerate. */
export const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.exp(-rate * dt));
export const dampAngle = (a, b, rate, dt) => a + angleDiff(a, b) * (1 - Math.exp(-rate * dt));
