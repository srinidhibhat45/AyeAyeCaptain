// ============================================================================
//  Sailing physics — run identically on the server (authority) and the client
//  (prediction). Pure and deterministic given its inputs.
// ============================================================================
import { POLAR, NO_GO, SHIP, HANDS, VISION, UPG_FX, RALLY, GUN } from './constants.js';
import { clamp, lerp, wrapAngle, TAU, closestOnPoly, pointInPoly } from './math.js';

/** Level of a team upgrade, from the team's upgrade map. 0 when unowned. */
export const upg = (u, id) => (u && u[id]) | 0;

/** Speed factor from the polar diagram, given angle off the wind's source. */
export function polarFactor(offWind, noGo = NO_GO) {
  const a = Math.abs(offWind);
  if (a < noGo) {
    // Inside the no-go zone the sails luff. Fade smoothly so the edge is learnable.
    const t = a / noGo;
    return 0.055 + 0.13 * t * t;
  }
  for (let i = 1; i < POLAR.length; i++) {
    if (a <= POLAR[i][0]) {
      const [a0, v0] = POLAR[i - 1], [a1, v1] = POLAR[i];
      return lerp(v0, v1, (a - a0) / (a1 - a0));
    }
  }
  return POLAR[POLAR.length - 1][1];
}

/**
 * Angle between the ship's heading and the direction the wind is COMING FROM.
 * 0 = bow straight into the wind (in irons), PI = running dead downwind.
 */
export function angleOffWind(heading, windDir) {
  return Math.abs(wrapAngle(heading - (windDir + Math.PI)));
}

/** Crew-station multipliers derived from the hand allocation. */
export function crewEffects(s) {
  const a = s.alloc;
  const health = s.crewMax > 0 ? clamp(s.crew / s.crewMax, 0.25, 1) : 1;
  return {
    reload: (1.46 - 0.92 * (a.gun / HANDS)) / lerp(0.62, 1, health),
    sail:   (0.80 + 0.32 * (a.sail / HANDS)) * lerp(0.78, 1, health),
    repair: (a.rep / HANDS) * 3.0 * lerp(0.5, 1, health),
    vision: lerp(VISION.lookoutMin, VISION.lookoutMax, a.look / HANDS),
  };
}

/** How much a squall hurts this ship, after the captain's Storm Rigging. */
export function stormResist(s) {
  return clamp(1 - UPG_FX.storm * upg(s.upg, 'storm'), 0.1, 1);
}

/** Effective max speed right now, in world units/second. */
export function targetSpeed(s, wind, env = {}) {
  const H = s.stats;
  const ce = crewEffects(s);
  const off = angleOffWind(s.heading, wind.dir);
  let f = polarFactor(off);
  // The upwind hull characteristic only matters when actually beating to windward.
  if (off < 1.4) f *= lerp(1, H.upwind, clamp((1.4 - off) / 1.4, 0, 1));

  const sailPower = SHIP.sailPower[s.sails]
                  * (s.sailMax > 0 ? clamp(s.sail / s.sailMax, 0.18, 1) : 0.18);

  let v = SHIP.baseSpeed * H.speed * f * sailPower * ce.sail * wind.speed;
  v *= 1 + UPG_FX.copper * upg(s.upg, 'copper');       // Copper Sheathing
  if (s.rallyUntil && env.now && env.now < s.rallyUntil) v *= 1 + RALLY.speed;
  if (env.inSupply) v *= 1.06;                          // a clean, busy anchorage
  if (s.slowUntil && env.now && env.now < s.slowUntil) v *= 0.62;
  return v;
}

/**
 * Advance one ship by dt. Mutates `s`. `env` carries world context:
 *   { islands, worldW, worldH, now, inSquall, squallPush:{x,y}, inSupply,
 *     onGround(dmg) }
 */
export function stepShip(s, wind, dt, env = {}) {
  const H = s.stats;
  const ce = crewEffects(s);

  // --- rudder ---------------------------------------------------------------
  s.rudderPos = lerp(s.rudderPos, s.rudder, clamp(SHIP.rudderLerp * dt, 0, 1));

  // Rudder authority scales with speed through the water: a stopped ship will
  // not answer her helm. Learning to keep way on is half of sailing well.
  const way = clamp(Math.abs(s.speed) / 52, 0, 1);
  const turnRate = SHIP.baseTurn * H.turn * way * SHIP.sailTurnPenalty[s.sails]
                 * lerp(0.55, 1, s.sailMax > 0 ? clamp(s.sail / s.sailMax, 0, 1) : 0)
                 * lerp(0.85, 1.12, ce.sail - 0.8);
  s.heading = wrapAngle(s.heading + s.rudderPos * turnRate * dt);

  // --- forward speed --------------------------------------------------------
  let tgt = targetSpeed(s, wind, env);

  // Sweeps: emergency oars to claw out of irons or off a lee shore.
  if (s.sweeps && s.stamina > 0 && s.crew > 0) {
    tgt = Math.max(tgt, SHIP.sweepSpeed * (s.crew / Math.max(1, s.crewMax)));
    s.stamina = clamp(s.stamina - SHIP.sweepDrain * dt, 0, SHIP.staminaMax);
  } else {
    s.stamina = clamp(s.stamina + SHIP.sweepRegen * dt, 0, SHIP.staminaMax);
  }

  const rate = tgt > s.speed ? SHIP.accel : SHIP.decel;
  s.speed = lerp(s.speed, tgt, clamp(rate * dt, 0, 1));

  // --- leeway: ships slip sideways downwind; heavy hulls slip less ----------
  const off = angleOffWind(s.heading, wind.dir);
  const leeway = Math.sin(off) * 13 * wind.speed
               * (1 - clamp(H.speed - 0.7, 0, 1) * 0.35)
               * (s.sails === 0 ? 0.35 : 1);
  const leeSign = Math.sign(wrapAngle(s.heading - (wind.dir + Math.PI))) || 1;
  let vx = Math.cos(s.heading) * s.speed + Math.cos(s.heading + leeSign * Math.PI / 2) * leeway;
  let vy = Math.sin(s.heading) * s.speed + Math.sin(s.heading + leeSign * Math.PI / 2) * leeway;

  // A squall shoves you bodily to leeward unless the captain bought rigging.
  if (env.squallPush) {
    const r = stormResist(s);
    vx += env.squallPush.x * r;
    vy += env.squallPush.y * r;
  }

  s.x += vx * dt;
  s.y += vy * dt;

  // --- world bounds ---------------------------------------------------------
  const m = 60;
  if (s.x < m) { s.x = m; s.speed *= 0.6; }
  if (s.y < m) { s.y = m; s.speed *= 0.6; }
  if (s.x > env.worldW - m) { s.x = env.worldW - m; s.speed *= 0.6; }
  if (s.y > env.worldH - m) { s.y = env.worldH - m; s.speed *= 0.6; }

  // --- grounding ------------------------------------------------------------
  s.groundCd = Math.max(0, (s.groundCd || 0) - dt);
  if (env.islands) {
    const r = H.beam * 0.62;
    for (const isl of env.islands) {
      const dx = s.x - isl.x, dy = s.y - isl.y;
      const reach = isl.r + r + 40;
      if (dx * dx + dy * dy > reach * reach) continue;
      const inside = pointInPoly(s.x, s.y, isl.pts);
      const cp = closestOnPoly(s.x, s.y, isl.pts);
      if (inside || cp.d < r) {
        const impact = Math.abs(s.speed);
        let nxv = s.x - cp.x, nyv = s.y - cp.y;
        const nl = Math.hypot(nxv, nyv) || 1;
        nxv /= nl; nyv /= nl;
        if (inside) { nxv = -nxv; nyv = -nyv; }
        s.x = cp.x + nxv * (r + 2.5);
        s.y = cp.y + nyv * (r + 2.5);
        s.speed *= 0.10;
        // One jarring impact, then a grace period — scraping a shore should not
        // shred a hull tick by tick.
        if (env.onGround && impact > 34 && s.groundCd <= 0) {
          s.groundCd = 1.6;
          env.onGround(Math.min(46, (impact - 34) * SHIP.groundingDmg));
        }
        break;
      }
    }
  }

  // --- passive recovery -----------------------------------------------------
  let rep = ce.repair * dt;
  if (env.inSquall) rep *= 0.25;                       // no one goes aloft in that
  if (env.inSupply) rep += (env.supplyRepair || 0) * dt;
  if (env.lastStand) rep *= 1 + (env.lastStandBonus || 0);
  if (rep > 0) {
    s.hull = Math.min(s.hullMax, s.hull + rep * 0.95);
    s.sail = Math.min(s.sailMax, s.sail + rep * 1.35);
  }
  return s;
}

/** Vision radius this ship currently projects. */
export function visionRadius(s, env = {}) {
  const ce = crewEffects(s);
  let v = VISION.base * s.stats.vision * ce.vision;
  v *= 1 + UPG_FX.signal * upg(s.upg, 'signal');       // Signal Mast
  if (env.inSquall) v *= 0.46;
  return v;
}

/** How detectable this ship is (multiplies the *observer's* vision). */
export function signature(s) {
  let sig = VISION.sailMod[s.sails];
  if (s.fireT > 0) sig *= 1.45;             // a burning ship is a beacon
  sig *= lerp(0.94, 1.10, clamp(s.stats.len / 78, 0, 1));
  return sig;
}

/** Seconds between broadsides for this ship right now. */
export function reloadTime(s, now = 0) {
  const ce = crewEffects(s);
  let t = GUN.reloadBase * ce.reload;
  t *= 1 - UPG_FX.powder * upg(s.upg, 'powder');       // Powder Monkeys
  if (s.rallyUntil && now < s.rallyUntil) t *= 1 - RALLY.reload;
  if (s.sails === 0) t *= 0.74;                        // hove to, guns run out fast
  return Math.max(1.4, t);
}
export { TAU };
