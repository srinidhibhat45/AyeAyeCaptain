// ============================================================================
//  Headless balance harness. Runs complete AI-vs-AI matches at thousands of
//  ticks per second and reports on how they actually played out.
//    node tools/balance.js [matches] [--v] [--fleet N] [--skill K]
//    node tools/balance.js [matches] --vs        hard crews against green ones
// ============================================================================
import { Match } from '../server/match.js';
import { BotBrain } from '../server/bot.js';
import { DT, PHASE, TEAMS, MATCH_MS, UPGRADES } from '../shared/constants.js';

const N = parseInt(process.argv[2] || '20', 10);
const verbose = process.argv.includes('--v');
const argN = (flag, def) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
};
const FLEET = argN('--fleet', 4);      // hulls per side
const SKILL = argN('--skill', 1);      // 0 green .. 1 hard
const SEED0 = argN('--seed', 0);       // shift the seed run, to sample elsewhere
const VS = process.argv.includes('--vs');   // hard crews against green ones

// ---------------------------------------------------------------------------
//  Hard vs green: does the skill setting actually buy anything?
// ---------------------------------------------------------------------------
if (VS) {
  const wins = { hard: 0, green: 0, draw: 0 };
  const kills = { hard: 0, green: 0 }, caps = { hard: 0, green: 0 };
  for (let i = 0; i < N; i++) {
    // Alternate which colour is the hard side, so the map cannot be the reason.
    const hard = i % 2 ? 'scarlet' : 'cobalt';
    const green = hard === 'scarlet' ? 'cobalt' : 'scarlet';
    const m = new Match(`vs${i}`, { seed: ((i + SEED0) * 7919 + 13) >>> 0, fleetSize: FLEET, skill: 1 });
    m.fillBots(FLEET);
    for (const s of m.ships.values()) m.bots.set(s.id, new BotBrain(s, m.rng(), s.team === hard ? 1 : 0));
    m.fleets[hard].skill = 1;
    m.fleets[green].skill = 0;
    m.begin();
    let g = 0;
    while (m.phase !== PHASE.OVER && g++ < 60 * 30 * 60) m.step(DT);
    wins[m.winner === hard ? 'hard' : m.winner === green ? 'green' : 'draw']++;
    kills.hard += m.teams[hard].kills;  kills.green += m.teams[green].kills;
    caps.hard += m.teams[hard].caps;    caps.green += m.teams[green].caps;
  }
  const p = (n) => `${((n / N) * 100).toFixed(0)}%`;
  console.log(`\n=== ${N} matches — hard crews vs green, ${FLEET}v${FLEET}, sides alternated ===`);
  console.log(`  wins       hard ${p(wins.hard)}   green ${p(wins.green)}   draw ${p(wins.draw)}`);
  console.log(`  sinkings   hard ${(kills.hard / N).toFixed(1)}   green ${(kills.green / N).toFixed(1)}`);
  console.log(`  captures   hard ${(caps.hard / N).toFixed(1)}   green ${(caps.green / N).toFixed(1)}`);
  process.exit(0);
}

const agg = {
  wins: { scarlet: 0, cobalt: 0, draw: 0 },
  reasons: {},
  durations: [],
  kills: [], caps: [], sinks: 0,
  deathBy: {},
  holdEnd: [],
  colourGap: [],
  upgTaken: {},
  ordersUsed: 0,
  fortsDown: 0,
  // Does the anti-snowball machinery actually engage, or is it decoration?
  prizeMin: [], prizeTimeLow: 0, subsidyMax: [], subsidyTime: 0,
  lastStandTime: 0, salvagePicked: 0, assists: 0,
  leadFlips: [], samples: 0,
  // The question that actually matters: if you are losing at the half, can you
  // still win? A game where the answer is "no" has snowballed, whatever the
  // brake systems say about themselves.
  halfBehind: 0, halfBehindWon: 0, halfClear: 0, halfClearWon: 0,
};

for (let i = 0; i < N; i++) {
  const m = new Match(`bal${i}`, { seed: ((i + SEED0) * 7919 + 13) >>> 0, skill: SKILL, fleetSize: FLEET });
  m.fillBots(FLEET);
  m.begin();

  let guard = 0;
  const deathBy = {};
  const origSink = m.sink.bind(m);
  m.sink = (s, byId, kind) => { agg.sinks++; deathBy[kind || '?'] = (deathBy[kind || '?'] | 0) + 1; origSink(s, byId, kind); };
  const origFort = m.damageFort.bind(m);
  m.damageFort = (h, d, bt, bi) => { const was = h.fortHp; origFort(h, d, bt, bi); if (was > 0 && h.fortHp <= 0) agg.fortsDown++; };
  const origOrder = m.issueOrder.bind(m);
  m.issueOrder = (...a) => { const r = origOrder(...a); if (!r) agg.ordersUsed++; return r; };

  let pMin = 1, sMax = 0, flips = 0, lead = 0, half = null;
  while (m.phase !== PHASE.OVER && guard++ < 60 * 30 * 60) {
    m.step(DT);
    if (guard % 30 === 0) {                    // once a simulated second
      agg.samples++;
      for (const t of TEAMS) {
        const T = m.teams[t], O = m.teams[t === 'scarlet' ? 'cobalt' : 'scarlet'];
        pMin = Math.min(pMin, T.prizeMul);
        if (T.prizeMul < 0.95) agg.prizeTimeLow++;
        const sub = Math.max(0, Math.min(1, (O.colours - T.colours) / 580));
        sMax = Math.max(sMax, sub);
        if (sub > 0.15) agg.subsidyTime++;
        if (T.lastStand) agg.lastStandTime++;
      }
      // How often does the lead actually change hands? A game nobody can come
      // back in shows up here as a flat zero.
      const d = Math.sign(m.holdCount('scarlet') - m.holdCount('cobalt'));
      if (d !== 0 && d !== lead) { if (lead !== 0) flips++; lead = d; }
      if (half === null && m.phase !== PHASE.MUSTER && (m.now - m.startedAt) > MATCH_MS * 0.45) {
        const gap = m.teams.scarlet.colours - m.teams.cobalt.colours;
        half = { ahead: gap > 0 ? 'scarlet' : 'cobalt', gap: Math.abs(gap) };
      }
    }
  }
  if (half) {
    const behind = half.ahead === 'scarlet' ? 'cobalt' : 'scarlet';
    agg.halfBehind++;
    if (m.winner === behind) agg.halfBehindWon++;
    if (half.gap > 90) { agg.halfClear++; if (m.winner === behind) agg.halfClearWon++; }
  }
  agg.prizeMin.push(pMin);
  agg.subsidyMax.push(sMax);
  agg.leadFlips.push(flips);
  for (const s of m.ships.values()) { agg.assists += s.assists; agg.salvagePicked += s.salvage; }

  const dur = (m.now - m.startedAt) / 1000;
  agg.durations.push(dur);
  agg.wins[m.winner || 'draw']++;
  agg.reasons[m.winReason] = (agg.reasons[m.winReason] | 0) + 1;
  agg.kills.push(m.teams.scarlet.kills + m.teams.cobalt.kills);
  agg.caps.push(m.teams.scarlet.caps + m.teams.cobalt.caps);
  agg.holdEnd.push(`${m.holdCount('scarlet')}-${m.holdCount('cobalt')}`);
  agg.colourGap.push(Math.abs(m.teams.scarlet.colours - m.teams.cobalt.colours));
  for (const k in deathBy) agg.deathBy[k] = (agg.deathBy[k] | 0) + deathBy[k];
  for (const t of TEAMS) for (const [u, l] of Object.entries(m.teams[t].upg)) agg.upgTaken[u] = (agg.upgTaken[u] | 0) + l;

  if (verbose) {
    console.log(`#${String(i).padStart(3)} ${String(Math.round(dur)).padStart(4)}s  ${(m.winner || 'draw').padEnd(8)} ${m.winReason.padEnd(30)} holds ${m.holdCount('scarlet')}-${m.holdCount('cobalt')}  colours ${Math.round(m.teams.scarlet.colours)}/${Math.round(m.teams.cobalt.colours)}`);
  }
}

const avg = a => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
const pct = (n, d) => `${((n / Math.max(1, d)) * 100).toFixed(1)}%`;

console.log(`\n=== ${N} matches — ${FLEET}v${FLEET}, skill ${SKILL} ===`);
console.log(`duration      avg ${avg(agg.durations).toFixed(0)}s   min ${Math.min(...agg.durations).toFixed(0)}s   max ${Math.max(...agg.durations).toFixed(0)}s   (cap ${MATCH_MS / 1000}s)`);
console.log(`winner        scarlet ${pct(agg.wins.scarlet, N)}   cobalt ${pct(agg.wins.cobalt, N)}   draw ${pct(agg.wins.draw, N)}`);
console.log(`per match     ${avg(agg.kills).toFixed(1)} sinkings   ${avg(agg.caps).toFixed(1)} captures   ${(agg.fortsDown / N).toFixed(1)} batteries silenced   ${(agg.ordersUsed / N).toFixed(1)} orders`);
console.log(`final colours gap avg ${avg(agg.colourGap).toFixed(0)}`);
console.log(`\nvictory routes`);
for (const [r, n] of Object.entries(agg.reasons).sort((a, b) => b[1] - a[1])) console.log(`  ${pct(n, N).padStart(6)}  ${r}`);
console.log(`\nhow ships were lost`);
for (const [k, n] of Object.entries(agg.deathBy).sort((a, b) => b[1] - a[1])) console.log(`  ${pct(n, agg.sinks).padStart(6)}  ${k}`);
console.log(`\nupgrades bought (levels per team per match)`);
for (const [u, n] of Object.entries(agg.upgTaken).sort((a, b) => b[1] - a[1])) console.log(`  ${(n / (N * 2)).toFixed(2)}  ${UPGRADES[u].name}`);
console.log(`\nanti-snowball (per match)`);
console.log(`  prize court   worst multiplier ${avg(agg.prizeMin).toFixed(2)}   in force ${pct(agg.prizeTimeLow, agg.samples * 2)} of the time`);
console.log(`  subsidy       peak +${(avg(agg.subsidyMax) * 65).toFixed(0)}%   paid out ${pct(agg.subsidyTime, agg.samples * 2)} of the time`);
console.log(`  last stand    ${pct(agg.lastStandTime, agg.samples * 2)} of the time`);
console.log(`  hold lead changed hands ${avg(agg.leadFlips).toFixed(1)} times`);
console.log(`  COMEBACKS     behind at the half and still won: ${pct(agg.halfBehindWon, agg.halfBehind)}`
          + `   (clearly behind, 90+ colours: ${pct(agg.halfClearWon, agg.halfClear)} of ${agg.halfClear})`);
console.log(`  ${(agg.assists / N).toFixed(1)} assists   ${(agg.salvagePicked / N).toFixed(0)} doubloons salvaged`);

console.log(`\nfinal hold splits`);
const hs = {};
for (const h of agg.holdEnd) hs[h] = (hs[h] | 0) + 1;
console.log('  ' + Object.entries(hs).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}:${v}`).join('  '));
