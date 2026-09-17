// ============================================================================
//  The authoritative match.
//  Everything that decides the outcome happens here; clients only predict.
//
//  Time is measured with `this.now`, a simulation clock advanced by dt each
//  tick rather than Date.now(). That lets tools/balance.js run a full fifteen
//  minute match in a fraction of a second.
// ============================================================================
import {
  TICK_HZ, DT, PHASE, MUSTER_MS, BATTLE_MS, SUDDEN_MS, MATCH_MS, OVER_MS,
  TEAMS, TEAM, other, MAX_PER_TEAM, FLEET_SIZE, CHAT, QUICKCHAT, COLOURS, ECON, HOLD, WIND, SHIP, HULLS,
  HULL_IDS, GUN, SHOT, VISION, UPGRADES, UPG_MAX, UPG_FX, ORDERS, ORDER_GLOBAL_CD,
  SKYRAID, RALLY, SMOKE, MINEFX, MINE, SQUALL, CONVOY, CATCHUP, PINGS, PING_MS, REEF,
  NO_GO,
  PING_COOLDOWN_MS, KILLFEED_MAX, STANCES, WORLD_W, WORLD_H,
  CAPTAIN_IDLE_MS, fleetScale, SCALE,
} from '../shared/constants.js';
import {
  clamp, lerp, wrapAngle, angleDiff, dist, dist2, distToSeg, makeRng, rngRange,
  rngInt, rngPick, TAU, pointInPoly, own,
} from '../shared/math.js';
import { stepShip, visionRadius, signature, reloadTime, targetSpeed, crewEffects, upg } from '../shared/physics.js';
import { generateWorld, worldPayload } from './worldgen.js';
import { Ship } from './ship.js';
import { BotBrain, BotAdmiral, FleetAI } from './bot.js';

const CX = WORLD_W / 2;

let uid = 1;
const nextId = () => `e${uid++}`;

function newTeamState(id) {
  return {
    id,
    colours: COLOURS.start,
    doubloons: ECON.start,
    upg: Object.fromEntries(Object.keys(UPGRADES).map(k => [k, 0])),
    paid: Object.fromEntries(Object.keys(UPGRADES).map(k => [k, 0])),  // for refunds
    orderCd: Object.fromEntries(Object.keys(ORDERS).map(k => [k, 0])),
    globalCd: 0,
    prizeMul: 1,
    lastKillAt: -1e9,
    captain: null,
    kills: 0, deaths: 0, caps: 0, earned: 0,
    lastStand: false,
  };
}

export class Match {
  constructor(roomId, opts = {}) {
    this.roomId = roomId;
    this.seed = (opts.seed ?? (Math.random() * 1e9)) >>> 0;
    this.rng = makeRng(this.seed);
    this.now = 0;                         // simulation clock, milliseconds
    this.tick = 0;

    this.world = generateWorld(this.seed);
    this.ships = new Map();               // id -> Ship
    this.bots = new Map();                // id -> BotBrain
    this.admirals = {};                   // team -> BotAdmiral (only when no human captain)
    // Seed both fleet coordinators from the match seed. Fixed seeds would give
    // one side the same tie-breaking luck in every single match.
    this.skill = clamp(opts.skill ?? 1, 0, 1);      // bot competence, 1 = hard
    this.fleets = {
      scarlet: new FleetAI('scarlet', this.rng(), this.skill),
      cobalt:  new FleetAI('cobalt',  this.rng(), this.skill),
    };

    this.teams = { scarlet: newTeamState('scarlet'), cobalt: newTeamState('cobalt') };
    this.fleetSize = clamp(opts.fleetSize ?? FLEET_SIZE, 1, MAX_PER_TEAM);
    this.scale = fleetScale(this.fleetSize);
    this.chat = { scarlet: [], cobalt: [] };

    this.holds = this.world.holds.map(h => ({
      id: h.id, key: h.key, name: h.name, lane: h.lane, x: h.x, y: h.y, r: h.r,
      owner: h.home,                       // null = the neutral garrison holds it
      fortMax: HOLD.fortHp * SCALE.fortHp(fleetScale(opts.fleetSize ?? FLEET_SIZE)),
      fortHp: HOLD.fortHp * SCALE.fortHp(fleetScale(opts.fleetSize ?? FLEET_SIZE)) * (h.home === null ? 0.8 : 1),
      reload: rngRange(this.rng, 0, HOLD.fortReload),
      calm: 0,                             // ms since last damage
      cap: 0, capTeam: null,               // capture progress 0..1
      contested: false,
      deep: false,
    }));

    this.balls = [];       // ship broadside shot
    this.shells = [];      // fort mortar shells (arcing, dodgeable)
    this.bombs = [];       // sky raid ordnance
    this.mines = [];
    this.salvage = [];
    this.smokes = [];
    this.rallies = [];
    this.raids = [];       // telegraphed sky raids in their warning window
    this.pings = [];
    this.fx = [];
    this.log = [];
    this.convoy = null;
    this.nextConvoyAt = CONVOY.firstMs;
    this.convoyWarned = false;

    // wind
    this.wind = {
      dir: rngRange(this.rng, 0, TAU),
      speed: 1,
      gust: 1, gustT: 0, gustNext: rngRange(this.rng, ...WIND.gustPeriod),
      shiftAt: rngRange(this.rng, ...WIND.shiftEveryMs),
      shiftTo: null,
    };

    // squalls
    this.squalls = [];
    for (let i = 0; i < SQUALL.count; i++) this.squalls.push(this.makeSquall(true));

    this.phase = PHASE.LOBBY;
    this.phaseEnd = 0;
    this.startedAt = 0;
    this.winner = null;
    this.winReason = '';
    this.finalBoard = null;
  }

  // -------------------------------------------------------------------------
  //  Roster
  //
  //  Two rules hold at all times, and everything here exists to keep them:
  //    1. Both fleets sail the SAME number of hulls. Bots make up the numbers.
  //    2. Each fleet has exactly one captain, and a human always outranks a bot.
  // -------------------------------------------------------------------------
  teamCount(team) {
    let n = 0;
    for (const s of this.ships.values()) if (s.team === team && !s.bot) n++;
    return n;
  }
  totalCount(team) {
    let n = 0;
    for (const s of this.ships.values()) if (s.team === team) n++;
    return n;
  }
  /** The side with fewer humans; a coin-flip on the seed decides a dead heat. */
  weakerTeam() {
    const a = this.teamCount('scarlet'), b = this.teamCount('cobalt');
    if (a !== b) return a < b ? 'scarlet' : 'cobalt';
    return this.rng() < 0.5 ? 'scarlet' : 'cobalt';
  }

  addPlayer(id, name, prefTeam = null) {
    // Two players under one id would silently overwrite each other in the ship
    // map, which is a very confusing way to lose a hull.
    if (this.ships.has(id)) return null;
    // An explicit ?team= is honoured — friends want to sail together — but it
    // cannot overfill a side. Without one, the thinner fleet gets the hand.
    let team = prefTeam && TEAMS.includes(prefTeam) ? prefTeam : this.weakerTeam();
    if (this.teamCount(team) >= MAX_PER_TEAM) team = other(team);
    if (this.teamCount(team) >= MAX_PER_TEAM) return null;   // ten aboard already

    const s = new Ship(id, name, team, 'helm');
    this.ships.set(id, s);
    this.balanceBots();          // pays off a bot to make room, then re-elects
    this.spawn(s, true);
    this.note(`${name} joins the ${TEAM[team].short} fleet`, team);
    return s;
  }

  /** Move a player to the other side, if there is room and it is not worse. */
  switchTeam(id) {
    const s = this.ships.get(id);
    if (!s || s.bot) return 'no such hand';
    const to = other(s.team);
    if (this.teamCount(to) >= MAX_PER_TEAM) return 'that fleet is full';
    if (this.teamCount(to) - this.teamCount(s.team) >= 1) return 'that would unbalance the fleets';
    const from = s.team;
    this.note(`${s.name} transfers to the ${TEAM[to].short} fleet`, null);
    s.team = to;
    // You do not carry your prizes across. Otherwise switching sides late is a
    // way to appear at the top of the winning fleet's column having earned none
    // of it, and the scoreboard stops meaning anything.
    s.kills = 0; s.deaths = 0; s.assists = 0; s.caps = 0; s.dmg = 0; s.salvage = 0;
    if (this.teams[from].captain === id) { this.teams[from].captain = null; }
    s.role = 'helm';
    this.respawnNow(s, 900);
    this.balanceBots();
    this.assignCaptain(from);
    this.assignCaptain(to);
    return null;
  }

  addBot(team) {
    const id = nextId();
    const name = BotBrain.pickName(this.rng, [...this.ships.values()].map(s => s.name));
    const s = new Ship(id, name, team, 'helm');
    s.bot = true;
    this.ships.set(id, s);
    const brain = new BotBrain(s, this.rng(), this.skill);
    this.bots.set(id, brain);
    s.hullId = brain.preferredHull();
    this.spawn(s, true);
    return s;
  }

  removeShip(id) {
    const s = this.ships.get(id);
    if (!s) return;
    // Bots hold direct references to their target. Marking her lost before she
    // leaves the map stops anyone chasing a ship that no longer exists.
    s.alive = false;
    this.ships.delete(id);
    this.bots.delete(id);
    if (this.teams[s.team].captain === id) this.teams[s.team].captain = null;
    this.assignCaptain(s.team);
  }

  /**
   * Keep both fleets the same size. The target is whichever is larger: the
   * standing fleet size, or the number of humans on the fuller side. Bots are
   * added to make up the numbers and paid off again when players arrive.
   */
  balanceBots(minPerTeam = this.fleetSize) {
    const target = Math.min(
      MAX_PER_TEAM,
      Math.max(minPerTeam, this.teamCount('scarlet'), this.teamCount('cobalt')),
    );
    this.scale = fleetScale(target);
    for (const team of TEAMS) {
      while (this.totalCount(team) < target) this.addBot(team);
      while (this.totalCount(team) > target) {
        // Pay off the bot with the least invested in this match, and never one
        // holding command while a human could not replace it.
        const bots = [...this.ships.values()]
          .filter(b => b.bot && b.team === team)
          .sort((a, b) => (a.kills + a.caps) - (b.kills + b.caps));
        const victim = bots.find(b => this.teams[team].captain !== b.id) || bots[0];
        if (!victim) break;
        victim.alive = false;
        this.ships.delete(victim.id);
        this.bots.delete(victim.id);
        if (this.teams[team].captain === victim.id) this.teams[team].captain = null;
      }
      this.assignCaptain(team);
    }
  }

  /** Take a ship out of the water without it counting as a loss to anyone. */
  respawnNow(s, ms = 1200) {
    s.alive = false;
    s.deadAt = this.now;
    s.respawnAt = this.now + ms;
  }

  /** Back-compat entry point used by the balance harness and the server. */
  fillBots(perTeam = FLEET_SIZE) {
    this.fleetSize = clamp(perTeam, 1, MAX_PER_TEAM);
    this.balanceBots();
  }

  /**
   * Exactly one captain per side. Humans outrank bots, a player who has asked
   * for the post outranks one who has not, and otherwise the longest serving
   * hand keeps it so command does not hop about mid-battle.
   */
  assignCaptain(team) {
    const t = this.teams[team];
    const cur = t.captain ? this.ships.get(t.captain) : null;
    // A human already in command stays in command unless they stand down.
    if (cur && cur.connected && !cur.bot && !cur.standDown) return;

    const crew = [...this.ships.values()].filter(s => s.team === team && s.connected);
    const humans = crew.filter(s => !s.bot && !s.standDown);
    const pick = humans.find(s => s.wantsCommand) || humans[0] || crew.find(s => s.bot) || crew[0];
    if (!pick) { t.captain = null; delete this.admirals[team]; return; }
    if (pick === cur) return;

    if (cur) this.setRole(cur, 'helm');
    t.captain = pick.id;
    this.setRole(pick, 'captain');

    if (pick.bot) {
      if (!this.admirals[team]) this.admirals[team] = new BotAdmiral(team, this.rng(), this.skill);
    } else {
      delete this.admirals[team];
      this.note(`${pick.name} takes command of the ${TEAM[team].short} fleet`, team, 'command');
    }
  }

  /**
   * Change a ship's role. A live ship refits at sea rather than being sunk:
   * she keeps her position, her way and her damage, and simply becomes a
   * different hull. Losing your ship because someone else logged off is not
   * a thing that should happen to anybody.
   */
  setRole(s, role) {
    if (s.role === role) return;
    s.role = role;
    const wantHull = role === 'captain' ? 'flagship'
                   : (s.bot ? (this.bots.get(s.id)?.preferredHull() || 'brigantine')
                            : (s.nextHullId || s.lastHullId || 'brigantine'));
    if (!s.alive) { s.nextHullId = role === 'captain' ? null : wantHull; return; }
    s.refitAtSea(wantHull, this.now);
    this.addFx('refit', s.x, s.y, { team: s.team, id: s.id });
  }

  /** A player asks for, or stands down from, command of their fleet. */
  command(id, act) {
    const s = this.ships.get(id);
    if (!s || s.bot) return 'no such hand';
    const t = this.teams[s.team];
    const capShip = t.captain ? this.ships.get(t.captain) : null;

    if (act === 'claim') {
      s.wantsCommand = true;
      s.standDown = false;
      // You may take command from a bot at any time, or from nobody at all.
      if (!capShip || capShip.bot) { t.captain = null; this.assignCaptain(s.team); return null; }
      if (capShip.id === id) return 'you already have the deck';
      return 'ask your captain to stand down';
    }
    if (act === 'standdown') {
      if (t.captain !== id) return 'you do not have the deck';
      // Somebody who has already asked for the deck gets it ahead of somebody
      // who has not.
      const mates = [...this.ships.values()]
        .filter(o => o.team === s.team && !o.bot && o.id !== id && o.connected);
      const heir = mates.find(o => o.wantsCommand) || mates[0];
      if (!heir) return 'there is nobody to hand her to';
      s.standDown = true;
      s.wantsCommand = false;
      heir.wantsCommand = true;
      this.assignCaptain(s.team);
      s.standDown = false;         // free to take the deck again later
      this.note(`${s.name} hands over command`, s.team, 'command');
      return null;
    }
    return 'no such order';
  }

  // -------------------------------------------------------------------------
  //  Spawning
  // -------------------------------------------------------------------------
  spawnPoint(team) {
    const pts = this.world.spawns[team];
    // Prefer a berth with no enemy nearby and some space from a team-mate.
    let best = pts[0], bestScore = -Infinity;
    for (const p of pts) {
      let score = rngRange(this.rng, 0, 90);
      for (const s of this.ships.values()) {
        if (!s.alive) continue;
        const d = dist(p.x, p.y, s.x, s.y);
        if (s.team === team) score += Math.min(d, 600) * 0.12;
        else score -= Math.max(0, 1800 - d) * 0.5;
      }
      if (score > bestScore) { bestScore = score; best = p; }
    }
    return best;
  }

  /**
   * Turn a course out of the no-go zone, the short way. A ship launched head
   * to wind sits in irons for ten seconds doing nothing, which is a rotten way
   * to begin a match — and it is not a decision anybody made, so it teaches
   * nothing either.
   */
  sailableHeading(want) {
    const windFrom = this.wind.dir + Math.PI;
    const off = angleDiff(windFrom, want);
    if (Math.abs(off) >= NO_GO + 0.25) return want;
    return wrapAngle(windFrom + (off >= 0 ? 1 : -1) * (NO_GO + 0.25));
  }

  spawn(s, immediate = false) {
    const p = this.spawnPoint(s.team);
    s.upg = this.teams[s.team].upg;
    s.reset(p.x, p.y, this.sailableHeading(p.heading), this.now);
    if (!immediate) this.addFx('spawn', s.x, s.y, { team: s.team });
  }

  respawnDelay(team) {
    const mine = this.holdCount(team), theirs = this.holdCount(other(team));
    let ms = CATCHUP.respawnBase + Math.max(0, mine - theirs) * CATCHUP.respawnPerHold;
    ms = Math.min(ms, CATCHUP.respawnMax);
    ms -= UPG_FX.dockyard * 1000 * (this.teams[team].upg.dockyard | 0);
    if (this.phase === PHASE.SUDDEN) ms *= 0.6;
    return Math.max(3000, ms);
  }

  holdCount(team) { return this.holds.reduce((n, h) => n + (h.owner === team ? 1 : 0), 0); }

  // -------------------------------------------------------------------------
  //  Events, log, fx
  // -------------------------------------------------------------------------
  addFx(kind, x, y, extra = {}) {
    this.fx.push({ k: kind, x: Math.round(x), y: Math.round(y), ...extra });
  }
  note(text, team = null, kind = 'info') {
    this.log.push({ t: text, team, k: kind, at: this.now });
    if (this.log.length > 40) this.log.shift();
  }
  kill(text, team, kind = 'kill') {
    this.log.push({ t: text, team, k: kind, at: this.now });
    if (this.log.length > 40) this.log.shift();
  }

  // -------------------------------------------------------------------------
  //  Phases
  // -------------------------------------------------------------------------
  begin() {
    this.phase = PHASE.MUSTER;
    this.phaseEnd = this.now + MUSTER_MS;
    this.startedAt = this.now;
    for (const t of TEAMS) this.assignCaptain(t);
    this.note('MUSTER — captains, spend your opening purse', null, 'phase');
  }

  toBattle() {
    this.phase = PHASE.BATTLE;
    this.phaseEnd = this.now + BATTLE_MS;
    this.matchEnd = this.now + MATCH_MS;
    for (const s of this.ships.values()) this.spawn(s, true);
    this.note('SIGNAL: ENGAGE THE ENEMY MORE CLOSELY', null, 'phase');
  }

  toSudden() {
    this.phase = PHASE.SUDDEN;
    this.phaseEnd = this.matchEnd;
    this.note('THE LAST BELL — colours fall twice as fast', null, 'phase');
    for (const h of this.holds) this.addFx('alarm', h.x, h.y, {});
  }

  finish(winner, reason) {
    if (this.phase === PHASE.OVER) return;
    this.phase = PHASE.OVER;
    this.winner = winner;
    this.winReason = reason;
    this.phaseEnd = this.now + OVER_MS;
    this.finalBoard = this.board();
    this.note(winner ? `${TEAM[winner].name} CARRIES THE DAY — ${reason}` : `A DRAW — ${reason}`, winner, 'phase');
  }

  // -------------------------------------------------------------------------
  //  Weather
  // -------------------------------------------------------------------------
  makeSquall(initial = false) {
    return {
      id: nextId(),
      x: rngRange(this.rng, 600, WORLD_W - 600),
      y: rngRange(this.rng, 400, WORLD_H - 400),
      r: rngRange(this.rng, ...SQUALL.radius),
      dir: rngRange(this.rng, 0, TAU),
      spd: rngRange(this.rng, ...SQUALL.speed),
      turnAt: this.now + rngRange(this.rng, ...SQUALL.turnEveryMs),
      boltAt: this.now + rngRange(this.rng, 800, SQUALL.lightningMs),
      grow: initial ? 1 : 0,
    };
  }

  stepWeather(dt) {
    const w = this.wind;
    // gusts
    w.gustT -= dt;
    if (w.gustT <= 0) {
      w.gustT = rngRange(this.rng, ...WIND.gustPeriod);
      w.gustNext = rngRange(this.rng, ...WIND.gustRange);
    }
    w.gust = lerp(w.gust, w.gustNext, clamp(dt * 0.5, 0, 1));
    w.speed = WIND.baseSpeed * w.gust;

    // slow veer, plus scheduled hard shifts that redraw every chase in progress
    w.dir = wrapAngle(w.dir + Math.sin(this.now * 0.00013) * WIND.driftRate * dt);
    if (w.shiftTo === null && this.now >= w.shiftAt - WIND.shiftWarnMs && this.phase === PHASE.BATTLE) {
      const amt = rngRange(this.rng, ...WIND.shiftAmount) * (this.rng() < 0.5 ? -1 : 1);
      w.shiftTo = wrapAngle(w.dir + amt);
      this.note('THE WIND IS BACKING — a shift is coming', null, 'wind');
    }
    if (w.shiftTo !== null) {
      w.dir = wrapAngle(w.dir + angleDiff(w.dir, w.shiftTo) * clamp(dt * 0.55, 0, 1));
      if (Math.abs(angleDiff(w.dir, w.shiftTo)) < 0.02) {
        w.dir = w.shiftTo; w.shiftTo = null;
        w.shiftAt = this.now + rngRange(this.rng, ...WIND.shiftEveryMs);
      }
    }
    w.shiftIn = w.shiftTo !== null ? 0 : Math.max(0, w.shiftAt - this.now);

    // squalls wander the board
    for (const q of this.squalls) {
      q.grow = Math.min(1, q.grow + dt * 0.35);
      q.x += Math.cos(q.dir) * q.spd * dt;
      q.y += Math.sin(q.dir) * q.spd * dt;
      if (q.x < q.r * 0.4 || q.x > WORLD_W - q.r * 0.4) q.dir = Math.PI - q.dir;
      if (q.y < q.r * 0.4 || q.y > WORLD_H - q.r * 0.4) q.dir = -q.dir;
      q.dir = wrapAngle(q.dir);
      if (this.now >= q.turnAt) {
        q.turnAt = this.now + rngRange(this.rng, ...SQUALL.turnEveryMs);
        q.dir = wrapAngle(q.dir + rngRange(this.rng, -0.9, 0.9));
      }
      if (this.now >= q.boltAt) {
        q.boltAt = this.now + rngRange(this.rng, 1200, SQUALL.lightningMs);
        this.addFx('bolt', q.x + rngRange(this.rng, -q.r, q.r), q.y + rngRange(this.rng, -q.r, q.r), {});
      }
    }
  }

  /** Squall influence at a point: 0..1 intensity plus the shove it applies. */
  squallAt(x, y) {
    let best = 0, dir = 0;
    for (const q of this.squalls) {
      const d = dist(x, y, q.x, q.y);
      if (d > q.r) continue;
      const k = (1 - d / q.r) * q.grow;
      if (k > best) { best = k; dir = q.dir; }
    }
    return best > 0 ? { k: best, px: Math.cos(dir) * SQUALL.driftPush * best, py: Math.sin(dir) * SQUALL.driftPush * best } : null;
  }

  smokedAt(x, y) {
    for (const sm of this.smokes) if (dist(x, y, sm.x, sm.y) < sm.r) return true;
    return false;
  }

  // -------------------------------------------------------------------------
  //  Main step
  // -------------------------------------------------------------------------
  step(dt = DT) {
    this.now += dt * 1000;
    this.tick++;
    this.fx.length = 0;

    if (this.phase === PHASE.LOBBY) return;
    if (this.phase === PHASE.OVER) return;

    if (this.phase === PHASE.MUSTER && this.now >= this.phaseEnd) this.toBattle();
    if (this.phase === PHASE.BATTLE && this.now >= this.phaseEnd) this.toSudden();

    this.stepWeather(dt);
    this.stepBotAdmirals(dt);
    this.stepShips(dt);
    this.stepHolds(dt);
    this.stepForts(dt);
    this.stepProjectiles(dt);
    this.stepMines(dt);
    this.stepSalvage(dt);
    this.stepConvoy(dt);
    this.stepZones(dt);
    this.stepEconomy(dt);
    this.stepVictory(dt);
    this.expirePings();
  }

  // -------------------------------------------------------------------------
  //  Ships
  // -------------------------------------------------------------------------
  stepShips(dt) {
    // During Muster the fleets may sail — getting into position is a real
    // opening decision — but the guns stay housed and no ground changes hands.
    const musterOnly = this.phase === PHASE.MUSTER;
    for (const s of this.ships.values()) {
      s.upg = this.teams[s.team].upg;

      if (!s.alive) {
        if (this.phase !== PHASE.MUSTER && this.now >= s.respawnAt) {
          const brain = this.bots.get(s.id);
          if (brain && s.role !== 'captain') s.nextHullId = brain.preferredHull();
          this.spawn(s);
        }
        continue;
      }

      // Bots decide first so their decisions ride this same tick.
      const brain = this.bots.get(s.id);
      if (brain) brain.think(this, s, dt);

      const sq = this.squallAt(s.x, s.y);
      const supply = this.supplyAt(s);
      const t = this.teams[s.team];

      const env = {
        islands: this.world.islands, reefs: this.world.reefs,
        worldW: WORLD_W, worldH: WORLD_H, now: this.now,
        inSquall: !!sq, squallPush: sq ? { x: sq.px, y: sq.py } : null,
        inSupply: !!supply, supplyRepair: supply ? HOLD.supplyRepair : 0,
        lastStand: t.lastStand, lastStandBonus: CATCHUP.lastStandRepair,
        onGround: (d) => this.damageShip(s, d, 0, 0.4, null, 'ran aground'),
      };
      stepShip(s, this.wind, dt, env);

      // Reefs: shoal water. You do not stop dead, you grind and bleed — and
      // how badly depends entirely on the way you were carrying. Shorten sail
      // and you can pick your way out; drive across at a full press and she
      // will not come out the other side.
      for (const rf of this.world.reefs) {
        if (dist2(s.x, s.y, rf.x, rf.y) > (rf.r + 60) * (rf.r + 60)) continue;
        if (!pointInPoly(s.x, s.y, rf.pts)) continue;
        const way = clamp(Math.abs(s.speed) / 110, 0, 1);
        s.speed *= 1 - clamp(dt * REEF.dragPerS, 0, 0.9);
        this.damageShip(s, lerp(REEF.dpsMin, REEF.dpsMax, way) * dt, 0,
                        REEF.crewDps * dt, null, 'struck a reef');
        if (this.tick % 9 === 0) this.addFx('scrape', s.x, s.y, { hard: way > 0.5 ? 1 : 0 });
      }

      // Squall punishment, softened by Storm Rigging.
      if (sq) {
        const resist = clamp(1 - UPG_FX.storm * (t.upg.storm | 0), 0.1, 1);
        this.damageShip(s, SQUALL.dps * sq.k * resist * dt, 0.8 * sq.k * resist * dt, 0, null, 'lost to the weather');
      }

      // Resupply and repair in the lee of a friendly hold.
      if (supply) {
        s.ammo = Math.min(s.ammoMax, s.ammo + HOLD.supplyAmmo * dt);
        if (s.mines < s.minesMax && this.tick % 60 === 0) s.mines++;
        s.fireT = Math.max(0, s.fireT - dt * 2.5);
      }

      // Fire aboard: keeps burning until damage control wins.
      if (s.fireT > 0) {
        s.fireT = Math.max(0, s.fireT - dt * (0.35 + crewEffects(s).repair * 0.3));
        this.damageShip(s, 7.5 * dt, 1.6 * dt, 0.22 * dt, s.fireBy, 'burned to the waterline');
        if (this.tick % 5 === 0) this.addFx('fire', s.x, s.y, { id: s.id });
      }

      // Reloads
      const rt = reloadTime(s, this.now);
      s.rlL = Math.max(0, s.rlL - dt / rt);
      s.rlR = Math.max(0, s.rlR - dt / rt);
      s.rlC = Math.max(0, s.rlC - dt / (rt * 0.62));

      if (musterOnly) { s.wantFireL = s.wantFireR = s.wantFireC = s.wantMine = false; }
      if (s.wantFireL) { this.fire(s, -1); s.wantFireL = false; }
      if (s.wantFireR) { this.fire(s, +1); s.wantFireR = false; }
      if (s.wantFireC) { this.fire(s, 0);  s.wantFireC = false; }
      if (s.wantMine)  { this.dropMine(s);  s.wantMine = false; }

      // Ramming: heavy hulls win, both sides hurt.
      if (musterOnly) continue;
      for (const o of this.ships.values()) {
        if (o === s || !o.alive || o.team === s.team) continue;
        if (dist2(s.x, s.y, o.x, o.y) > 6400) continue;
        const rel = Math.abs(s.speed) + Math.abs(o.speed);
        if (rel < 40) continue;
        const mine = s.stats.hull, theirs = o.stats.hull;
        this.damageShip(o, rel * SHIP.ramDmg * (mine / theirs) * dt * 3, 0, 0.4 * dt, s.id, 'run down');
        this.damageShip(s, rel * SHIP.ramDmg * (theirs / mine) * dt * 3, 0, 0.4 * dt, o.id, 'run down');
        s.speed *= 0.94; o.speed *= 0.94;
        if (this.tick % 6 === 0) this.addFx('crunch', (s.x + o.x) / 2, (s.y + o.y) / 2, {});
      }
    }
  }

  /** The friendly hold supplying this ship, if any. */
  supplyAt(s) {
    for (const h of this.holds) {
      if (h.owner !== s.team) continue;
      if (dist2(s.x, s.y, h.x, h.y) < HOLD.supplyR * HOLD.supplyR) return h;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  //  Gunnery
  // -------------------------------------------------------------------------
  /** side: -1 port, +1 starboard, 0 bow chasers. */
  fire(s, side) {
    if (!s.alive || s.ammo < 1) { if (s.ammo < 1) this.addFx('dry', s.x, s.y, { id: s.id }); return; }
    const chase = side === 0;
    if (chase && !s.stats.chase) return;
    const rl = chase ? s.rlC : (side < 0 ? s.rlL : s.rlR);
    if (rl > 0) return;

    const beam = chase ? s.heading : s.heading + side * Math.PI / 2;
    const arc = chase ? GUN.chaseArc : GUN.arc;
    if (Math.abs(angleDiff(beam, s.aimAngle)) > arc) { this.addFx('cantbear', s.x, s.y, { id: s.id }); return; }

    const n = chase ? 2 : s.stats.guns;
    const range = clamp(s.aimDist, GUN.minRange, GUN.maxRange);
    const shot = own(SHOT, s.shot) || SHOT.round;
    const use = Math.min(s.ammo, n);
    s.ammo -= use;

    for (let i = 0; i < use; i++) {
      // Dispersion is dominated by the along-range term: misjudging the
      // distance is what actually makes a broadside miss.
      const r = range * (1 + rngRange(this.rng, -GUN.spreadAlong, GUN.spreadAlong));
      const off = rngRange(this.rng, -GUN.spreadAcross, GUN.spreadAcross);
      const a = s.aimAngle + Math.atan2(off, r);
      this.balls.push({
        id: nextId(), x: s.x, y: s.y,
        vx: Math.cos(a) * GUN.ballSpeed, vy: Math.sin(a) * GUN.ballSpeed,
        life: r / GUN.ballSpeed, by: s.id, team: s.team, shot: shot.id,
        siege: !!s.stats.siege,
      });
    }
    if (chase) s.rlC = 1; else if (side < 0) s.rlL = 1; else s.rlR = 1;
    this.addFx('broadside', s.x, s.y, { a: s.aimAngle, side, n: use, id: s.id, team: s.team });
  }

  dropMine(s) {
    if (s.mines < 1) return;
    s.mines--;
    const a = s.heading + Math.PI;
    this.mines.push({
      id: nextId(), team: s.team, by: s.id,
      x: s.x + Math.cos(a) * 42, y: s.y + Math.sin(a) * 42,
      dir: rngRange(this.rng, 0, TAU), armAt: this.now + MINE.armMs,
      dieAt: this.now + MINE.lifeMs,
    });
    this.addFx('minedrop', s.x, s.y, { team: s.team });
  }

  /** Segment-vs-oriented-ellipse: exact hull test for a shot's travel this tick. */
  segHitsShip(ax, ay, bx, by, s) {
    const hl = s.stats.len * 0.5, hb = s.stats.beam * 0.62;
    const c = Math.cos(-s.heading), si = Math.sin(-s.heading);
    const tx = (px, py) => {
      const dx = px - s.x, dy = py - s.y;
      return [(dx * c - dy * si) / hl, (dx * si + dy * c) / hb];
    };
    const [x1, y1] = tx(ax, ay), [x2, y2] = tx(bx, by);
    return distToSeg(0, 0, x1, y1, x2, y2) <= 1;
  }

  stepProjectiles(dt) {
    // --- broadside shot ------------------------------------------------------
    for (let i = this.balls.length - 1; i >= 0; i--) {
      const b = this.balls[i];
      const nx = b.x + b.vx * dt, ny = b.y + b.vy * dt;
      let done = false;

      for (const s of this.ships.values()) {
        if (!s.alive || s.team === b.team || this.now < s.invulnUntil) continue;
        if (dist2(nx, ny, s.x, s.y) > 62500) continue;
        if (!this.segHitsShip(b.x, b.y, nx, ny, s)) continue;
        this.hitShip(s, b);
        done = true; break;
      }
      // Shore batteries
      if (!done) {
        for (const h of this.holds) {
          if (h.fortHp <= 0 || h.owner === b.team) continue;
          if (dist2(nx, ny, h.x, h.y) > (h.r + 30) * (h.r + 30)) continue;
          this.hitFort(h, b);
          done = true; break;
        }
      }
      // The Bullion Run barque
      if (!done && this.convoy && dist2(nx, ny, this.convoy.x, this.convoy.y) < 5200) {
        this.hitConvoy(b);
        done = true;
      }
      // Land soaks up the rest.
      if (!done) {
        for (const isl of this.world.islands) {
          if (dist2(nx, ny, isl.x, isl.y) > isl.r * isl.r) continue;
          if (pointInPoly(nx, ny, isl.pts)) { this.addFx('dirt', nx, ny, {}); done = true; break; }
        }
      }

      b.x = nx; b.y = ny; b.life -= dt;
      if (done) { this.balls.splice(i, 1); continue; }
      if (b.life <= 0) { this.addFx('splash', b.x, b.y, {}); this.balls.splice(i, 1); }
    }

    // --- fort shells: arcing, and therefore dodgeable ------------------------
    for (let i = this.shells.length - 1; i >= 0; i--) {
      const sh = this.shells[i];
      sh.t += dt;
      const k = clamp(sh.t / sh.dur, 0, 1);
      sh.x = lerp(sh.sx, sh.tx, k);
      sh.y = lerp(sh.sy, sh.ty, k);
      if (k >= 1) {
        this.burst(sh.tx, sh.ty, 96, sh.dmg, sh.team, null, 'shore battery');
        this.addFx('shellburst', sh.tx, sh.ty, {});
        this.shells.splice(i, 1);
      }
    }

    // --- sky raid ordnance ---------------------------------------------------
    for (let i = this.bombs.length - 1; i >= 0; i--) {
      const b = this.bombs[i];
      b.t -= dt;
      if (b.t <= 0) {
        this.burst(b.x, b.y, 168, SKYRAID.dmg, b.team, b.by, 'caught by a sky raid');
        this.addFx('bomb', b.x, b.y, {});
        this.bombs.splice(i, 1);
      }
    }
  }

  /** Area damage to every ship of the opposing side within r. */
  burst(x, y, r, dmg, byTeam, byId, kind) {
    for (const s of this.ships.values()) {
      if (!s.alive || s.team === byTeam || this.now < s.invulnUntil) continue;
      const d = dist(x, y, s.x, s.y);
      if (d > r) continue;
      const k = 1 - (d / r) * 0.6;
      this.damageShip(s, dmg * k, dmg * k * 0.35, dmg * k * 0.03, byId, kind);
    }
    for (const h of this.holds) {
      if (h.owner === byTeam || h.fortHp <= 0) continue;
      if (dist(x, y, h.x, h.y) > r + h.r * 0.5) continue;
      this.damageFort(h, dmg * 0.5, byTeam, byId);
    }
  }

  hitShip(s, b) {
    const shot = own(SHOT, b.shot) || SHOT.round;
    const base = 15 + s.stats.beam * 0.16;
    const hullD = base * shot.hull;
    const sailD = base * shot.sail * 1.25;
    const crewD = base * shot.crew * 0.10;
    this.damageShip(s, hullD, sailD, crewD, b.by, `sunk by ${shot.name.toLowerCase()}`);
    // Round shot sometimes starts a fire; a burning ship is a beacon and a clock.
    if (shot.id === 'round' && this.rng() < 0.085) { s.fireT = Math.max(s.fireT, 5.5); s.fireBy = b.by; }
    this.addFx('hit', b.x, b.y, { id: s.id, shot: shot.id, by: b.by,
                                  v: Math.round(hullD + sailD * 0.5 + crewD * 6), n: s.name });
    const by = this.ships.get(b.by);
    if (by) by.dmg += hullD;
  }

  hitFort(h, b) {
    const shot = own(SHOT, b.shot) || SHOT.round;
    const base = 15 + 3;
    let d = base * shot.fort * 1.9;
    if (b.siege) d *= GUN.siegeVsFort;
    this.damageFort(h, d, b.team, b.by);
    this.addFx('fhit', b.x, b.y, { hold: h.id, by: b.by, v: Math.round(d) });
  }

  damageShip(s, hullD, sailD, crewD, byId, kind) {
    if (!s.alive) return;
    const sank = s.takeDamage(hullD, sailD, crewD, byId, kind, this.now);
    if (sank) this.sink(s, byId, kind);
  }

  damageFort(h, d, byTeam, byId) {
    if (h.fortHp <= 0) return;
    h.fortHp = Math.max(0, h.fortHp - d);
    h.calm = 0;
    const by = this.ships.get(byId);
    if (by) by.fortDmg += d;
    if (h.fortHp <= 0) {
      const prev = h.owner;
      this.addFx('fortdown', h.x, h.y, { hold: h.id });
      this.kill(`${h.name} — BATTERY SILENCED`, byTeam, 'fort');
      if (byTeam) {
        this.teams[byTeam].doubloons += ECON.fortBounty;
        this.teams[byTeam].earned += ECON.fortBounty;
      }
      if (prev && prev !== byTeam) {
        this.teams[prev].colours -= COLOURS.fortCost * SCALE.loss(this.scale)
                                  * (this.phase === PHASE.SUDDEN ? COLOURS.suddenMul : 1);
      }
    }
  }

  // -------------------------------------------------------------------------
  //  Sinking, bounties and the Prize Court
  // -------------------------------------------------------------------------
  sink(s, byId, kind) {
    s.alive = false;
    s.deaths++;
    s.deadAt = this.now;
    s.respawnAt = this.now + this.respawnDelay(s.team);
    s.speed = 0; s.fireT = 0;

    const t = this.teams[s.team];
    t.deaths++;
    t.colours -= COLOURS.sinkCost * SCALE.loss(this.scale)
               * (s.role === 'captain' ? 1.8 : 1)
               * (this.phase === PHASE.SUDDEN ? COLOURS.suddenMul : 1);

    const by = byId ? this.ships.get(byId) : null;
    const flag = s.role === 'captain' ? ' (FLAGSHIP)' : '';

    if (by && by.team !== s.team) {
      by.kills++;
      this.teams[by.team].kills++;
      // Prize Court: a run of kills pays progressively less, so no side can
      // simply farm its way to an unassailable treasury.
      const bt = this.teams[by.team];
      const bounty = Math.round(ECON.killBounty * bt.prizeMul * (s.role === 'captain' ? 1.5 : 1));
      bt.doubloons += bounty;
      bt.earned += bounty;
      bt.prizeMul = Math.max(ECON.prizeFloor, bt.prizeMul * ECON.prizeDecay);
      bt.lastKillAt = this.now;

      // Whoever else was working on her gets the credit they earned. The prize
      // is the same size either way — the killer simply shares it — so this
      // rewards concentrating fire without printing a single extra doubloon.
      const helpers = s.hitLog
        .filter(h => h.by !== byId && this.now - h.at <= ECON.assistWindowMs)
        .map(h => this.ships.get(h.by))
        .filter(o => o && o.team === by.team);
      if (helpers.length) {
        const pool = Math.round(bounty * ECON.assistShare);
        const cut = Math.round(pool / helpers.length);
        bt.doubloons -= pool;                      // out of the killer's share
        for (const o of helpers) {
          o.assists++;
          bt.doubloons += cut;
          this.addFx('assist', o.x, o.y, { team: by.team, v: cut, id: o.id });
        }
      }

      this.kill(`${by.name} sank ${s.name}${flag}`, by.team, 'kill');
      this.addFx('prize', s.x, s.y, { team: by.team, v: bounty });
    } else {
      this.kill(`${s.name}${flag} ${kind || 'was lost'}`, s.team, 'loss');
    }

    // Salvage: part of the prize floats free for whoever dares collect it.
    const worth = Math.round(ECON.killBounty * ECON.salvageShare);
    for (let i = 0; i < 2; i++) {
      this.salvage.push({
        id: nextId(), x: s.x + rngRange(this.rng, -70, 70), y: s.y + rngRange(this.rng, -70, 70),
        v: Math.round(worth / 2), dieAt: this.now + ECON.salvageLifeMs,
        dir: rngRange(this.rng, 0, TAU),
      });
    }
    this.addFx('sink', s.x, s.y, { team: s.team, id: s.id, by: byId || null, n: s.name });
  }

  // -------------------------------------------------------------------------
  //  Holds
  // -------------------------------------------------------------------------
  stepHolds(dt) {
    if (this.phase === PHASE.MUSTER) return;
    for (const h of this.holds) {
      // Is this one inside the other fleet's half? The gates never count.
      h.deep = h.owner ? ((h.owner === 'scarlet') !== (h.x < CX)) && h.lane !== 'gate' : false;
      const near = { scarlet: 0, cobalt: 0 };
      for (const s of this.ships.values()) {
        if (!s.alive) continue;
        if (dist2(s.x, s.y, h.x, h.y) < HOLD.captureR * HOLD.captureR) near[s.team]++;
      }
      const att = TEAMS.filter(t => t !== h.owner && near[t] > 0);
      const def = h.owner ? near[h.owner] : 0;
      h.contested = att.length > 1 || (att.length === 1 && def > 0);

      // The battery must be silenced before anyone can set foot ashore.
      if (h.fortHp > 0) { h.cap = Math.max(0, h.cap - HOLD.decayPerS * dt); continue; }

      if (att.length === 1 && def === 0) {
        const team = att[0];
        if (h.capTeam !== team) { h.capTeam = team; h.cap = 0; }
        const n = near[team];
        const ls = this.teams[team].lastStand ? 1 + HOLD.lastStandCap : 1;
        h.cap += HOLD.capturePerS * (1 + (n - 1) * HOLD.extraShipMul) * ls * dt;
        if (h.cap >= 1) this.captureHold(h, team);
      } else if (att.length === 0) {
        h.cap = Math.max(0, h.cap - HOLD.decayPerS * dt);
        if (h.cap === 0) h.capTeam = null;
      }
      // Contested: progress simply stops. Fight it out.
    }
  }

  captureHold(h, team) {
    const prev = h.owner;
    h.owner = team;
    h.cap = 0; h.capTeam = null;
    h.fortMax = this.fortCap(team, h.deep);
    h.fortHp = h.fortMax * HOLD.rebuildFrac;
    h.calm = 0;
    this.teams[team].caps++;
    for (const s of this.ships.values()) {
      if (s.alive && s.team === team && dist2(s.x, s.y, h.x, h.y) < HOLD.captureR * HOLD.captureR) s.caps++;
    }
    this.kill(`${TEAM[team].short} TAKES ${h.name}`, team, 'capture');
    this.addFx('capture', h.x, h.y, { team, hold: h.id });
    if (prev) this.addFx('alarm', h.x, h.y, { team: prev });
  }

  /** Battery strength for the size of fleet actually on the water. */
  fortBase() { return HOLD.fortHp * SCALE.fortHp(this.scale); }
  fortCap(team, deep = false) {
    return Math.round(this.fortBase()
                      * (1 + UPG_FX.armour * (this.teams[team].upg.armour | 0))
                      * (deep ? HOLD.deepFort : 1));
  }

  /** How far this hold's battery can actually shoot, after Long Nines. */
  fortReach(h) {
    const lvl = h.owner ? (this.teams[h.owner].upg.longnine | 0) : 0;
    return HOLD.fortRange * (1 + UPG_FX.longnine * lvl);
  }

  stepForts(dt) {
    if (this.phase === PHASE.MUSTER) return;
    for (const h of this.holds) {
      h.calm += dt * 1000;

      // Rebuild once the guns have been quiet a while.
      h.fortMax = h.owner ? this.fortCap(h.owner, h.deep) : Math.round(this.fortBase() * 0.8);
      // Batteries scale with the fleet size, so a hold can find itself over its
      // own ceiling when somebody leaves and the fleets shrink.
      if (h.fortHp > h.fortMax) h.fortHp = h.fortMax;
      if (h.fortHp > 0 && h.fortHp < h.fortMax && h.calm > HOLD.fortCalmMs) {
        const ls = h.owner && this.teams[h.owner].lastStand ? 1 + CATCHUP.lastStandFort : 1;
        const deep = h.deep ? HOLD.deepRegen : 1;
        h.fortHp = Math.min(h.fortMax, h.fortHp + HOLD.fortRegen * (h.owner ? 1 : 0.5) * ls * deep * dt);
      }
      if (h.fortHp <= 0) continue;

      // --- lay the guns ------------------------------------------------------
      h.reload -= dt;
      if (h.reload > 0) continue;

      const range = this.fortReach(h);
      let best = null, bestD = range;
      for (const s of this.ships.values()) {
        if (!s.alive || this.now < s.invulnUntil) continue;
        if (h.owner && s.team === h.owner) continue;      // neutral garrisons shoot everyone
        const d = dist(s.x, s.y, h.x, h.y);
        if (d < bestD) { bestD = d; best = s; }
      }
      if (!best) { h.reload = 0.4; continue; }

      const flight = bestD / HOLD.fortShellSpd;
      const lead = HOLD.fortLead * flight;
      const tx = best.x + Math.cos(best.heading) * best.speed * lead;
      const ty = best.y + Math.sin(best.heading) * best.speed * lead;
      const dmg = HOLD.fortDps * SCALE.fortDps(this.scale)
                * (1 + (h.owner ? UPG_FX.heated * (this.teams[h.owner].upg.heated | 0) : 0))
                * (h.owner ? 1 : 0.8);

      this.shells.push({
        id: nextId(), sx: h.x, sy: h.y, x: h.x, y: h.y,
        tx: tx + rngRange(this.rng, -46, 46), ty: ty + rngRange(this.rng, -46, 46),
        t: 0, dur: Math.max(0.5, flight), dmg, team: h.owner, hold: h.id,
      });
      h.reload = HOLD.fortReload;
      this.addFx('fortfire', h.x, h.y, { hold: h.id });
    }
  }

  // -------------------------------------------------------------------------
  //  Mines, salvage, zones
  // -------------------------------------------------------------------------
  stepMines(dt) {
    for (let i = this.mines.length - 1; i >= 0; i--) {
      const m = this.mines[i];
      if (this.now > m.dieAt) { this.mines.splice(i, 1); continue; }
      m.x += Math.cos(m.dir) * MINE.driftSpd * dt;
      m.y += Math.sin(m.dir) * MINE.driftSpd * dt;
      if (this.now < m.armAt) continue;
      for (const s of this.ships.values()) {
        if (!s.alive || s.team === m.team || this.now < s.invulnUntil) continue;
        if (dist2(s.x, s.y, m.x, m.y) > MINE.radius * MINE.radius) continue;
        this.damageShip(s, MINE.dmg, MINE.dmg * 0.3, MINE.crewDmg, m.by, 'blown apart by a mine');
        this.addFx('mineboom', m.x, m.y, {});
        this.mines.splice(i, 1);
        break;
      }
    }
  }

  stepSalvage(dt) {
    for (let i = this.salvage.length - 1; i >= 0; i--) {
      const g = this.salvage[i];
      if (this.now > g.dieAt) { this.salvage.splice(i, 1); continue; }
      g.x += Math.cos(this.wind.dir) * 9 * dt;
      g.y += Math.sin(this.wind.dir) * 9 * dt;
      for (const s of this.ships.values()) {
        if (!s.alive) continue;
        if (dist2(s.x, s.y, g.x, g.y) > 8100) continue;
        this.teams[s.team].doubloons += g.v;
        this.teams[s.team].earned += g.v;
        s.salvage += g.v;
        this.addFx('pickup', g.x, g.y, { team: s.team, v: g.v });
        this.salvage.splice(i, 1);
        break;
      }
    }
  }

  stepZones(dt) {
    for (let i = this.smokes.length - 1; i >= 0; i--) {
      const sm = this.smokes[i];
      sm.age += dt * 1000;
      sm.r = SMOKE.radius * clamp(sm.age / SMOKE.growMs, 0.2, 1);
      if (sm.age > SMOKE.ms) this.smokes.splice(i, 1);
    }
    for (let i = this.rallies.length - 1; i >= 0; i--) {
      const r = this.rallies[i];
      if (this.now > r.until) { this.rallies.splice(i, 1); continue; }
      for (const s of this.ships.values()) {
        if (!s.alive || s.team !== r.team) continue;
        if (dist2(s.x, s.y, r.x, r.y) < RALLY.radius * RALLY.radius) s.rallyUntil = Math.max(s.rallyUntil, this.now + 900);
      }
    }
    // Sky raids: four seconds of warning, then the line walks through.
    for (let i = this.raids.length - 1; i >= 0; i--) {
      const r = this.raids[i];
      if (this.now < r.dropAt) continue;
      const k = (this.now - r.dropAt) / SKYRAID.spacingMs;
      while (r.dropped < SKYRAID.bombs && k >= r.dropped) {
        const t = (r.dropped / (SKYRAID.bombs - 1) - 0.5) * SKYRAID.length;
        const off = rngRange(this.rng, -SKYRAID.width, SKYRAID.width) * 0.5;
        this.bombs.push({
          x: r.x + Math.cos(r.a) * t + Math.cos(r.a + Math.PI / 2) * off,
          y: r.y + Math.sin(r.a) * t + Math.sin(r.a + Math.PI / 2) * off,
          t: 0.28, team: r.team, by: r.by,
        });
        r.dropped++;
      }
      if (r.dropped >= SKYRAID.bombs) this.raids.splice(i, 1);
    }
  }

  // -------------------------------------------------------------------------
  //  The Bullion Run
  // -------------------------------------------------------------------------
  stepConvoy(dt) {
    if (this.phase === PHASE.MUSTER) return;
    if (!this.convoy) {
      if (!this.convoyWarned && this.now >= this.nextConvoyAt - CONVOY.warnMs) {
        this.convoyWarned = true;
        this.note('THE BULLION RUN — a treasure barque enters the strait', null, 'convoy');
      }
      if (this.now >= this.nextConvoyAt) {
        const lane = this.world.convoyLane;
        const east = this.rng() < 0.5;
        this.convoy = {
          id: nextId(),
          x: east ? lane.x0 : lane.x1, y: lane.y + rngRange(this.rng, -260, 260),
          dir: east ? 0 : Math.PI,
          hull: CONVOY.hull, hullMax: CONVOY.hull,
          wob: rngRange(this.rng, 0, TAU),
        };
        this.convoyWarned = false;
        this.nextConvoyAt = this.now + CONVOY.everyMs;
        this.addFx('convoy', this.convoy.x, this.convoy.y, {});
      }
      return;
    }
    const c = this.convoy;
    c.wob += dt * 0.6;
    c.x += Math.cos(c.dir) * CONVOY.speed * dt;
    c.y += Math.sin(c.dir) * CONVOY.speed * dt + Math.sin(c.wob) * 12 * dt;
    if (c.x < 120 || c.x > WORLD_W - 120) {
      this.note('The bullion barque slips away into the fog', null, 'convoy');
      this.convoy = null;
    }
  }

  hitConvoy(b) {
    const c = this.convoy;
    if (!c) return;
    const shot = own(SHOT, b.shot) || SHOT.round;
    c.hull -= (15 + 3) * shot.hull * 1.6;
    this.addFx('hit', b.x, b.y, { shot: shot.id });
    const by = this.ships.get(b.by);
    if (by) by.dmg += 12;
    if (c.hull <= 0) {
      const t = this.teams[b.team];
      t.doubloons += CONVOY.prize;
      t.earned += CONVOY.prize;
      this.teams[other(b.team)].colours -= CONVOY.colours;
      this.kill(`${TEAM[b.team].short} TAKES THE BULLION — ${CONVOY.prize} doubloons`, b.team, 'convoy');
      this.addFx('bullion', c.x, c.y, { team: b.team });
      this.convoy = null;
    }
  }

  // -------------------------------------------------------------------------
  //  Economy and victory
  // -------------------------------------------------------------------------
  stepEconomy(dt) {
    if (this.phase === PHASE.MUSTER) return;
    for (const id of TEAMS) {
      const t = this.teams[id], o = this.teams[other(id)];

      // Income from the holds, weighted so the two gates are worth fighting for
      // and a hold seized deep in enemy water does not pay for itself.
      let income = 0;
      for (const h of this.holds) {
        if (h.owner !== id) continue;
        let bias = HOLD_BIAS(h);
        income += ECON.holdIncome * bias;
      }
      // Admiralty Subsidy: the fleet that is losing is paid to keep fighting.
      const deficit = clamp((o.colours - t.colours) / COLOURS.start, 0, 1);
      income *= 1 + ECON.subsidyMax * deficit;
      t.doubloons += income * dt;
      t.earned += income * dt;
      t.income = income;

      // Prize Court recovery, one step per quiet interval.
      if (this.now - t.lastKillAt > ECON.prizeWindowMs && t.prizeMul < 1) {
        const steps = Math.floor((this.now - t.lastKillAt - ECON.prizeWindowMs) / ECON.prizeRecoverMs);
        if (steps > (t.recovered || 0)) {
          t.recovered = steps;
          t.prizeMul = Math.min(1, t.prizeMul / ECON.prizeDecay);
        }
      }
      if (this.now - t.lastKillAt <= ECON.prizeWindowMs) t.recovered = 0;

      for (const k of Object.keys(t.orderCd)) t.orderCd[k] = Math.max(0, t.orderCd[k] - dt * 1000);
      t.globalCd = Math.max(0, t.globalCd - dt * 1000);
      t.lastStand = t.colours < COLOURS.start * COLOURS.lastStand;
    }
  }

  stepVictory(dt) {
    if (this.phase === PHASE.MUSTER) return;
    const sh = this.holdCount('scarlet'), ch = this.holdCount('cobalt');
    const mul = this.phase === PHASE.SUDDEN ? COLOURS.suddenMul : 1;
    const diff = sh - ch;
    if (diff > 0) this.teams.cobalt.colours -= COLOURS.drainPerHold * diff * mul * dt;
    if (diff < 0) this.teams.scarlet.colours -= COLOURS.drainPerHold * -diff * mul * dt;
    for (const id of TEAMS) this.teams[id].colours = Math.max(0, this.teams[id].colours);

    if (this.teams.scarlet.colours <= 0 && this.teams.cobalt.colours <= 0) return this.finish(null, 'both fleets struck at once');
    if (this.teams.scarlet.colours <= 0) return this.finish('cobalt', 'SCARLET STRUCK HER COLOURS');
    if (this.teams.cobalt.colours <= 0) return this.finish('scarlet', 'COBALT STRUCK HER COLOURS');

    if (this.now >= this.matchEnd) {
      const a = this.teams.scarlet, b = this.teams.cobalt;
      if (Math.abs(a.colours - b.colours) > 0.5) {
        const w = a.colours > b.colours ? 'scarlet' : 'cobalt';
        return this.finish(w, 'THE BELL — higher colours');
      }
      if (sh !== ch) return this.finish(sh > ch ? 'scarlet' : 'cobalt', 'THE BELL — more holds');
      if (a.kills !== b.kills) return this.finish(a.kills > b.kills ? 'scarlet' : 'cobalt', 'THE BELL — more prizes taken');
      return this.finish(null, 'THE BELL — dead level');
    }
  }

  // -------------------------------------------------------------------------
  //  Commands from clients
  // -------------------------------------------------------------------------
  applyInput(id, m) {
    const s = this.ships.get(id);
    if (!s) return;
    s.lastInputAt = this.now;
    if (typeof m.seq === 'number') s.seq = m.seq;

    // Choosing the next hull is allowed whenever you are not in the water.
    if (own(HULLS, m.hull) && !s.alive) {
      // Remembered even while in command: it is the hull handed back when the
      // captain stands down.
      if (s.role === 'captain') s.lastHullId = m.hull; else s.nextHullId = m.hull;
    }
    if (own(STANCES, m.stance)) s.setStance(m.stance);
    if (m.shift) s.shiftHand(m.shift.from, m.shift.to);

    if (!s.alive) return;
    if (Number.isFinite(m.rudder)) s.rudder = clamp(m.rudder, -1, 1);
    if (Number.isFinite(m.sails)) s.sails = clamp(m.sails | 0, 0, 3);
    if (typeof m.sweeps === 'boolean') s.sweeps = m.sweeps;
    if (own(SHOT, m.shot)) s.shot = m.shot;
    if (Number.isFinite(m.aimA)) s.aimAngle = wrapAngle(m.aimA);
    if (Number.isFinite(m.aimD)) s.aimDist = clamp(m.aimD, GUN.minRange, GUN.maxRange);
    if (m.fL) s.wantFireL = true;
    if (m.fR) s.wantFireR = true;
    if (m.fC) s.wantFireC = true;
    if (m.mine) s.wantMine = true;
  }

  isCaptain(id) {
    const s = this.ships.get(id);
    return !!s && this.teams[s.team].captain === id;
  }

  /** Buy the next level of a fleet upgrade. Returns a short reason on failure. */
  buy(id, upgId) {
    const s = this.ships.get(id);
    if (!s || !this.isCaptain(id)) return 'not in command';
    const u = own(UPGRADES, upgId);
    if (!u) return 'no such work';
    const t = this.teams[s.team];
    const lvl = t.upg[upgId] | 0;
    if (lvl >= UPG_MAX) return 'already at the top';
    const cost = u.cost[lvl];
    if (t.doubloons < cost) return 'not enough coin';

    t.doubloons -= cost;
    t.paid[upgId] += cost;
    t.upg[upgId] = lvl + 1;
    this.onUpgrade(s.team, upgId);
    this.note(`${u.name} ${'I'.repeat(lvl + 1)}`, s.team, 'upgrade');
    this.addFx('upgrade', s.x, s.y, { team: s.team, up: upgId });
    return null;
  }

  /** Sell a level back. You get ECON.refundRate of what that level cost. */
  sell(id, upgId) {
    const s = this.ships.get(id);
    if (!s || !this.isCaptain(id)) return 'not in command';
    const u = own(UPGRADES, upgId);
    if (!u) return 'no such work';
    const t = this.teams[s.team];
    const lvl = t.upg[upgId] | 0;
    if (lvl <= 0) return 'nothing to sell';

    const paid = u.cost[lvl - 1];
    const back = Math.round(paid * ECON.refundRate);
    t.upg[upgId] = lvl - 1;
    t.paid[upgId] = Math.max(0, t.paid[upgId] - paid);
    t.doubloons += back;
    this.onUpgrade(s.team, upgId);
    this.note(`${u.name} sold back — ${back} recovered of ${paid}`, s.team, 'upgrade');
    return null;
  }

  /** Re-derive anything an upgrade changes that is stored rather than computed. */
  onUpgrade(team, upgId) {
    if (upgId === 'frames') {
      for (const s of this.ships.values()) {
        if (s.team !== team) continue;
        s.upg = this.teams[team].upg;
        const was = s.hullMax || 1;
        s.hullMax = s.hullCap;
        s.hull = clamp(s.hull * (s.hullMax / was), 1, s.hullMax);
      }
    }
    if (upgId === 'armour') {
      for (const h of this.holds) {
        if (h.owner !== team) continue;
        const was = h.fortMax || 1;
        h.fortMax = this.fortCap(team, h.deep);
        if (h.fortHp > 0) h.fortHp = clamp(h.fortHp * (h.fortMax / was), 1, h.fortMax);
      }
    }
  }

  /** Issue a captain's order at a point (or at a hold, for Shore Works). */
  issueOrder(id, orderId, x, y, holdId) {
    const s = this.ships.get(id);
    if (!s || !this.isCaptain(id)) return 'not in command';
    const o = own(ORDERS, orderId);
    if (!o) return 'no such order';
    const t = this.teams[s.team];
    if (this.phase === PHASE.MUSTER) return 'not yet — the fleet is still mustering';
    if (t.globalCd > 0) return 'signal party is busy';
    if (t.orderCd[orderId] > 0) return 'not ready';
    if (t.doubloons < o.cost) return 'not enough coin';

    if (o.target === 'hold') {
      const h = this.holds.find(hh => hh.id === holdId);
      if (!h) return 'pick one of your holds';
      if (h.owner !== s.team) return 'that is not your hold';
      h.fortMax = this.fortCap(s.team, h.deep);
      h.fortHp = Math.min(h.fortMax, h.fortHp + h.fortMax * 0.45);
      h.calm = 0;
      this.addFx('works', h.x, h.y, { team: s.team, hold: h.id });
      this.note(`SHORE WORKS at ${h.name}`, s.team, 'order');
    } else {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return 'point to somewhere on the chart';
      x = clamp(x, 0, WORLD_W); y = clamp(y, 0, WORLD_H);
      if (orderId === 'skyraid') {
        // The balloon runs in from your own side of the strait.
        const a = s.team === 'scarlet' ? 0 : Math.PI;
        this.raids.push({ id: nextId(), x, y, a, team: s.team, by: s.id,
                          dropAt: this.now + SKYRAID.warnMs, dropped: 0 });
        this.addFx('raidwarn', x, y, { team: s.team, a });
        this.note('SKY RAID INBOUND', s.team, 'order');
      } else if (orderId === 'rally') {
        this.rallies.push({ id: nextId(), x, y, team: s.team, until: this.now + RALLY.ms });
        this.addFx('rally', x, y, { team: s.team });
        this.note('RALLY SIGNAL HOISTED', s.team, 'order');
      } else if (orderId === 'mines') {
        for (let i = 0; i < MINEFX.count; i++) {
          const a = this.rng() * TAU, r = Math.sqrt(this.rng()) * MINEFX.scatter;
          this.mines.push({
            id: nextId(), team: s.team, by: s.id,
            x: x + Math.cos(a) * r, y: y + Math.sin(a) * r,
            dir: rngRange(this.rng, 0, TAU),
            armAt: this.now + MINE.armMs, dieAt: this.now + MINE.lifeMs,
          });
        }
        this.note('MINEFIELD LAID', s.team, 'order');
      } else if (orderId === 'smoke') {
        this.smokes.push({ id: nextId(), x, y, r: 40, age: 0, team: s.team });
        this.addFx('smokepop', x, y, { team: s.team });
        this.note('SMOKE SCREEN', s.team, 'order');
      }
    }

    t.doubloons -= o.cost;
    t.orderCd[orderId] = o.cd;
    t.globalCd = ORDER_GLOBAL_CD;
    return null;
  }

  /**
   * A word to the fleet. Team-only: the enemy never sees it, and neither does
   * any log the server keeps. Rate-limited and length-capped at the door.
   */
  say(id, text, quickId = null) {
    const s = this.ships.get(id);
    if (!s) return 'no such hand';
    if (this.now - (s.lastChatAt || -1e9) < CHAT.cooldownMs) return 'one at a time';
    let body;
    if (quickId) {
      const q = QUICKCHAT.find(x => x.id === quickId);
      if (!q) return 'no such signal';
      body = q.text;
    } else {
      body = String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, CHAT.maxLen);
      if (!body) return null;
    }
    s.lastChatAt = this.now;
    const line = {
      at: this.now, by: s.name, id: s.id,
      cap: this.teams[s.team].captain === s.id ? 1 : 0,
      bot: s.bot ? 1 : 0,
      t: body,
    };
    const feed = this.chat[s.team];
    feed.push(line);
    while (feed.length > CHAT.historyMax) feed.shift();
    return null;
  }

  /** The recent, still-relevant part of a fleet's channel. */
  chatFor(team) {
    const cut = this.now - CHAT.showMs;
    return this.chat[team].filter(l => l.at >= cut).slice(-CHAT.showMax);
  }

  addPing(id, pingId, x, y) {
    const s = this.ships.get(id);
    if (!s) return;
    const p = PINGS.find(pp => pp.id === pingId);
    if (!p) return;
    if (s.lastPingAt && this.now - s.lastPingAt < PING_COOLDOWN_MS) return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    s.lastPingAt = this.now;
    this.pings.push({
      id: nextId(), team: s.team, by: s.name, kind: p.id,
      x: clamp(x, 0, WORLD_W), y: clamp(y, 0, WORLD_H),
      at: this.now, until: this.now + PING_MS,
    });
  }
  expirePings() {
    for (let i = this.pings.length - 1; i >= 0; i--) if (this.now > this.pings[i].until) this.pings.splice(i, 1);
  }

  // -------------------------------------------------------------------------
  //  Fog of war — computed on the server, so the client is never sent
  //  anything its team has not genuinely seen.
  // -------------------------------------------------------------------------
  losBlocked(ax, ay, bx, by) {
    for (const sm of this.smokes) {
      if (distToSeg(sm.x, sm.y, ax, ay, bx, by) < sm.r) return true;
    }
    return false;
  }

  visibilityFor(team) {
    const seen = new Set();
    const ghosts = [];
    const viewers = [];
    for (const s of this.ships.values()) {
      if (s.alive && s.team === team) {
        viewers.push({ x: s.x, y: s.y, r: visionRadius(s, { inSquall: !!this.squallAt(s.x, s.y) }) });
      }
    }
    for (const h of this.holds) if (h.owner === team) viewers.push({ x: h.x, y: h.y, r: HOLD.visionR });

    for (const e of this.ships.values()) {
      if (e.team === team || !e.alive) continue;
      const sig = signature(e);
      let vis = false, ghost = false;
      for (const v of viewers) {
        const d = dist(v.x, v.y, e.x, e.y);
        const r = v.r * sig;
        if (d > r * VISION.ghostR) continue;
        if (this.losBlocked(v.x, v.y, e.x, e.y)) continue;
        if (d <= r) { vis = true; break; }
        ghost = true;
      }
      if (vis) seen.add(e.id);
      else if (ghost) ghosts.push({ x: Math.round(e.x / 140) * 140, y: Math.round(e.y / 140) * 140 });
    }
    // A burning wreck or a firing broadside is its own announcement.
    return { seen, ghosts, viewers };
  }

  nearAny(viewers, x, y, pad = 260) {
    for (const v of viewers) if (dist2(v.x, v.y, x, y) < (v.r + pad) * (v.r + pad)) return true;
    return false;
  }

  // -------------------------------------------------------------------------
  //  Snapshots
  // -------------------------------------------------------------------------
  teamSnapshot(team) {
    const { seen, ghosts, viewers } = this.visibilityFor(team);
    const ships = [];
    for (const s of this.ships.values()) {
      if (!s.alive) continue;
      if (s.team === team || seen.has(s.id)) ships.push(s.pub());
    }

    const t = this.teams[team], o = this.teams[other(team)];
    return {
      k: 'snap',
      now: Math.round(this.now),
      tick: this.tick,
      phase: this.phase,
      phaseEnd: Math.round(this.phaseEnd),
      matchEnd: Math.round(this.matchEnd || 0),
      wind: { d: +this.wind.dir.toFixed(3), s: +this.wind.speed.toFixed(3),
              si: Math.round(this.wind.shiftIn || 0), sh: this.wind.shiftTo !== null ? 1 : 0 },
      team,
      us: {
        colours: Math.round(t.colours), doubloons: Math.round(t.doubloons),
        upg: t.upg, income: +(t.income || 0).toFixed(1), prize: +t.prizeMul.toFixed(2),
        orderCd: Object.fromEntries(Object.entries(t.orderCd).map(([k, v]) => [k, Math.round(v)])),
        globalCd: Math.round(t.globalCd), captain: t.captain, lastStand: t.lastStand,
        kills: t.kills, caps: t.caps,
      },
      them: {
        colours: Math.round(o.colours), upg: o.upg, kills: o.kills, caps: o.caps,
        lastStand: o.lastStand,
      },
      holds: this.holds.map(h => ({
        id: h.id, o: h.owner, hp: Math.round(h.fortHp), hm: h.fortMax,
        c: +h.cap.toFixed(2), ct: h.capTeam, x: h.contested ? 1 : 0, d: h.deep ? 1 : 0,
        fr: Math.round(this.fortReach(h)),
      })),
      ships,
      ghosts,
      // A shot in flight carries its heading as well as its position. Twenty
      // snapshots a second against a ball doing 770 a second is a forty-unit
      // jump per packet: without the heading the client cannot draw a streak,
      // and cannot walk the shot on between packets either.
      balls: this.balls.filter(b => this.nearAny(viewers, b.x, b.y))
                       .map(b => ({ x: Math.round(b.x), y: Math.round(b.y), t: b.team, s: b.shot,
                                    a: +Math.atan2(b.vy, b.vx).toFixed(3) })),
      shells: this.shells.map(s => ({ x: Math.round(s.x), y: Math.round(s.y),
                                      tx: Math.round(s.tx), ty: Math.round(s.ty),
                                      k: +(s.t / s.dur).toFixed(2), t: s.team })),
      bombs: this.bombs.map(b => ({ x: Math.round(b.x), y: Math.round(b.y) })),
      mines: this.mines.filter(m => m.team === team || this.nearAnyClose(viewers, m.x, m.y))
                       .map(m => ({ x: Math.round(m.x), y: Math.round(m.y), t: m.team,
                                    a: this.now >= m.armAt ? 1 : 0 })),
      salvage: this.salvage.filter(g => this.nearAny(viewers, g.x, g.y))
                           .map(g => ({ x: Math.round(g.x), y: Math.round(g.y), v: g.v })),
      squalls: this.squalls.map(q => ({ x: Math.round(q.x), y: Math.round(q.y),
                                        r: Math.round(q.r * q.grow), d: +q.dir.toFixed(2) })),
      smokes: this.smokes.map(s => ({ x: Math.round(s.x), y: Math.round(s.y), r: Math.round(s.r) })),
      rallies: this.rallies.filter(r => r.team === team)
                           .map(r => ({ x: Math.round(r.x), y: Math.round(r.y), r: RALLY.radius,
                                        u: Math.round(r.until) })),
      raids: this.raids.map(r => ({ x: Math.round(r.x), y: Math.round(r.y), a: +r.a.toFixed(2),
                                     t: r.team, at: Math.round(r.dropAt),
                                     L: SKYRAID.length, W: SKYRAID.width })),
      convoy: this.convoy ? { x: Math.round(this.convoy.x), y: Math.round(this.convoy.y),
                              a: +this.convoy.dir.toFixed(2),
                              hp: Math.round((this.convoy.hull / this.convoy.hullMax) * 100) } : null,
      convoyIn: this.convoy ? 0 : Math.max(0, Math.round(this.nextConvoyAt - this.now)),
      pings: this.pings.filter(p => p.team === team)
                       .map(p => ({ x: p.x, y: p.y, k: p.kind, n: p.by, u: Math.round(p.until) })),
      fx: this.fx,
      // The roster and the killfeed do not change twenty times a second, and
      // together they were a third of every packet. Send them at 4 Hz and let
      // the client hold on to the last set.
      ...(this.tick % 5 === 0 || this.phase === PHASE.OVER
          ? { log: this.log.slice(-KILLFEED_MAX), board: this.board(team),
              chat: this.chatFor(team), roster: this.rosterCounts() }
          : {}),
      winner: this.winner, winReason: this.winReason,
    };
  }

  nearAnyClose(viewers, x, y) {
    for (const v of viewers) if (dist2(v.x, v.y, x, y) < MINE.seeR * MINE.seeR) return true;
    return false;
  }

  /** Per-client payload: the team snapshot plus this player's private slice. */
  snapshotFor(clientId, teamSnap) {
    const me = this.ships.get(clientId);
    if (!me) return teamSnap;
    const priv = me.priv();
    priv.vision = Math.round(visionRadius(me, { inSquall: !!this.squallAt(me.x, me.y) }));
    priv.isCaptain = this.teams[me.team].captain === clientId;
    priv.reload = +reloadTime(me, this.now).toFixed(2);
    priv.name = me.name;
    priv.nextHullId = me.nextHullId;
    priv.inSupply = !!this.supplyAt(me);
    return { ...teamSnap, me: priv };
  }

  /** Who is actually aboard: humans and hulls, per side. */
  rosterCounts() {
    const out = {};
    for (const t of TEAMS) out[t] = { humans: this.teamCount(t), hulls: this.totalCount(t) };
    return out;
  }

  /**
   * The roster, as one fleet is entitled to see it.
   *
   * What the enemy has DONE is public — a fleet knows who sank whom. What the
   * enemy is doing RIGHT NOW is not: which of their hulls is in the water, and
   * what she is, are things you find out by looking at the sea. Redacting it
   * here rather than in the interface matters, because the promise is that the
   * information is not in the socket at all.
   */
  board(forTeam = null) {
    const open = !forTeam || this.phase === PHASE.OVER;
    const rows = [];
    for (const s of this.ships.values()) {
      const ours = open || s.team === forTeam;
      rows.push({
        id: s.id, n: s.name, t: s.team, r: s.role, b: s.bot ? 1 : 0,
        cn: s.connected ? 1 : 0, wc: s.wantsCommand ? 1 : 0,
        k: s.kills, d: s.deaths, as: s.assists, c: s.caps, dm: Math.round(s.dmg),
        ...(ours ? {
          h: s.hullId, sv: s.salvage,
          a: s.alive ? 1 : 0, rs: Math.round(Math.max(0, s.respawnAt - this.now)),
        } : { a: 1, rs: 0 }),
      });
    }
    rows.sort((a, b) => (b.k * 3 + b.as + b.c * 4 + b.dm / 200) - (a.k * 3 + a.as + a.c * 4 + a.dm / 200));
    return rows;
  }

  stepBotAdmirals(dt) {
    for (const team of TEAMS) {
      this.relieveIdleCaptain(team);
      this.fleets[team].think(this, dt);
      const a = this.admirals[team];
      if (a) a.think(this, dt);
    }
  }

  /**
   * A captain who has walked away from the keyboard leaves their fleet with no
   * purchases, no orders and nobody answering signals. After a full minute of
   * silence the deck passes to whoever is actually aboard.
   */
  relieveIdleCaptain(team) {
    const t = this.teams[team];
    const cap = t.captain ? this.ships.get(t.captain) : null;
    if (!cap || cap.bot) return;
    if (this.phase === PHASE.MUSTER || this.phase === PHASE.OVER) return;
    if (this.now - (cap.lastInputAt || 0) < CAPTAIN_IDLE_MS) return;
    const heir = [...this.ships.values()]
      .find(o => o.team === team && o.id !== cap.id && !o.bot && o.connected
                 && this.now - (o.lastInputAt || 0) < CAPTAIN_IDLE_MS);
    cap.standDown = true;
    cap.wantsCommand = false;
    if (heir) heir.wantsCommand = true;
    this.assignCaptain(team);
    cap.standDown = false;
    if (t.captain !== cap.id) this.note(`${cap.name} is not at the wheel — command passes`, team, 'command');
  }
}

/** Income weighting for a hold: the gates pay best, deep captures pay least. */
function HOLD_BIAS(h) {
  if (h.lane === 'gate') return ECON.midBias;
  if (h.deep) return ECON.deepBias;
  return ECON.homeBias;
}
