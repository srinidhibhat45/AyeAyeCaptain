// ============================================================================
//  The roster rules, exercised in-process across the whole promised range.
//
//  Two things must hold at every instant, whatever order people arrive and
//  leave in and however much they fight over the deck:
//    1. Both fleets sail the same number of hulls, never more than the cap.
//    2. Each fleet has exactly one captain, a human wherever one is aboard,
//       and a living captain is in the flagship.
//
//    node tools/roster.js
// ============================================================================
import { Match } from '../server/match.js';
import { TEAMS, MAX_PER_TEAM, MAX_PLAYERS, FLEET_SIZE } from '../shared/constants.js';

const fail = [];
const seen = new Set();
const note = (msg) => { if (!seen.has(msg)) { seen.add(msg); fail.push(msg); } };

function check(m, where) {
  const [a, b] = TEAMS.map(t => m.totalCount(t));
  if (a !== b) note(`${where}: uneven fleets, ${a} v ${b}`);
  if (a > MAX_PER_TEAM) note(`${where}: ${a} hulls exceeds the cap of ${MAX_PER_TEAM}`);
  for (const t of TEAMS) {
    const crew = [...m.ships.values()].filter(s => s.team === t);
    const caps = crew.filter(s => s.role === 'captain');
    if (caps.length !== 1) note(`${where}: ${t} has ${caps.length} captains`);
    if (caps[0] && m.teams[t].captain !== caps[0].id) note(`${where}: ${t} captain id disagrees with the role`);
    if (crew.some(s => !s.bot) && caps[0]?.bot) note(`${where}: ${t} is led by a bot with humans aboard`);
    if (caps[0]?.alive && caps[0].hullId !== 'flagship') note(`${where}: ${t} captain is sailing a ${caps[0].hullId}`);
  }
}

// --- every join order, up to the ceiling, and all the way back down ---------
for (const pref of [null, 'scarlet', 'cobalt', 'alternate']) {
  const label = pref || 'auto';
  const m = new Match('roster', { seed: 3, fleetSize: FLEET_SIZE });
  m.fillBots(FLEET_SIZE);
  m.begin();

  const aboard = [];
  for (let i = 0; i < MAX_PLAYERS + 2; i++) {
    const want = pref === 'alternate' ? TEAMS[i % 2] : pref;
    if (m.addPlayer(`h${i}`, `Hand ${i}`, want)) aboard.push(`h${i}`);
    for (let k = 0; k < 40; k++) m.step(1 / 30);
    check(m, `${label}: after join ${i + 1}`);
  }
  if (aboard.length !== MAX_PLAYERS) note(`${label}: ${aboard.length} got aboard, expected ${MAX_PLAYERS}`);

  for (const id of aboard) {
    m.ships.get(id).connected = false;
    m.removeShip(id);
    m.balanceBots(FLEET_SIZE);
    for (let k = 0; k < 40; k++) m.step(1 / 30);
    check(m, `${label}: after a departure`);
  }
  if (m.totalCount('scarlet') !== FLEET_SIZE) note(`${label}: fleet did not settle back to ${FLEET_SIZE}`);
}

// --- people fighting over the deck ------------------------------------------
{
  const m = new Match('command', { seed: 9, fleetSize: FLEET_SIZE });
  m.fillBots(FLEET_SIZE);
  m.begin();
  ['scarlet', 'scarlet', 'cobalt', 'cobalt'].forEach((t, i) => m.addPlayer(`p${i}`, `Hand ${i}`, t));
  const humans = [...m.ships.values()].filter(s => !s.bot).map(s => s.id);

  for (let i = 0; i < 200; i++) {
    const id = humans[i % humans.length];
    m.command(id, i % 2 ? 'standdown' : 'claim');
    if (i % 17 === 0) m.switchTeam(id);
    for (let k = 0; k < 6; k++) m.step(1 / 30);
    check(m, 'command churn');
  }
  const left = [...m.ships.values()].filter(s => !s.bot).length;
  if (left !== humans.length) note(`command churn: ${left} humans left of ${humans.length}`);
}

// --- and a duplicate id must not quietly overwrite somebody -----------------
{
  const m = new Match('dupe', { seed: 1, fleetSize: FLEET_SIZE });
  m.fillBots(FLEET_SIZE);
  m.begin();
  m.addPlayer('same', 'First', 'scarlet');
  if (m.addPlayer('same', 'Second', 'scarlet')) note('a duplicate id was allowed aboard');
  if (m.ships.get('same')?.name !== 'First') note('a duplicate id overwrote the original player');
  check(m, 'duplicate id');
}

if (fail.length) {
  console.log(`${fail.length} PROBLEM(S):\n  ${fail.join('\n  ')}`);
  process.exit(1);
}
console.log('roster rules hold from four players to ten and back, through command churn');
