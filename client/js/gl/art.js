// ============================================================================
//  Procedural art. Every sprite the game draws is generated here at boot into
//  a single atlas, so the build ships with no image files and the whole set
//  stays in one art direction.
//
//  All ships are drawn bow-right (+X) so a sprite's rotation is its heading.
// ============================================================================

const TAU = Math.PI * 2;

function cv(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/** Deterministic little PRNG so the atlas is identical every run. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
//  Palette
// ---------------------------------------------------------------------------
export const PAL = {
  hullDark:  '#2a1c10',
  hullMid:   '#4d3620',
  hullLight: '#6e4e2c',
  wale:      '#1b1008',
  rail:      '#a8814f',
  railLite:  '#cfa871',
  deck:      '#c9a970',
  deckDark:  '#8a6b40',
  waterway:  '#5a4228',
  plank:     '#a78453',
  trim:      '#1d2b38',
  gold:      '#d8ae52',
  canvasCol: '#e8dcc2',
  canvasSh:  '#b8ac92',
  stone:     '#7d7a72',
  stoneDark: '#4a4841',
  stoneLite: '#a5a197',
  grass:     '#4e6b41',
  grassDark: '#33492c',
  sand:      '#d8c69a',
  rock:      '#6f6a60',
  iron:      '#2f3238',
};

// ---------------------------------------------------------------------------
//  Small drawing utilities
// ---------------------------------------------------------------------------
function grain(ctx, w, h, amount = 14, seed = 7, alpha = 0.5) {
  const r = rng(seed);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const n = (r() - 0.5) * amount * alpha;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  ctx.putImageData(img, 0, 0);
}

/** Light from the upper-left: a soft bevel that sells depth on a flat sprite. */
function bevel(ctx, path, w, h, strength = 0.45) {
  ctx.save();
  ctx.clip(path);
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, `rgba(255,240,215,${0.30 * strength})`);
  g.addColorStop(0.42, 'rgba(255,255,255,0)');
  g.addColorStop(0.62, 'rgba(0,0,0,0)');
  g.addColorStop(1, `rgba(10,6,2,${0.42 * strength})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

function innerShadow(ctx, path, w, h, blur = 10, col = 'rgba(0,0,0,0.55)') {
  ctx.save();
  ctx.clip(path);
  ctx.shadowColor = col;
  ctx.shadowBlur = blur;
  ctx.lineWidth = blur * 0.9;
  ctx.strokeStyle = 'rgba(0,0,0,1)';
  ctx.stroke(path);
  ctx.restore();
}

// ---------------------------------------------------------------------------
//  Hull geometry
// ---------------------------------------------------------------------------
/** Classic hull plan: fine bow, full midships, square-ish transom. */
function hullPath(L, B, opts = {}) {
  const p = new Path2D();
  const bow = L * 0.5, stern = -L * 0.5, b = B * 0.5;
  const fine = opts.fine ?? 0.34;         // how sharp the entry is
  const transom = opts.transom ?? 0.46;   // stern width as a share of beam
  // Widest point is forward of amidships on a sailing hull, not at the middle.
  const mid = L * 0.10;

  p.moveTo(bow, 0);
  p.bezierCurveTo(bow - L * fine * 0.36, -b * 0.42, bow - L * fine * 0.82, -b * 0.90, mid, -b);
  p.bezierCurveTo(mid - L * 0.20, -b, -L * 0.30, -b * 0.93, stern + L * 0.04, -b * transom);
  p.lineTo(stern, -b * transom * 0.86);
  p.quadraticCurveTo(stern - L * 0.012, 0, stern, b * transom * 0.86);
  p.lineTo(stern + L * 0.04, b * transom);
  p.bezierCurveTo(-L * 0.30, b * 0.93, mid - L * 0.20, b, mid, b);
  p.bezierCurveTo(bow - L * fine * 0.82, b * 0.90, bow - L * fine * 0.36, b * 0.42, bow, 0);
  p.closePath();
  return p;
}

function scalePath(L, B, k, opts) { return hullPath(L * k, B * k, opts); }

/**
 * Draw one ship into ctx, centred at (0,0), bow toward +X.
 * Yards are NOT drawn here: they rotate with the sails, so the renderer
 * instances them separately.
 *
 * spec: { L, B, guns, masts:[{at,size}], castle, boat, fine, transom }
 */
function drawShip(ctx, spec, seed = 3) {
  const r = rng(seed);
  const { L, B } = spec;
  const opts = { fine: spec.fine, transom: spec.transom };
  const hull = hullPath(L, B, opts);
  // The deck sits inside the bulwarks; the ring between the two is the rail.
  const deckW = spec.deckW ?? 0.70;
  const deck = hullPath(L * 0.95, B * deckW, { fine: (spec.fine ?? 0.34) * 1.15, transom: (spec.transom ?? 0.46) * 1.18 });

  // --- shadow on the water --------------------------------------------------
  ctx.save();
  ctx.translate(L * 0.018, B * 0.09);
  ctx.fillStyle = 'rgba(0,0,0,0.34)';
  ctx.filter = 'blur(7px)';
  ctx.fill(hull);
  ctx.restore();
  ctx.filter = 'none';

  // --- topsides: dark, so the pale deck reads against them ------------------
  const g = ctx.createLinearGradient(0, -B * 0.5, 0, B * 0.5);
  g.addColorStop(0.00, '#1d1309');
  g.addColorStop(0.20, PAL.hullDark);
  g.addColorStop(0.48, PAL.hullMid);
  g.addColorStop(0.76, PAL.hullDark);
  g.addColorStop(1.00, '#140c05');
  ctx.fillStyle = g;
  ctx.fill(hull);

  // --- rail cap: the sunlit top of the bulwark, a narrow ring inside the
  //     hull outline. Cut the deck out of it so only the ring survives.
  const rail = hullPath(L * 0.975, B * ((deckW + 1) / 2), { fine: (spec.fine ?? 0.34) * 1.06, transom: (spec.transom ?? 0.46) * 1.08 });
  const rg = ctx.createLinearGradient(0, -B * 0.5, 0, B * 0.5);
  rg.addColorStop(0.00, '#6b5030');
  rg.addColorStop(0.26, PAL.railLite);
  rg.addColorStop(0.58, PAL.rail);
  rg.addColorStop(1.00, '#4f3a22');
  ctx.fillStyle = rg;
  ctx.fill(rail);

  // the heavy wale that runs the length of a ship's side, drawn over the fill,
  // with a hard outer line so the hull separates from the sea at any zoom
  ctx.save();
  ctx.lineWidth = B * 0.050;
  ctx.strokeStyle = PAL.wale;
  ctx.stroke(hull);
  ctx.lineWidth = B * 0.020;
  ctx.strokeStyle = 'rgba(6,3,1,0.9)';
  ctx.stroke(hullPath(L * 1.012, B * 1.016, opts));
  ctx.lineWidth = B * 0.016;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.stroke(rail);
  ctx.restore();

  // --- deck -----------------------------------------------------------------
  const dg = ctx.createLinearGradient(0, -B * 0.4, 0, B * 0.4);
  dg.addColorStop(0.00, '#a8874f');
  dg.addColorStop(0.30, '#e3c489');
  dg.addColorStop(0.66, '#c8a468');
  dg.addColorStop(1.00, '#7e6038');
  ctx.fillStyle = dg;
  ctx.fill(deck);

  ctx.save();
  ctx.clip(deck);
  // planking runs fore and aft
  const gap = B * 0.045;
  ctx.lineWidth = Math.max(0.7, B * 0.008);
  for (let y = -B * 0.5; y <= B * 0.5; y += gap) {
    ctx.strokeStyle = `rgba(74,52,28,${0.20 + r() * 0.12})`;
    ctx.beginPath(); ctx.moveTo(-L * 0.5, y); ctx.lineTo(L * 0.5, y); ctx.stroke();
  }
  // butt joints between plank lengths
  ctx.strokeStyle = 'rgba(62,42,22,0.30)';
  for (let i = 0; i < 52; i++) {
    const px = (r() - 0.5) * L * 0.88;
    const py = (Math.round((r() - 0.5) * B / gap)) * gap;
    ctx.beginPath(); ctx.moveTo(px, py - gap * 0.5); ctx.lineTo(px, py + gap * 0.5); ctx.stroke();
  }
  // a wash of grain so the deck is not a flat colour field
  for (let i = 0; i < 26; i++) {
    ctx.fillStyle = `rgba(${r() < 0.5 ? '255,238,208' : '60,42,22'},${0.03 + r() * 0.05})`;
    ctx.fillRect((r() - 0.5) * L, (r() - 0.5) * B, L * (0.04 + r() * 0.12), gap * 0.9);
  }
  ctx.restore();

  // waterway: the dark seam where deck meets bulwark
  ctx.lineWidth = B * 0.026;
  ctx.strokeStyle = PAL.waterway;
  ctx.stroke(deck);

  // --- gun ports ------------------------------------------------------------
  const n = spec.guns;
  const portW = L * 0.026, portH = B * 0.050;
  ctx.save();
  ctx.clip(hull);                       // nothing may spill past the ship's side
  for (let side = -1; side <= 1; side += 2) {
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const px = -L * 0.30 + t * L * 0.60;
      // follow the sheer: ports sit closer to the centreline toward the ends
      const taper = 1 - Math.pow(Math.abs(px) / (L * 0.5), 2.4) * 0.45;
      const py = side * B * ((deckW + 1) / 4 + deckW / 2) * 0.5 * taper;
      ctx.save();
      ctx.translate(px, py);
      ctx.fillStyle = 'rgba(8,5,2,0.95)';
      ctx.fillRect(-portW / 2, -portH / 2, portW, portH);
      // a lid hinged above the port, catching a little light
      ctx.fillStyle = 'rgba(190,150,92,0.55)';
      ctx.fillRect(-portW / 2, -portH / 2, portW, portH * 0.22);
      // the muzzle, just showing
      ctx.fillStyle = '#42464e';
      ctx.fillRect(-portW * 0.16, side > 0 ? portH * 0.05 : -portH * 0.45, portW * 0.32, portH * 0.40);
      ctx.restore();
    }
  }
  ctx.restore();

  // --- deck furniture -------------------------------------------------------
  const grating = (px, py, w, h) => {
    ctx.save(); ctx.translate(px, py);
    ctx.fillStyle = 'rgba(0,0,0,0.34)';
    ctx.fillRect(-w / 2 + w * 0.07, -h / 2 + h * 0.12, w, h);
    ctx.fillStyle = '#4e3a20';
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.strokeStyle = 'rgba(190,158,108,0.5)';
    ctx.lineWidth = Math.max(0.6, h * 0.05);
    for (let i = 1; i < 5; i++) {
      const y = -h / 2 + (h * i) / 5;
      ctx.beginPath(); ctx.moveTo(-w / 2, y); ctx.lineTo(w / 2, y); ctx.stroke();
    }
    for (let i = 1; i < 4; i++) {
      const x = -w / 2 + (w * i) / 4;
      ctx.beginPath(); ctx.moveTo(x, -h / 2); ctx.lineTo(x, h / 2); ctx.stroke();
    }
    ctx.strokeStyle = '#7a5c34'; ctx.lineWidth = Math.max(0.8, h * 0.07);
    ctx.strokeRect(-w / 2, -h / 2, w, h);
    ctx.restore();
  };

  const hatch = (px, py, w, h) => {
    ctx.save(); ctx.translate(px, py);
    ctx.fillStyle = 'rgba(0,0,0,0.34)';
    ctx.fillRect(-w / 2 + w * 0.08, -h / 2 + h * 0.14, w, h);
    const hg = ctx.createLinearGradient(0, -h / 2, 0, h / 2);
    hg.addColorStop(0, '#8e6c3f'); hg.addColorStop(1, '#5c4326');
    ctx.fillStyle = hg;
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.strokeStyle = 'rgba(30,20,10,0.7)'; ctx.lineWidth = Math.max(0.7, h * 0.06);
    ctx.strokeRect(-w / 2, -h / 2, w, h);
    ctx.restore();
  };

  // quarterdeck aft, raised, with a hard shadow at its break
  if (spec.castle !== false) {
    const qx = -L * 0.28, qw = L * 0.24, qh = B * deckW * 0.72;
    ctx.save();
    ctx.beginPath();
    ctx.rect(qx + qw / 2 - qw * 0.06, -qh / 2, qw * 0.14, qh);
    ctx.fillStyle = 'rgba(0,0,0,0.42)';
    ctx.filter = 'blur(3px)'; ctx.fill(); ctx.filter = 'none';
    ctx.restore();
    const qg = ctx.createLinearGradient(0, -qh / 2, 0, qh / 2);
    qg.addColorStop(0, '#9d7d4c'); qg.addColorStop(0.36, '#d6b67c'); qg.addColorStop(1, '#7a5e38');
    ctx.fillStyle = qg;
    ctx.fillRect(qx - qw / 2, -qh / 2, qw, qh);
    ctx.strokeStyle = 'rgba(40,26,14,0.55)'; ctx.lineWidth = B * 0.018;
    ctx.strokeRect(qx - qw / 2, -qh / 2, qw, qh);
    // the wheel and binnacle
    ctx.strokeStyle = '#6a4a2c'; ctx.lineWidth = B * 0.026;
    ctx.beginPath(); ctx.arc(qx - qw * 0.24, 0, B * 0.070, 0, TAU); ctx.stroke();
    ctx.fillStyle = PAL.gold;
    ctx.beginPath(); ctx.arc(qx + qw * 0.10, 0, B * 0.030, 0, TAU); ctx.fill();
    // stern transom: gallery windows and a lantern
    ctx.fillStyle = 'rgba(255,214,140,0.55)';
    for (let i = -1; i <= 1; i++) ctx.fillRect(-L * 0.492, i * B * 0.075 - B * 0.026, L * 0.016, B * 0.052);
    ctx.fillStyle = PAL.gold;
    ctx.beginPath(); ctx.arc(-L * 0.468, 0, B * 0.038, 0, TAU); ctx.fill();
  }

  // forecastle
  ctx.save();
  const fx = L * 0.325, fw = L * 0.10, fh = B * deckW * 0.50;
  const fg = ctx.createLinearGradient(0, -fh / 2, 0, fh / 2);
  fg.addColorStop(0, '#9d7d4c'); fg.addColorStop(0.4, '#cdae76'); fg.addColorStop(1, '#7a5e38');
  ctx.fillStyle = fg;
  ctx.fillRect(fx - fw / 2, -fh / 2, fw, fh);
  ctx.strokeStyle = 'rgba(40,26,14,0.5)'; ctx.lineWidth = B * 0.015;
  ctx.strokeRect(fx - fw / 2, -fh / 2, fw, fh);
  ctx.restore();

  grating(L * 0.06, 0, L * 0.075, B * 0.30);
  hatch(-L * 0.10, 0, L * 0.055, B * 0.22);
  // capstan with its bars
  ctx.save();
  ctx.translate(L * 0.19, 0);
  ctx.strokeStyle = '#6a4d2e'; ctx.lineWidth = B * 0.020;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * B * 0.10, Math.sin(a) * B * 0.10);
    ctx.lineTo(-Math.cos(a) * B * 0.10, -Math.sin(a) * B * 0.10);
    ctx.stroke();
  }
  ctx.fillStyle = '#4e3a20';
  ctx.beginPath(); ctx.arc(0, 0, B * 0.048, 0, TAU); ctx.fill();
  ctx.restore();

  // ship's boat stowed amidships
  if (spec.boat !== false) {
    ctx.save(); ctx.translate(-L * 0.02, 0);
    const bp = hullPath(L * 0.105, B * 0.15, { fine: 0.40, transom: 0.66 });
    ctx.fillStyle = 'rgba(0,0,0,0.30)';
    ctx.save(); ctx.translate(L * 0.004, B * 0.012); ctx.fill(bp); ctx.restore();
    ctx.fillStyle = '#8a6a43'; ctx.fill(bp);
    ctx.strokeStyle = 'rgba(28,18,8,0.65)'; ctx.lineWidth = Math.max(0.7, B * 0.012); ctx.stroke(bp);
    ctx.restore();
  }
  // coiled cable on deck
  ctx.strokeStyle = 'rgba(190,168,126,0.45)';
  ctx.lineWidth = Math.max(0.6, B * 0.010);
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.arc(-L * 0.19, B * 0.20, B * (0.020 + i * 0.013), 0, TAU);
    ctx.stroke();
  }

  // --- bowsprit -------------------------------------------------------------
  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = B * 0.070;
  ctx.beginPath(); ctx.moveTo(L * 0.42, B * 0.020); ctx.lineTo(L * 0.5 + L * 0.115, B * 0.020); ctx.stroke();
  ctx.strokeStyle = '#7a5b37';
  ctx.lineWidth = B * 0.085;
  ctx.beginPath(); ctx.moveTo(L * 0.42, 0); ctx.lineTo(L * 0.5 + L * 0.12, 0); ctx.stroke();
  ctx.strokeStyle = 'rgba(240,225,195,0.42)';
  ctx.lineWidth = B * 0.030;
  ctx.beginPath(); ctx.moveTo(L * 0.42, -B * 0.016); ctx.lineTo(L * 0.5 + L * 0.112, -B * 0.014); ctx.stroke();
  ctx.restore();

  // --- rudder ---------------------------------------------------------------
  const tb = (spec.transom ?? 0.46) * B * 0.5;
  ctx.fillStyle = '#3f2c1a';
  ctx.beginPath();
  ctx.moveTo(-L * 0.497, -tb * 0.30);
  ctx.lineTo(-L * 0.497 - L * 0.042, -tb * 0.17);
  ctx.lineTo(-L * 0.497 - L * 0.042, tb * 0.17);
  ctx.lineTo(-L * 0.497, tb * 0.30);
  ctx.closePath(); ctx.fill();

  // --- standing rigging -----------------------------------------------------
  ctx.save();
  ctx.strokeStyle = 'rgba(236,226,202,0.20)';
  ctx.lineWidth = Math.max(0.5, B * 0.0065);
  const masts = spec.masts;
  for (let i = 0; i < masts.length; i++) {
    const mx = masts[i].at * L;
    // forestay to the next mast forward, or to the bowsprit end
    const fwd = i > 0 ? masts[i - 1].at * L : L * 0.5 + L * 0.10;
    ctx.beginPath(); ctx.moveTo(mx, 0); ctx.lineTo(fwd, 0); ctx.stroke();
    // shrouds fanning down to the rail
    for (const side of [-1, 1]) {
      for (let k = 0; k < 3; k++) {
        const sp = mx - L * (0.028 + k * 0.022);
        const taper = 1 - Math.pow(Math.abs(sp) / (L * 0.5), 2.4) * 0.45;
        ctx.beginPath();
        ctx.moveTo(mx, 0);
        ctx.lineTo(sp, side * B * 0.5 * taper * 0.80);
        ctx.stroke();
      }
    }
  }
  // backstay to the taffrail
  if (masts.length) {
    ctx.beginPath();
    ctx.moveTo(masts[masts.length - 1].at * L, 0);
    ctx.lineTo(-L * 0.49, 0);
    ctx.stroke();
  }
  ctx.restore();

  // --- masts ----------------------------------------------------------------
  for (const m of spec.masts) {
    const mx = m.at * L;
    const R = B * m.size;
    // the top: a platform round the mast
    ctx.fillStyle = 'rgba(0,0,0,0.38)';
    ctx.beginPath(); ctx.arc(mx + R * 0.30, R * 0.34, R * 1.55, 0, TAU); ctx.fill();
    const tg = ctx.createRadialGradient(mx - R * 0.5, -R * 0.5, R * 0.2, mx, 0, R * 1.55);
    tg.addColorStop(0, '#b4915e'); tg.addColorStop(1, '#5c4327');
    ctx.fillStyle = tg;
    ctx.beginPath(); ctx.arc(mx, 0, R * 1.55, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(25,16,8,0.6)'; ctx.lineWidth = R * 0.20;
    ctx.beginPath(); ctx.arc(mx, 0, R * 1.55, 0, TAU); ctx.stroke();
    // the mast itself
    const mg = ctx.createRadialGradient(mx - R * 0.35, -R * 0.35, R * 0.08, mx, 0, R);
    mg.addColorStop(0, '#d8b782'); mg.addColorStop(1, '#4f3922');
    ctx.fillStyle = mg;
    ctx.beginPath(); ctx.arc(mx, 0, R, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(20,13,6,0.75)'; ctx.lineWidth = R * 0.20;
    ctx.beginPath(); ctx.arc(mx, 0, R, 0, TAU); ctx.stroke();
  }
}

// ---------------------------------------------------------------------------
//  Hull specifications — the rigging plan for each class.
// ---------------------------------------------------------------------------
// Proportions follow real practice: a sailing hull runs four to five times
// longer than her beam. `yard` is the half-length of that mast's yard as a
// share of beam — yards are wider than the hull, and they rotate with the
// sails rather than with the hull, so they are drawn by the renderer.
export const HULL_ART = {
  cutter: {
    L: 340, B: 80, guns: 3, fine: 0.40, transom: 0.38, castle: false, boat: false, deckW: 0.66,
    masts: [{ at: 0.04, size: 0.105, yard: 0.98 }],
  },
  brigantine: {
    L: 420, B: 104, guns: 6, fine: 0.34, transom: 0.46, deckW: 0.70,
    masts: [{ at: 0.19, size: 0.090, yard: 0.90 }, { at: -0.10, size: 0.098, yard: 1.02 }],
  },
  xebec: {
    L: 400, B: 90, guns: 5, fine: 0.44, transom: 0.34, deckW: 0.68,
    masts: [{ at: 0.24, size: 0.080, yard: 0.78 }, { at: 0.01, size: 0.094, yard: 0.98 },
            { at: -0.22, size: 0.074, yard: 0.70 }],
  },
  galleon: {
    L: 500, B: 140, guns: 8, fine: 0.28, transom: 0.58, deckW: 0.72,
    masts: [{ at: 0.26, size: 0.076, yard: 0.76 }, { at: 0.03, size: 0.094, yard: 1.00 },
            { at: -0.21, size: 0.080, yard: 0.82 }],
  },
  flagship: {
    L: 460, B: 112, guns: 6, fine: 0.32, transom: 0.50, deckW: 0.70,
    masts: [{ at: 0.25, size: 0.080, yard: 0.80 }, { at: 0.02, size: 0.098, yard: 1.04 },
            { at: -0.22, size: 0.082, yard: 0.86 }],
  },
  barque: {
    L: 380, B: 116, guns: 2, fine: 0.30, transom: 0.62, deckW: 0.74,
    masts: [{ at: 0.14, size: 0.086, yard: 0.86 }, { at: -0.16, size: 0.078, yard: 0.74 }],
  },
};

// ---------------------------------------------------------------------------
//  Individual sprite painters
// ---------------------------------------------------------------------------
const paint = {
  ship(ctx, w, h, key) {
    const spec = HULL_ART[key];
    // 1.40 leaves room for the bowsprit, which reaches well past the stem.
    const s = Math.min(w / (spec.L * 1.30), h / (spec.B * 1.55));
    // Record how much of the cell the hull actually occupies, so the renderer
    // can size the quad to make the drawn ship match her real length.
    spec.frac = (spec.L * s) / w;
    spec.cell = [w, h];
    ctx.translate(w / 2, h / 2);
    ctx.scale(s, s);
    drawShip(ctx, spec, key.length * 31 + 7);
  },

  /** A yard: the tapered spar a square sail hangs from. Rotates with the sail. */
  yard(ctx, w, h) {
    const cy = h / 2;
    ctx.save();
    ctx.translate(w * 0.02, h * 0.06);
    ctx.fillStyle = 'rgba(0,0,0,0.34)';
    ctx.beginPath();
    ctx.moveTo(0, cy); ctx.quadraticCurveTo(w * 0.5, cy - h * 0.22, w, cy);
    ctx.quadraticCurveTo(w * 0.5, cy + h * 0.22, 0, cy);
    ctx.fill();
    ctx.restore();
    const g = ctx.createLinearGradient(0, cy - h * 0.2, 0, cy + h * 0.2);
    g.addColorStop(0, '#c9a874'); g.addColorStop(0.42, '#8a6738'); g.addColorStop(1, '#4a3520');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, cy); ctx.quadraticCurveTo(w * 0.5, cy - h * 0.20, w, cy);
    ctx.quadraticCurveTo(w * 0.5, cy + h * 0.20, 0, cy);
    ctx.fill();
    ctx.strokeStyle = 'rgba(245,232,205,0.30)';
    ctx.lineWidth = Math.max(1, h * 0.035);
    ctx.beginPath();
    ctx.moveTo(w * 0.04, cy - h * 0.055); ctx.quadraticCurveTo(w * 0.5, cy - h * 0.16, w * 0.96, cy - h * 0.045);
    ctx.stroke();
  },

  /** One bellied sail. Yard along -Y..+Y at x=0, canvas bulging toward +X. */
  sail(ctx, w, h) {
    const cx = w * 0.14, cy = h / 2, H = h * 0.86, W = w * 0.62;
    const p = new Path2D();
    p.moveTo(cx, cy - H / 2);
    p.bezierCurveTo(cx + W * 0.92, cy - H * 0.34, cx + W * 0.92, cy + H * 0.34, cx, cy + H / 2);
    p.quadraticCurveTo(cx + W * 0.10, cy, cx, cy - H / 2);
    p.closePath();

    ctx.save();
    ctx.translate(w * 0.03, h * 0.035);
    ctx.fillStyle = 'rgba(0,0,0,0.26)';
    ctx.filter = 'blur(5px)';
    ctx.fill(p);
    ctx.restore();
    ctx.filter = 'none';

    const g2 = ctx.createLinearGradient(cx, 0, cx + W, 0);
    g2.addColorStop(0.00, PAL.canvasSh);
    g2.addColorStop(0.28, PAL.canvasCol);
    g2.addColorStop(0.72, '#f4ecd9');
    g2.addColorStop(1.00, '#a79c84');
    ctx.fillStyle = g2;
    ctx.fill(p);

    // reef bands and the seams between cloths
    ctx.save();
    ctx.clip(p);
    ctx.strokeStyle = 'rgba(120,108,86,0.32)';
    ctx.lineWidth = Math.max(1, h * 0.008);
    for (let i = 1; i < 6; i++) {
      const y = cy - H / 2 + (H * i) / 6;
      ctx.beginPath(); ctx.moveTo(cx, y); ctx.bezierCurveTo(cx + W * 0.7, y - 3, cx + W * 0.7, y + 3, cx + W, y); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = Math.max(1, h * 0.012);
    ctx.beginPath(); ctx.moveTo(cx + W * 0.10, cy - H * 0.42); ctx.bezierCurveTo(cx + W * 0.74, cy - H * 0.18, cx + W * 0.74, cy + H * 0.18, cx + W * 0.10, cy + H * 0.42); ctx.stroke();
    ctx.restore();

    ctx.strokeStyle = 'rgba(90,78,58,0.55)';
    ctx.lineWidth = Math.max(1, h * 0.010);
    ctx.stroke(p);
    grain(ctx, w, h, 16, 21, 0.7);
  },

  /** Shore battery: an octagonal stone bastion with embrasures. */
  fort(ctx, w, h) {
    const cx = w / 2, cy = h / 2, R = w * 0.40;
    const poly = (r, n, rot = 0) => {
      const p = new Path2D();
      for (let i = 0; i < n; i++) {
        const a = rot + (i / n) * TAU;
        const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
        i ? p.lineTo(x, y) : p.moveTo(x, y);
      }
      p.closePath();
      return p;
    };

    ctx.save();
    ctx.translate(w * 0.02, h * 0.03);
    ctx.fillStyle = 'rgba(0,0,0,0.42)'; ctx.filter = 'blur(8px)';
    ctx.fill(poly(R, 8, 0.39));
    ctx.restore(); ctx.filter = 'none';

    // outer curtain wall
    const g = ctx.createLinearGradient(0, cy - R, 0, cy + R);
    g.addColorStop(0, PAL.stoneLite); g.addColorStop(0.45, PAL.stone); g.addColorStop(1, PAL.stoneDark);
    ctx.fillStyle = g;
    const wall = poly(R, 8, 0.39);
    ctx.fill(wall);
    ctx.strokeStyle = 'rgba(20,20,18,0.8)'; ctx.lineWidth = w * 0.018; ctx.stroke(wall);

    // stone courses
    ctx.save(); ctx.clip(wall);
    const r = rng(91);
    for (let i = 0; i < 90; i++) {
      const a = r() * TAU, rr = R * (0.45 + r() * 0.55);
      const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
      ctx.fillStyle = `rgba(${r() < 0.5 ? '255,255,250' : '20,20,18'},${0.05 + r() * 0.09})`;
      ctx.fillRect(x, y, w * (0.03 + r() * 0.05), h * (0.016 + r() * 0.022));
    }
    ctx.restore();

    // embrasures with gun muzzles
    for (let i = 0; i < 8; i++) {
      const a = 0.39 + (i / 8) * TAU + TAU / 16;
      const x = cx + Math.cos(a) * R * 0.90, y = cy + Math.sin(a) * R * 0.90;
      ctx.save(); ctx.translate(x, y); ctx.rotate(a);
      ctx.fillStyle = '#23231f';
      ctx.fillRect(-w * 0.030, -h * 0.030, w * 0.075, h * 0.060);
      ctx.fillStyle = PAL.iron;
      ctx.fillRect(0, -h * 0.014, w * 0.075, h * 0.028);
      ctx.fillStyle = '#15161a';
      ctx.beginPath(); ctx.arc(w * 0.072, 0, h * 0.017, 0, TAU); ctx.fill();
      ctx.restore();
    }

    // inner court and keep
    const court = poly(R * 0.60, 8, 0.39);
    ctx.fillStyle = '#5c5a52'; ctx.fill(court);
    innerShadow(ctx, court, w, h, 14);
    const keep = poly(R * 0.30, 6, 0.2);
    const kg = ctx.createRadialGradient(cx - R * 0.12, cy - R * 0.12, 2, cx, cy, R * 0.34);
    kg.addColorStop(0, '#9b978c'); kg.addColorStop(1, '#3f3e38');
    ctx.fillStyle = kg; ctx.fill(keep);
    ctx.strokeStyle = 'rgba(15,15,13,0.85)'; ctx.lineWidth = w * 0.012; ctx.stroke(keep);
    // powder magazine roof
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath(); ctx.arc(cx, cy, R * 0.12, 0, TAU); ctx.fill();
    grain(ctx, w, h, 20, 33, 0.9);
  },

  /** The team pennant flown over a hold — painted white so it can be tinted. */
  banner(ctx, w, h) {
    const cx = w / 2, cy = h / 2;
    ctx.fillStyle = '#ffffff';
    const p = new Path2D();
    p.moveTo(cx - w * 0.30, cy - h * 0.20);
    p.lineTo(cx + w * 0.30, cy - h * 0.20);
    p.lineTo(cx + w * 0.30, cy + h * 0.10);
    p.lineTo(cx, cy + h * 0.30);
    p.lineTo(cx - w * 0.30, cy + h * 0.10);
    p.closePath();
    ctx.fill(p);
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = '#000000';
    ctx.fillRect(cx - w * 0.30, cy + h * 0.02, w * 0.60, h * 0.05);
    ctx.globalAlpha = 1;
  },

  mine(ctx, w, h) {
    const cx = w / 2, cy = h / 2, R = w * 0.30;
    ctx.save(); ctx.translate(w * 0.04, h * 0.06);
    ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.filter = 'blur(4px)';
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.fill();
    ctx.restore(); ctx.filter = 'none';
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * TAU;
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(a);
      ctx.fillStyle = '#4a4e55';
      ctx.fillRect(R * 0.85, -w * 0.022, R * 0.42, w * 0.044);
      ctx.fillStyle = '#8d3a2a';
      ctx.beginPath(); ctx.arc(R * 1.26, 0, w * 0.034, 0, TAU); ctx.fill();
      ctx.restore();
    }
    const g = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.35, R * 0.1, cx, cy, R);
    g.addColorStop(0, '#6b7079'); g.addColorStop(0.6, '#3b3f46'); g.addColorStop(1, '#191b1f');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.14)'; ctx.lineWidth = w * 0.018;
    ctx.beginPath(); ctx.arc(cx, cy, R * 0.72, 0.6, 2.2); ctx.stroke();
  },

  salvage(ctx, w, h) {
    const cx = w / 2, cy = h / 2, S = w * 0.30;
    ctx.save(); ctx.translate(w * 0.04, h * 0.06);
    ctx.fillStyle = 'rgba(0,0,0,0.38)'; ctx.filter = 'blur(4px)';
    ctx.fillRect(cx - S, cy - S * 0.75, S * 2, S * 1.5);
    ctx.restore(); ctx.filter = 'none';
    const g = ctx.createLinearGradient(0, cy - S, 0, cy + S);
    g.addColorStop(0, '#b98d51'); g.addColorStop(1, '#6a4a28');
    ctx.fillStyle = g;
    ctx.fillRect(cx - S, cy - S * 0.75, S * 2, S * 1.5);
    ctx.strokeStyle = '#3d2a14'; ctx.lineWidth = w * 0.03;
    ctx.strokeRect(cx - S, cy - S * 0.75, S * 2, S * 1.5);
    ctx.strokeStyle = PAL.gold; ctx.lineWidth = w * 0.035;
    ctx.beginPath();
    ctx.moveTo(cx - S, cy - S * 0.25); ctx.lineTo(cx + S, cy - S * 0.25);
    ctx.moveTo(cx - S, cy + S * 0.25); ctx.lineTo(cx + S, cy + S * 0.25);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,224,150,0.85)';
    ctx.beginPath(); ctx.arc(cx, cy, S * 0.22, 0, TAU); ctx.fill();
  },

  /** Soft radial falloff — the workhorse for lights, bloom seeds and haze. */
  glow(ctx, w, h) {
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0.00, 'rgba(255,255,255,1)');
    g.addColorStop(0.18, 'rgba(255,255,255,0.72)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.22)');
    g.addColorStop(0.75, 'rgba(255,255,255,0.05)');
    g.addColorStop(1.00, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  },

  /** Turbulent smoke puff, white so it can be tinted per particle. */
  smoke(ctx, w, h) {
    const r = rng(1234);
    const cx = w / 2, cy = h / 2;
    for (let i = 0; i < 46; i++) {
      const a = r() * TAU, d = Math.pow(r(), 0.7) * w * 0.30;
      const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d;
      const rad = w * (0.07 + r() * 0.16) * (1 - d / (w * 0.46));
      const g = ctx.createRadialGradient(x, y, 0, x, y, Math.max(2, rad));
      const al = 0.10 + r() * 0.13;
      g.addColorStop(0, `rgba(255,255,255,${al})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, Math.max(2, rad), 0, TAU); ctx.fill();
    }
    // fade the rim so quads never show an edge
    const v = ctx.createRadialGradient(cx, cy, w * 0.30, cx, cy, w * 0.50);
    v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = v; ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
  },

  spark(ctx, w, h) {
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  },

  /** Sea foam: lacy, irregular, with holes. */
  foam(ctx, w, h) {
    const r = rng(555);
    const cx = w / 2, cy = h / 2;
    ctx.fillStyle = '#ffffff';
    for (let i = 0; i < 120; i++) {
      const a = r() * TAU, d = Math.pow(r(), 0.55) * w * 0.40;
      const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d;
      ctx.globalAlpha = (0.14 + r() * 0.5) * (1 - d / (w * 0.5));
      ctx.beginPath(); ctx.arc(x, y, w * (0.012 + r() * 0.055), 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 40; i++) {
      const a = r() * TAU, d = Math.pow(r(), 0.5) * w * 0.34;
      ctx.globalAlpha = 0.5 + r() * 0.5;
      ctx.beginPath(); ctx.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, w * (0.01 + r() * 0.035), 0, TAU); ctx.fill();
    }
    const v = ctx.createRadialGradient(cx, cy, w * 0.26, cx, cy, w * 0.50);
    v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.globalAlpha = 1; ctx.fillStyle = v; ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
  },

  /** A hot muzzle flash, drawn as a cone of light. */
  flash(ctx, w, h) {
    const cx = w * 0.12, cy = h / 2;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, w * 0.9);
    g.addColorStop(0.00, 'rgba(255,255,255,1)');
    g.addColorStop(0.10, 'rgba(255,240,196,0.95)');
    g.addColorStop(0.30, 'rgba(255,176,74,0.55)');
    g.addColorStop(0.62, 'rgba(210,96,32,0.18)');
    g.addColorStop(1.00, 'rgba(120,40,10,0)');
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(w, cy - h * 0.44);
    ctx.quadraticCurveTo(w * 1.0, cy, w, cy + h * 0.44);
    ctx.closePath();
    ctx.clip();
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    ctx.restore();
    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, w * 0.22);
    core.addColorStop(0, 'rgba(255,255,255,1)');
    core.addColorStop(1, 'rgba(255,220,150,0)');
    ctx.fillStyle = core; ctx.fillRect(0, 0, w, h);
  },

  ball(ctx, w, h) {
    const g = ctx.createRadialGradient(w * 0.36, h * 0.34, 1, w / 2, h / 2, w * 0.42);
    g.addColorStop(0, '#8e9299'); g.addColorStop(0.5, '#3a3d43'); g.addColorStop(1, '#101114');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(w / 2, h / 2, w * 0.40, 0, TAU); ctx.fill();
  },

  /** A soft annulus, tinted at draw time for capture rings and radius hints. */
  /**
   * A shot in flight, painted as a streak running bow-right: a hot head with a
   * tail drawn out behind it. A cannonball is a dark thirty-centimetre object
   * doing seven hundred a second — at any sane zoom it is a fraction of a pixel,
   * so what the player has to be shown is the STREAK, not the ball. Everything
   * about reading a gunfight — where it came from, where it is going, whether it
   * is going to reach — is in the line, and the game did not draw one.
   */
  tracer(ctx, w, h) {
    const cy = h / 2;
    // the drawn-out tail
    const g = ctx.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0.00, 'rgba(255,190,110,0)');
    g.addColorStop(0.45, 'rgba(255,196,120,0.36)');
    g.addColorStop(0.82, 'rgba(255,228,176,0.85)');
    g.addColorStop(1.00, 'rgba(255,255,244,1)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, cy);
    ctx.lineTo(w * 0.60, cy - h * 0.19);
    ctx.lineTo(w, cy - h * 0.30);
    ctx.lineTo(w, cy + h * 0.30);
    ctx.lineTo(w * 0.60, cy + h * 0.19);
    ctx.closePath();
    ctx.fill();
    // the head, bright enough to read against bright water
    const hg = ctx.createRadialGradient(w * 0.90, cy, 1, w * 0.90, cy, h * 0.46);
    hg.addColorStop(0, 'rgba(255,255,250,1)');
    hg.addColorStop(0.42, 'rgba(255,224,160,0.92)');
    hg.addColorStop(1, 'rgba(255,170,70,0)');
    ctx.fillStyle = hg;
    ctx.beginPath(); ctx.arc(w * 0.90, cy, h * 0.46, 0, TAU); ctx.fill();
  },

  ring(ctx, w, h) {
    const cx = w / 2, cy = h / 2;
    const g = ctx.createRadialGradient(cx, cy, w * 0.36, cx, cy, w * 0.5);
    g.addColorStop(0.00, 'rgba(255,255,255,0)');
    g.addColorStop(0.72, 'rgba(255,255,255,0.20)');
    g.addColorStop(0.93, 'rgba(255,255,255,0.95)');
    g.addColorStop(1.00, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  },

  /** A stretched teardrop for wakes and spray trails. */
  wake(ctx, w, h) {
    const g = ctx.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,0.95)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.quadraticCurveTo(w * 0.5, h * 0.06, w, h * 0.30);
    ctx.lineTo(w, h * 0.70);
    ctx.quadraticCurveTo(w * 0.5, h * 0.94, 0, h / 2);
    ctx.closePath();
    ctx.fill();
    const v = ctx.createLinearGradient(0, 0, 0, h);
    v.addColorStop(0, 'rgba(0,0,0,1)'); v.addColorStop(0.2, 'rgba(0,0,0,0)');
    v.addColorStop(0.8, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = v; ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
  },
};

// ---------------------------------------------------------------------------
//  Atlas
// ---------------------------------------------------------------------------
const SPRITES = [
  ...['cutter', 'brigantine', 'xebec', 'galleon', 'flagship', 'barque']
      .map(k => ({ name: 'ship_' + k, w: 640, h: 224, fn: (c, w, h) => paint.ship(c, w, h, k) })),
  { name: 'sail',    w: 256, h: 256, fn: paint.sail },
  { name: 'yard',    w: 384, h: 40,  fn: paint.yard },
  { name: 'fort',    w: 384, h: 384, fn: paint.fort },
  { name: 'banner',  w: 128, h: 128, fn: paint.banner },
  { name: 'mine',    w: 128, h: 128, fn: paint.mine },
  { name: 'salvage', w: 128, h: 128, fn: paint.salvage },
  { name: 'glow',    w: 256, h: 256, fn: paint.glow },
  { name: 'smoke',   w: 256, h: 256, fn: paint.smoke },
  { name: 'spark',   w: 64,  h: 64,  fn: paint.spark },
  { name: 'foam',    w: 256, h: 256, fn: paint.foam },
  { name: 'flash',   w: 256, h: 192, fn: paint.flash },
  { name: 'ball',    w: 32,  h: 32,  fn: paint.ball },
  { name: 'tracer',  w: 256, h: 64,  fn: paint.tracer },
  { name: 'ring',    w: 512, h: 512, fn: paint.ring },
  { name: 'wake',    w: 256, h: 96,  fn: paint.wake },
];

/** Build the sprite atlas. Returns { canvas, uv:{name:[u0,v0,u1,v1]}, size:{name:[w,h]} }. */
export function buildAtlas() {
  const SIZE = 2048;
  const c = cv(SIZE, SIZE);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const uv = {}, size = {};
  const PAD = 4;
  let x = PAD, y = PAD, shelf = 0;

  for (const s of SPRITES) {
    if (x + s.w + PAD > SIZE) { x = PAD; y += shelf + PAD; shelf = 0; }
    if (y + s.h + PAD > SIZE) { console.warn('atlas full at', s.name); break; }
    const sub = cv(s.w, s.h);
    const sctx = sub.getContext('2d');
    sctx.imageSmoothingQuality = 'high';
    s.fn(sctx, s.w, s.h);
    ctx.drawImage(sub, x, y);
    uv[s.name] = [x / SIZE, y / SIZE, (x + s.w) / SIZE, (y + s.h) / SIZE];
    size[s.name] = [s.w, s.h];
    x += s.w + PAD;
    shelf = Math.max(shelf, s.h);
  }
  return { canvas: c, uv, size };
}

/**
 * Tileable 4-channel noise for the water shader. Each channel is real
 * multi-octave value noise built on periodic lattices, so it has detail at
 * every scale and no visible cell structure when tiled.
 */
export function buildNoise(N = 256) {
  const c = cv(N, N);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(N, N);
  const d = img.data;
  const smooth = (t) => t * t * t * (t * (t * 6 - 15) + 10);   // quintic: C2 continuous

  // One periodic value-noise lattice at a given cell count.
  const lattice = (cells, seed) => {
    const r = rng(seed);
    const t = new Float32Array(cells * cells);
    for (let i = 0; i < t.length; i++) t[i] = r();
    return (u, v) => {
      const x = u * cells, y = v * cells;
      const x0 = Math.floor(x), y0 = Math.floor(y);
      const fx = smooth(x - x0), fy = smooth(y - y0);
      const at = (a, b) => t[(((b % cells) + cells) % cells) * cells + (((a % cells) + cells) % cells)];
      return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy)
           + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
    };
  };

  // Each channel is its own octave stack, normalised to 0..1.
  const stacks = [
    [[4, 1], [8, 0.5], [16, 0.25], [32, 0.125], [64, 0.0625]],   // R: broad, for swell
    [[8, 1], [16, 0.5], [32, 0.25], [64, 0.125]],                // G: working sea
    [[16, 1], [32, 0.55], [64, 0.30], [128, 0.15]],              // B: chop and glitter
    [[3, 1], [6, 0.5]],                                          // A: very long period
  ].map((oct, ch) => {
    const fns = oct.map(([cells, w], i) => [lattice(cells, 9173 + ch * 733 + i * 41), w]);
    const total = oct.reduce((a, [, w]) => a + w, 0);
    return (u, v) => {
      let acc = 0;
      for (const [f, w] of fns) acc += f(u, v) * w;
      return acc / total;
    };
  });

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4, u = x / N, v = y / N;
      for (let ch = 0; ch < 4; ch++) d[i + ch] = Math.max(0, Math.min(255, stacks[ch](u, v) * 255));
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
