// ============================================================================
//  AI captains. Two brains:
//    BotBrain    — sails a ship: navigation, tacking, gunnery, objectives.
//    BotAdmiral  — runs a fleet's treasury when no human has taken command.
//  Both are deliberately fallible: they misjudge range, react late, and pick
//  fights they should not.
// ============================================================================
import {
  PHASE, TEAMS, other, HOLD, GUN, SHOT, HULLS, HULL_IDS, UPGRADES, UPG_MAX,
  ORDERS, SHIP, CONVOY, WORLD_W, WORLD_H, NO_GO, MINE, SKYRAID, QUICKCHAT,
} from '../shared/constants.js';
import {
  clamp, lerp, wrapAngle, angleDiff, dist, dist2, makeRng, rngRange, rngPick,
  TAU, pointInPoly,
} from '../shared/math.js';
import { angleOffWind, polarFactor, visionRadius } from '../shared/physics.js';

const NAMES = [
  'Blackwood', 'Vane', 'Rackham', 'Teach', 'Bonny', 'Kidd', 'Drake', 'Hornigold',
  'Quelch', 'Roberts', 'Avery', 'Morgan', 'Lowther', 'Gibbs', 'Bellamy', 'Cofresi',
  'Ching', 'Surcouf', 'Maynard', 'Barbosa', 'Tew', 'Dampier', 'Halsey', 'Every',
];
const RANKS = ['Cpt.', 'Cmdr.', 'Lt.', 'Mstr.'];

const GOAL = {
  TAKE:   'TAKE',     // silence and capture a hold
  HOLD:   'HOLD',     // sit on one we own that is under threat
  HUNT:   'HUNT',
  RUN:    'RUN',      // damaged, head for supply
  SUPPLY: 'SUPPLY',   // out of shot
  BULLION:'BULLION',
};

export class BotBrain {
  static pickName(rng, taken) {
    for (let i = 0; i < 40; i++) {
      const n = `${rngPick(rng, RANKS)} ${rngPick(rng, NAMES)}`;
      if (!taken.includes(n)) return n;
    }
    return `Cpt. ${Math.floor(rng() * 900 + 100)}`;
  }

  /**
   * `skill` runs 0 (green) to 1 (hard). It moves three things — how quickly a
   * bot reacts, how well it lays a gun, and how many of the habits a good
   * human player has are switched on at all.
   */
  constructor(ship, seed, skill = 1) {
    this.rng = makeRng((seed * 1e9) >>> 0);
    this.skill = clamp(skill, 0, 1);
    this.goal = GOAL.TAKE;
    this.target = null;       // Ship
    this.hold = null;         // hold id
    this.think_t = 0;
    this.tackHold = 0;
    this.tackSide = this.rng() < 0.5 ? 1 : -1;
    // A hard fleet still has a spread of ability: nobody is a machine, and a
    // side where every hull reacts identically reads as fake within a minute.
    this.reaction = lerp(rngRange(this.rng, 0.30, 0.75),
                         rngRange(this.rng, 0.13, 0.30), this.skill);
    this.aimErr   = lerp(rngRange(this.rng, 0.030, 0.075),
                         rngRange(this.rng, 0.006, 0.026), this.skill);
    this.rangeErr = lerp(0.14, 0.035, this.skill);    // how badly it judges distance
    this.aggro = rngRange(this.rng, 0.35, 0.95);
    this.nerve = lerp(0.18, 0.36, this.skill);        // hull fraction it will run at
    this.dodgeT = 0;
    this.lane = null;
    this.fireT = 0;
    this.stanceT = 0;
    this.commitT = 0;        // stay on an objective long enough to finish it
    this.assigned = null;    // hold id handed down by the fleet coordinator
    this.job = 'attack';     // 'attack' | 'defend' | 'roam'
    // A doctrine, fixed for the match, so a fleet of bots is not eight copies
    // of the same captain all doing the same thing.
    const r = this.rng();
    this.doctrine = r < 0.30 ? 'siege' : r < 0.62 ? 'line' : r < 0.84 ? 'raider' : 'skirmish';
  }

  /** Habits that only a competent player has. Green crews simply lack them. */
  can(habit) {
    const need = {
      focus:     0.35,   // shoot what the rest of the fleet is shooting
      dodge:     0.30,   // get out from under a telegraphed sky raid
      minefield: 0.45,   // see a mine and go round it
      heaveTo:   0.55,   // furl sail while sieging, for the faster reload
      weather:   0.60,   // fight from upwind where you can choose the range
      finish:    0.25,   // press a cripple instead of picking a fresh fight
      screen:    0.70,   // lay mines across the water you are giving up
    };
    return this.skill >= (need[habit] ?? 1);
  }

  /** The hull this bot wants next time she is launched. */
  preferredHull() {
    switch (this.doctrine) {
      case 'siege':    return this.rng() < 0.75 ? 'galleon' : 'brigantine';
      case 'line':     return this.rng() < 0.70 ? 'brigantine' : 'galleon';
      case 'raider':   return this.rng() < 0.65 ? 'cutter' : 'xebec';
      default:         return this.rng() < 0.70 ? 'xebec' : 'cutter';
    }
  }

  // -- helpers --------------------------------------------------------------
  hullFrac(s) { return s.hull / Math.max(1, s.hullMax); }

  enemiesNear(m, s, r) {
    const out = [];
    for (const o of m.ships.values()) {
      if (!o.alive || o.team === s.team) continue;
      const d = dist(s.x, s.y, o.x, o.y);
      if (d < r) out.push({ s: o, d });
    }
    return out.sort((a, b) => a.d - b.d);
  }

  /** Is the straight line ahead clear of land for `maxD`? Returns clear distance. */
  rayClear(m, x, y, a, maxD, radius) {
    const step = 46;
    const cx = Math.cos(a), cy = Math.sin(a);
    for (let d = step; d <= maxD; d += step) {
      const px = x + cx * d, py = y + cy * d;
      if (px < radius || py < radius || px > WORLD_W - radius || py > WORLD_H - radius) return d;
      for (const isl of m.world.islands) {
        if (dist2(px, py, isl.x, isl.y) > (isl.r + radius) * (isl.r + radius)) continue;
        if (pointInPoly(px, py, isl.pts)) return d;
      }
      // Reefs do not stop a ship dead, but grinding across one bleeds her
      // badly — treat shoal water as nearly as bad as rock.
      for (const rf of m.world.reefs) {
        if (dist2(px, py, rf.x, rf.y) > (rf.r + radius) * (rf.r + radius)) continue;
        if (pointInPoly(px, py, rf.pts)) return d * 0.45;
      }
    }
    return maxD;
  }

  /**
   * Mines this bot is entitled to know about: its own fleet's, and enemy ones
   * close enough that a lookout would have called them. Reading the whole
   * minefield would be cheating, and it would feel like cheating.
   */
  minesSeen(m, s, r) {
    const out = [];
    for (const mn of m.mines) {
      const d = dist(s.x, s.y, mn.x, mn.y);
      if (d > r) continue;
      if (mn.team !== s.team && d > MINE.seeR) continue;
      if (mn.team === s.team) continue;            // ours do not hurt us
      out.push(mn);
    }
    return out;
  }

  /** Nudge a desired course onto the nearest heading that is not into trouble. */
  avoidLand(m, s, want) {
    // Look far enough ahead to actually turn. A galleon at speed needs several
    // hundred units of water to come round, so a short horizon is the same as
    // having no lookout at all.
    const look = 340 + Math.abs(s.speed) * 3.4 / Math.max(0.6, s.stats.turn);
    const radius = s.stats.beam * 0.9;
    const fans = [0, 0.22, -0.22, 0.45, -0.45, 0.7, -0.7, 1.0, -1.0, 1.35, -1.35, 1.75, -1.75, 2.2, -2.2];
    const mines = this.can('minefield') ? this.minesSeen(m, s, MINE.seeR + look) : [];
    let best = want, bestScore = -Infinity;
    for (const f of fans) {
      const a = wrapAngle(want + f);
      const clear = this.rayClear(m, s.x, s.y, a, look, radius);
      let score = (clear / look) * 3.2 - Math.abs(f) * 0.55 - Math.abs(angleDiff(s.heading, a)) * 0.18;
      // Steer round anything we have actually spotted in the water.
      for (const mn of mines) {
        const ahead = (mn.x - s.x) * Math.cos(a) + (mn.y - s.y) * Math.sin(a);
        if (ahead < 0 || ahead > look) continue;
        const px = s.x + Math.cos(a) * ahead, py = s.y + Math.sin(a) * ahead;
        const miss = dist(px, py, mn.x, mn.y);
        if (miss < MINE.radius + radius + 40) score -= 4.5 * (1 - miss / (MINE.radius + radius + 40));
      }
      if (score > bestScore) { bestScore = score; best = a; }
    }
    return best;
  }

  /**
   * A sky raid gives four seconds and draws its line on the water. Anyone
   * paying attention runs perpendicular to it — so competent bots do too.
   */
  dodgeCourse(m, s) {
    if (!this.can('dodge')) return null;
    for (const r of m.raids) {
      if (r.team === s.team) continue;
      const along = (s.x - r.x) * Math.cos(r.a) + (s.y - r.y) * Math.sin(r.a);
      const across = -(s.x - r.x) * Math.sin(r.a) + (s.y - r.y) * Math.cos(r.a);
      if (Math.abs(along) > SKYRAID.length * 0.62) continue;
      if (Math.abs(across) > SKYRAID.width * 2.4) continue;
      // Straight out of the lane, whichever side is nearer.
      return wrapAngle(r.a + (across >= 0 ? 1 : -1) * Math.PI / 2);
    }
    return null;
  }

  /** If the course is inside the no-go zone, commit to a tack instead. */
  sailable(m, s, want) {
    const windFrom = m.wind.dir + Math.PI;
    const off = Math.abs(angleDiff(want, windFrom));
    if (off >= NO_GO + 0.06) { this.tackHold = 0; return want; }
    if (this.tackHold > 0) return wrapAngle(windFrom + this.tackSide * (NO_GO + 0.20));
    // Pick the tack that gains most toward the goal, then stick with it — a
    // bot that flip-flops every tick makes no ground at all.
    const a1 = wrapAngle(windFrom + (NO_GO + 0.20));
    const a2 = wrapAngle(windFrom - (NO_GO + 0.20));
    this.tackSide = Math.abs(angleDiff(a1, want)) < Math.abs(angleDiff(a2, want)) ? 1 : -1;
    this.tackHold = rngRange(this.rng, 6, 12);
    return wrapAngle(windFrom + this.tackSide * (NO_GO + 0.20));
  }

  steer(m, s, tx, ty, dt) {
    let want = Math.atan2(ty - s.y, tx - s.x);
    const flee = this.dodgeCourse(m, s);
    if (flee !== null) { want = flee; this.dodgeT = 2.2; }
    want = this.sailable(m, s, want);
    want = this.avoidLand(m, s, want);
    const d = angleDiff(s.heading, want);
    s.rudder = clamp(d * 1.9, -1, 1);
    this.tackHold = Math.max(0, this.tackHold - dt);

    // Sail plan: crack on when clear, shorten sail to fight or to turn tight.
    const off = angleOffWind(s.heading, m.wind.dir);
    if (off < NO_GO * 0.85 && Math.abs(s.speed) < 14) s.sweeps = s.stamina > 25;
    else s.sweeps = false;
    const enemyClose = this.target && dist(s.x, s.y, this.target.x, this.target.y) < 520;
    s.sails = enemyClose ? 2 : (Math.abs(d) > 1.1 ? 2 : 3);
    if (this.dodgeT > 0) { s.sails = 3; this.dodgeT -= dt; }   // get out, fast
  }

  /**
   * Which of these is worth shooting. A good player does not simply engage the
   * nearest hull: they finish what is already hurt, they pile onto whatever the
   * rest of the fleet is shooting, and they go for the enemy flagship because
   * it costs the other side most.
   */
  pickVictim(m, s, near) {
    if (!near.length) return null;
    if (!this.can('focus')) return near[0].s;
    const focusId = m.fleets?.[s.team]?.focus || null;
    let best = null, bestScore = -Infinity;
    for (const { s: e, d } of near) {
      let v = 1600 - d;
      if (this.can('finish')) v += (1 - e.hull / Math.max(1, e.hullMax)) * 1500;
      if (e.sail / Math.max(1, e.sailMax) < 0.45) v += 500;   // she cannot run
      if (e.role === 'captain') v += 700;                     // the dearest prize
      if (e.id === focusId) v += 900;                         // the fleet's call
      if (m.now < e.invulnUntil) v -= 3000;                   // no point at all
      if (v > bestScore) { bestScore = v; best = e; }
    }
    return best || near[0].s;
  }

  // -- decision -------------------------------------------------------------
  decide(m, s) {
    const hp = this.hullFrac(s);
    const near = this.enemiesNear(m, s, 1500);
    const threat = this.pickVictim(m, s, near);

    if (s.ammo < 4) { this.goal = GOAL.SUPPLY; this.hold = this.nearestOwn(m, s); return; }
    // Know when you are beaten. Better crews break off earlier and live.
    if (hp < this.nerve && (!near[0] || near[0].d > 420)) {
      this.goal = GOAL.RUN; this.hold = this.nearestOwn(m, s); return;
    }

    // The Bullion Run is worth breaking off for.
    if (m.convoy && dist(s.x, s.y, m.convoy.x, m.convoy.y) < 2200 && this.rng() < 0.7) {
      this.goal = GOAL.BULLION; return;
    }

    // Defend only what the fleet has actually asked us to defend, and only
    // when it is genuinely slipping away.
    if (this.job === 'defend' && this.assigned !== null) {
      const h = m.holds.find(hh => hh.id === this.assigned);
      if (h && h.owner === s.team) { this.goal = GOAL.HOLD; this.hold = h.id; return; }
    }

    // Standing on a silenced hold IS the job. Do not wander off to duel: fight
    // from inside the ring, because leaving it throws the capture away.
    const objective = this.hold !== null ? m.holds.find(h => h.id === this.hold) : null;
    if (objective && objective.owner !== s.team && objective.fortHp <= 0
        && dist(s.x, s.y, objective.x, objective.y) < HOLD.captureR * 1.5) {
      this.goal = GOAL.TAKE; return;
    }

    // Fight what is in front of us if it is worth fighting. A ship already
    // committed to breaking a battery ignores anything that is not on top of her.
    const sieging = this.goal === GOAL.TAKE && this.commitT > 0 && this.doctrine === 'siege';
    const engageAt = sieging ? 420 : 900 * (0.5 + this.aggro);
    if (threat && dist(s.x, s.y, threat.x, threat.y) < engageAt && hp > this.nerve + 0.05) {
      this.goal = GOAL.HUNT; this.target = threat; return;
    }

    if (this.job === 'roam') {
      const n2 = this.enemiesNear(m, s, 2600);
      const v = this.pickVictim(m, s, n2);
      if (v) { this.goal = GOAL.HUNT; this.target = v; return; }
    }

    // Otherwise go and take something — and stay on it. A bot that re-picks
    // its objective every second never finishes taking anything.
    this.goal = GOAL.TAKE;
    const cur = this.hold !== null ? m.holds.find(h => h.id === this.hold) : null;
    if (cur && cur.owner !== s.team && this.commitT > 0 && this.assigned === cur.id) return;
    this.hold = this.assigned !== null ? this.assigned : this.pickTarget(m, s);
    const tgt = m.holds.find(h => h.id === this.hold);
    const travel = tgt ? dist(s.x, s.y, tgt.x, tgt.y) / 95 : 0;   // rough sailing time
    this.commitT = rngRange(this.rng, 20, 34) + travel;
  }

  nearestOwn(m, s) {
    let best = null, bd = Infinity;
    for (const h of m.holds) {
      if (h.owner !== s.team) continue;
      const d = dist2(s.x, s.y, h.x, h.y);
      if (d < bd) { bd = d; best = h.id; }
    }
    return best;
  }

  pickTarget(m, s) {
    // Prefer the gates early, then whatever is nearest and not already ours.
    const gatesHeld = m.holds.every(h => h.lane !== 'gate' || h.owner === s.team);
    let best = null, bestScore = -Infinity;
    for (const h of m.holds) {
      if (h.owner === s.team) continue;
      const d = dist(s.x, s.y, h.x, h.y);
      let score = 2600 - d;
      if (h.lane === 'gate') score += 900;
      if (h.owner === null) score += 700;             // neutral is cheaper to take
      if (h.fortHp <= 0) score += 1100;               // already silenced, go sit on it
      if (this.lane && h.lane === this.lane) score += 500;
      if (this.doctrine === 'siege' && h.fortHp > 0) score += 800;
      // Once both gates are ours there is nothing left but to push a lane.
      if (gatesHeld && h.lane !== 'gate') score += 1500;
      score += this.rng() * 420;
      if (score > bestScore) { bestScore = score; best = h.id; }
    }
    return best;
  }

  // -- gunnery --------------------------------------------------------------
  layGuns(m, s, tx, ty, dt, isFort) {
    const d = dist(s.x, s.y, tx, ty);
    if (d > GUN.maxRange * 1.1) return false;

    let aimX = tx, aimY = ty;
    if (!isFort && this.target && this.target.alive) {
      const t = this.target;
      const flight = d / GUN.ballSpeed;
      aimX = t.x + Math.cos(t.heading) * t.speed * flight;
      aimY = t.y + Math.sin(t.heading) * t.speed * flight;
    }
    const want = wrapAngle(Math.atan2(aimY - s.y, aimX - s.x) + rngRange(this.rng, -this.aimErr, this.aimErr));
    s.aimAngle = want;
    // Misjudging the range is what actually makes a broadside miss, so this is
    // the single number that separates a green gun crew from a good one.
    s.aimDist = clamp(dist(s.x, s.y, aimX, aimY) * (1 + rngRange(this.rng, -this.rangeErr, this.rangeErr)),
                      GUN.minRange, GUN.maxRange);

    // Choose ammunition for the job. A thinking gunner cripples a runner's rig,
    // sweeps the deck of a hull it cannot break, and otherwise fires round.
    const t = this.target;
    if (isFort) s.shot = 'round';
    else if (!t) s.shot = 'round';
    else if (this.skill >= 0.4) {
      const rig = t.sail / Math.max(1, t.sailMax);
      const hull = t.hull / Math.max(1, t.hullMax);
      const crew = t.crew / Math.max(1, t.crewMax);
      const faster = t.stats.speed > s.stats.speed * 1.02;
      if (rig > 0.55 && (faster || hull > 0.7)) s.shot = 'chain';
      else if (crew > 0.62 && hull > 0.55 && s.stats.guns >= 5) s.shot = 'grape';
      else s.shot = 'round';
    }
    else if (t.sail / t.sailMax > 0.55 && this.rng() < 0.35) s.shot = 'chain';
    else if (t.crew / t.crewMax > 0.6 && this.rng() < 0.15) s.shot = 'grape';
    else s.shot = 'round';

    if (d < GUN.minRange * 0.75 || d > GUN.maxRange) return true;

    this.fireT -= dt;
    if (this.fireT > 0) return true;

    const tryside = (side, rl) => {
      const beam = side === 0 ? s.heading : s.heading + side * Math.PI / 2;
      const arc = side === 0 ? GUN.chaseArc : GUN.arc;
      if (rl > 0.001) return false;
      if (Math.abs(angleDiff(beam, want)) > arc * 0.92) return false;
      return true;
    };
    if (tryside(-1, s.rlL)) { s.wantFireL = true; this.fireT = this.reaction * 0.5; }
    else if (tryside(+1, s.rlR)) { s.wantFireR = true; this.fireT = this.reaction * 0.5; }
    else if (s.stats.chase && tryside(0, s.rlC)) { s.wantFireC = true; this.fireT = this.reaction * 0.5; }
    return true;
  }

  /** Sail so that a broadside will bear: cross the target's course, not charge it. */
  broadsideCourse(m, s, tx, ty, wantRange = null) {
    const toT = Math.atan2(ty - s.y, tx - s.x);
    const d = dist(s.x, s.y, tx, ty);
    const want = wantRange !== null
      ? clamp(wantRange, GUN.minRange + 90, GUN.maxRange - 40)
      : clamp(lerp(620, 420, this.aggro), GUN.minRange + 90, GUN.maxRange - 180);
    // Circle the target at the range we like, in whichever direction we already lean.
    const side = angleDiff(s.heading, toT) > 0 ? -1 : 1;
    const tangent = toT + side * Math.PI / 2;
    const closing = clamp((d - want) / 420, -1, 1);
    return wrapAngle(tangent + closing * side * -0.9);
  }

  // -- main -----------------------------------------------------------------
  think(m, s, dt) {
    this.think_t -= dt;
    if (this.think_t <= 0) {
      this.think_t = rngRange(this.rng, 0.45, 1.1);
      if (!this.lane) this.lane = rngPick(this.rng, ['north', 'centre', 'south', 'gate']);
      this.decide(m, s);
    }
    this.commitT = Math.max(0, this.commitT - dt);
    // Refresh the target each tick so gunnery tracks smoothly between decisions.
    if (this.goal === GOAL.HUNT) {
      if (!this.target || !this.target.alive || dist(s.x, s.y, this.target.x, this.target.y) > 1800) {
        this.target = this.pickVictim(m, s, this.enemiesNear(m, s, 1600));
        if (!this.target) this.goal = GOAL.TAKE;
      }
    } else if (this.goal !== GOAL.BULLION) {
      this.target = null;
    }

    // Crew stations to suit the job.
    this.stanceT -= dt;
    if (this.stanceT <= 0) {
      this.stanceT = 2.5;
      const hp = this.hullFrac(s);
      if (hp < 0.4) s.setStance('repair');
      else if (this.goal === GOAL.HUNT || this.goal === GOAL.HOLD) s.setStance('battle');
      else if (this.goal === GOAL.TAKE && this.hold !== null) s.setStance('battle');
      else s.setStance('chase');
    }

    const hold = this.hold !== null ? m.holds.find(h => h.id === this.hold) : null;

    switch (this.goal) {
      case GOAL.HUNT: {
        const t = this.target;
        if (!t) break;
        const c = this.broadsideCourse(m, s, t.x, t.y);
        this.steer(m, s, s.x + Math.cos(c) * 600, s.y + Math.sin(c) * 600, dt);
        this.layGuns(m, s, t.x, t.y, dt, false);
        break;
      }
      case GOAL.BULLION: {
        if (!m.convoy) { this.goal = GOAL.TAKE; break; }
        const c = m.convoy;
        const course = this.broadsideCourse(m, s, c.x, c.y, 520);
        this.steer(m, s, s.x + Math.cos(course) * 600, s.y + Math.sin(course) * 600, dt);
        this.target = null;
        this.layGuns(m, s, c.x, c.y, dt, true);
        break;
      }
      case GOAL.TAKE:
      case GOAL.HOLD: {
        if (!hold) { this.goal = GOAL.TAKE; this.hold = this.pickTarget(m, s); break; }
        const d = dist(s.x, s.y, hold.x, hold.y);
        const mine = hold.owner === s.team;

        if (!mine && hold.fortHp > 0) {
          // Stand off OUTSIDE the battery's reach and knock it down for free.
          // Closing inside that circle is how a ship dies to a fort.
          const reach = m.fortReach(hold);
          const standoff = clamp(reach + 90, GUN.minRange + 140, GUN.maxRange - 30);
          const course = this.broadsideCourse(m, s, hold.x, hold.y, standoff);
          this.steer(m, s, s.x + Math.cos(course) * 600, s.y + Math.sin(course) * 600, dt);
          this.layGuns(m, s, hold.x, hold.y, dt, true);
          // Hove to at the right range with nobody nearby, the guns run out
          // a quarter faster. Experienced crews take that trade.
          if (this.can('heaveTo') && !this.enemiesNear(m, s, 900).length) {
            const off = Math.abs(d - standoff);
            const bears = Math.abs(Math.abs(angleDiff(s.heading, Math.atan2(hold.y - s.y, hold.x - s.x))) - Math.PI / 2);
            if (off < 150 && bears < 0.5) s.sails = 0;
          }
        } else {
          // Hold station in the band of water between the shore and the edge
          // of the capture ring. Steering at the island centre just runs you
          // aground, so orbit a radius that is actually navigable.
          const ring = clamp(hold.r + 105, hold.r + 70, HOLD.captureR - 60);
          const bearing = Math.atan2(s.y - hold.y, s.x - hold.x);
          if (d > HOLD.captureR - 40) {
            this.steer(m, s, hold.x + Math.cos(bearing) * ring, hold.y + Math.sin(bearing) * ring, dt);
          } else {
            const orbit = bearing + 0.75;
            this.steer(m, s, hold.x + Math.cos(orbit) * ring, hold.y + Math.sin(orbit) * ring, dt);
            s.sails = 1;
          }
          const n = this.enemiesNear(m, s, 1100);
          if (n[0]) { this.target = n[0].s; this.layGuns(m, s, n[0].s.x, n[0].s.y, dt, false); }
          else if (hold.fortHp > 0 && !mine) this.layGuns(m, s, hold.x, hold.y, dt, true);
        }
        // Lay a mine behind us when we are about to be pushed off.
        if (s.mines > 0 && hold.contested && this.rng() < 0.004) s.wantMine = true;
        break;
      }
      case GOAL.RUN:
      case GOAL.SUPPLY: {
        const h = hold || m.holds.find(hh => hh.owner === s.team);
        if (!h) { this.goal = GOAL.TAKE; break; }
        this.steer(m, s, h.x, h.y, dt);
        s.sails = 3;
        // Leave something in the water behind you. Being chased by someone who
        // mines their own wake is how a pursuit turns expensive.
        if (this.goal === GOAL.RUN && this.can('screen') && s.mines > 0
            && this.enemiesNear(m, s, 700).length && this.rng() < 0.012) s.wantMine = true;
        const n = this.enemiesNear(m, s, 800);
        if (n[0]) { this.target = n[0].s; this.layGuns(m, s, n[0].s.x, n[0].s.y, dt, false); this.target = null; }
        if (dist(s.x, s.y, h.x, h.y) < HOLD.supplyR * 0.7
            && s.ammo > s.ammoMax * 0.8 && this.hullFrac(s) > 0.75) { this.goal = GOAL.TAKE; this.think_t = 0; }
        break;
      }
    }
  }
}

// ============================================================================
//  The bot admiral: spends a fleet's purse when nobody human is in command.
// ============================================================================
export class BotAdmiral {
  constructor(team, seed, skill = 1) {
    this.team = team;
    this.rng = makeRng((seed * 1e9) >>> 0);
    this.skill = clamp(skill, 0, 1);
    this.t = 0;
    this.orderT = rngRange(this.rng, 6, 16);
    // Every bot admiral has a different doctrine, so two bot games do not
    // play out identically.
    const ids = Object.keys(UPGRADES);
    this.plan = ids.map(id => ({ id, w: rngRange(this.rng, 0.4, 1.6) }))
                   .sort((a, b) => b.w - a.w);
  }

  /**
   * What this fleet most needs right now, on top of its standing doctrine. A
   * competent admiral reads the battle; a green one just works down a list.
   */
  urgency(m, id) {
    if (this.skill < 0.4) return 0;
    const t = m.teams[this.team];
    const mine = m.holds.filter(h => h.owner === this.team);
    const ships = [...m.ships.values()].filter(s => s.team === this.team);
    const alive = ships.filter(s => s.alive);
    const hurtForts = mine.filter(h => h.fortHp < h.fortMax * 0.6).length;
    const weather = m.squalls.filter(q => alive.some(s => dist(s.x, s.y, q.x, q.y) < q.r)).length;
    const behind = t.colours < m.teams[other(this.team)].colours;
    const dying = ships.length ? ships.reduce((n, s) => n + (s.alive ? 0 : 1), 0) / ships.length : 0;
    switch (id) {
      case 'armour':   return hurtForts * 0.9 + (mine.length > 4 ? 0.8 : 0);
      case 'heated':   return mine.length >= 4 ? 1.0 : 0;
      case 'longnine': return mine.length >= 3 && behind ? 0.9 : 0;
      case 'storm':    return weather * 0.55;
      case 'dockyard': return dying * 2.2;
      case 'frames':   return behind ? 1.0 : 0.3;
      case 'powder':   return alive.length >= 3 ? 0.9 : 0.2;
      case 'copper':   return mine.length < 3 ? 0.9 : 0.2;   // we need to get there
      case 'signal':   return 0.4;
      default:         return 0;
    }
  }

  captainShip(m) {
    const id = m.teams[this.team].captain;
    return id ? m.ships.get(id) : null;
  }

  think(m, dt) {
    const t = m.teams[this.team];
    const cap = this.captainShip(m);
    if (!cap) return;

    this.t -= dt;
    if (this.t <= 0) {
      this.t = rngRange(this.rng, 2.5, 5.5);
      // Buy the highest-weighted thing we can afford, keeping a war chest for
      // orders once the fighting starts.
      const reserve = m.phase === PHASE.MUSTER ? 0 : 150;
      const ranked = this.plan
        .map(p => ({ ...p, score: p.w + this.urgency(m, p.id) }))
        .sort((a, b) => b.score - a.score);
      for (const p of ranked) {
        const lvl = t.upg[p.id] | 0;
        if (lvl >= UPG_MAX) continue;
        const cost = UPGRADES[p.id].cost[lvl];
        if (t.doubloons - cost < reserve) continue;
        m.buy(cap.id, p.id);
        break;
      }
    }

    if (m.phase === PHASE.MUSTER) return;
    this.orderT -= dt;
    if (this.orderT > 0) return;
    this.orderT = rngRange(this.rng, 5, 11);
    if (t.globalCd > 0) return;

    const foe = other(this.team);
    const enemies = [...m.ships.values()].filter(s => s.alive && s.team === foe);
    const friends = [...m.ships.values()].filter(s => s.alive && s.team === this.team);

    // Shore Works on the most battered friendly fort.
    const hurt = m.holds.filter(h => h.owner === this.team && h.fortHp > 0 && h.fortHp < h.fortMax * 0.55)
                        .sort((a, b) => a.fortHp - b.fortHp)[0];
    if (hurt && t.orderCd.works <= 0 && t.doubloons > ORDERS.works.cost + 120) {
      if (!m.issueOrder(cap.id, 'works', 0, 0, hurt.id)) return;
    }

    // Sky raid the tightest knot of enemy ships we can see.
    const knot = this.cluster(enemies, 700);
    if (knot && knot.n >= 2 && t.orderCd.skyraid <= 0 && t.doubloons > ORDERS.skyraid.cost + 80) {
      if (!m.issueOrder(cap.id, 'skyraid', knot.x, knot.y)) return;
    }

    // Rally our own knot when it is near a contested hold.
    const ours = this.cluster(friends, 800);
    const hot = m.holds.find(h => h.contested);
    if (ours && ours.n >= 2 && hot && t.orderCd.rally <= 0 && t.doubloons > ORDERS.rally.cost + 60) {
      if (dist(ours.x, ours.y, hot.x, hot.y) < 1400 && !m.issueOrder(cap.id, 'rally', ours.x, ours.y)) return;
    }

    // Mine the approaches to a hold we own and expect to be attacked.
    const risky = m.holds.filter(h => h.owner === this.team).sort(() => this.rng() - 0.5)[0];
    if (risky && t.orderCd.mines <= 0 && t.doubloons > ORDERS.mines.cost + 200) {
      const a = this.rng() * TAU;
      if (!m.issueOrder(cap.id, 'mines', risky.x + Math.cos(a) * 520, risky.y + Math.sin(a) * 520)) return;
    }

    // Smoke to cover a push.
    if (knot && ours && t.orderCd.smoke <= 0 && t.doubloons > ORDERS.smoke.cost + 240) {
      if (!m.issueOrder(cap.id, 'smoke', (ours.x + knot.x) / 2, (ours.y + knot.y) / 2)) return;
    }
  }

  /** Densest group of ships within radius r: {x, y, n}. */
  cluster(list, r) {
    let best = null;
    for (const a of list) {
      let n = 0, sx = 0, sy = 0;
      for (const b of list) {
        if (dist(a.x, a.y, b.x, b.y) < r) { n++; sx += b.x; sy += b.y; }
      }
      if (!best || n > best.n) best = { x: sx / n, y: sy / n, n };
    }
    return best;
  }
}


// ============================================================================
//  A fleet coordinator. Without one, eight bots all defend the same contested
//  gate and the map never moves. This hands out jobs so a fleet concentrates
//  where it matters and still leaves someone minding the back door.
// ============================================================================
export class FleetAI {
  constructor(team, seed, skill = 1) {
    this.team = team;
    this.rng = makeRng((seed * 1e9) >>> 0);
    this.skill = clamp(skill, 0, 1);
    this.t = 0;
    this.focus = null;     // the hull the whole fleet is told to pile onto
    this.focusT = 0;
    this.talkT = rngRange(this.rng, 14, 40);
  }

  /**
   * Call the target. Concentrating fire is the single biggest thing that
   * separates a fleet from a crowd, so the coordinator names one hull that
   * everyone in range should be shooting at.
   */
  callTarget(m, crew) {
    const cur = this.focus ? m.ships.get(this.focus) : null;
    if (cur && cur.alive && this.focusT > 0) return;
    let best = null, bestScore = -Infinity;
    for (const e of m.ships.values()) {
      if (e.team === this.team || !e.alive) continue;
      if (m.now < e.invulnUntil) continue;
      // Worth calling only if enough of ours could actually reach it.
      let inReach = 0, nearest = Infinity;
      for (const s of crew) {
        const d = dist(s.x, s.y, e.x, e.y);
        nearest = Math.min(nearest, d);
        if (d < GUN.maxRange * 1.5) inReach++;
      }
      if (inReach < 2) continue;
      let v = inReach * 600 - nearest * 0.35;
      v += (1 - e.hull / Math.max(1, e.hullMax)) * 1400;
      if (e.role === 'captain') v += 600;
      if (v > bestScore) { bestScore = v; best = e; }
    }
    this.focus = best ? best.id : null;
    this.focusT = best ? 7 : 2;
  }

  /** Ask the captain for what the fleet is actually short of. */
  speakUp(m, alive) {
    const t = m.teams[this.team];
    const voice = rngPick(this.rng, alive);
    const lowHull = alive.filter(s => s.hull / Math.max(1, s.hullMax) < 0.5).length;
    const forts = m.holds.filter(h => h.owner === this.team && h.fortHp < h.fortMax * 0.5).length;
    const losing = t.colours < m.teams[other(this.team)].colours * 0.8;
    let id = 'aye';
    if (forts >= 2) id = 'buyfort';
    else if (lowHull >= Math.ceil(alive.length / 2)) id = 'buyhull';
    else if (losing) id = 'buyguns';
    else if (t.doubloons > 700) id = 'buyguns';
    else if (this.rng() < 0.4) id = 'wantrun';
    else return;
    m.say(voice.id, null, id);
  }

  /** How badly a hold we own is in danger right now. */
  threat(m, h) {
    if (h.owner !== this.team) return 0;
    let t = 0;
    if (h.fortHp <= 0) t += 3;
    else t += (1 - h.fortHp / Math.max(1, h.fortMax)) * 2;
    if (h.cap > 0.05 && h.capTeam && h.capTeam !== this.team) t += 4 + h.cap * 6;
    for (const s of m.ships.values()) {
      if (!s.alive || s.team === this.team) continue;
      const d = dist(s.x, s.y, h.x, h.y);
      if (d < HOLD.captureR * 2.2) t += 1.6;
      else if (d < 1600) t += 0.4;
    }
    return t;
  }

  /** How attractive an enemy or neutral hold is as a target. */
  prize(m, h, crew) {
    if (h.owner === this.team) return -1;
    let v = h.lane === 'gate' ? 5 : 3;
    if (h.owner === null) v += 2;                       // neutral is cheapest
    if (h.fortHp <= 0) v += 14;                         // open: standing on it IS the win
    else v -= (h.fortHp / Math.max(1, h.fortMax)) * 2.5;
    // Prefer somewhere the fleet can actually reach soon.
    let near = Infinity;
    for (const s of crew) near = Math.min(near, dist(s.x, s.y, h.x, h.y));
    v += clamp(3 - near / 1400, -3, 3);
    return v;
  }

  think(m, dt) {
    this.focusT -= dt;
    this.talkT -= dt;
    this.t -= dt;
    if (this.t > 0) return;
    this.t = 2.0;

    const crew = [...m.ships.values()].filter(s => s.team === this.team && m.bots.has(s.id));
    if (!crew.length) return;
    const alive = crew.filter(s => s.alive);
    if (this.skill >= 0.35) this.callTarget(m, alive);

    // A bot crew under a human captain still has opinions, and voicing them is
    // most of what makes commanding a fleet feel like commanding a fleet.
    const capShip = m.teams[this.team].captain ? m.ships.get(m.teams[this.team].captain) : null;
    if (this.talkT <= 0 && capShip && !capShip.bot && alive.length) {
      this.talkT = rngRange(this.rng, 28, 62);
      this.speakUp(m, alive);
    }

    const mine = m.holds.filter(h => h.owner === this.team);
    const threats = mine.map(h => ({ h, t: this.threat(m, h) })).sort((a, b) => b.t - a.t);
    const prizes = m.holds.map(h => ({ h, v: this.prize(m, h, alive.length ? alive : crew) }))
                          .filter(p => p.v > -1).sort((a, b) => b.v - a.v);

    // One roamer per four hulls keeps the sea lanes dangerous.
    const roamers = Math.max(0, Math.floor(crew.length / 4));
    // Defend only what is genuinely under threat, and never more than half the fleet.
    const needDefence = threats.filter(t => t.t >= 3).slice(0, Math.max(1, Math.floor(crew.length / 2)));

    // Nearest hulls take the nearest jobs.
    const pool = crew.slice().sort((a, b) => (a.alive ? 0 : 1) - (b.alive ? 0 : 1));
    const taken = new Set();
    const assign = (ship, holdId, job) => {
      const b = m.bots.get(ship.id);
      if (!b) return;
      if (b.assigned !== holdId || b.job !== job) { b.commitT = 0; b.think_t = 0; }
      b.assigned = holdId; b.job = job;
      taken.add(ship.id);
    };

    for (const { h } of needDefence) {
      const best = pool.filter(s => !taken.has(s.id))
                       .sort((a, b) => dist2(a.x, a.y, h.x, h.y) - dist2(b.x, b.y, h.x, h.y))[0];
      if (best) assign(best, h.id, 'defend');
    }

    let r = 0;
    const rest = pool.filter(s => !taken.has(s.id));
    // Concentrate: send the fleet at the top one or two prizes rather than
    // spreading one lonely ship against each.
    // If something is standing open, throw most of the fleet at it; otherwise
    // split between the two best prizes.
    const open = prizes.filter(p => p.h.fortHp <= 0);
    const targets = open.length ? open.slice(0, 1) : prizes.slice(0, Math.max(1, Math.min(2, prizes.length)));
    rest.forEach((s, i) => {
      const brain = m.bots.get(s.id);
      if (!open.length && r < roamers && brain && brain.doctrine === 'raider') {
        assign(s, null, 'roam'); r++; return;
      }
      const t = targets[i % targets.length];
      assign(s, t ? t.h.id : null, 'attack');
    });
  }
}
