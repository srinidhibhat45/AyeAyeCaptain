// ============================================================================
//  AYE AYE, CAPTAIN — Tides of War
//  Every balance number in the game lives in this file. Tune here, restart.
// ============================================================================

export const TICK_HZ   = 30;            // server simulation rate
export const SNAP_HZ   = 20;            // snapshot broadcast rate
export const INPUT_HZ  = 30;            // client input rate
export const DT        = 1 / TICK_HZ;

// --- world -----------------------------------------------------------------
// Wide rather than tall: three lanes run west <-> east between the two fleets.
export const WORLD_W = 7600;
export const WORLD_H = 4600;

export const PHASE = {
  LOBBY:    'LOBBY',
  MUSTER:   'MUSTER',     // pre-match: captain election + opening purchases
  BATTLE:   'BATTLE',
  SUDDEN:   'SUDDEN',     // final 90s: everything worth double, no respawn wait
  OVER:     'OVER',
};

// Matches can be run short for testing: AAC_SPEED=20 makes the clock twenty
// times faster. Server-side only — the client reads its timings from snapshots,
// so it needs no matching setting.
const SPEED = (typeof process !== 'undefined' && Number(process.env?.AAC_SPEED)) || 1;

export const MUSTER_MS  = 22_000 / SPEED;
export const BATTLE_MS  = (13 * 60_000 + 30_000) / SPEED;   // 13:30
export const SUDDEN_MS  = 90_000 / SPEED;                   // 1:30 -> 15:00 total
export const MATCH_MS   = BATTLE_MS + SUDDEN_MS;            // hard cap
export const OVER_MS    = 16_000 / SPEED;

// --- teams -----------------------------------------------------------------
export const TEAMS = ['scarlet', 'cobalt'];
export const TEAM = {
  scarlet: { id: 'scarlet', name: 'SCARLET FLEET', short: 'SCARLET',
             hue: 8,   rgb: [0.94, 0.30, 0.26], css: '#ef4b42', dim: '#7d2a26' },
  cobalt:  { id: 'cobalt',  name: 'COBALT COMPACT', short: 'COBALT',
             hue: 199, rgb: [0.24, 0.66, 0.95], css: '#3ea9f2', dim: '#1f5680' },
};
export const other = (t) => (t === 'scarlet' ? 'cobalt' : 'scarlet');

// A match is 2 sides. Four humans is the smallest game worth playing (2v2,
// each side with a captain); ten is the ceiling (5v5). Bots make up the
// difference so both fleets always sail the SAME number of hulls.
export const MAX_PER_TEAM  = 5;         // 1 captain + 4 helmsmen
export const MIN_PLAYERS   = 4;         // two a side, each with a captain
export const MAX_PLAYERS   = MAX_PER_TEAM * 2;
export const FLEET_SIZE    = 4;         // hulls per side when nobody is waiting

// --- colours (the victory resource) ----------------------------------------
// A team "strikes its colours" when this hits zero.
export const COLOURS = {
  start:        580,
  drainPerHold: 0.345,   // per second, per hold of advantage, to the team behind
  sinkCost:     7,      // colours lost when one of your ships goes down
  fortCost:     12,     // colours lost when one of your forts is silenced
  suddenMul:    2.15,   // everything bites harder in the last 90 seconds
  lastStand:    0.30,   // below this fraction, the comeback buff switches on
};

// --- doubloons (the captain's resource) ------------------------------------
export const ECON = {
  start:          320,
  holdIncome:     1.25,    // per second, per owned hold
  homeBias:       1.0,    // income multiplier for holds in your own half
  midBias:        1.22,   // the two middle holds pay best - fight for them
  deepBias:       0.55,   // holds captured inside enemy waters pay less (anti-lock)
  killBounty:     85,
  // A prize is worth the same whether one ship took it or four. This share of
  // it is set aside for anyone who helped in the last few seconds; if nobody
  // did, the ship that fired the last broadside keeps the lot.
  assistShare:    0.30,
  assistWindowMs: 14_000,
  fortBounty:     100,
  salvageShare:   0.42,   // fraction of a kill bounty that drops as floating salvage
  salvageLifeMs:  26_000,
  convoyPrize:    300,
  // Prize Court: a RUN of kills is worth progressively less. The decay has to
  // be gentle enough that ordinary trading is not permanently taxed — the point
  // is to stop a rampage paying for itself, not to make every prize worthless.
  prizeDecay:     0.80,
  prizeFloor:     0.30,
  prizeWindowMs:  26_000,  // quiet for this long and the decay starts easing
  prizeRecoverMs: 11_000,  // ... one step back per this long after that
  // Admiralty Subsidy: the team behind on colours earns more.
  subsidyMax:     0.65,
  refundRate:     0.60,    // sell an upgrade back for this share of what you paid
};

// --- holds (the islands / "towers") ----------------------------------------
export const HOLD = {
  captureR:     470,     // you must be inside this ring to take or hold
  capturePerS:  0.26,   // one lone ship: ~4.3s of uncontested work
  extraShipMul: 0.55,    // each additional friendly ship adds this much again
  decayPerS:    0.10,    // unheld progress bleeds back toward the owner
  fortHp:       560,
  fortRegen:    17,      // hp/s once out of combat for fortCalm
  fortCalmMs:   7_000,
  fortRange:     820,   // deliberately SHORTER than GUN.maxRange: a patient
                        // ship can out-range a battery and pound it for free
  fortDps:      30,      // damage per shell (fires every fortReload)
  fortReload:   2.35,
  fortShellSpd: 690,
  fortLead:     0.85,    // how much the fort leads a moving target (0..1)
  rebuildFrac:  0.34,    // fort HP a hold rebuilds to right after being captured
  // A Hold seized deep in enemy water is at the end of a long supply line. It
  // pays less AND it is harder to keep — without this the map locks solid after
  // the opening exchange and there is no way back into the match.
  deepFort:     0.68,    // battery strength for a hold inside enemy waters
  deepRegen:    0.45,
  lastStandCap: 0.35,    // the losing fleet lands faster while it is behind
  supplyR:      520,     // resupply/repair radius around a friendly hold
  supplyRepair: 15,      // hull/sail per second while in friendly supply
  supplyAmmo:   2.6,     // rounds per second
  visionR:      1250,    // a hold sees this far for its owners
};

/**
 * The tower-defence layer has to work at both ends of the roster. Four hulls a
 * side is the reference. With two, a battery that takes thirty ship-seconds to
 * break takes a minute of real time and the map never moves; with five, the
 * same battery falls in seconds. These scale it against the fleet that is
 * actually out there, so a 2v2 and a 5v5 feel like the same game.
 */
export function fleetScale(hullsPerSide) {
  return Math.max(0.5, Math.min(1.25, (hullsPerSide || FLEET_SIZE) / FLEET_SIZE));
}
export const SCALE = {
  fortHp:   (k) => 0.55 + 0.45 * k,    // 2 hulls -> 0.78,  5 -> 1.11
  fortDps:  (k) => 0.62 + 0.38 * k,    // 2 hulls -> 0.81,  5 -> 1.10
  loss:     (k) => Math.pow(1 / k, 0.6), // fewer hulls, fewer sinkings, each worth more
};

// --- wind & sailing --------------------------------------------------------
// Polar diagram: [angle off the wind (radians), speed factor]. The heart of it.
export const POLAR = [
  [0.00, 0.06], [0.30, 0.09], [0.52, 0.16], [0.70, 0.46], [0.90, 0.72],
  [1.10, 0.88], [1.35, 0.97], [1.60, 1.00], [1.85, 1.00], [2.10, 0.96],
  [2.40, 0.88], [2.70, 0.79], [3.00, 0.72], [3.15, 0.70],
];
export const NO_GO = 0.62;

export const WIND = {
  baseSpeed:   1.0,
  gustRange:   [0.82, 1.22],
  gustPeriod:  [9, 21],
  driftRate:   0.035,     // radians/second of slow veering
  shiftEveryMs:[52_000, 86_000],
  shiftAmount: [0.45, 1.05],
  shiftWarnMs: 5_000,
};

// --- ships -----------------------------------------------------------------
export const HANDS = 12;   // crew hands the helmsman distributes across stations

export const SHIP = {
  baseSpeed:    128,
  baseTurn:     1.30,
  accel:        0.72,
  decel:        1.25,
  rudderLerp:   4.4,
  sailPower:    [0.00, 0.44, 0.76, 1.00],       // furled / reefed / full / press
  sailTurnPenalty:[1.28, 1.14, 1.00, 0.86],
  sweepSpeed:   40,
  sweepDrain:   26,
  sweepRegen:   11,
  staminaMax:   100,
  groundingDmg: 0.30,
  ramDmg:       0.42,
  invulnMs:     3200,
};

// Four hulls. Deliberately few: the depth is in sailing them, not picking one.
export const HULLS = {
  cutter: {
    id:'cutter', name:'CUTTER', role:'RAIDER',
    hull:112, sailHp:104, crew:12, speed:1.30, turn:1.34, upwind:1.20,
    guns:3, len:44, beam:15, vision:1.16, ammo:44, mines:3,
    blurb:'Fast, weatherly, fragile. Cuts upwind where others cannot follow.',
  },
  brigantine: {
    id:'brigantine', name:'BRIGANTINE', role:'LINE',
    hull:164, sailHp:132, crew:12, speed:1.06, turn:1.05, upwind:0.98,
    guns:6, len:60, beam:21, vision:1.00, ammo:62, mines:2,
    blurb:'The honest all-rounder. Six guns a side and nothing to apologise for.',
  },
  xebec: {
    id:'xebec', name:'XEBEC', role:'SKIRMISHER', chase:true,
    hull:138, sailHp:118, crew:12, speed:1.17, turn:1.22, upwind:1.08,
    guns:5, len:53, beam:18, vision:1.08, ammo:54, mines:3,
    blurb:'Carries bow chasers as well as broadsides. Fights while running.',
  },
  galleon: {
    id:'galleon', name:'GALLEON', role:'SIEGE', siege:true,
    hull:236, sailHp:168, crew:12, speed:0.85, turn:0.80, upwind:0.80,
    guns:8, len:78, beam:29, vision:0.92, ammo:78, mines:1,
    blurb:'Slow, vast, and the only hull that truly breaks a shore battery.',
  },
};
export const HULL_IDS = Object.keys(HULLS);

// The captain's flagship: tough, commanding, but no faster than anyone else.
export const FLAGSHIP = {
  id:'flagship', name:'FLAGSHIP', role:'COMMAND',
  hull:198, sailHp:150, crew:12, speed:1.00, turn:0.98, upwind:0.96,
  guns:6, len:70, beam:25, vision:1.30, ammo:66, mines:2,
  blurb:'Your command. Signals reach further; her loss costs the fleet dearly.',
};

// --- gunnery ---------------------------------------------------------------
export const GUN = {
  reloadBase:  6.1,
  minRange:    220,
  maxRange:    1000,
  ballSpeed:   770,
  spreadAlong: 0.030,   // fraction of range - misjudging distance is the real miss
  spreadAcross:21,
  arc:         1.02,    // broadside traverse either side of the beam
  chaseArc:    0.42,    // bow chasers (xebec)
  furledBonus: 0.74,    // reload multiplier when hove to with sails furled
  siegeVsFort: 2.30,    // galleon bonus against shore batteries
};

// Bound to 1 2 3, in this order.
export const SHOT = {
  round: { id:'round', name:'ROUND SHOT', hull:1.00, sail:0.30, crew:0.20, fort:1.00,
           blurb:'Bites hull. The honest answer to most questions.' },
  chain: { id:'chain', name:'CHAIN SHOT', hull:0.22, sail:1.85, crew:0.15, fort:0.25,
           blurb:'Shreds rigging. Cripple a runner, then take your time.' },
  grape: { id:'grape', name:'GRAPE SHOT', hull:0.28, sail:0.20, crew:1.90, fort:0.30,
           blurb:'Sweeps the deck. Kill the crew and every station slows.' },
};
export const SHOT_IDS = ['round', 'chain', 'grape'];

// --- crew stances (quick presets over the 12 hands) ------------------------
// Bound to Z X C V, in this order.
export const STANCES = {
  battle: { id:'battle', name:'BEAT TO QUARTERS', alloc:{ gun:7, sail:2, rep:2, look:1 } },
  chase:  { id:'chase',  name:'MAKE ALL SAIL',    alloc:{ gun:2, sail:8, rep:1, look:1 } },
  repair: { id:'repair', name:'DAMAGE CONTROL',   alloc:{ gun:2, sail:2, rep:7, look:1 } },
  scout:  { id:'scout',  name:'SHARP LOOKOUT',    alloc:{ gun:2, sail:4, rep:1, look:5 } },
};

export const VISION = {
  base:        1080,
  lookoutMin:  0.86,
  lookoutMax:  1.46,
  sailMod:     [0.72, 0.88, 1.00, 1.16],   // press more canvas, get seen sooner
  ghostR:      1.55,   // beyond vision * this, a lookout reports a vague contact
};

// ============================================================================
//  CAPTAIN'S KIT
// ============================================================================

// Upgrades: small, meaningful, stacking, and sellable. Three levels each.
export const UPGRADES = {
  copper:  { id:'copper',  name:'COPPER SHEATHING', cat:'FLEET', icon:'speed',
             cost:[165, 275, 430], per:'+4% fleet speed',
             blurb:'Clean bottoms. Every ship in the fleet sails a touch faster.' },
  frames:  { id:'frames',  name:'OAK FRAMES',       cat:'FLEET', icon:'hull',
             cost:[175, 290, 455], per:'+7% fleet hull',
             blurb:'Doubled futtocks. Your ships take a broadside and stay swimming.' },
  storm:   { id:'storm',   name:'STORM RIGGING',    cat:'FLEET', icon:'storm',
             cost:[140, 235, 370], per:'-30% weather punishment',
             blurb:'Preventer stays and storm canvas. Squalls stop mattering.' },
  powder:  { id:'powder',  name:'POWDER MONKEYS',   cat:'FLEET', icon:'gun',
             cost:[190, 305, 480], per:'-6% reload',
             blurb:'Drilled gun crews. The second broadside comes sooner.' },
  armour:  { id:'armour',  name:'BATTERY ARMOUR',   cat:'SHORE', icon:'fort',
             cost:[155, 260, 410], per:'+18% fort hull',
             blurb:'Stone revetments. Your holds cost the enemy real time.' },
  heated:  { id:'heated',  name:'HEATED SHOT',      cat:'SHORE', icon:'fire',
             cost:[165, 275, 435], per:'+15% fort damage',
             blurb:'Furnace-hot roundshot. Shore guns that genuinely hurt.' },
  longnine:{ id:'longnine',name:'LONG NINES',       cat:'SHORE', icon:'range',
             cost:[160, 265, 415], per:'+10% fort range',
             blurb:'Reaches further out to sea. Widens the no-go water.' },
  dockyard:{ id:'dockyard',name:'DOCKYARDS',        cat:'LOGISTICS', icon:'anchor',
             cost:[150, 245, 390], per:'-1.2s respawn',
             blurb:'Ships ready on the slips. Your fleet returns quicker.' },
  signal:  { id:'signal',  name:'SIGNAL MAST',      cat:'LOGISTICS', icon:'eye',
             cost:[135, 225, 355], per:'+12% fleet vision',
             blurb:'Repeating frigates and a tall mast. The fleet sees further.' },
};
export const UPGRADE_IDS = Object.keys(UPGRADES);
export const UPG_MAX = 3;

// Per-level effect magnitudes, read by shared/physics.js and the server.
export const UPG_FX = {
  copper:   0.040,
  frames:   0.070,
  storm:    0.300,
  powder:   0.060,
  armour:   0.180,
  heated:   0.150,
  longnine: 0.100,
  dockyard: 1.200,
  signal:   0.120,
};

// Orders: the captain's active plays. Cost doubloons, share a short global
// cooldown so they cannot all be dumped at once. Armed with shift + 1-5, in
// this order, then placed by clicking the water.
export const ORDERS = {
  skyraid: { id:'skyraid', name:'SKY RAID',     cost:185, cd:56_000, target:'point',
             blurb:'A bomb-ketch balloon runs a line through the marked water. Four seconds warning — they can dodge.' },
  rally:   { id:'rally',   name:'RALLY SIGNAL', cost:95,  cd:42_000, target:'point',
             blurb:'+16% speed and -22% reload to friendly ships in the circle for 14 seconds.' },
  mines:   { id:'mines',   name:'SEA MINES',    cost:80,  cd:34_000, target:'point',
             blurb:'Five moored mines, all but invisible until you are nearly on them.' },
  smoke:   { id:'smoke',   name:'SMOKE SCREEN', cost:65,  cd:38_000, target:'point',
             blurb:'A rolling bank of powder smoke. Nothing sees through it for 20 seconds.' },
  works:   { id:'works',   name:'SHORE WORKS',  cost:120, cd:46_000, target:'hold',
             blurb:'Dockyard gangs restore 45% of a friendly fort instantly.' },
};
export const ORDER_IDS = Object.keys(ORDERS);
export const ORDER_GLOBAL_CD = 4_500;

export const SKYRAID = {
  warnMs:   4_000,
  length:   1500,
  width:    190,
  bombs:    9,
  dmg:      64,
  spacingMs:150,
};
export const RALLY  = { radius: 900, ms: 14_000, speed: 0.16, reload: 0.22 };
export const SMOKE  = { radius: 640, ms: 20_000, growMs: 2_000 };
export const MINEFX = { count: 5, scatter: 260 };

export const MINE = {
  armMs:     2_400,
  radius:    118,
  dmg:       82,
  crewDmg:   2.2,
  lifeMs:    150_000,
  driftSpd:  7,
  seeR:      330,      // enemies only spot a mine this close
};

// --- shoal water -----------------------------------------------------------
// A reef is not a rock. It punishes you for carrying way into water you should
// have read, and the punishment scales with how fast you were going, so the
// lesson is "shorten sail", not "never go near it".
export const REEF = {
  dpsMin:   5,        // barely moving: a scrape
  dpsMax:   21,       // full press: she is being opened up
  crewDps:  0.4,
  dragPerS: 1.15,     // how hard the coral holds her
};

// --- weather ---------------------------------------------------------------
export const SQUALL = {
  count:      3,
  radius:     [560, 980],
  speed:      [26, 52],
  dps:        7.0,
  visionMul:  0.46,
  driftPush:  26,
  lightningMs:3400,
  turnEveryMs:[12_000, 26_000],
};

// --- the Bullion Run (neutral objective) -----------------------------------
export const CONVOY = {
  firstMs:    195_000,
  everyMs:    215_000,
  warnMs:     20_000,
  hull:       520,
  speed:      64,
  prize:      ECON.convoyPrize,
  colours:    26,     // sinking it also costs the enemy this many colours
};

// --- anti-snowball ---------------------------------------------------------
export const CATCHUP = {
  respawnBase:     7_000,
  respawnPerHold:  1_500,   // the team ahead on holds waits longer to return
  respawnMax:      13_000,
  lastStandRepair: 0.22,
  lastStandFort:   0.30,
};

// --- pings / fleet signals -------------------------------------------------
// Sent from the wheel on T, not from keys of their own.
export const PINGS = [
  { id:'attack',  name:'ATTACK HERE',  col:'#ff6b4a' },
  { id:'defend',  name:'DEFEND',       col:'#4ad6ff' },
  { id:'help',    name:'NEED HELP',    col:'#ffd24a' },
  { id:'omw',     name:'ON MY WAY',    col:'#8affa0' },
  { id:'supply',  name:'NEED POWDER',  col:'#c79bff' },
];
export const PING_MS = 6_500;
export const PING_COOLDOWN_MS = 1_400;

// --- fleet talk ------------------------------------------------------------
// Signals are fast but blunt. Real coordination — "sell a level of armour and
// buy me powder" — needs words, so the fleet gets a team-only channel.
export const CHAT = {
  maxLen:      140,
  cooldownMs:  700,
  historyMax:  40,
  showMax:     7,
  showMs:      26_000,
};

// Quick phrases, sent with one key. They cover the things a fleet actually
// needs to say without anyone taking a hand off the helm.
// Sent from the wheel on Y.
export const QUICKCHAT = [
  { id:'push',    to:'all', text:'PUSHING THE GATE — with me' },
  { id:'fall',    to:'all', text:'FALLING BACK — regroup' },
  { id:'focus',   to:'all', text:'FOCUS THE ONE I MARKED' },
  { id:'buyguns', to:'cap', text:'CAPTAIN — we need POWDER and GUNS' },
  { id:'buyhull', to:'cap', text:'CAPTAIN — we need HULLS and FRAMES' },
  { id:'buyfort', to:'cap', text:'CAPTAIN — spend on the SHORE BATTERIES' },
  { id:'wantrun', to:'cap', text:'CAPTAIN — save coin, buy nothing yet' },
  { id:'aye',     to:'all', text:'AYE — understood' },
];

// --- misc ------------------------------------------------------------------
// A captain who has stopped playing starves their fleet of everything. After
// this long with no input at all, the deck passes to someone who is aboard.
export const CAPTAIN_IDLE_MS = 60_000 / SPEED;

export const KILLFEED_MAX = 7;
