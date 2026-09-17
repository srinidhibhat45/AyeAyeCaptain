// ============================================================================
//  A ship under a player's (or a bot's) command.
// ============================================================================
import { HULLS, FLAGSHIP, SHIP, HANDS, STANCES, GUN, UPG_FX } from '../shared/constants.js';
import { clamp, wrapAngle, own } from '../shared/math.js';

export function hullStats(hullId) {
  return hullId === 'flagship' ? FLAGSHIP : (own(HULLS, hullId) || HULLS.brigantine);
}

export class Ship {
  constructor(id, name, team, role = 'helm') {
    this.id = id;
    this.name = name;
    this.team = team;
    this.role = role;                 // 'captain' | 'helm'
    this.bot = false;
    this.connected = true;
    this.wantsCommand = false;        // this player has asked for the deck
    this.standDown = false;           // ... or asked to be relieved of it

    this.hullId = role === 'captain' ? 'flagship' : 'brigantine';
    this.stats = hullStats(this.hullId);
    this.nextHullId = null;           // chosen while dead, applied on respawn
    this.lastHullId = 'brigantine';   // what to give back when command changes

    // kinematics
    this.x = 0; this.y = 0; this.heading = 0;
    this.speed = 0; this.rudder = 0; this.rudderPos = 0;
    this.sails = 2; this.sweeps = false; this.stamina = SHIP.staminaMax;

    // condition
    this.hull = 1; this.hullMax = 1;
    this.sail = 1; this.sailMax = 1;
    this.crew = HANDS; this.crewMax = HANDS;
    this.fireT = 0;

    // crew stations
    this.alloc = { ...STANCES.battle.alloc };
    this.stance = 'battle';

    // gunnery
    this.shot = 'round';
    this.ammo = 40; this.ammoMax = 40;
    this.mines = 2; this.minesMax = 2;
    this.rlL = 0; this.rlR = 0; this.rlC = 0;
    this.aimAngle = 0; this.aimDist = 620;

    // status
    this.alive = false;
    this.deadAt = 0;
    this.respawnAt = 0;
    this.invulnUntil = 0;
    this.rallyUntil = 0;
    this.slowUntil = 0;
    this.lastHitAt = 0;
    this.lastHitBy = null;
    this.lastDamageKind = null;
    this.upg = {};                    // mirror of the team's upgrade levels

    // who has been hurting her lately, for assist credit
    this.hitLog = [];                 // { by, at, dmg }

    // score
    this.kills = 0; this.deaths = 0; this.assists = 0;
    this.caps = 0; this.dmg = 0; this.fortDmg = 0; this.salvage = 0;

    // net
    this.seq = 0;
    this.lastInputAt = 0;
  }

  /** Effective maxima after the captain's fleet upgrades. */
  get hullCap() { return Math.round(this.stats.hull * (1 + UPG_FX.frames * (this.upg.frames | 0))); }
  get sailCap() { return this.stats.sailHp; }
  get ammoCap() { return this.stats.ammo; }

  /**
   * Refit at sea: become a different hull without leaving the water. Position,
   * heading, way and the FRACTION of damage carried all survive the change.
   * Used when command passes hands, so nobody loses a ship to someone else's
   * disconnect.
   */
  refitAtSea(hullId, now) {
    if (hullId !== 'flagship') this.lastHullId = hullId;
    const hullK = this.hullMax > 0 ? clamp(this.hull / this.hullMax, 0.25, 1) : 1;
    const sailK = this.sailMax > 0 ? clamp(this.sail / this.sailMax, 0.25, 1) : 1;
    const ammoK = this.ammoMax > 0 ? clamp(this.ammo / this.ammoMax, 0, 1) : 1;
    this.hullId = hullId;
    this.stats = hullStats(hullId);
    this.hullMax = this.hullCap;   this.hull = Math.max(1, this.hullMax * hullK);
    this.sailMax = this.sailCap;   this.sail = this.sailMax * sailK;
    this.ammoMax = this.ammoCap;   this.ammo = Math.round(this.ammoMax * ammoK);
    this.minesMax = this.stats.mines; this.mines = Math.min(this.mines, this.minesMax);
    this.rlL = 1; this.rlR = 1; this.rlC = 1;      // guns have to be run out again
    this.invulnUntil = Math.max(this.invulnUntil, now + 1800);
    return this;
  }

  /** Put a fresh ship in the water. */
  reset(x, y, heading, now) {
    this.hullId = this.role === 'captain' ? 'flagship' : (this.nextHullId || this.lastHullId || this.hullId);
    if (this.hullId !== 'flagship') this.lastHullId = this.hullId;
    this.nextHullId = null;
    this.stats = hullStats(this.hullId);

    this.x = x; this.y = y; this.heading = heading;
    this.speed = 0; this.rudder = 0; this.rudderPos = 0;
    this.sails = 2; this.sweeps = false; this.stamina = SHIP.staminaMax;

    this.hullMax = this.hullCap;   this.hull = this.hullMax;
    this.sailMax = this.sailCap;   this.sail = this.sailMax;
    this.crewMax = HANDS;          this.crew = HANDS;
    this.fireT = 0;

    this.ammoMax = this.ammoCap;   this.ammo = this.ammoMax;
    this.minesMax = this.stats.mines; this.mines = this.minesMax;
    this.rlL = 0; this.rlR = 0; this.rlC = 0;
    this.aimAngle = heading + Math.PI / 2;
    this.aimDist = 620;

    this.alive = true;
    this.invulnUntil = now + SHIP.invulnMs;
    this.rallyUntil = 0; this.slowUntil = 0;
    this.lastHitBy = null; this.lastDamageKind = null;
    this.hitLog.length = 0;
    this.groundCd = 0;
    return this;
  }

  setStance(id) {
    const st = own(STANCES, id);
    if (!st) return;
    this.stance = id;
    this.alloc = { ...st.alloc };
  }

  /** Move one hand between stations. Total always stays at HANDS. */
  shiftHand(from, to) {
    const a = this.alloc;
    // `in` walks the prototype chain: 'toString' in alloc is true, and
    // decrementing a function turns the whole allocation into NaN.
    if (!Object.hasOwn(a, from) || !Object.hasOwn(a, to) || from === to) return;
    if (!(a[from] > 0)) return;
    a[from]--; a[to]++;
    this.stance = 'custom';
  }

  /** Apply damage. `kind` feeds the kill feed. Returns true if this sank her. */
  takeDamage(hullDmg, sailDmg, crewDmg, byId, kind, now) {
    if (!this.alive || now < this.invulnUntil) return false;
    if (sailDmg) this.sail = clamp(this.sail - sailDmg, 0, this.sailMax);
    if (crewDmg) this.crew = clamp(this.crew - crewDmg, 0, this.crewMax);
    if (hullDmg) this.hull -= hullDmg;
    if (byId && byId !== this.id) {
      this.lastHitBy = byId; this.lastHitAt = now;
      const rec = this.hitLog.find(h => h.by === byId);
      if (rec) { rec.at = now; rec.dmg += hullDmg || 0; }
      else this.hitLog.push({ by: byId, at: now, dmg: hullDmg || 0 });
      if (this.hitLog.length > 12) this.hitLog.shift();
    }
    this.lastDamageKind = kind;
    // A gutted crew cannot man the stations they were assigned to.
    if (this.crew < 1) this.crew = 0;
    if (this.hull <= 0) { this.hull = 0; return true; }
    return false;
  }

  /** The private, full-fidelity slice sent only to this ship's own client. */
  priv() {
    return {
      id: this.id, team: this.team, role: this.role, hullId: this.hullId,
      x: this.x, y: this.y, heading: this.heading, speed: this.speed,
      rudder: this.rudder, rudderPos: this.rudderPos, sails: this.sails,
      sweeps: this.sweeps, stamina: Math.round(this.stamina),
      hull: this.alive ? Math.max(1, Math.round(this.hull)) : 0, hullMax: this.hullMax,
      sail: Math.round(this.sail), sailMax: this.sailMax,
      crew: Math.round(this.crew), crewMax: this.crewMax,
      alloc: this.alloc, stance: this.stance,
      shot: this.shot, ammo: Math.round(this.ammo), ammoMax: this.ammoMax,
      mines: this.mines, minesMax: this.minesMax,
      rlL: +this.rlL.toFixed(2), rlR: +this.rlR.toFixed(2), rlC: +this.rlC.toFixed(2),
      aimAngle: this.aimAngle, aimDist: this.aimDist,
      alive: this.alive, respawnAt: this.respawnAt,
      wantsCommand: this.wantsCommand,
      invulnUntil: this.invulnUntil, rallyUntil: this.rallyUntil, slowUntil: this.slowUntil,
      fireT: +this.fireT.toFixed(2),
      arc: GUN.arc, chaseArc: GUN.chaseArc, chase: !!this.stats.chase, siege: !!this.stats.siege,
      kills: this.kills, deaths: this.deaths, assists: this.assists,
      caps: this.caps, dmg: Math.round(this.dmg),
    };
  }

  /** The compact slice other clients receive when they can see this ship. */
  pub() {
    return {
      id: this.id, n: this.name, t: this.team, r: this.role, h: this.hullId,
      x: Math.round(this.x), y: Math.round(this.y),
      a: +this.heading.toFixed(3), v: Math.round(this.speed),
      s: this.sails, hp: this.alive ? Math.max(1, Math.round((this.hull / this.hullMax) * 100)) : 0,
      sp: Math.round((this.sail / this.sailMax) * 100),
      cr: Math.round((this.crew / this.crewMax) * 100),
      f: this.fireT > 0 ? 1 : 0,
      iv: this.invulnUntil,
      cn: this.connected ? 1 : 0,
      ra: this.rallyUntil,
      al: +this.aimAngle.toFixed(3),
      b: this.bot ? 1 : 0,
    };
  }
}
