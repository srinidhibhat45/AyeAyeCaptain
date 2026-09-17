# AYE AYE, CAPTAIN — *Tides of War*

A team-versus-team naval game for the browser. Two fleets, eight fortified
islands, fifteen minutes. One player on each side is the **Captain**: they hold
the purse, buy the fleet's upgrades and call the standing orders. Everybody else
sails a ship and tries to take ground.

It is a tower-defence map you fight over with sailing ships, where the towers
shoot back and the wind decides who can reach them.

```bash
npm install && npm start
```

Then open **http://localhost:8787**, put in a name, and you are at sea. Send the
same link to anyone else; add `?room=<anything>` for a private action.

**Four to ten players.** Two sides, one Captain on each, always. AI hands crew
any berth nobody has taken, and both fleets always sail the same number of
hulls however the humans are split — so the game is honest at 2v2 and at 5v5
and everywhere between.

No build step. No asset files — every ship, island, wave and sound in the game
is generated in code at boot.

**You do not have to read any of this to play.** A first visit opens a six-page
briefing — what the game is, how to sail, how the guns work, how to take a
Hold, what the Captain does, and what will sink you. After that the game
teaches the rest as it happens: the first time you stall head to wind, the
first time your broadside will not bear, the first time you are low on powder,
one line appears and says what to do about it. Every lesson shows once, ever.
Press `F1` or the `?` in the corner to read the briefing again.

---

## The shape of a match

| | |
|---|---|
| **Muster** | 22 s. Captains spend their opening purse. The fleets may sail but the guns stay housed. |
| **Engaged** | 13 m 30 s. The main action. |
| **The Last Bell** | 90 s. Everything bites twice as hard and ships return faster. |
| **Total** | **15:00 hard cap.** A winner is guaranteed. |

### Winning

Each fleet starts with **580 Colours**. Whoever holds more of the eight Holds
drains the other side's Colours, faster the bigger the lead. Sinking a ship and
silencing a battery cost Colours too.

You win by taking the enemy's Colours to zero, or by simply being ahead at the
bell. There is no draw unless the two fleets are level on Colours, Holds *and*
prizes taken.

### The map

Point-symmetric, so neither side gets the better ground. Three lanes run west to
east between the fleets:

```
   N lane    [GALLOWS POINT] ..................... [BLACKWATER]
                              ( NORTH GATE )
   C lane    [KEELHAUL BAY]  . . . . . . . . . . . [IRON ROADS]
                              ( SOUTH GATE )
   S lane    [SALT HARROW]  ...................... [WIDOWS REACH]
```

Three Holds per fleet, and **two contested Gates** in the middle. The Gates start
under a neutral garrison that fires on *both* fleets, they pay the best income,
and their batteries cover the centre passage between them — sailing straight
through the middle is the shortest route and the most dangerous one.

Only the Holds are fixed. The islands, reefs and weather are generated fresh
every match.

### Taking a Hold

1. **Silence the battery.** Bombard the fort until its guns fall quiet. You
   cannot land while it is firing.
2. **Hold the ring.** Sit inside the capture circle with no enemy present.
   About four seconds alone; faster with company.
3. It flips, rebuilds its battery to a third strength, and starts paying you.

A friendly Hold repairs your hull, refills your magazine and hands out mines.

---

## Sailing

Two rules generate nearly all of the skill in this game.

**You cannot sail into the wind.** A real polar curve governs your speed. The
compass at the bottom of the screen shows a red wedge you physically cannot
enter — to go upwind you must tack, and the wind veers all match and
occasionally shifts hard, silently redrawing every chase in progress.

**Guns fire sideways.** Your batteries traverse a limited arc off the beam. The
mouse sets both bearing *and* range: the ellipse under your cursor is where the
broadside will actually fall, and it is long in the direction of fire because
misjudging the range is what makes you miss. A green arc shows where the guns
bear. If they will not bear, you are told so.

### Crew

Twelve hands across four stations — **guns, sail, repair, watch**. More hands on
the guns means a faster reload; more on sail means more speed and a better helm.
Grape shot kills crew, and a gutted crew makes every station worse. Four preset
stances are on `Z X C V`, or click a station to move a hand yourself.

### Hulls

| | | |
|---|---|---|
| **Cutter** | Raider | Fast, weatherly, fragile. Points higher than anything else afloat. |
| **Brigantine** | Line | The honest all-rounder. Six guns a side. |
| **Xebec** | Skirmisher | Carries bow chasers as well as broadsides — fights while running. |
| **Galleon** | Siege | Slow and vast, and the only hull that truly breaks a shore battery (×2.3 against forts). |
| **Flagship** | Command | The Captain's. Tough, sees furthest, and her loss costs the fleet nearly twice as much. |

You choose a fresh hull every time you are sunk, so you can answer what the
enemy is doing.

---

## The Captain

One player per side. They sail a Flagship *and* run the Admiralty panel on the
left — the panel is always open, so command costs them attention rather than
taking them out of the fight.

**Nine upgrades, three levels each, all sellable.** Click to buy, right-click to
sell a level back for 60% of what it cost. Small, stacking, meaningful:

- *Fleet* — Copper Sheathing (+4% speed), Oak Frames (+7% hull), Storm Rigging
  (−30% weather punishment), Powder Monkeys (−6% reload)
- *Shore* — Battery Armour (+18% fort hull), Heated Shot (+15% fort damage),
  Long Nines (+10% fort range)
- *Logistics* — Dockyards (−1.2 s respawn), Signal Mast (+12% fleet vision)

A full match buys roughly ten or twelve levels out of the twenty-seven
available, so a Captain has to pick a doctrine rather than take everything.

**Five standing orders**, each on its own cooldown plus a short shared one:

| | | |
|---|---|---|
| **Sky Raid** | 185 | A bomb-ketch balloon runs a line through the marked water. Four seconds of warning — it can be dodged. |
| **Rally Signal** | 95 | +16% speed and −22% reload in a circle, for 14 s. |
| **Sea Mines** | 80 | Five moored mines, near-invisible until you are on them. |
| **Smoke Screen** | 65 | Blocks line of sight entirely for 20 s. |
| **Shore Works** | 120 | Restores 45% of a friendly fort instantly. |

Click an order, then click the water. `Shift`+`1`–`5` are the hotkeys, and they
work from the tactical chart (`M`) too — a Sky Raid can be laid on the far side
of the map without leaving your own fight.

The Captain's panel also tells them the one thing only they can fix: a **silenced
battery** on a Hold they still own shows up in red, because Shore Works is the
only way to put it back.

### Who has the deck

The longest-serving human on each side takes command. It never hops about
mid-battle on its own, and it never costs anybody a ship:

- **Taking or handing over command refits you at sea.** You keep your position,
  your way and the damage you are carrying, and simply become a different hull.
  Nobody is ever sunk because a team-mate logged off.
- Open the roster (`Tab`) to **take command** — instantly if an AI holds it,
  otherwise your request shows against your name until the Captain stands down.
- **Hand over command** from the same place, and take it back later if you want.
- A Captain who stops playing entirely is relieved after a minute. A fleet with
  nobody spending its purse is a fleet that has already lost.

### Talking to your Captain

There is no voice chat, so there are three ways to say something, in increasing
order of detail:

- Hold `T` for the **signal wheel** — attack here, defend, need help, on my way,
  need powder. Help and Powder land directly on the Captain's panel.
- Hold `Y` for **fleet talk** — eight phrases covering the things a fleet
  actually needs to say, including *"spend on the shore batteries"* and *"save
  your coin"*. Even the AI crew use it, so a human Captain has opinions coming
  at them all match.
- Press `Enter` to **type** to your own fleet. Nothing you say reaches the enemy.

Crew who are not in command see a read-only **Fleet** panel: the purse, the
income, who has the deck, and every level the Captain has bought. Asking for
something specific is much easier when you can see what has already been spent.

---

## Keeping it fair

The brief was that a fleet on a roll should not be able to snowball the match
out of reach. Six systems, all structural:

- **The Prize Court.** A run of kills pays progressively less — each one inside
  a 26-second window multiplies the next bounty by 0.80, down to a floor of 30%.
  It recovers a step at a time once you stop farming. The decay is deliberately
  gentle: the point is to stop a rampage paying for itself, not to make every
  prize worthless.
- **Admiralty Subsidy.** The fleet behind on Colours earns up to 65% more.
- **Slower returns for the leader.** The side ahead on Holds waits up to 13
  seconds to respawn. The side behind always waits the minimum.
- **Deep Holds are held on a long rope.** A Hold seized inside enemy water earns
  55% of normal *and* its battery is a third weaker and rebuilds at half speed.
  Without this the map locks solid after the opening exchange and there is no
  way back into the match.
- **Salvage.** Part of every bounty floats free where the ship went down, and
  *either* side can collect it. Pushing deep to farm kills leaves loot behind.
- **Last Stand.** Below 30% Colours a fleet repairs faster, its forts rebuild
  faster, and it lands on a Hold 35% quicker — it can retake ground, not merely
  survive on it.

A **prize is worth the same whether one ship took it or four**: 30% of every
bounty is set aside for anyone who was hurting the target in the last fourteen
seconds. Concentrating fire pays, and it pays without printing a single extra
doubloon.

And the map, the weather, the squalls and the Bullion Run are different every
match, so experience helps you but it does not hand you a solved position.

**Does any of it work?** The harness measures it rather than taking it on trust.
The Subsidy pays out about a quarter of the time and peaks near +35%; Last Stand
is on for 8–13% of a match; and the Prize Court engages in proportion to the
farming — at 5v5, where kills come thick, it is in force three-quarters of the
time and sits near its floor, while at 2v2 it barely bites at all.

The number that actually matters is the last one: **a fleet losing at the halfway
mark still wins 16% of the time at 2v2, 25% at 4v4 and 30% at 5v5.** Being behind
is a problem, not a verdict.

### Four players or ten

The tower-defence layer is scaled against the number of hulls actually on the
water. A battery that takes thirty ship-seconds of gunfire to break takes a full
minute of real time when there are only two ships to break it, and seconds when
there are five — so at 2v2 the batteries are lighter and softer, at 5v5 heavier
and harder, and losses cost more Colours in the smaller game where there are
fewer of them. Measured over fifty AI matches at each size:

| | 2v2 | 4v4 | 5v5 |
|---|---|---|---|
| average length | 13:13 | 12:48 | 12:29 |
| reach the bell | 34% | 26% | 12% |
| Holds captured | 4.1 | 4.9 | 4.8 |
| batteries silenced | 5.0 | 5.8 | 5.7 |
| comeback rate | 16% | 25% | 30% |

---

## The rest of the sea

- **The Bullion Run.** Every three and a half minutes a treasure barque crosses
  the strait, announced twenty seconds ahead. Sinking it pays 300 doubloons and
  costs the enemy 26 Colours. It exists to start a fight in the middle.
- **Squalls** wander the map: they cut your vision by half, shove you bodily to
  leeward, stop damage control and bleed your hull. Storm Rigging answers them.
- **Reefs** are shoal water, and what they cost you depends entirely on the way
  you were carrying. Shorten sail and you can pick your way out; drive across
  at a full press and she will not come out the other side. You can see them;
  that is the point.
- **Mines**, both yours and the Captain's, drift slowly and are invisible to the
  enemy until they are nearly aboard.
- **Fire** starts occasionally from round shot and burns until damage control
  wins. A burning ship is a beacon.
- **Salvage** floats where a ship went down — part of the prize, free to
  whoever dares sail over it, whichever side they are on.

---

## Controls

| | |
|---|---|
| `W` / `S` | More sail · less sail (furled → reefed → full → press) |
| `A` / `D` | Helm to port · to starboard |
| `Space` | Sweeps — oars, to claw out of irons |
| Mouse | Point at a ship to **lock** her — the lead and the range are worked out for you |
| Left click | Fire the broadside that bears |
| `Q` / `E` | Fire port · starboard by hand |
| Right click | Bow chasers (Xebec only) |
| `1` `2` `3` | Round · chain · grape shot |
| `Z` `X` `C` `V` | Crew stations: quarters · sail · repair · lookout |
| `R` | Lay a mine astern |
| `T` *hold* | Signal wheel |
| `Y` *hold* | Fleet talk — what to push, what to buy |
| `G` | Quick "attack here" on the cursor |
| `Enter` | Say something to your own fleet |
| `Tab` | Fleet roster — and where you take or hand over command |
| `Esc` | Close the roster · disarm an order |
| `M` | Tactical chart |
| `H` | Help card |
| `F1` | Ship's orders — the full briefing |
| `Shift`+`1`–`5` | Captain's orders |
| Wheel | Zoom |

**Shot types.** Round shot bites hull and is the honest answer to most
questions. Chain shot shreds rigging — cripple a runner, then take your time.
Grape shot sweeps the deck, and every station slows when the crew is gone.

### Reading the screen

Everything you need to fight is drawn on the water rather than buried in a
panel, because a gunfight is not a thing you can read a table during.

| | |
|---|---|
| Green wedges either side of your ship | Where your guns can reach. **Bright** means loaded *and* bearing; the wedge fills back out from the hull as the battery reloads. |
| Yellow corner bracket | The ship or battery your guns are laid on, with her name and the range. Under it, in words: `BROADSIDE BEARS — FIRE`, `RELOADING`, `OUT OF RANGE`, or `TURN — SHE WILL NOT BEAR`. |
| A curling arrow on your own hull | You asked for a shot the ship cannot make. The arrow and the words say which way to put the helm. |
| Red corner brackets | Enemy ships. `GUNS ON YOU` means her broadside is lined up on you *now*. |
| Red arrows at the edge of the view | Enemies off-screen, with the range to each. They step around the panels rather than hiding behind them. |
| A dashed red circle | A hostile shore battery's reach. Do not loiter inside it. |
| Gold streaks | Your shot in flight. Red streaks are theirs. |
| Red glow on one side of the screen | You were just hit, and that is the bearing it came from. |
| A white ring under your keel | You. Smoke, squall or crowd, you can always find your own ship. |

---

## How it is built

Node with one dependency (`ws`). The server is authoritative; the client only
predicts.

```
shared/     constants.js   every balance number in the game
            physics.js     sailing model, imported byte-identical by both sides
            math.js
server/     match.js       the simulation: roster, holds, forts, economy, fog of war
            bot.js         bot helmsmen, a bot admiral, a fleet coordinator
            worldgen.js    the symmetric three-lane map
            ship.js  index.js
client/     js/gl/         WebGL2: core.js, art.js (all sprites), scene.js (shaders)
            js/draw.js     game state to draw calls, plus particles
            js/ui/hud.js   instruments, Admiralty dock, fleet talk, roster, minimap
            js/main.js     prediction, interpolation, camera
tools/      balance.js     headless AI-vs-AI match runner
            playtest.js    end-to-end scenarios over real WebSockets
            humanclient.js a headless player that sees only what a snapshot says
            roster.js      the four-to-ten rules, hammered in-process
            lint-colors.mjs
```

- **30 Hz** simulation, **20 Hz** snapshots, **30 Hz** client input.
- **Client prediction with reconciliation.** Your own ship is stepped locally
  with the same `shared/physics.js` the server runs, then eased toward the
  server's truth (or snapped, past 260 units of error). Everyone else is drawn
  110 ms in the past and interpolated.
- **Fog of war is computed on the server.** Clients are only sent the enemies
  their team can actually see — teammates share vision, holds see for their
  owners, smoke blocks line of sight, and a lookout beyond visual range reports
  a vague contact instead of a ship. The roster is redacted the same way: what
  the enemy has *done* is public, what they are doing *right now* — which hulls
  are in the water and what they are — is not. You cannot cheat by reading the
  socket, because the information is not in it. A snapshot runs about 3.7 KB,
  which is 0.6 Mbit/s down per player at twenty a second.
- **The simulation clock is `Match.now`,** advanced by `dt` rather than read from
  the wall clock, which is what lets `tools/balance.js` play a full fifteen
  minute match in a fraction of a second.
- **Every client-supplied key is looked up with `own()`.** `UPGRADES['__proto__']`
  is `Object.prototype`, which is truthy and sails straight past a `if (!u)`
  guard before throwing on the first property access — one WebSocket message
  and the room is gone. Own keys only, everywhere, and the message handler is
  wrapped as well.

### Graphics

A WebGL2 renderer, with a 2D canvas over it for anything that needs crisp text.

- **The ocean is a shader.** Three layers of wind-aligned swell, sized against
  real world units so nothing is finer than a ship is long. The slope drives
  sun glitter, whitecaps and light scattering through the wave crests.
- **Depth is baked.** At boot the island polygons go through a chamfer distance
  transform into a four-channel field — land mask, distance offshore, reefs,
  distance inland. The water reads it for its shallow ramp and its shore break;
  the land shader reads it for beaches, treeline and cliff shading.
- **Territory is painted into the water.** Owned Holds tint the sea around them,
  so you can read the map at a glance.
- **Yards brace properly.** A yard bisects the angle between the wind and the
  keel — square when running, about 45° on a beam reach, hard round
  close-hauled — and the canvas bellies to leeward off it. Watching the rig
  swing as you tack is most of what makes a ship feel like a ship.
- **Post:** bright-pass bloom, shockwave distortion on explosions, chromatic
  spread toward the corners, vignette and a whisper of grain.
- **Every sprite is drawn in code** into one 2048² atlas at boot — hulls with
  planking, gun ports, rigging and deck furniture; forts; sails; smoke; foam.
  Open `/atlas.html` to inspect the sheet.
- **Shot in flight is a streak, not a ball.** A cannonball is a thirty-centimetre
  object doing 770 a second: at any playable zoom it is a fraction of a pixel.
  So the server sends each shot's heading as well as its position, the client
  walks it on between packets, and it is drawn as a tracer sized in *screen*
  space — gold going out, red coming in. Everything about reading a gunfight is
  in that line.
- **The view is framed in world units**, not pixels, so a brigantine is the same
  readable size on a laptop and on a large retina display, and your own hull is
  drawn *after* the weather so a smoke screen can never hide your ship from you.
- **Sound is synthesised** from oscillators and shaped noise, and it is
  *positional*: every report, splash and bell is panned to where it happened on
  screen and rolled off with distance. Landing a shot, taking one, and hearing
  someone else's land nearby are three different sounds, because knowing which
  of them just happened is the whole feedback loop of a fight. A broadside
  ripples down the ship's side, and the ripple is as long as the battery is.

### Tuning and testing

Nearly everything lives in `shared/constants.js`. Change a number, restart, play.

```bash
npm run balance 60                 # 60 complete AI-vs-AI matches, reported
npm run balance 40 -- --fleet 2    # ... at the four-player minimum
npm run balance 40 -- --skill 0    # ... against green crews instead of hard ones
npm run balance 40 -- --vs         # hard crews against green ones, sides alternated
npm run playtest                   # every end-to-end scenario, over real sockets
npm run roster                     # the four-to-ten rules, hammered in-process
npm run lint                       # catch malformed colour literals
npm run check                      # all three

BOTS=5 SKILL=0.5 npm start         # five hulls a side, middling AI
AAC_SPEED=30 npm start             # run the match clock 30x faster
```

`AAC_SPEED` shortens the phases but not the per-second drain rates, so a
sped-up match usually reaches the bell with both fleets still healthy. Use the
balance harness, not the fast clock, to judge balance.

**`tools/playtest.js` boots the real server and joins real WebSocket players.**
They are not the server's own bots: `HumanClient` sees only what a snapshot
tells it and plays from that, so a field missing from a snapshot breaks the test
the way it would break a person. Invariants are checked against every snapshot
every client receives — exactly one captain per side, both fleets the same size,
nobody alive at zero hull, twelve crew hands allocated, no NaN anywhere. The
scenarios cover four players up to ten, an eleventh being turned away, everyone
piling onto one side, the captain quitting mid-battle, handing the deck over and
taking it back, late joiners, switching sides, a complete match with the room
re-forming afterwards, and a client sending deliberate rubbish.

**`tools/roster.js`** hammers the two rules that make a four-to-ten player game
honest — both fleets the same size, exactly one captain each — through every join
order and team preference up to ten players and all the way back down, and then
through two hundred rounds of people claiming and handing over the deck. It
checks after every single step, which is how it caught a duplicate player id
silently overwriting a hull.

**The balance harness** reports duration, which side won, victory routes, how
ships were lost, captures, upgrades bought, and whether the anti-snowball
machinery actually engages rather than merely existing.

Over 50 matches at each fleet size, with hard crews:

```
                         2v2        4v4        5v5
duration        avg     793s       768s       749s      (cap 900s)
                min     302s       392s       443s
reach the bell           34%        26%        12%
sinkings                11.1       30.3       39.4
captures                 4.1        4.9        4.8
batteries silenced       5.0        5.8        5.7
lost to round shot       45%        55%        56%
lost to shore batteries  34%        26%        26%
comeback rate            16%        25%        30%
upgrades, levels of 3  1.1-2.0    1.2-1.9    1.1-1.9
```

Every Hold changes hands over the course of these runs, so the map genuinely
moves rather than settling after the opening, and every upgrade line gets bought
without any of them being an automatic max.

**Watch out for seed luck.** These runs use fixed seeds, and at n=50 a win split
of 56/44 or 38/62 is well inside the noise. One apparent 66/34 bias turned out to
be exactly 50/50 on `--seed 500`. Confirm any side bias on a second seed range
before you go looking for a cause.

Bot fleets are coordinated. A `FleetAI` assigns each hull a job so a fleet
concentrates on one objective and still leaves someone minding the back door,
and it calls a focus target so the fleet piles onto one hull rather than
spreading its fire. `SKILL` runs 0 to 1 and moves three things: how quickly a
bot reacts, how well it judges range — which is what actually makes a broadside
miss — and how many of a good player's habits are switched on at all. At the
top of the scale they dodge telegraphed sky raids, steer round mines they have
genuinely spotted, heave to for the faster reload while breaking a battery,
finish cripples instead of picking fresh fights, and mine their own wake while
running. At the bottom they do none of it. Nobody is a machine either way:
reaction and aim are spread across the fleet, because a side where every hull
behaves identically reads as fake within a minute.

Does the setting buy anything? Over forty matches with the sides alternated,
**hard crews beat green ones 70–30**, sink half again as many ships and take a
third more Holds — a real gap, but not a hopeless one. Turn `SKILL` down if a
fleet of new players is getting walked over.

`window.__game` is exposed in the browser console (`scene`, `G`, `hud`, `net`)
if you want to poke at the renderer while tuning.
