// ============================================================================
//  World generation.
//  The battleground is point-symmetric about the map centre: whatever the
//  Scarlet Fleet must sail around, the Cobalt Compact must sail around too.
//  Only the decoration is random; the eight Holds are always in the same
//  places, so both teams can learn the map.
// ============================================================================
import { WORLD_W, WORLD_H } from '../shared/constants.js';
import { makeRng, rngRange, rngInt, clamp, TAU } from '../shared/math.js';

const CX = WORLD_W / 2, CY = WORLD_H / 2;

/** Rotate a point 180 degrees about the map centre. */
const mirror = (x, y) => [WORLD_W - x, WORLD_H - y];

// ---------------------------------------------------------------------------
//  The eight Holds. Three per fleet, two contested in the middle.
//
//      N lane   [S1]..................................[C1]
//                            [M1]
//      C lane   [S2]. . . . . <gate> . . . . . . . . .[C2]
//                            [M2]
//      S lane   [S3]..................................[C3]
// ---------------------------------------------------------------------------
const HOLD_LAYOUT = [
  { key:'S1', owner:'scarlet', lane:'north',  name:'GALLOWS POINT',  x:1750, y: 900 },
  { key:'S2', owner:'scarlet', lane:'centre', name:'KEELHAUL BAY',   x:1450, y:2300 },
  { key:'S3', owner:'scarlet', lane:'south',  name:'SALT HARROW',    x:1750, y:3700 },
  { key:'M1', owner:null,      lane:'gate',   name:'THE NORTH GATE', x:3800, y:1500 },
  { key:'M2', owner:null,      lane:'gate',   name:'THE SOUTH GATE', x:3800, y:3100 },
  { key:'C1', owner:'cobalt',  lane:'north',  name:'WIDOWS REACH',   x:5850, y:3700 },
  { key:'C2', owner:'cobalt',  lane:'centre', name:'IRON ROADS',     x:6150, y:2300 },
  { key:'C3', owner:'cobalt',  lane:'south',  name:'BLACKWATER',     x:5850, y: 900 },
];

/** A closed island polygon around (x,y) built from smoothed radial noise. */
function islandPoly(rng, x, y, r, lumps = 9, rough = 0.30) {
  const n = 26;
  const amp = [], phase = [];
  for (let k = 0; k < 4; k++) { amp.push(rngRange(rng, 0.4, 1)); phase.push(rng() * TAU); }
  const raw = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    let d = 1;
    for (let k = 0; k < 4; k++) d += Math.sin(a * (2 + k * 2 + (k === 2 ? 1 : 0)) + phase[k]) * amp[k] * rough / (k + 1);
    raw.push(clamp(d, 0.62, 1.42));
  }
  // One smoothing pass so nothing is needle-sharp to run onto.
  const pts = [];
  for (let i = 0; i < n; i++) {
    const d = (raw[(i - 1 + n) % n] + raw[i] * 2 + raw[(i + 1) % n]) / 4;
    const a = (i / n) * TAU;
    pts.push(x + Math.cos(a) * r * d, y + Math.sin(a) * r * d);
  }
  return pts;
}

function polyRadius(pts, x, y) {
  let m = 0;
  for (let i = 0; i < pts.length; i += 2) m = Math.max(m, Math.hypot(pts[i] - x, pts[i + 1] - y));
  return m;
}

export function generateWorld(seed) {
  const rng = makeRng(seed >>> 0);
  const islands = [];
  const reefs = [];
  let nextId = 1;

  const addIsland = (x, y, r, kind, holdKey = null) => {
    const pts = islandPoly(rng, x, y, r, 9, kind === 'rock' ? 0.40 : 0.28);
    const isl = { id: nextId++, x, y, r: polyRadius(pts, x, y), pts, kind, hold: holdKey };
    islands.push(isl);
    return isl;
  };

  // --- the Hold islands ----------------------------------------------------
  const holds = HOLD_LAYOUT.map((h, i) => {
    const r = h.lane === 'gate' ? 205 : 190;
    const isl = addIsland(h.x, h.y, r, 'hold', h.key);
    return {
      id: i, key: h.key, name: h.name, lane: h.lane,
      x: h.x, y: h.y, r: isl.r, island: isl.id,
      home: h.owner,                // who starts with it (null = contested)
    };
  });

  // --- decorative / tactical terrain, generated west then mirrored east ----
  // Cover to hide behind, obstacles to navigate, and reefs to fear.
  const west = [];
  const wantIslands = rngInt(rng, 6, 8);
  const wantReefs   = rngInt(rng, 5, 7);

  const clearOfHolds = (x, y, r, pad) => {
    for (const h of holds) if (Math.hypot(x - h.x, y - h.y) < h.r + r + pad) return false;
    return true;
  };
  const clearOfWest = (x, y, r, pad) => {
    for (const w of west) if (Math.hypot(x - w.x, y - w.y) < w.r + r + pad) return false;
    return true;
  };
  // Keep the three sailing lanes open where they leave a fleet's home water.
  const laneClear = (x, y, r) => {
    if (x < 900) return false;
    for (const ly of [900, 2300, 3700]) if (x < 2900 && Math.abs(y - ly) < r + 190) return false;
    return true;
  };

  for (let t = 0; t < 400 && west.length < wantIslands; t++) {
    const r = rngRange(rng, 150, 300);
    const x = rngRange(rng, 900, CX - 200);
    const y = rngRange(rng, 320, WORLD_H - 320);
    if (!laneClear(x, y, r) || !clearOfHolds(x, y, r, 540) || !clearOfWest(x, y, r, 320)) continue;
    west.push({ x, y, r, reef: false });
  }
  // Reefs may crowd closer — they are a hazard to read, not a wall to sail round.
  for (let t = 0; t < 500 && west.length < wantIslands + wantReefs; t++) {
    const r = rngRange(rng, 95, 175);
    const x = rngRange(rng, 820, CX - 140);
    const y = rngRange(rng, 260, WORLD_H - 260);
    if (!laneClear(x, y, r) || !clearOfHolds(x, y, r, 300) || !clearOfWest(x, y, r, 170)) continue;
    west.push({ x, y, r, reef: true });
  }

  // Mirror every piece of terrain to the far side of the map.
  for (const w of west) {
    const [mx, my] = mirror(w.x, w.y);
    if (w.reef) {
      for (const [rx, ry] of [[w.x, w.y], [mx, my]]) {
        const pts = islandPoly(rng, rx, ry, w.r, 7, 0.46);
        reefs.push({ id: nextId++, x: rx, y: ry, r: polyRadius(pts, rx, ry), pts });
      }
    } else {
      addIsland(w.x, w.y, w.r, 'rock');
      addIsland(mx, my, w.r, 'rock');
    }
  }

  // --- home anchorages: where a fleet returns after a sinking ---------------
  const spawns = { scarlet: [], cobalt: [] };
  const anchorX = { scarlet: 380, cobalt: WORLD_W - 380 };
  for (const team of ['scarlet', 'cobalt']) {
    for (let i = 0; i < 6; i++) {
      const y = 760 + (i / 5) * (WORLD_H - 1520);
      spawns[team].push({ x: anchorX[team], y, heading: team === 'scarlet' ? 0 : Math.PI });
    }
  }

  // The lane the Bullion Run convoy sails along, west to east or back.
  const convoyLane = { y: CY, x0: 260, x1: WORLD_W - 260 };

  return {
    seed: seed >>> 0,
    w: WORLD_W, h: WORLD_H,
    islands, reefs, holds, spawns, convoyLane,
  };
}

/** The static slice of the world sent to a client once, on join. */
export function worldPayload(w) {
  return {
    seed: w.seed, w: w.w, h: w.h,
    islands: w.islands.map(i => ({ id: i.id, x: i.x, y: i.y, r: i.r, pts: i.pts, kind: i.kind, hold: i.hold })),
    reefs:   w.reefs.map(i => ({ id: i.id, x: i.x, y: i.y, r: i.r, pts: i.pts })),
    holds:   w.holds.map(h => ({ id: h.id, key: h.key, name: h.name, lane: h.lane, x: h.x, y: h.y, r: h.r, home: h.home })),
    convoyLane: w.convoyLane,
  };
}
