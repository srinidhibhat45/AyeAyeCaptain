// ============================================================================
//  The interface. DOM for panels (crisp type, easy layout), a 2D canvas over
//  the GL scene for anything that has to sit at a world position.
// ============================================================================
import {
  PHASE, TEAM, HOLD, GUN, SHOT, SHOT_IDS, STANCES, UPGRADES, UPGRADE_IDS, UPG_MAX,
  ORDERS, ORDER_IDS, PINGS, HULLS, HULL_IDS, POLAR, NO_GO, COLOURS, HANDS,
  QUICKCHAT, CHAT, MAX_PER_TEAM,
} from '/shared/constants.js';
import { clamp, lerp, wrapAngle, angleDiff, fmtTime, dist, TAU } from '/shared/math.js';
import { polarFactor, angleOffWind } from '/shared/physics.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
/** Break a label into lines of at most `n` characters, on word boundaries. */
function wrapWords(text, n) {
  const out = [];
  let line = '';
  for (const w of String(text).split(/\s+/)) {
    if (!line) line = w;
    else if ((line + ' ' + w).length <= n) line += ' ' + w;
    else { out.push(line); line = w; }
  }
  if (line) out.push(line);
  return out.slice(0, 3);
}
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const UPG_ICON = {
  copper: '⛵', frames: '🛡', storm: '🌊', powder: '💣',
  armour: '🏰', heated: '🔥', longnine: '🎯', dockyard: '⚓', signal: '🔭',
};
const ORD_ICON = { skyraid: '🎈', rally: '🚩', mines: '✹', smoke: '💨', works: '🔨' };
const WHEEL_DEAD = 44;      // px from the middle that picks nothing

const SAIL_NAMES = ['FURLED', 'REEFED', 'FULL', 'PRESS'];

// Small diagrams for the briefing. A picture of the no-go zone teaches more
// about sailing than three paragraphs of it, and the firing-arc diagram is the
// single most useful thing in the game to have seen once.
const SVG = (body, vb = '0 0 260 200') =>
  `<svg viewBox="${vb}" xmlns="http://www.w3.org/2000/svg" role="img">${body}</svg>`;

const BRIEF_ART = {
  map: SVG(`
    <rect x="0" y="0" width="260" height="200" fill="#0b1520"/>
    <g opacity=".45">
      <rect x="0" y="0" width="76" height="200" fill="#ef4b42" opacity=".13"/>
      <rect x="184" y="0" width="76" height="200" fill="#3ea9f2" opacity=".13"/>
    </g>
    <g fill="#ef4b42"><circle cx="34" cy="56" r="9"/><circle cx="34" cy="144" r="9"/><circle cx="84" cy="100" r="9"/></g>
    <g fill="#3ea9f2"><circle cx="226" cy="56" r="9"/><circle cx="226" cy="144" r="9"/><circle cx="176" cy="100" r="9"/></g>
    <g fill="#e8dcc2">
      <rect x="120" y="42" width="20" height="20" transform="rotate(45 130 52)"/>
      <rect x="120" y="138" width="20" height="20" transform="rotate(45 130 148)"/>
    </g>
    <text x="130" y="24" fill="#ffc44d" font-size="13" text-anchor="middle" font-family="monospace">THE GATES</text>
    <text x="130" y="112" fill="#8fa3b8" font-size="11" text-anchor="middle" font-family="monospace">worth most</text>
    <text x="34" y="184" fill="#ef4b42" font-size="11" text-anchor="middle" font-family="monospace">YOU</text>
    <text x="226" y="184" fill="#3ea9f2" font-size="11" text-anchor="middle" font-family="monospace">THEM</text>`),

  polar: SVG(`
    <circle cx="130" cy="106" r="80" fill="#0d1c28" stroke="#2a3a4a"/>
    <path d="M130 106 L92 32 A82 82 0 0 1 168 32 Z" fill="#ff4a3a" opacity=".30"/>
    <path d="M130 106 L92 32 A82 82 0 0 1 168 32 Z" fill="none" stroke="#ff4a3a" stroke-width="1.5"/>
    <text x="130" y="52" fill="#ff8a7a" font-size="12" text-anchor="middle" font-family="monospace">NO GO</text>
    <path d="M130 12 L130 34 M124 28 L130 36 L136 28" stroke="#8fd7ff" stroke-width="2.5" fill="none"/>
    <text x="130" y="10" fill="#8fd7ff" font-size="11" text-anchor="middle" font-family="monospace">WIND</text>
    <g fill="#6fdc8c">
      <text x="222" y="110" font-size="12" text-anchor="middle" font-family="monospace">100%</text>
      <text x="38" y="110" font-size="12" text-anchor="middle" font-family="monospace">100%</text>
    </g>
    <text x="130" y="198" fill="#9fb0c0" font-size="12" text-anchor="middle" font-family="monospace">running &mdash; 72%</text>
    <g transform="translate(130 106) rotate(120)">
      <path d="M-15 0 L9 -6 L18 0 L9 6 Z" fill="#e8dcc2"/>
    </g>`),

  arcs: SVG(`
    <rect x="0" y="0" width="260" height="200" fill="#0b1520"/>
    <path d="M130 100 L34 34 A118 118 0 0 0 34 166 Z" fill="#6fdc8c" opacity=".22"/>
    <path d="M130 100 L226 34 A118 118 0 0 1 226 166 Z" fill="#6fdc8c" opacity=".22"/>
    <path d="M130 100 L34 34 A118 118 0 0 0 34 166 Z" fill="none" stroke="#6fdc8c" stroke-width="1.4"/>
    <path d="M130 100 L226 34 A118 118 0 0 1 226 166 Z" fill="none" stroke="#6fdc8c" stroke-width="1.4"/>
    <path d="M130 100 L96 8 A98 98 0 0 1 164 8 Z" fill="#ff4a3a" opacity=".22"/>
    <path d="M130 100 L96 192 A98 98 0 0 0 164 192 Z" fill="#ff4a3a" opacity=".22"/>
    <g transform="translate(130 100) rotate(-90)"><path d="M-30 0 L18 -11 L36 0 L18 11 Z" fill="#e8dcc2"/></g>
    <text x="52" y="104" fill="#6fdc8c" font-size="13" font-family="monospace">GUNS</text>
    <text x="178" y="104" fill="#6fdc8c" font-size="13" font-family="monospace">GUNS</text>
    <text x="130" y="30" fill="#ff8a7a" font-size="12" text-anchor="middle" font-family="monospace">BLIND</text>
    <text x="130" y="180" fill="#ff8a7a" font-size="12" text-anchor="middle" font-family="monospace">BLIND</text>`),

  hold: SVG(`
    <rect x="0" y="0" width="260" height="200" fill="#0b1520"/>
    <circle cx="130" cy="100" r="76" fill="#3ea9f2" opacity=".10" stroke="#3ea9f2" stroke-width="1.6" stroke-dasharray="6 5"/>
    <ellipse cx="130" cy="100" rx="34" ry="28" fill="#2b3a2c"/>
    <rect x="118" y="86" width="24" height="24" rx="3" fill="#7d8a94"/>
    <path d="M130 86 L130 70" stroke="#3ea9f2" stroke-width="3"/>
    <path d="M130 70 L150 76 L130 82 Z" fill="#3ea9f2"/>
    <g transform="translate(66 128) rotate(-20)"><path d="M-16 0 L10 -6 L19 0 L10 6 Z" fill="#ef4b42"/></g>
    <g transform="translate(196 74) rotate(160)"><path d="M-16 0 L10 -6 L19 0 L10 6 Z" fill="#ef4b42"/></g>
    <text x="130" y="192" fill="#ffc44d" font-size="12" text-anchor="middle" font-family="monospace">SILENCE IT, THEN SIT IN THE RING</text>`),

  purse: SVG(`
    <rect x="0" y="0" width="260" height="200" fill="#0b1520"/>
    <text x="130" y="28" fill="#c9a227" font-size="15" text-anchor="middle" font-family="monospace">&#9884; 320</text>
    <g fill="#12202c" stroke="#2e4256">
      <rect x="28" y="46" width="62" height="54" rx="4"/><rect x="99" y="46" width="62" height="54" rx="4"/>
      <rect x="170" y="46" width="62" height="54" rx="4"/>
      <rect x="28" y="110" width="62" height="54" rx="4"/><rect x="99" y="110" width="62" height="54" rx="4"/>
      <rect x="170" y="110" width="62" height="54" rx="4"/>
    </g>
    <g fill="#6fdc8c">
      <rect x="36" y="52" width="14" height="4"/><rect x="54" y="52" width="14" height="4"/>
      <rect x="107" y="52" width="14" height="4"/>
      <rect x="36" y="116" width="14" height="4"/>
    </g>
    <text x="130" y="186" fill="#8fa3b8" font-size="12" text-anchor="middle" font-family="monospace">every level helps the WHOLE fleet</text>`),

  danger: SVG(`
    <rect x="0" y="0" width="260" height="200" fill="#0b1520"/>
    <circle cx="66" cy="56" r="40" fill="#5a6a7a" opacity=".28"/>
    <text x="66" y="112" fill="#8fa3b8" font-size="12" text-anchor="middle" font-family="monospace">SQUALL</text>
    <path d="M150 34 q22 -12 44 0 q-14 18 -44 0 Z" fill="#46705e" opacity=".55"/>
    <text x="194" y="68" fill="#8fa3b8" font-size="12" text-anchor="middle" font-family="monospace">REEF</text>
    <circle cx="60" cy="150" r="9" fill="#e8dcc2" opacity=".9"/>
    <g stroke="#e8dcc2" stroke-width="2"><path d="M60 136 L60 130 M60 164 L60 170 M46 150 L40 150 M74 150 L80 150"/></g>
    <text x="60" y="188" fill="#8fa3b8" font-size="12" text-anchor="middle" font-family="monospace">MINE</text>
    <rect x="128" y="132" width="110" height="26" rx="13" fill="#ef4b42" opacity=".22" stroke="#ef4b42" stroke-dasharray="5 4"/>
    <text x="183" y="188" fill="#8fa3b8" font-size="12" text-anchor="middle" font-family="monospace">SKY RAID &mdash; MOVE</text>`),
};


/**
 * The briefing. Six pages, in the order a new hand actually needs them: what
 * the game is, then how to move, then how to shoot, then how to win, then the
 * captain, then what will kill you.
 *
 * It is worth the words. The game has a wind model, a capture layer, a shared
 * purse and a command role, and before this the entire explanation was a list
 * of key bindings in the corner — which tells you which button does what and
 * nothing at all about why you would press it.
 */
const BRIEFING = [
  {
    t: 'THE ACTION',
    art: 'map',
    p: [
      `Two fleets, one strait, fifteen minutes. Eight <b>Holds</b> — fortified islands —
       are strung across it, and the two in the middle are the <b>Gates</b>.`,
      `Hold more of them than the enemy and their <b>Colours</b> bleed away at the top of
       the screen. Bleed them to nothing, or simply be ahead when the bell goes, and you win.`,
      `Every side has exactly one <b>Captain</b>, who spends the fleet's shared purse.
       Everyone else sails and fights. You can swap at any time from the roster on <b>Tab</b>.`,
    ],
  },
  {
    t: 'SAILING HER',
    art: 'polar',
    p: [
      `She is a sailing ship, so the <b>wind decides your speed</b>. The gauge at the
       bottom of the screen is a top-down picture of it: the blue arrow is where the wind
       is coming from, the pale arrow is your bow, and the number is how fast she will go
       on this heading.`,
      `The red wedge is the <b>no-go zone</b>. Point into it and she stalls — that is
       being <b>in irons</b>. Bear away thirty degrees and she picks up at once. Across the
       wind is fastest.`,
      `<b>W</b> and <b>S</b> set how much canvas is out. More sail is faster and turns
       worse; furled reloads the guns quicker. <b>SPACE</b> puts out the oars to claw out
       of trouble.`,
    ],
    keys: [['A / D', 'helm to port / starboard'], ['W / S', 'more sail / less sail'], ['SPACE', 'sweeps (oars)']],
  },
  {
    t: 'THE GUNS',
    art: 'arcs',
    p: [
      `Your guns are down both <b>sides</b> of the ship, not on the bow. You cannot shoot
       at what you are pointing at — you shoot at what is <b>abeam</b>. Turn side-on to
       your target and fire.`,
      `<b>Put the cursor on an enemy</b> and the guns lock on to her: the game works out
       the lead and the range for you, and a bracket appears. <b>Left click</b> fires
       whichever broadside bears. If neither does, the screen tells you which way to put
       the helm.`,
      `The two arcs drawn on the water are your batteries. <b>Green means loaded.</b>
       <b>1 2 3</b> switch shot: round for hulls, chain for rigging, grape for crew.`,
      `You have <b>twelve hands</b> and four stations, shown bottom-left. More on the
       <b>guns</b> reloads faster, more on <b>sail</b> goes faster, <b>repair</b> patches
       her as you sail, <b>watch</b> sees further. <b>Z X C V</b> are the four standard
       watches — beat to quarters, make all sail, damage control, sharp lookout.`,
    ],
    keys: [['LEFT CLICK', 'fire the broadside that bears'], ['Q / E', 'fire port / starboard by hand'],
           ['1 2 3', 'round · chain · grape'], ['Z X C V', 'set the watch'],
           ['R', 'lay a mine astern']],
  },
  {
    t: 'TAKING A HOLD',
    art: 'hold',
    p: [
      `Each Hold has a <b>shore battery</b> that shoots at you. You cannot capture a Hold
       while its battery is firing — <b>silence it first</b>, then sit inside the ring
       until the bar fills.`,
      `More friendly ships in the ring is faster. An enemy ship in the ring stops it dead:
       that is <b>CONTESTED</b>.`,
      `Your own Holds resupply you. Sail near one to refill powder and repair. Batteries
       that have been silenced grow back, and your captain can rebuild one instantly.`,
    ],
  },
  {
    t: 'THE CAPTAIN',
    art: 'purse',
    p: [
      `One hand each side has the deck. They see the <b>Admiralty</b> panel, they spend
       the fleet's doubloons, and their choices apply to <b>everyone</b> — faster ships,
       tougher hulls, stronger shore batteries.`,
      `Every upgrade can be <b>sold back</b> at 60% with a right click, so nothing is
       ever a dead end. Captains also place <b>orders</b>: sky raids, rally signals, sea
       mines, smoke, dockyard repairs.`,
      `If you are not the captain, <b>talk to them</b>. Hold <b>Y</b> for one-key
       requests, <b>T</b> to mark the map, <b>Enter</b> to type. A captain who does not
       know what the fleet needs spends badly.`,
    ],
    keys: [['TAB', 'roster — take or hand over command'], ['Y <em>hold</em>', 'tell the captain what you need'],
           ['T <em>hold</em>', 'signal the map'], ['ENTER', 'talk to your fleet']],
  },
  {
    t: 'WHAT WILL SINK YOU',
    art: 'danger',
    p: [
      `<b>Squalls</b> darken the sea, shove you sideways and blind you. <b>Reefs</b> open
       her up, and the faster you are going the worse it is — shorten sail in shoal water.
       <b>Mines</b> are nearly invisible until you are on them.`,
      `<b>Sky raids</b> paint a line on the water four seconds before the bombs fall. Move,
       and they miss.`,
      `When you go down you pick a new hull and come back. You keep your score. The team
       behind on Holds returns faster, so a bad patch is never the end of it.`,
    ],
  },
];

export class HUD {
  constructor(scene, canvas) {
    this.scene = scene;
    this.c = canvas;
    this.x = canvas.getContext('2d');
    this.mini = $('minimap');
    this.mctx = this.mini.getContext('2d');

    this.w = 1; this.h = 1; this.dpr = 1;
    this.you = null; this.world = null; this.rules = null;
    this.snap = null;
    this.floaters = [];
    this.scoreboard = false;
    this.signalWheel = false;
    this.pendingOrder = null;
    this.pickedHull = null;
    // Shown once, to whoever has not seen it. After that it is behind H, so it
    // stops competing with the killfeed for the right-hand column.
    this.helpHidden = false;
    try {
      if (localStorage.getItem('aac_seen_help')) this.helpHidden = true;
      else localStorage.setItem('aac_seen_help', '1');
    } catch {}
    this.toastT = 0;
    this.objT = 0;
    this.feedSig = '';
    this.built = false;

    // --- combat feedback ---------------------------------------------------
    this.bannerText = ''; this.bannerCol = '#ffd76a'; this.bannerT = 0;
    this.hitMarkT = 0;              // the tick that says a shot of yours landed
    this.dmgArcs = [];              // which way the last hits came from
    this.bearWarnT = 0; this.bearWarnSide = 0;
    this.lastRl = { L: 0, R: 0 };
    this.onReady = () => {};
    this.onBilge = () => {};

    // --- the coach ---------------------------------------------------------
    // One short lesson at the moment it becomes true, once ever. A veteran
    // never sees any of it; somebody on their first match gets taught the game
    // by playing it rather than by reading a wall of keys.
    this.tip = null; this.tipT = 0;
    this.tipsSeen = new Set();
    try { (JSON.parse(localStorage.getItem('aac_tips') || '[]') || []).forEach(t => this.tipsSeen.add(t)); } catch {}

    this.buildBriefing();
    this.helpAuto = this.helpHidden ? 0 : performance.now() + 26000;
    if (this.helpHidden) $('helpcard').classList.add('hide');

    this.onBuy = () => {}; this.onSell = () => {}; this.onOrderAtHold = () => {};
    this.onSay = () => {}; this.onCommand = () => {}; this.onSide = () => {};
    this.onHail = () => {};

    // --- fleet talk --------------------------------------------------------
    this.chatOpen = false;
    this.chatWheel = false;
    this.chatSig = '';
    this.chatLines = [];
    const box = $('chatinput');
    box.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { this.sendChat(); }
      else if (e.key === 'Escape') { this.closeChat(); }
    });
    box.addEventListener('blur', () => { if (this.chatOpen) this.closeChat(); });

    $('sb-command').addEventListener('click', () => {
      this.onCommand(this.snap?.me?.isCaptain ? 'standdown' : 'claim');
    });
    $('sb-side').addEventListener('click', () => this.onSide());

    addEventListener('contextmenu', e => { if (e.target.closest('#admiralty')) e.preventDefault(); });
  }

  /**
   * Where the interface panels actually are, in canvas pixels.
   *
   * The edge markers live on the canvas and the panels are DOM on top of it,
   * so a marker for an enemy off the right-hand side used to slide neatly in
   * behind the killfeed and vanish. Rather than guess at fixed insets, ask the
   * panels where they are and walk the markers clear of them.
   */
  obstacles() {
    const now = performance.now();
    if (this.obsAt && now - this.obsAt < 400) return this.obs;
    this.obsAt = now;
    const d = this.dpr;
    this.obs = [];
    for (const id of ['feed', 'admiralty', 'fleetkit', 'status', 'mapwrap', 'helpcard', 'topbar', 'chatwrap']) {
      const n = $(id);
      if (!n || n.hidden || n.classList.contains('hide')) continue;
      const r = n.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      this.obs.push([r.left * d, r.top * d, r.right * d, r.bottom * d]);
    }
    return this.obs;
  }
  blocked(x, y) {
    for (const [l, t, r, b] of this.obstacles()) if (x > l && x < r && y > t && y < b) return true;
    return false;
  }

  resize(w, h, dpr) {
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    this.w = w; this.h = h; this.dpr = dpr;
    this.c.width = Math.round(w * dpr); this.c.height = Math.round(h * dpr);
    this.c.style.width = w + 'px'; this.c.style.height = h + 'px';
    const mw = this.mini.clientWidth || 222, mh = this.mini.clientHeight || 134;
    this.mini.width = Math.round(mw * dpr); this.mini.height = Math.round(mh * dpr);
  }

  setConn(state) {
    const n = $('conn');
    if (state === 'open') { n.classList.remove('show'); return; }
    n.textContent = state === 'connecting' ? 'RAISING THE SIGNAL…' : 'SIGNAL LOST — TRYING AGAIN';
    n.classList.add('show');
  }

  setWorld(world, rules, you, room) {
    this.world = world; this.rules = rules; this.you = you; this.room = room;
    this.buildStatic();
  }

  toast(msg) {
    const n = $('toast');
    n.textContent = msg;
    n.classList.add('show');
    this.toastT = performance.now() + 2100;
  }
  objective(msg) {
    const n = $('objective');
    n.textContent = msg;
    n.classList.add('show');
    this.objT = performance.now() + 4200;
  }
  floater(x, y, text, col) {
    this.floaters.push({ x, y, text, col, t: 0 });
    if (this.floaters.length > 40) this.floaters.shift();
  }
  openChat() {
    if (this.chatOpen) return;
    this.chatOpen = true;
    $('chatbox').hidden = false;
    const i = $('chatinput');
    i.value = '';
    i.focus();
  }
  closeChat() {
    if (!this.chatOpen) return;
    this.chatOpen = false;
    $('chatbox').hidden = true;
    $('chatinput').blur();
  }
  sendChat() {
    const i = $('chatinput');
    const t = i.value.trim().slice(0, CHAT.maxLen);
    if (t) this.onSay({ t });
    this.closeChat();
  }
  /** Close the quick-talk wheel and return the phrase under the cursor. */
  closeChatWheel(mx, my) {
    this.chatWheel = false;
    const i = this.wheelPick(mx, my, QUICKCHAT.length);
    return i < 0 ? null : QUICKCHAT[i].id;
  }

  // -------------------------------------------------------------------------
  //  The briefing
  // -------------------------------------------------------------------------
  buildBriefing() {
    this.bfPage = 0;
    const dots = $('bf-dots');
    dots.innerHTML = '';
    BRIEFING.forEach((_, i) => {
      const d = el('i');
      d.addEventListener('click', () => this.showBriefing(i));
      dots.appendChild(d);
    });
    $('bf-prev').addEventListener('click', () => this.showBriefing(this.bfPage - 1));
    $('bf-next').addEventListener('click', () => {
      if (this.bfPage >= BRIEFING.length - 1) this.closeBriefing();
      else this.showBriefing(this.bfPage + 1);
    });
    $('bf-x').addEventListener('click', () => this.closeBriefing());
    $('bf-tips').addEventListener('click', (e) => {
      this.resetCoach();
      e.target.textContent = 'THE TIPS WILL COME BACK';
      e.target.disabled = true;
    });
    $('orders-btn').addEventListener('click', () => this.toggleBriefing());

    // Somebody who has never played gets the briefing; everybody else does not.
    let seen = false;
    try { seen = !!localStorage.getItem('aac_briefed'); } catch {}
    if (!seen) this.openBriefing();
  }

  openBriefing() {
    this.briefing = true;
    const tips = $('bf-tips');
    tips.textContent = 'SHOW THE TIPS AGAIN';
    tips.disabled = false;
    $('briefing').hidden = false;
    this.showBriefing(this.bfPage || 0);
  }
  closeBriefing() {
    this.briefing = false;
    $('briefing').hidden = true;
    try { localStorage.setItem('aac_briefed', '1'); } catch {}
  }
  toggleBriefing() { this.briefing ? this.closeBriefing() : this.openBriefing(); }

  showBriefing(i) {
    const n = BRIEFING.length;
    this.bfPage = clamp(i, 0, n - 1);
    const pg = BRIEFING[this.bfPage];
    const body = $('bf-body');
    body.innerHTML =
      `<div class="bf-page">
       <div class="bf-art">${BRIEF_ART[pg.art] || ''}</div>
       <div class="bf-text">
         <h2>${pg.t}</h2>
         ${pg.p.map(t => `<p>${t}</p>`).join('')}
         ${pg.keys ? `<dl>${pg.keys.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>` : ''}
       </div></div>`;
    [...$('bf-dots').children].forEach((d, j) => d.classList.toggle('on', j === this.bfPage));
    $('bf-count').textContent = `${this.bfPage + 1} / ${n}`;
    $('bf-prev').disabled = this.bfPage === 0;
    $('bf-next').textContent = this.bfPage === n - 1 ? 'TAKE THE DECK ▸' : 'NEXT ▸';
  }

  // -------------------------------------------------------------------------
  //  Feedback: loud, short, and never more than one thing at a time
  // -------------------------------------------------------------------------
  /** A line across the middle of the screen for something that just happened. */
  banner(text, col = '#ffd76a') {
    this.bannerText = text; this.bannerCol = col;
    this.bannerT = performance.now() + 2400;
  }
  /** A shot of yours landed. */
  hitMark() { this.hitMarkT = performance.now() + 240; }
  /** You asked a battery to fire while it was still being run out. */
  stillLoading(secs, side) {
    this.loadWarn = { s: Math.max(0.1, secs), side, t: performance.now() + 1100 };
  }
  /**
   * A shot of THEIRS landed. Remember which way it came from.
   *
   * A broadside is six or eight shot arriving together, so this fires in a
   * burst; drawn as a burst it painted the entire screen red and told you
   * nothing. Hits from roughly the same bearing refresh one arc instead of
   * stacking, and only the three most recent bearings are ever drawn.
   */
  tookHit(x, y, v) {
    const p = this.snap?.me;
    if (!p) return;
    const a = Math.atan2(y - p.y, x - p.x);
    const now = performance.now();
    const same = this.dmgArcs.find(q => Math.abs(angleDiff(q.a, a)) < 0.55);
    if (same) { same.t = now + 1400; same.v += v || 0; return; }
    this.dmgArcs.push({ a, t: now + 1400, v: v || 0 });
    if (this.dmgArcs.length > 3) this.dmgArcs.shift();
  }
  /**
   * The guns will not bear. Saying so is not enough — a new player reads "she
   * will not bear" and has no idea what to do about it. Work out which way the
   * helm has to go and say THAT.
   */
  wontBear(off) {
    // We want the target on the beam, ninety degrees off the bow. If she is
    // finer than that, turn away from her; if she is further aft, turn towards.
    const away = Math.abs(off) < Math.PI / 2;
    const toStarboard = off > 0 ? !away : away;
    this.bearWarnSide = toStarboard ? 1 : -1;
    this.bearWarnT = performance.now() + 1500;
    this.coach('bear', 'YOUR GUNS ARE ON THE SIDES',
               'Broadsides fire abeam, never over the bow. Turn until she is off your side.');
  }

  /** One lesson, at the moment it becomes true, once ever. */
  coach(id, title, body) {
    if (this.tipsSeen.has(id) || this.briefing) return;
    this.tipsSeen.add(id);
    try { localStorage.setItem('aac_tips', JSON.stringify([...this.tipsSeen])); } catch {}
    this.tip = { title, body };
    this.tipT = performance.now() + 8600;
    $('coach-t').textContent = title;
    $('coach-b').innerHTML = body;
    $('coach').hidden = false;
    $('coach').classList.add('show');
    document.body.classList.add('coaching');
  }
  hideCoach() {
    this.tip = null; this.tipT = 0;
    $('coach').classList.remove('show');
    $('coach').hidden = true;
    document.body.classList.remove('coaching');
  }
  /** Wipe the record, so the lessons come back. Offered on the briefing. */
  resetCoach() { this.tipsSeen.clear(); this.taughtAll = false; try { localStorage.removeItem('aac_tips'); } catch {} }

  /**
   * Watch the state of play and teach from it. Each of these is a thing that
   * confuses somebody on their first match, spotted the moment it happens.
   */
  coachTick(S, me, ctx) {
    if (!S || !me || this.taughtAll) return;
    const p = ctx.pred;
    if (me.isCaptain) {
      this.coach('captain', 'YOU HAVE THE DECK',
                 'The <b>Admiralty</b> on your left is the fleet\'s shared purse. What you buy helps every ship on your side. Right-click sells a level back.');
    }
    if (!p || !me.alive) return;

    const off = angleOffWind(p.heading, S.wind.d);
    if (off < NO_GO) {
      this.coach('irons', 'IN IRONS — SHE HAS STALLED',
                 'You are pointing into the wind. Put the helm over with <b>A</b> or <b>D</b> until the gauge leaves the red, or hold <b>SPACE</b> for the oars.');
    }
    if (me.ammo <= 4) {
      this.coach('ammo', 'POWDER RUNNING OUT',
                 'Sail within reach of one of <b>your own</b> Holds and she refills herself — and repairs while she is there.');
    }
    if (me.hull / Math.max(1, me.hullMax) < 0.3) {
      this.coach('hurt', 'SHE IS BADLY HURT',
                 'Press <b>C</b> for damage control and break off toward a friendly Hold. A sinking costs your fleet colours.');
    }
    const hot = S.holds.find(h => h.x && dist(p.x, p.y, this.holdPos(h.id).x, this.holdPos(h.id).y) < HOLD.captureR * 1.4);
    if (hot) {
      this.coach('contest', 'CONTESTED — DRIVE THEM OFF',
                 'An enemy ship inside the ring stops the capture dead. Sink her or push her out, then the bar moves again.');
    }
    const silenced = S.holds.find(h => h.hp <= 0 && h.o !== S.team
      && dist(p.x, p.y, this.holdPos(h.id).x, this.holdPos(h.id).y) < HOLD.captureR * 1.6);
    if (silenced) {
      this.coach('land', 'HER BATTERY IS SILENT — TAKE IT',
                 'Stay inside the ring and the bar fills. More friendly ships in the ring is faster.');
    }
    if (me.inSupply) {
      this.coach('supply', 'IN SUPPLY',
                 'You are in reach of a friendly Hold. She is repairing herself and the magazine is filling. Stay a moment.');
    }
    if ((S.salvage || []).some(g => dist(p.x, p.y, g.x, g.y) < 700)) {
      this.coach('salvage', 'PRIZE MONEY IN THE WATER',
                 'Those floating crates are the salvage off a wreck. Sail over one and the coin goes straight to your captain\'s purse.');
    }
    if (S.convoy) {
      this.coach('bullion', 'THE BULLION RUN',
                 'A treasure barque is crossing the strait. Whichever fleet sinks her takes the prize — and it costs the other side colours.');
    }

    // Everything has been taught. Stop looking.
    if (['captain', 'irons', 'ammo', 'hurt', 'contest', 'land', 'supply', 'salvage', 'bullion', 'bear']
        .every(k => this.tipsSeen.has(k))) this.taughtAll = true;
  }
  holdPos(id) { return this.world.holds.find(h => h.id === id) || { x: 0, y: 0 }; }

  toggleHelp() {
    this.helpHidden = !this.helpHidden;
    $('helpcard').classList.toggle('hide', this.helpHidden);
    this.helpAuto = 0;
  }

  // -------------------------------------------------------------------------
  //  One-time DOM
  // -------------------------------------------------------------------------
  buildStatic() {
    if (this.built) return;
    this.built = true;

    // hold pips, in map order west -> east
    const pips = $('pips');
    pips.innerHTML = '';
    this.pipEls = {};
    const order = [...this.world.holds].sort((a, b) => a.x - b.x || a.y - b.y);
    for (const h of order) {
      const p = el('div', 'pip' + (h.lane === 'gate' ? ' gate' : ''));
      p.title = h.name;
      pips.appendChild(p);
      this.pipEls[h.id] = p;
    }

    // crew stations
    const st = $('stations');
    st.innerHTML = '';
    this.stEls = {};
    // Twelve hands across four stations is one of the deepest things in the
    // game and the panel said nothing about what any of them were for.
    const WHAT = {
      gun:  'GUN CREWS — more hands, faster reload. Seven is a fighting ship.',
      sail: 'SAILORS — more hands, more speed out of the same wind.',
      rep:  'CARPENTERS — they patch hull and rigging while you sail.',
      look: 'LOOKOUTS — they see further, and spot mines and ghosts sooner.',
    };
    for (const [key, label] of [['gun', 'GUNS'], ['sail', 'SAIL'], ['rep', 'REPAIR'], ['look', 'WATCH']]) {
      const n = el('div', 'st', `<b>0</b><span>${label}</span>`);
      n.title = `${WHAT[key]}\nClick to add a hand, right-click to take one away.\nZ X C V set the four standard watches.`;
      n.addEventListener('click', () => this.shiftHand(key, +1));
      n.addEventListener('contextmenu', (e) => { e.preventDefault(); this.shiftHand(key, -1); });
      st.appendChild(n);
      this.stEls[key] = n;
    }

    // upgrades
    const up = $('upgrades');
    up.innerHTML = '';
    this.upgEls = {};
    for (const id of UPGRADE_IDS) {
      const u = UPGRADES[id];
      const n = el('div', 'upg', `
        <div class="lv"><i></i><i></i><i></i></div>
        <div class="ic">${UPG_ICON[id] || '◆'}</div>
        <div class="nm">${u.name.replace(' ', '<br>')}</div>
        <div class="cost">${u.cost[0]}</div>`);
      n.title = `${u.name} — ${u.per}\n${u.blurb}`;
      n.addEventListener('click', () => this.onBuy(id));
      n.addEventListener('contextmenu', (e) => { e.preventDefault(); this.onSell(id); });
      up.appendChild(n);
      this.upgEls[id] = n;
    }

    // orders
    const od = $('orders');
    od.innerHTML = '';
    this.ordEls = {};
    ORDER_IDS.forEach((id) => {
      const o = ORDERS[id];
      const n = el('div', 'ord', `<div class="ic">${ORD_ICON[id] || '★'}</div><div class="c">${o.cost}</div><div class="sweep"></div>`);
      n.title = `${o.name} — ${o.cost} doubloons\n${o.blurb}`;
      n.addEventListener('click', () => this.armOrder(id));
      od.appendChild(n);
      this.ordEls[id] = n;
    });

    // the read-only version of the Admiralty that every hand can see
    const fk = $('fk-upgrades');
    fk.innerHTML = '';
    this.fkEls = {};
    for (const id of UPGRADE_IDS) {
      const u = UPGRADES[id];
      const n = el('div', 'fku', `
        <div class="lv"><i></i><i></i><i></i></div>
        <div class="ic">${UPG_ICON[id] || '◆'}</div>
        <div class="nm">${u.name.replace(' ', '<br>')}</div>`);
      n.title = `${u.name} — ${u.per}\n${u.blurb}`;
      fk.appendChild(n);
      this.fkEls[id] = n;
    }

    // The hull you come back in. It used to be four unlabelled cards of prose
    // on a screen you only ever see for eight seconds: no numbers, no sense of
    // what you were choosing between, and no statement that clicking one was
    // even the point of the screen.
    const hp = $('hullpick');
    hp.innerHTML = '';
    this.hullEls = {};
    const span = (k, lo, hi) => clamp((k - lo) / (hi - lo), 0, 1);
    for (const id of HULL_IDS) {
      const H = HULLS[id];
      const stats = [
        ['SPEED', span(H.speed, 0.80, 1.34)],
        ['TURN',  span(H.turn, 0.75, 1.38)],
        ['HULL',  span(H.hull, 100, 245)],
        ['GUNS',  span(H.guns, 2, 8)],
      ];
      const n = el('div', 'hp', `
        <div class="hp-top"><b>${H.name}</b><span>${H.role}</span></div>
        <div class="hp-stats">${stats.map(([k, v]) =>
          `<div class="hs"><label>${k}</label><div class="track"><i style="width:${Math.round(v * 100)}%"></i></div></div>`).join('')}</div>
        <em>${H.blurb}</em>
        <div class="hp-pick">SELECTED</div>`);
      n.addEventListener('click', () => { this.pickedHull = id; this.syncHullPick(); });
      hp.appendChild(n);
      this.hullEls[id] = n;
    }
  }

  shiftHand(to, dir) {
    const me = this.snap?.me;
    if (!me) return;
    // Take from the largest other station so a click always does something.
    const a = me.alloc;
    if (dir > 0) {
      const from = ['gun', 'sail', 'rep', 'look'].filter(k => k !== to).sort((p, q) => a[q] - a[p])[0];
      if (a[from] > 0) this.sendShift(from, to);
    } else {
      const other = ['gun', 'sail', 'rep', 'look'].filter(k => k !== to).sort((p, q) => a[p] - a[q])[0];
      if (a[to] > 0) this.sendShift(to, other);
    }
  }
  sendShift(from, to) { this.shiftQueue = { from, to }; }
  /** Hand the queued crew move to the next input packet, once. */
  takeShift() { const s = this.shiftQueue; this.shiftQueue = null; return s; }

  armOrder(id) {
    const s = this.snap;
    if (!s || !s.me?.isCaptain) return;
    const o = ORDERS[id];
    if (s.us.doubloons < o.cost) return this.toast('not enough coin');
    if (s.us.orderCd[id] > 0) return this.toast('not ready');
    if (o.target === 'hold') {
      // The worst-off friendly battery, and a SILENCED one counts most of all:
      // that is the hold the enemy is about to walk onto.
      const hurt = s.holds.filter(h => h.o === s.team && h.hp < h.hm)
                          .sort((a, b) => a.hp / a.hm - b.hp / b.hm)[0];
      if (!hurt) return this.toast('every battery is already sound');
      this.onOrderAtHold(id, hurt.id);
      const name = this.world.holds.find(h => h.id === hurt.id)?.name || 'the hold';
      this.toast(`shore works at ${name.toLowerCase()}`);
      return;
    }
    this.pendingOrder = this.pendingOrder === id ? null : id;
    this.syncOrders(s);
  }
  selectOrderByIndex(i) { const id = ORDER_IDS[i]; if (id) this.armOrder(id); }

  /**
   * Which segment of a wheel of `n` the cursor is over, or -1 for the dead zone
   * in the middle. Shared by the drawing and the picking so the thing you see
   * highlighted is always the thing you get.
   */
  wheelPick(mx, my, n) {
    const cx = this.c.width / 2, cy = this.c.height / 2;
    if (Math.hypot(mx - cx, my - cy) < WHEEL_DEAD * this.dpr) return -1;
    let i = Math.round(((Math.atan2(my - cy, mx - cx) + Math.PI / 2) / TAU) * n);
    return ((i % n) + n) % n;
  }

  closeSignalWheel(mx, my) {
    this.signalWheel = false;
    const i = this.wheelPick(mx, my, PINGS.length);
    return i < 0 ? null : PINGS[i].id;
  }

  // -------------------------------------------------------------------------
  //  DOM, refreshed once per snapshot rather than once per frame
  // -------------------------------------------------------------------------
  onSnap(s) {
    this.snap = s;
    this.syncTop(s);
    this.syncStatus(s);
    this.syncAdmiralty(s);
    this.syncFleetKit(s);
    this.syncChat(s);
    this.syncFeed(s);
    this.syncDead(s);
    this.syncEnd(s);
    if (this.scoreboard) this.syncBoard(s);
  }

  syncTop(s) {
    const left = s.team === 'scarlet' ? s.us : s.them;
    const right = s.team === 'scarlet' ? s.them : s.us;
    const sc = s.team === 'scarlet' ? s.us : s.them;
    const co = s.team === 'cobalt' ? s.us : s.them;

    for (const [id, t] of [['scarlet', sc], ['cobalt', co]]) {
      const box = $('fleet-' + id);
      const k = clamp(t.colours / COLOURS.start, 0, 1);
      box.querySelector('.fill').style.transform = `scaleX(${k})`;
      box.querySelector('.val').textContent = Math.round(t.colours);
      box.classList.toggle('laststand', !!t.lastStand);
    }

    const remain = Math.max(0, (s.matchEnd || s.phaseEnd) - s.now);
    const clock = $('clock');
    clock.textContent = fmtTime(s.phase === PHASE.MUSTER ? s.phaseEnd - s.now : remain);
    clock.classList.toggle('urgent', s.phase === PHASE.SUDDEN || remain < 60000);

    const label = { LOBBY: 'LOBBY', MUSTER: 'MUSTER', BATTLE: 'ENGAGED', SUDDEN: 'THE LAST BELL', OVER: 'ACTION OVER' };
    $('phase').textContent = label[s.phase] || s.phase;
    this.syncMuster(s);

    for (const h of s.holds) {
      const p = this.pipEls[h.id];
      if (!p) continue;
      p.className = 'pip' + (this.world.holds.find(w => w.id === h.id)?.lane === 'gate' ? ' gate' : '')
                  + (h.o ? ' ' + h.o : '') + (h.x ? ' hot' : '');
    }

    // The Bullion Run is on a timetable. Anyone can plan around a timetable,
    // and planning around it is the whole point of having one.
    const bull = $('bullion');
    if (s.convoy) {
      bull.textContent = `⚜ BULLION IN THE STRAIT — ${s.convoy.hp}%`;
      bull.className = 'here';
    } else if (s.convoyIn > 0 && s.convoyIn < 75_000) {
      bull.textContent = `⚜ BULLION RUN IN ${fmtTime(s.convoyIn)}`;
      bull.className = s.convoyIn < 20_000 ? 'soon' : '';
    } else {
      bull.textContent = '';
      bull.className = '';
    }
  }

  /**
   * The opening twenty seconds decide a lot, and a new player has no idea what
   * they are for. Say it plainly, and say something different to the captain.
   */
  syncMuster(s) {
    const hint = $('musterhint');
    const on = s.phase === PHASE.MUSTER;
    hint.hidden = !on;
    if (!on) { this.musterSig = ''; return; }
    const cap = !!s.me?.isCaptain;
    const sig = cap ? 'cap' : 'crew';
    if (sig === this.musterSig) return;
    this.musterSig = sig;
    hint.innerHTML = cap
      ? `<b>YOU HAVE THE DECK</b><span>Spend the opening purse in the <em>Admiralty</em> on your left —
         click to buy, right-click to sell a level back at 60%. Your guns are housed until the signal,
         so use the time to place your fleet. Orders are <em>shift + 1–5</em>, then click the water.
         <em>H</em> for the full list of controls.</span>`
      : `<b>MAKE SAIL</b><span>The guns stay housed until the signal. Pick a lane and get there.
         Your captain is spending the fleet's purse — hold <em>Y</em> to tell them what you need,
         <em>T</em> to signal, <em>Enter</em> to talk. Take the two middle <em>Gates</em> and their
         colours bleed. <em>H</em> for the full list of controls.</span>`;
  }

  syncStatus(s) {
    const me = s.me;
    if (!me) return;
    const H = me.hullId === 'flagship' ? { name: 'FLAGSHIP' } : (HULLS[me.hullId] || { name: '—' });
    $('hullname').textContent = H.name;
    $('rolebadge').textContent = me.isCaptain ? 'IN COMMAND' : '';

    const bar = (id, v, max, lowAt = 0.3) => {
      const k = clamp(max > 0 ? v / max : 0, 0, 1);
      const n = $('m-' + id);
      n.style.width = (k * 100) + '%';
      n.parentElement.classList.toggle('low', k < lowAt);
      const lbl = $('v-' + id);
      if (lbl) lbl.textContent = Math.round(v);
    };
    bar('hull', me.hull, me.hullMax);
    bar('sail', me.sail, me.sailMax);
    bar('crew', me.crew, me.crewMax, 0.4);
    bar('stam', me.stamina, 100, 0.25);

    for (const k of ['gun', 'sail', 'rep', 'look']) {
      const n = this.stEls[k];
      n.querySelector('b').textContent = me.alloc[k];
      n.classList.toggle('hi', me.alloc[k] >= 5);
    }

    // How much canvas is out. This was an eight-pixel word tucked under the
    // gauge, which is a strange place to hide the single setting that decides
    // how fast the ship goes.
    const rungs = $('sailladder').children;
    for (let i = 0; i < rungs.length; i++) {
      rungs[i].classList.toggle('on', i <= me.sails);
      rungs[i].classList.toggle('at', i === me.sails);
    }

    // Guns loaded or not, per side, so you never have to guess.
    for (const [side, rl] of [['L', me.rlL], ['R', me.rlR]]) {
      const box = $('gb-' + side);
      const ready = rl <= 0.001;
      box.classList.toggle('ready', ready);
      box.querySelector('i').style.width = ((1 - clamp(rl, 0, 1)) * 100) + '%';
      // A single click when a battery comes back: the cue to fire again.
      if (ready && this.lastRl[side] > 0.001) this.onReady();
      this.lastRl[side] = rl;
    }
    if (me.hull / Math.max(1, me.hullMax) < 0.22) this.onBilge();

    const shot = SHOT[me.shot] || SHOT.round;
    $('lo-shot').textContent = shot.name;
    const ammo = $('lo-ammo');
    ammo.textContent = `⚫ ${me.ammo}`;
    ammo.classList.toggle('empty', me.ammo < 6);
    const mines = $('lo-mines');
    mines.textContent = `✹ ${me.mines}`;
    mines.classList.toggle('empty', me.mines === 0);
  }

  syncAdmiralty(s) {
    const isCap = !!s.me?.isCaptain;
    $('admiralty').hidden = !isCap;
    if (!isCap) return;

    $('purse').textContent = Math.round(s.us.doubloons);
    $('income').textContent = `+${(s.us.income || 0).toFixed(1)}/s`;

    for (const id of UPGRADE_IDS) {
      const u = UPGRADES[id], n = this.upgEls[id];
      const lvl = s.us.upg[id] | 0;
      const max = lvl >= UPG_MAX;
      const cost = max ? null : u.cost[lvl];
      n.classList.toggle('max', max);
      n.classList.toggle('poor', !max && s.us.doubloons < cost);
      n.querySelector('.cost').textContent = max ? 'MAX' : cost;
      const pips = n.querySelectorAll('.lv i');
      pips.forEach((p, i) => p.classList.toggle('on', i < lvl));
      n.title = `${u.name} ${'I'.repeat(Math.max(1, lvl))} — ${u.per}\n${u.blurb}`
              + (lvl ? `\nright-click to sell a level back for ${Math.round(u.cost[lvl - 1] * 0.6)}` : '');
    }
    this.syncOrders(s);

    // Surface what needs the captain's attention: silenced batteries first,
    // because that is the one thing only the captain can put right, then
    // whatever the crew is asking for.
    const req = $('requests');
    const down = s.holds.filter(h => h.o === s.team && h.hp <= 0)
                        .map(h => this.world.holds.find(w => w.id === h.id)?.name)
                        .filter(Boolean);
    const want = (s.pings || []).filter(p => p.k === 'help' || p.k === 'supply');
    const sig = down.join(',') + '|' + want.map(p => p.k + p.n).join('|');
    if (sig !== this.reqSig) {
      this.reqSig = sig;
      req.innerHTML = '';
      for (const name of down.slice(0, 2)) {
        req.appendChild(el('div', 'req urgent', `${esc(name)} — BATTERY DOWN, SHORE WORKS`));
      }
      for (const p of want.slice(0, 3)) {
        const label = PINGS.find(x => x.id === p.k)?.name || p.k;
        req.appendChild(el('div', 'req', `${esc(p.n)} — ${label}`));
      }
    }
  }

  /** What a hand who is not in command still needs to know about the purse. */
  syncFleetKit(s) {
    const isCap = !!s.me?.isCaptain;
    $('fleetkit').hidden = isCap;
    $('helpcard').classList.toggle('crew', !isCap);
    if (isCap) return;

    $('fk-purse').textContent = Math.round(s.us.doubloons);
    $('fk-income').textContent = `+${(s.us.income || 0).toFixed(1)}/s`;
    const capRow = (s.board || []).find(r => r.id === s.us.captain);
    $('fk-captain').textContent = capRow ? capRow.n : 'NOBODY';

    for (const id of UPGRADE_IDS) {
      const n = this.fkEls[id];
      if (!n) continue;
      const lvl = s.us.upg[id] | 0;
      n.classList.toggle('on', lvl > 0);
      n.querySelectorAll('.lv i').forEach((p, i) => p.classList.toggle('on', i < lvl));
    }
  }

  /** The fleet's own channel. Nothing here ever reaches the other side. */
  syncChat(s) {
    const lines = s.chat || [];
    const sig = lines.map(l => l.at + l.id).join('|');
    if (sig === this.chatSig) return;
    const latest = lines[lines.length - 1];
    if (this.chatSig && latest && latest.id !== this.you) this.onHail(!!latest.cap);
    this.chatSig = sig;
    const log = $('chatlog');
    log.innerHTML = '';
    for (const l of lines) {
      const cls = ['', l.cap ? 'cap' : '', l.id === this.you ? 'mine' : ''].join(' ').trim();
      const tag = l.cap ? '⚜ ' : '';
      log.appendChild(el('li', cls, `<span class="who">${tag}${esc(l.by)}</span> ${esc(l.t)}`));
    }
  }

  syncOrders(s) {
    for (const id of ORDER_IDS) {
      const o = ORDERS[id], n = this.ordEls[id];
      const cd = s.us.orderCd[id] || 0;
      const busy = cd > 0 || s.us.globalCd > 0;
      n.classList.toggle('cool', cd > 0);
      n.classList.toggle('poor', s.us.doubloons < o.cost);
      n.classList.toggle('armed', this.pendingOrder === id);
      n.querySelector('.sweep').style.transform = `scaleY(${clamp(cd / o.cd, 0, 1)})`;
    }
  }

  syncFeed(s) {
    const sig = s.log.map(l => l.at + l.t).join('|');
    if (sig === this.feedSig) return;
    this.feedSig = sig;
    const f = $('feed');
    f.innerHTML = '';
    for (const l of s.log) {
      const li = el('li', (l.team || '') + ' k-' + l.k, esc(l.t));
      f.appendChild(li);
    }
    // Loud events also get a line across the middle of the screen.
    const latest = s.log[s.log.length - 1];
    if (latest && latest.at > (this.lastObj || 0) && ['phase', 'convoy', 'capture'].includes(latest.k)) {
      this.lastObj = latest.at;
      this.objective(latest.t);
    }
  }

  syncDead(s) {
    const me = s.me;
    const dead = me && !me.alive && s.phase !== PHASE.OVER && s.phase !== PHASE.MUSTER;
    $('deadpanel').hidden = !dead;
    if (!dead) return;
    const last = s.log.slice().reverse().find(l => l.t.includes(me.name));
    $('deadwhy').textContent = last ? last.t : 'the sea has her now';
    const cap = !!me.isCaptain;
    $('hullpick').style.display = cap ? 'none' : '';
    $('deadpanel').querySelector('.dead-step').style.display = cap ? 'none' : '';
    if (!this.pickedHull) this.pickedHull = me.nextHullId || me.hullId;
    this.syncHullPick();
    const secs = (Math.max(0, me.respawnAt - s.now) / 1000).toFixed(1);
    const picked = HULLS[this.pickedHull]?.name || 'YOUR SHIP';
    $('respawn').innerHTML = cap
      ? `THE FLAGSHIP IS REFITTING — BACK IN <b>${secs}</b><small>Your fleet still sees what you buy. Keep spending.</small>`
      : `BACK IN THE <b>${picked}</b> IN <b>${secs}</b><small>Change your mind any time before the clock runs out.</small>`;
  }
  syncHullPick() {
    for (const id of HULL_IDS) this.hullEls[id].classList.toggle('on', this.pickedHull === id);
  }

  syncEnd(s) {
    const over = s.phase === PHASE.OVER;
    $('endscreen').hidden = !over;
    if (!over) return;
    const v = $('end-victor');
    v.textContent = s.winner ? TEAM[s.winner].name : 'NO DECISION';
    v.className = s.winner || '';
    $('end-reason').textContent = s.winReason || '';
    $('end-next').innerHTML = `THE FLEETS REFIT — <b>${Math.ceil(Math.max(0, s.phaseEnd - s.now) / 1000)}</b>`;
    if (this.endSig !== s.winReason) {
      this.endSig = s.winReason;
      const b = $('end-board');
      b.innerHTML = '';
      for (const t of ['scarlet', 'cobalt']) b.appendChild(this.boardColumn(s, t, true));
    }
  }

  boardColumn(s, team, compact = false) {
    const col = el('div', 'sb-col');
    const rows = s.board.filter(r => r.t === team);
    const T = TEAM[team];
    col.appendChild(el('h3', null, `${T.name} &nbsp;·&nbsp; ${s.holds.filter(h => h.o === team).length}/8 HOLDS`));
    col.appendChild(el('div', 'sb-row head',
      '<div>CAPTAIN</div><div class="num">SUNK</div><div class="num">HELPED</div>'
      + '<div class="num">LOST</div><div class="num">TAKEN</div><div class="num">DAMAGE</div>'));
    for (const r of rows) {
      const tags = [];
      if (r.r === 'captain') tags.push('<span class="tag cap">CMD</span>');
      if (r.b) tags.push('<span class="tag">AI</span>');
      else if (r.wc && r.r !== 'captain') tags.push('<span class="tag want">WANTS CMD</span>');
      if (r.cn === 0) tags.push('<span class="tag">GONE</span>');
      const row = el('div', 'sb-row' + (r.id === this.you ? ' me' : '') + (r.a ? '' : ' down'),
        `<div class="n">${esc(r.n)}${tags.join('')}</div>
         <div class="num">${r.k}</div><div class="num">${r.as | 0}</div><div class="num">${r.d}</div>
         <div class="num">${r.c}</div><div class="num">${r.dm}</div>`);
      col.appendChild(row);
    }
    return col;
  }

  syncBoard(s) {
    if (this.boardSig === s.tick >> 3) return;
    this.boardSig = s.tick >> 3;
    for (const t of ['scarlet', 'cobalt']) {
      const host = $('sb-' + t);
      host.replaceWith(Object.assign(this.boardColumn(s, t), { id: 'sb-' + t }));
    }

    const r = s.roster || { scarlet: { humans: 0, hulls: 0 }, cobalt: { humans: 0, hulls: 0 } };
    const total = r.scarlet.humans + r.cobalt.humans;
    $('sb-count').innerHTML =
      `ROOM <b>${esc(this.room || 'main')}</b> &nbsp;·&nbsp; <b>${total}</b> of ${MAX_PER_TEAM * 2} aboard`
      + ` &nbsp;·&nbsp; SCARLET <b>${r.scarlet.humans}</b> of ${r.scarlet.hulls} hulls`
      + ` &nbsp;·&nbsp; COBALT <b>${r.cobalt.humans}</b> of ${r.cobalt.hulls}`;

    const isCap = !!s.me?.isCaptain;
    const mates = (s.board || []).filter(x => x.t === s.team && !x.b && x.id !== this.you).length;
    const cmd = $('sb-command');
    // textContent here would wipe the line under the label that says what the
    // button actually does, which is the whole reason it is there.
    cmd.innerHTML = isCap
      ? 'HAND OVER COMMAND<em>let another hand spend the purse</em>'
      : 'TAKE COMMAND<em>spend the fleet\'s purse yourself</em>';
    // You may only stand down if there is somebody to stand down to.
    cmd.disabled = isCap && mates === 0;
    cmd.title = isCap
      ? (mates ? 'pass the deck to another hand in your fleet' : 'there is nobody to hand her to')
      : 'take the deck — immediately if an AI holds it, otherwise when your captain stands down';

    const side = $('sb-side');
    const them = r[s.team === 'scarlet' ? 'cobalt' : 'scarlet'];
    side.disabled = them.humans >= MAX_PER_TEAM || them.humans > r[s.team].humans - 1;
    side.title = side.disabled ? 'that would leave the fleets uneven' : 'sail for the other fleet';
  }

  // -------------------------------------------------------------------------
  //  Canvas overlay — anything that has to sit at a world position
  // -------------------------------------------------------------------------
  drawBoot() {
    const x = this.x, W = this.c.width, H = this.c.height;
    x.clearRect(0, 0, W, H);
    x.fillStyle = '#05090e'; x.fillRect(0, 0, W, H);
    x.textAlign = 'center';
    x.fillStyle = '#c9a227';
    x.font = `${26 * this.dpr}px "Iowan Old Style", Palatino, Georgia, serif`;
    x.fillText('AYE AYE, CAPTAIN', W / 2, H / 2 - 12 * this.dpr);
    x.fillStyle = '#6b8098';
    x.font = `${12 * this.dpr}px ui-sans-serif, system-ui, sans-serif`;
    x.fillText('making the fleet ready…', W / 2, H / 2 + 16 * this.dpr);
  }

  draw(S, me, ctx) {
    const x = this.x, d = this.dpr;
    this.curX = ctx.mx; this.curY = ctx.my;
    x.clearRect(0, 0, this.c.width, this.c.height);
    if (!S) return;

    const now = performance.now();
    if (this.toastT && now > this.toastT) { $('toast').classList.remove('show'); this.toastT = 0; }
    if (this.objT && now > this.objT) { $('objective').classList.remove('show'); this.objT = 0; }
    if (this.helpAuto && now > this.helpAuto) { this.helpAuto = 0; this.helpHidden = true; $('helpcard').classList.add('hide'); }
    if (this.tipT && now > this.tipT) this.hideCoach();
    $('scoreboard').hidden = !this.scoreboard;
    if (this.scoreboard) this.syncBoard(S);

    // Anything the captain has armed follows the cursor.
    document.body.style.cursor = this.pendingOrder ? 'cell' : 'crosshair';

    // The gauge goes down FIRST. It is a slow reference you glance at; a target
    // bracket is the thing you are acting on, so when they land in the same
    // pixels the bracket has to be the one on top.
    if (!ctx.tactical) this.drawGauge(S, me, ctx, d);
    this.drawHolds(S, d);
    this.drawShips(S, ctx, d);
    this.drawPings(S, d);
    this.drawFloaters(ctx.dt, d);
    if (ctx.pred && me?.alive && !ctx.tactical) this.drawReticle(S, me, ctx, d);
    this.drawEdgeMarkers(S, ctx, d);
    this.drawDamageArcs(d);
    this.drawHitMark(d);
    this.drawBanner(d);
    this.coachTick(S, me, ctx);
    if (this.signalWheel) this.drawWheel(d, PINGS.map(p => ({ label: p.name, col: p.col })), 'release to signal');
    if (this.chatWheel) this.drawWheel(d, QUICKCHAT.map(q => ({
      label: q.text.replace(/^CAPTAIN — /, ''),
      col: q.to === 'cap' ? '#f0d27a' : '#8fd7ff',
    })), 'release to say it');
    this.drawMinimap(S, ctx);
  }

  // --- holds ---------------------------------------------------------------
  drawHolds(S, d) {
    const x = this.x;
    for (const h of this.world.holds) {
      const st = S.holds.find(q => q.id === h.id);
      if (!st) continue;
      const [sx, sy] = this.scene.toScreen(h.x, h.y);
      if (sx < -220 * d || sy < -220 * d || sx > this.c.width + 220 * d || sy > this.c.height + 220 * d) continue;

      const col = st.o ? TEAM[st.o].css : '#b4ae9c';
      const y0 = sy - (h.r * this.scene.cam.zoom) - 26 * d;

      // The water this battery can reach. A dashed line says "boundary"; the
      // soft red disc that used to be here said "smudge on the lens".
      if (st.hp > 0 && st.o && st.o !== S.team) {
        x.save();
        x.setLineDash([9 * d, 9 * d]);
        x.lineDashOffset = -(performance.now() / 44) % (18 * d);
        x.strokeStyle = 'rgba(255,90,70,.34)';
        x.lineWidth = 1.6 * d;
        x.beginPath(); x.arc(sx, sy, st.fr * this.scene.cam.zoom, 0, TAU); x.stroke();
        x.restore();
      }

      x.textAlign = 'center';
      x.font = `${10.5 * d}px ui-sans-serif, system-ui, sans-serif`;
      x.lineWidth = 3 * d;
      x.strokeStyle = 'rgba(0,0,0,.75)';
      x.strokeText(h.name, sx, y0);
      x.fillStyle = col;
      x.fillText(h.name, sx, y0);

      // battery condition
      const bw = 86 * d, bh = 4 * d, bx = sx - bw / 2, by = y0 + 6 * d;
      x.fillStyle = 'rgba(0,0,0,.6)';
      x.fillRect(bx, by, bw, bh);
      if (st.hp > 0) {
        const k = clamp(st.hp / Math.max(1, st.hm), 0, 1);
        x.fillStyle = st.o ? col : '#b4ae9c';
        x.fillRect(bx, by, bw * k, bh);
      } else {
        x.fillStyle = 'rgba(255,120,90,.85)';
        x.font = `${8.5 * d}px ui-monospace, monospace`;
        x.fillText('BATTERY SILENCED', sx, by + 12 * d);
      }

      // capture progress
      if (st.c > 0.01 && st.ct) {
        const cy = by + (st.hp > 0 ? 8 * d : 18 * d);
        x.fillStyle = 'rgba(0,0,0,.6)';
        x.fillRect(bx, cy, bw, bh);
        x.fillStyle = TEAM[st.ct].css;
        x.fillRect(bx, cy, bw * clamp(st.c, 0, 1), bh);
      }
      if (st.x) {
        x.fillStyle = '#ffc44d';
        x.font = `${9 * d}px ui-monospace, monospace`;
        x.fillText('CONTESTED', sx, by + (st.hp > 0 ? 20 : 30) * d);
      }
    }
  }

  // --- ships ---------------------------------------------------------------
  /**
   * Every hull on screen, labelled.
   *
   * An enemy used to get a thin health bar and a hollow diamond under her keel
   * — at the zoom this game plays at, that is nothing. A ship you can shoot at
   * now reads as a TARGET: a bracket, a name, a range, and a warning when her
   * guns come round on to you.
   */
  drawShips(S, ctx, d) {
    const x = this.x;
    const zoom = this.scene.cam.zoom;
    const p = ctx.pred;
    const lockId = ctx.lock?.id;
    for (const s of S.ships) {
      const [sx, sy] = this.scene.toScreen(s.x, s.y);
      if (sx < -80 * d || sy < -80 * d || sx > this.c.width + 80 * d || sy > this.c.height + 80 * d) continue;
      const mine = s.t === S.team;
      const isMe = s.id === this.you;
      const len = (this.rules?.HULLS[s.h]?.len || 64);
      const half = Math.max(20 * d, len * zoom * 0.62);
      const top = sy - half - 14 * d;

      // --- condition: hull over rig ---------------------------------------
      const bw = clamp(len * zoom * 1.5, 40 * d, 104 * d), bh = 4.2 * d;
      const bx = sx - bw / 2;
      x.fillStyle = 'rgba(0,0,0,.66)';
      x.fillRect(bx - d, top - d, bw + 2 * d, bh * 2 + 3 * d);
      x.fillStyle = s.hp > 55 ? (mine ? '#6fdc8c' : '#ff6a52') : s.hp > 25 ? '#ffc44d' : '#ff4a3a';
      x.fillRect(bx, top, bw * (s.hp / 100), bh);
      x.fillStyle = 'rgba(232,220,194,.62)';
      x.fillRect(bx, top + bh + d, bw * (s.sp / 100), bh * 0.7);

      if (isMe) {
        // A ring under your own keel. In smoke, in a squall, in a crowd, this
        // is the mark that says HERE YOU ARE.
        x.save();
        x.strokeStyle = 'rgba(255,255,255,.34)';
        x.lineWidth = 1.6 * d;
        x.beginPath(); x.arc(sx, sy, half + 6 * d, 0, TAU); x.stroke();
        x.translate(sx, sy); x.rotate(s.a);
        x.beginPath();
        x.moveTo(half + 14 * d, 0); x.lineTo(half + 5 * d, -4.5 * d); x.lineTo(half + 5 * d, 4.5 * d);
        x.closePath();
        x.fillStyle = 'rgba(255,255,255,.62)'; x.fill();
        x.restore();
        continue;
      }

      // --- is she pointing her guns at us? ---------------------------------
      let threat = false;
      if (!mine && p) {
        const toMe = Math.atan2(p.y - s.y, p.x - s.x);
        const range = dist(s.x, s.y, p.x, p.y);
        threat = range < GUN.maxRange
          && (Math.abs(angleDiff(s.a - Math.PI / 2, toMe)) <= GUN.arc
              || Math.abs(angleDiff(s.a + Math.PI / 2, toMe)) <= GUN.arc);
      }

      // --- the marker ------------------------------------------------------
      if (!mine) {
        // A hostile bracket. Shape as well as colour, because scarlet against
        // cobalt is the one pair a colour-blind player cannot separate.
        const R = half + 8 * d;
        const lit = s.id === lockId;
        x.save();
        x.strokeStyle = threat ? 'rgba(255,90,70,.95)' : 'rgba(255,124,104,.62)';
        x.lineWidth = (threat ? 2.2 : 1.6) * d;
        if (!lit) {
          for (const [cx2, cy2] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
            const qx = sx + cx2 * R, qy = sy + cy2 * R, L = 7 * d;
            x.beginPath();
            x.moveTo(qx, qy - cy2 * L); x.lineTo(qx, qy); x.lineTo(qx - cx2 * L, qy);
            x.stroke();
          }
        }
        x.restore();
        if (threat) {
          x.save();
          x.textAlign = 'center';
          x.font = `700 ${10 * d}px ui-sans-serif, system-ui, sans-serif`;
          x.globalAlpha = 0.6 + 0.4 * Math.sin(performance.now() / 150);
          x.lineWidth = 3 * d; x.strokeStyle = 'rgba(0,0,0,.85)';
          x.strokeText('GUNS ON YOU', sx, sy + R + 14 * d);
          x.fillStyle = '#ff6a52';
          x.fillText('GUNS ON YOU', sx, sy + R + 14 * d);
          x.restore();
        }
      } else {
        // A friend: a solid chevron under the keel, pointing her way.
        x.save();
        x.translate(sx, sy + half + 9 * d);
        x.beginPath();
        x.moveTo(0, -5 * d); x.lineTo(5 * d, 3.4 * d); x.lineTo(-5 * d, 3.4 * d);
        x.closePath();
        x.fillStyle = TEAM[s.t].css; x.globalAlpha = 0.92; x.fill();
        x.restore();
      }

      // --- name, and the range to her --------------------------------------
      if (zoom > 0.30) {
        x.textAlign = 'center';
        x.font = `${10 * d}px ui-sans-serif, system-ui, sans-serif`;
        x.lineWidth = 3.4 * d; x.strokeStyle = 'rgba(0,0,0,.85)';
        const tag = s.r === 'captain' ? '⚜ ' : '';
        const rng = (!mine && p) ? `  ${Math.round(dist(s.x, s.y, p.x, p.y))}m` : '';
        const txt = tag + s.n + rng;
        x.strokeText(txt, sx, top - 6 * d);
        x.fillStyle = mine ? TEAM[s.t].css : '#ffb0a8';
        x.fillText(txt, sx, top - 6 * d);
      }
    }
  }

  // --- signals -------------------------------------------------------------
  drawPings(S, d) {
    const x = this.x, now = S.now;
    for (const p of S.pings || []) {
      const [sx, sy] = this.scene.toScreen(p.x, p.y);
      const life = clamp((p.u - now) / 6500, 0, 1);
      const def = PINGS.find(q => q.id === p.k) || PINGS[0];
      const pulse = (1 - (life * 3 % 1));
      x.save();
      x.globalAlpha = life;
      x.strokeStyle = def.col; x.lineWidth = 2 * d;
      x.beginPath(); x.arc(sx, sy, (12 + pulse * 22) * d, 0, TAU); x.stroke();
      x.beginPath(); x.arc(sx, sy, 7 * d, 0, TAU); x.fillStyle = def.col; x.fill();
      x.textAlign = 'center';
      x.font = `${9.5 * d}px ui-sans-serif, system-ui, sans-serif`;
      x.lineWidth = 3 * d; x.strokeStyle = 'rgba(0,0,0,.8)';
      x.strokeText(`${def.name} — ${p.n}`, sx, sy - 20 * d);
      x.fillStyle = def.col;
      x.fillText(`${def.name} — ${p.n}`, sx, sy - 20 * d);
      x.restore();
    }
  }

  drawFloaters(dt, d) {
    const x = this.x;
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i];
      f.t += dt;
      if (f.t > 1.5) { this.floaters.splice(i, 1); continue; }
      const [sx, sy] = this.scene.toScreen(f.x, f.y);
      x.save();
      x.globalAlpha = clamp(1.6 - f.t, 0, 1);
      x.textAlign = 'center';
      x.font = `700 ${13 * d}px ui-monospace, monospace`;
      x.lineWidth = 3.5 * d; x.strokeStyle = 'rgba(0,0,0,.85)';
      const y = sy - f.t * 46 * d;
      x.strokeText(f.text, sx, y); x.fillStyle = f.col; x.fillText(f.text, sx, y);
      x.restore();
    }
  }

  /** One radial picker, used for both the signal wheel and fleet talk. */
  drawWheel(d, items, hint) {
    const x = this.x, cx = this.c.width / 2, cy = this.c.height / 2;
    const n = items.length;
    const R = (n > 6 ? 168 : 124) * d;
    const seg = (n > 6 ? 40 : 30) * d;
    const hot = this.wheelPick(this.curX ?? cx, this.curY ?? cy, n);
    x.save();
    x.fillStyle = 'rgba(4,8,13,.72)';
    x.beginPath(); x.arc(cx, cy, R + seg + 8 * d, 0, TAU); x.fill();
    items.forEach((p, i) => {
      const a = (i / n) * TAU - Math.PI / 2;
      const px = cx + Math.cos(a) * R, py = cy + Math.sin(a) * R;
      x.beginPath(); x.arc(px, py, seg, 0, TAU);
      x.fillStyle = i === hot ? 'rgba(34,48,64,.96)' : 'rgba(12,20,30,.92)'; x.fill();
      x.strokeStyle = p.col; x.lineWidth = (i === hot ? 3 : 2) * d; x.stroke();
      x.textAlign = 'center';
      x.fillStyle = p.col;
      x.font = `${(n > 6 ? 8.5 : 9.5) * d}px ui-sans-serif, system-ui, sans-serif`;
      const words = wrapWords(p.label, n > 6 ? 12 : 9);
      words.forEach((w, j) => x.fillText(w, px, py + (j - (words.length - 1) / 2) * 10 * d + 3 * d));
    });
    x.fillStyle = '#6b8098';
    x.textAlign = 'center';
    x.font = `${10 * d}px ui-sans-serif, system-ui, sans-serif`;
    x.fillText(hint, cx, cy + 4 * d);
    x.restore();
  }

  // --- gunnery solution ----------------------------------------------------
  /**
   * Everything about laying the guns, in one picture.
   *
   * The old version drew the firing arcs at five percent alpha — invisible in
   * practice — and a dashed line to wherever the cursor happened to be. So the
   * two questions a gunner actually has, "can I shoot at that" and "are my guns
   * loaded", were both unanswerable from the screen.
   */
  drawReticle(S, me, ctx, d) {
    const x = this.x, p = ctx.pred, zoom = this.scene.cam.zoom;
    const [sx, sy] = this.scene.toScreen(p.x, p.y);
    const lock = ctx.lock;
    const r = GUN.maxRange * zoom;

    const arcs = [
      { beam: p.heading - Math.PI / 2, arc: GUN.arc, rl: me.rlL },
      { beam: p.heading + Math.PI / 2, arc: GUN.arc, rl: me.rlR },
    ];
    if (me.chase) arcs.push({ beam: p.heading, arc: GUN.chaseArc, rl: me.rlC });

    // --- the batteries, painted on the water --------------------------------
    for (const a of arcs) {
      const ready = a.rl <= 0.001;
      const bears = Math.abs(angleDiff(a.beam, ctx.aimA)) <= a.arc;
      x.save();
      x.beginPath();
      x.moveTo(sx, sy);
      x.arc(sx, sy, r, a.beam - a.arc, a.beam + a.arc);
      x.closePath();
      x.fillStyle = !ready ? 'rgba(150,170,190,.05)'
                  : bears  ? 'rgba(120,220,150,.20)'
                           : 'rgba(120,220,150,.085)';
      x.fill();
      // A dark line under the bright one. Without it the arc edge disappears
      // against sand, foam and smoke — which is most of where a fight happens.
      x.strokeStyle = 'rgba(0,0,0,.42)';
      x.lineWidth = (ready && bears ? 4.4 : 3.0) * d;
      x.stroke();
      x.strokeStyle = !ready ? 'rgba(180,200,220,.34)'
                    : bears  ? 'rgba(150,255,185,.92)'
                             : 'rgba(130,235,160,.50)';
      x.lineWidth = (ready && bears ? 2.4 : 1.4) * d;
      x.stroke();
      // Reloading: the wedge fills back out from the ship as she runs the guns
      // out again, so the reload is a THING ON THE WATER, not a number.
      if (!ready) {
        x.beginPath();
        x.moveTo(sx, sy);
        x.arc(sx, sy, r * (1 - clamp(a.rl, 0, 1)), a.beam - a.arc, a.beam + a.arc);
        x.closePath();
        x.fillStyle = 'rgba(255,196,77,.085)';
        x.fill();
      }
      x.restore();
    }

    // --- minimum range: you cannot depress the guns this close --------------
    x.save();
    x.beginPath(); x.arc(sx, sy, GUN.minRange * zoom, 0, TAU);
    x.strokeStyle = 'rgba(255,106,82,.18)'; x.setLineDash([4 * d, 6 * d]); x.lineWidth = 1 * d; x.stroke();
    x.restore();

    // --- the solution -------------------------------------------------------
    const bears = arcs.some(a => a.rl <= 0.001 && Math.abs(angleDiff(a.beam, ctx.aimA)) <= a.arc);
    const anyBears = arcs.some(a => Math.abs(angleDiff(a.beam, ctx.aimA)) <= a.arc);
    const ax = sx + Math.cos(ctx.aimA) * ctx.aimD * zoom;
    const ay = sy + Math.sin(ctx.aimA) * ctx.aimD * zoom;
    const good = bears ? 'rgba(130,240,165,' : anyBears ? 'rgba(255,196,77,' : 'rgba(255,106,82,';

    x.save();
    x.setLineDash([7 * d, 6 * d]);
    x.strokeStyle = good + '.55)';
    x.lineWidth = 1.5 * d;
    x.beginPath(); x.moveTo(sx, sy); x.lineTo(ax, ay); x.stroke();
    x.setLineDash([]);

    // Dispersion: long along the line of fire, narrow across it. This is where
    // the volley will actually go.
    const along = ctx.aimD * GUN.spreadAlong * zoom;
    const across = GUN.spreadAcross * zoom;
    x.translate(ax, ay); x.rotate(ctx.aimA);
    x.beginPath();
    x.ellipse(0, 0, Math.max(7 * d, along), Math.max(5 * d, across), 0, 0, TAU);
    x.strokeStyle = good + '.85)';
    x.lineWidth = 1.6 * d;
    x.stroke();
    x.fillStyle = good + '.12)';
    x.fill();
    x.restore();

    // --- the lock -----------------------------------------------------------
    if (lock) {
      const [tx, ty] = this.scene.toScreen(lock.x, lock.y);
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 180);
      const R = (lock.kind === 'fort' ? 40 : 26) * d;
      x.save();
      x.strokeStyle = bears ? 'rgba(130,240,165,.95)' : 'rgba(255,196,77,.92)';
      x.lineWidth = 2.4 * d;
      // four corner ticks: unmistakably "this is the thing I am shooting at"
      for (const [cx2, cy2] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const bx = tx + cx2 * R, by = ty + cy2 * R, L = 9 * d;
        x.beginPath();
        x.moveTo(bx, by - cy2 * L); x.lineTo(bx, by); x.lineTo(bx - cx2 * L, by);
        x.stroke();
      }
      x.globalAlpha = 0.35 + pulse * 0.3;
      x.beginPath(); x.arc(tx, ty, R * 1.28, 0, TAU); x.lineWidth = 1.2 * d; x.stroke();
      x.restore();

      // The lead mark: where she will be when the shot gets there.
      if (lock.kind === 'ship') {
        x.save();
        x.strokeStyle = 'rgba(255,255,255,.55)';
        x.setLineDash([3 * d, 4 * d]); x.lineWidth = 1.2 * d;
        x.beginPath(); x.moveTo(tx, ty); x.lineTo(ax, ay); x.stroke();
        x.restore();
      }

      x.textAlign = 'center';
      x.font = `700 ${12 * d}px ui-monospace, monospace`;
      x.lineWidth = 3.5 * d; x.strokeStyle = 'rgba(0,0,0,.85)';
      const head = `${lock.name}  ·  ${lock.range}m`;
      x.strokeText(head, tx, ty - R - 10 * d);
      x.fillStyle = (bears && lock.range <= GUN.maxRange && lock.range >= GUN.minRange) ? '#8ff0a5' : '#ffc44d';
      x.fillText(head, tx, ty - R - 10 * d);

      // Range comes before bearing: a locked target you cannot reach should
      // never be told "FIRE", because the guns will simply throw shot at the
      // sea two hundred metres short of her.
      const far  = lock.range > GUN.maxRange;
      const near = lock.range < GUN.minRange;
      const state = far  ? 'OUT OF RANGE — CLOSE HER'
                  : near ? 'TOO CLOSE — SHEER OFF'
                  : bears ? 'BROADSIDE BEARS — FIRE'
                  : anyBears ? 'RELOADING'
                  : 'TURN — SHE WILL NOT BEAR';
      x.font = `${10.5 * d}px ui-sans-serif, system-ui, sans-serif`;
      x.strokeText(state, tx, ty + R + 18 * d);
      x.fillStyle = (far || near) ? '#ffc44d' : bears ? '#8ff0a5' : anyBears ? '#ffc44d' : '#ff8a7a';
      x.fillText(state, tx, ty + R + 18 * d);
    } else {
      x.textAlign = 'center';
      x.font = `${10.5 * d}px ui-monospace, monospace`;
      x.fillStyle = good + '.95)';
      x.fillText(`${Math.round(ctx.aimD)}m`, ax, ay - Math.max(12 * d, across + 11 * d));
    }

    // --- the guns are not ready yet ----------------------------------------
    if (this.loadWarn && this.loadWarn.t > performance.now()) {
      const k = clamp((this.loadWarn.t - performance.now()) / 1100, 0, 1);
      x.save();
      x.globalAlpha = Math.min(1, k * 2.4);
      x.textAlign = 'center';
      x.font = `700 ${12 * d}px ui-monospace, monospace`;
      x.lineWidth = 4 * d; x.strokeStyle = 'rgba(0,0,0,.85)';
      const msg = `RUNNING OUT THE ${this.loadWarn.side === 'L' ? 'PORT' : 'STARBOARD'} GUNS — ${this.loadWarn.s.toFixed(1)}s`;
      x.strokeText(msg, sx, sy - 74 * d);
      x.fillStyle = '#ffc44d';
      x.fillText(msg, sx, sy - 74 * d);
      x.restore();
    }

    // --- which way to put the helm -----------------------------------------
    // Told at the moment the player asked for something the ship could not do.
    if (this.bearWarnT > performance.now()) {
      const k = clamp((this.bearWarnT - performance.now()) / 1500, 0, 1);
      const side = this.bearWarnSide;
      x.save();
      x.globalAlpha = Math.min(1, k * 2.2);
      x.translate(sx, sy);
      x.rotate(p.heading + side * Math.PI / 2);
      // an arrow curling the way the helm should go
      x.strokeStyle = '#ffc44d'; x.lineWidth = 3 * d;
      x.beginPath(); x.arc(0, 0, 64 * d, -0.8, 0.8); x.stroke();
      x.translate(Math.cos(0.8) * 64 * d, Math.sin(0.8) * 64 * d);
      x.rotate(0.8 + Math.PI / 2);
      x.beginPath(); x.moveTo(0, -9 * d); x.lineTo(9 * d, 5 * d); x.lineTo(-9 * d, 5 * d);
      x.closePath(); x.fillStyle = '#ffc44d'; x.fill();
      x.restore();

      x.save();
      x.globalAlpha = Math.min(1, k * 2.2);
      x.textAlign = 'center';
      x.font = `700 ${13 * d}px ui-sans-serif, system-ui, sans-serif`;
      x.lineWidth = 4 * d; x.strokeStyle = 'rgba(0,0,0,.85)';
      const msg = side > 0 ? 'HELM TO STARBOARD  ·  D' : 'HELM TO PORT  ·  A';
      x.strokeText(msg, sx, sy + 96 * d);
      x.fillStyle = '#ffc44d';
      x.fillText(msg, sx, sy + 96 * d);
      x.restore();
    }
  }

  // --- point of sail -------------------------------------------------------
  drawGauge(S, me, ctx, d) {
    const p = ctx.pred;
    if (!p) return;
    const x = this.x;
    const R = 54 * d;
    const cx = this.c.width / 2, cy = this.c.height - R - 24 * d;
    const wind = ctx.wind;
    // Heading-up: the wind moves around you, which is how it feels at the helm.
    const rel = (worldA) => wrapAngle(worldA - p.heading) - Math.PI / 2;
    const windFrom = wind.dir + Math.PI;

    x.save();
    x.translate(cx, cy);

    x.beginPath(); x.arc(0, 0, R + 9 * d, 0, TAU);
    x.fillStyle = 'rgba(6,11,17,.74)'; x.fill();
    x.strokeStyle = 'rgba(201,162,39,.30)'; x.lineWidth = 1 * d; x.stroke();

    // the polar curve: how fast she will go on every heading
    x.beginPath();
    for (let i = 0; i <= 72; i++) {
      const off = (i / 72) * Math.PI;
      const f = polarFactor(off);
      for (const sgn of [1]) {
        const a = rel(windFrom + off * sgn);
        const r = R * (0.22 + f * 0.74);
        const px = Math.cos(a) * r, py = Math.sin(a) * r;
        i ? x.lineTo(px, py) : x.moveTo(px, py);
      }
    }
    for (let i = 72; i >= 0; i--) {
      const off = (i / 72) * Math.PI;
      const a = rel(windFrom - off);
      const r = R * (0.22 + polarFactor(off) * 0.74);
      x.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    x.closePath();
    x.fillStyle = 'rgba(110,190,220,.14)';
    x.fill();
    x.strokeStyle = 'rgba(140,210,240,.45)'; x.lineWidth = 1.2 * d; x.stroke();

    // the no-go zone
    x.beginPath();
    x.moveTo(0, 0);
    x.arc(0, 0, R, rel(windFrom - NO_GO), rel(windFrom + NO_GO));
    x.closePath();
    x.fillStyle = 'rgba(255,74,58,.16)';
    x.fill();
    x.strokeStyle = 'rgba(255,74,58,.5)'; x.lineWidth = 1 * d; x.stroke();

    // where the wind is coming from
    const wa = rel(windFrom);
    x.save();
    x.rotate(wa);
    x.beginPath();
    x.moveTo(R + 6 * d, 0); x.lineTo(R - 7 * d, -5 * d); x.lineTo(R - 7 * d, 5 * d);
    x.closePath();
    x.fillStyle = '#8fd7ff'; x.fill();
    x.restore();

    // our own bow
    x.beginPath();
    x.moveTo(0, -R * 0.92); x.lineTo(5 * d, -R * 0.72); x.lineTo(-5 * d, -R * 0.72);
    x.closePath();
    x.fillStyle = '#e9e0ca'; x.fill();

    // how well she is sailing right now
    const off = angleOffWind(p.heading, wind.dir);
    const eff = polarFactor(off);
    const label = off < NO_GO ? 'IN IRONS' : off < 0.95 ? 'CLOSE HAULED' : off < 1.35 ? 'CLOSE REACH'
                : off < 1.85 ? 'BEAM REACH' : off < 2.6 ? 'BROAD REACH' : 'RUNNING';
    x.textAlign = 'center';
    x.font = `700 ${15 * d}px ui-monospace, monospace`;
    x.fillStyle = eff < 0.3 ? '#ff6a52' : eff < 0.75 ? '#ffc44d' : '#6fdc8c';
    x.fillText(`${Math.round(eff * 100)}%`, 0, 4 * d);
    x.font = `${8 * d}px ui-sans-serif, system-ui, sans-serif`;
    x.fillStyle = '#9fb0c0';
    x.fillText(label, 0, 16 * d);
    // How much canvas is out, under the gauge, big enough to read at a glance
    // while a shot is in the air. It used to be eight pixels of grey.
    x.font = `700 ${13 * d}px ui-monospace, monospace`;
    x.fillStyle = p.sails === 0 ? '#ff8a7a' : p.sails === 3 ? '#ffc44d' : '#e9e0ca';
    x.lineWidth = 3.5 * d; x.strokeStyle = 'rgba(0,0,0,.8)';
    x.strokeText(SAIL_NAMES[p.sails], 0, R + 18 * d);
    x.fillText(SAIL_NAMES[p.sails], 0, R + 18 * d);
    // four rungs, so the setting is a position and not just a word
    for (let i = 0; i < 4; i++) {
      const bw = 13 * d, bx = (i - 1.5) * (bw + 4 * d) - bw / 2;
      x.fillStyle = i <= p.sails ? (i === p.sails ? '#ffc44d' : 'rgba(255,196,77,.45)') : 'rgba(150,170,190,.22)';
      x.fillRect(bx, R + 24 * d, bw, 4 * d);
    }
    x.restore();

    // an incoming wind shift is worth shouting about
    if (S.wind.sh) {
      x.textAlign = 'center';
      x.font = `${10 * d}px ui-sans-serif, system-ui, sans-serif`;
      x.fillStyle = '#ffc44d';
      x.fillText('THE WIND IS SHIFTING', cx, cy - R - 18 * d);
    }
  }

  // --- off-screen markers --------------------------------------------------
  /**
   * What is happening just outside the view. The screen shows about two
   * thousand metres of sea and the guns reach a thousand, so a great deal of
   * what matters is off the edge of it — and the only things that used to be
   * marked were the bullion convoy and your own team's pings.
   */
  drawEdgeMarkers(S, ctx, d) {
    const x = this.x, W = this.c.width, H = this.c.height;
    const pad = 38 * d;
    const p = ctx.pred;
    const marks = [];

    if (S.convoy) marks.push({ x: S.convoy.x, y: S.convoy.y, col: '#ffd76a', label: 'BULLION' });
    for (const ping of S.pings || []) {
      const def = PINGS.find(q => q.id === ping.k);
      marks.push({ x: ping.x, y: ping.y, col: def?.col || '#ffffff', label: def?.name || '' });
    }
    for (const t of S.ships) {
      if (t.id === this.you) continue;
      if (t.t === S.team) {
        if (t.r !== 'captain') continue;
        marks.push({ x: t.x, y: t.y, col: TEAM[t.t].css, label: 'YOUR CAPTAIN', small: true });
      } else {
        marks.push({ x: t.x, y: t.y, col: '#ff6a52', label: '', enemy: true });
      }
    }
    for (const h of S.holds) {
      if (!h.x) continue;
      const w = this.world.holds.find(q => q.id === h.id);
      if (w) marks.push({ x: w.x, y: w.y, col: '#ffc44d', label: 'CONTESTED', small: true });
    }

    for (const m of marks) {
      const [sx, sy] = this.scene.toScreen(m.x, m.y);
      if (sx > pad && sy > pad && sx < W - pad && sy < H - pad) continue;
      const cx = W / 2, cy = H / 2;
      const a = Math.atan2(sy - cy, sx - cx);
      const rx = Math.abs(Math.cos(a)) > 1e-3 ? Math.abs((W / 2 - pad) / Math.cos(a)) : 1e9;
      const ry = Math.abs(Math.sin(a)) > 1e-3 ? Math.abs((H / 2 - pad) / Math.sin(a)) : 1e9;
      let r = Math.min(rx, ry);
      // Slide in along the same bearing until the marker is in clear water.
      let px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r;
      for (let step = 0; step < 14 && this.blocked(px, py); step++) {
        r -= 22 * d;
        if (r < 60 * d) break;
        px = cx + Math.cos(a) * r; py = cy + Math.sin(a) * r;
      }
      const size = m.enemy ? 10 : m.small ? 7 : 9;

      x.save();
      x.translate(px, py); x.rotate(a);
      x.beginPath();
      x.moveTo(size * d, 0); x.lineTo(-size * 0.7 * d, -size * 0.7 * d); x.lineTo(-size * 0.7 * d, size * 0.7 * d);
      x.closePath();
      x.fillStyle = m.col;
      x.globalAlpha = m.enemy ? 0.92 : 0.8;
      x.fill();
      if (m.enemy) { x.strokeStyle = 'rgba(0,0,0,.65)'; x.lineWidth = 1.2 * d; x.stroke(); }
      x.restore();

      // Distance matters more than a name for a ship you cannot see.
      const label = m.enemy
        ? (p ? `${Math.round(dist(m.x, m.y, p.x, p.y))}m` : '')
        : m.label;
      if (label) {
        const ly = py + (py > H * 0.5 ? -16 : 18) * d;
        // Keep the text inboard of the marker near the edges, so it does not
        // run out under whichever panel the marker just dodged.
        const lx = px < W * 0.22 ? px + 26 * d : px > W * 0.78 ? px - 26 * d : px;
        x.textAlign = 'center';
        x.font = `${8.5 * d}px ui-monospace, monospace`;
        x.lineWidth = 3 * d; x.strokeStyle = 'rgba(0,0,0,.8)';
        x.strokeText(label, lx, ly);
        x.fillStyle = m.col;
        x.fillText(label, lx, ly);
      }
    }
  }

  // --- what just happened to you -------------------------------------------
  /** A line across the middle for a prize taken, an empty magazine, a win. */
  drawBanner(d) {
    const left = this.bannerT - performance.now();
    if (left <= 0) return;
    const x = this.x;
    const k = clamp(left / 2400, 0, 1);
    const rise = (1 - Math.min(1, (2400 - left) / 240)) * 18 * d;
    x.save();
    x.globalAlpha = Math.min(1, k * 4);
    x.textAlign = 'center';
    const cy = this.c.height * 0.30 + rise;
    x.font = `700 ${23 * d}px "Iowan Old Style", Palatino, Georgia, serif`;
    x.lineWidth = 6 * d; x.strokeStyle = 'rgba(0,0,0,.85)';
    x.strokeText(this.bannerText, this.c.width / 2, cy);
    x.fillStyle = this.bannerCol;
    x.fillText(this.bannerText, this.c.width / 2, cy);
    x.restore();
  }

  /** A quick cross at the cursor the instant one of your shots connects. */
  drawHitMark(d) {
    const left = this.hitMarkT - performance.now();
    if (left <= 0) return;
    const x = this.x;
    const k = clamp(left / 240, 0, 1);
    const cx = this.curX ?? this.c.width / 2, cy = this.curY ?? this.c.height / 2;
    const R = (9 + (1 - k) * 7) * d;
    x.save();
    x.globalAlpha = k;
    x.strokeStyle = '#ffe9a8'; x.lineWidth = 2.6 * d; x.lineCap = 'round';
    for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      x.beginPath();
      x.moveTo(cx + dx * R * 0.45, cy + dy * R * 0.45);
      x.lineTo(cx + dx * R, cy + dy * R);
      x.stroke();
    }
    x.restore();
  }

  /**
   * Which way the shot that just hit you came from. Being hit by something you
   * never saw is the single most disorienting thing that can happen in a game
   * like this, and the screen said nothing about it at all.
   */
  drawDamageArcs(d) {
    const x = this.x, now = performance.now();
    const cx = this.c.width / 2, cy = this.c.height / 2;
    const R = Math.min(cx, cy) * 0.82;
    for (let i = this.dmgArcs.length - 1; i >= 0; i--) {
      const a = this.dmgArcs[i];
      if (a.t < now) { this.dmgArcs.splice(i, 1); continue; }
      const k = clamp((a.t - now) / 1400, 0, 1);
      x.save();
      x.globalAlpha = k * k * 0.46;
      x.translate(cx, cy);
      const grd = x.createRadialGradient(0, 0, R * 0.72, 0, 0, R * 1.08);
      grd.addColorStop(0, 'rgba(255,60,44,0)');
      grd.addColorStop(1, 'rgba(255,60,44,.90)');
      x.fillStyle = grd;
      x.beginPath();
      x.moveTo(0, 0);
      x.arc(0, 0, R * 1.08, a.a - 0.36, a.a + 0.36);
      x.closePath();
      x.fill();
      x.restore();
    }
  }

  // --- minimap -------------------------------------------------------------
  drawMinimap(S, ctx) {
    const c = this.mini, x = this.mctx;
    const W = c.width, H = c.height;
    const sx = W / this.world.w, sy = H / this.world.h;
    const P = (wx, wy) => [wx * sx, wy * sy];

    x.clearRect(0, 0, W, H);
    x.fillStyle = '#071019'; x.fillRect(0, 0, W, H);

    // territory wash
    for (const h of this.world.holds) {
      const st = S.holds.find(q => q.id === h.id);
      if (!st?.o) continue;
      const [hx, hy] = P(h.x, h.y);
      const g = x.createRadialGradient(hx, hy, 2, hx, hy, 1500 * sx);
      g.addColorStop(0, st.o === 'scarlet' ? 'rgba(239,75,66,.30)' : 'rgba(62,169,242,.30)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      x.fillStyle = g;
      x.beginPath(); x.arc(hx, hy, 1500 * sx, 0, TAU); x.fill();
    }

    // land
    x.fillStyle = '#1d2a22';
    for (const i of this.world.islands) {
      x.beginPath();
      x.moveTo(...P(i.pts[0], i.pts[1]));
      for (let k = 2; k < i.pts.length; k += 2) x.lineTo(...P(i.pts[k], i.pts[k + 1]));
      x.closePath(); x.fill();
    }
    x.fillStyle = 'rgba(70,110,100,.35)';
    for (const i of this.world.reefs) {
      x.beginPath();
      x.moveTo(...P(i.pts[0], i.pts[1]));
      for (let k = 2; k < i.pts.length; k += 2) x.lineTo(...P(i.pts[k], i.pts[k + 1]));
      x.closePath(); x.fill();
    }

    // weather
    x.fillStyle = 'rgba(150,165,180,.16)';
    for (const q of S.squalls || []) {
      const [qx, qy] = P(q.x, q.y);
      x.beginPath(); x.arc(qx, qy, q.r * sx, 0, TAU); x.fill();
    }

    // holds
    for (const h of this.world.holds) {
      const st = S.holds.find(q => q.id === h.id);
      const [hx, hy] = P(h.x, h.y);
      const col = st?.o ? TEAM[st.o].css : '#b4ae9c';
      const R = (h.lane === 'gate' ? 5.5 : 4.5) * this.dpr;
      if (st?.x) {
        x.strokeStyle = '#ffc44d'; x.lineWidth = 1.6 * this.dpr;
        x.beginPath(); x.arc(hx, hy, R + 3 * this.dpr, 0, TAU); x.stroke();
      }
      x.fillStyle = col;
      x.beginPath();
      if (h.lane === 'gate') {
        x.moveTo(hx, hy - R); x.lineTo(hx + R, hy); x.lineTo(hx, hy + R); x.lineTo(hx - R, hy);
        x.closePath();
      } else x.arc(hx, hy, R, 0, TAU);
      x.fill();
      if (st && st.hp <= 0) {
        x.strokeStyle = 'rgba(255,120,90,.9)'; x.lineWidth = 1.2 * this.dpr;
        x.beginPath(); x.arc(hx, hy, R + 2 * this.dpr, 0, TAU); x.stroke();
      }
    }

    // the Bullion Run
    if (S.convoy) {
      const [bx, by] = P(S.convoy.x, S.convoy.y);
      x.fillStyle = '#ffd76a';
      x.beginPath(); x.arc(bx, by, 3.6 * this.dpr, 0, TAU); x.fill();
    }

    // ships — ours are arrowheads showing their heading, theirs are diamonds
    for (const s of S.ships) {
      const [px, py] = P(s.x, s.y);
      const mine = s.t === S.team;
      x.save();
      x.translate(px, py);
      const r = (s.id === this.you ? 4.4 : 3.2) * this.dpr;
      x.beginPath();
      if (mine) {
        x.rotate(s.a);
        x.moveTo(r * 1.5, 0); x.lineTo(-r, -r * 0.8); x.lineTo(-r, r * 0.8);
        x.closePath();
        x.fillStyle = s.id === this.you ? '#ffffff' : TEAM[s.t].css;
        x.fill();
      } else {
        x.moveTo(0, -r * 1.2); x.lineTo(r * 1.2, 0); x.lineTo(0, r * 1.2); x.lineTo(-r * 1.2, 0);
        x.closePath();
        x.fillStyle = '#ff6a52'; x.fill();
        x.strokeStyle = 'rgba(0,0,0,.6)'; x.lineWidth = 0.8 * this.dpr; x.stroke();
      }
      x.restore();
    }
    for (const g of S.ghosts || []) {
      const [px, py] = P(g.x, g.y);
      x.fillStyle = 'rgba(255,180,120,.35)';
      x.beginPath(); x.arc(px, py, 3 * this.dpr, 0, TAU); x.fill();
    }

    // pings
    for (const p of S.pings || []) {
      const [px, py] = P(p.x, p.y);
      const def = PINGS.find(q => q.id === p.k) || PINGS[0];
      const k = clamp((p.u - S.now) / 6500, 0, 1);
      x.strokeStyle = def.col; x.lineWidth = 1.4 * this.dpr; x.globalAlpha = k;
      x.beginPath(); x.arc(px, py, (3 + (1 - k % 1) * 6) * this.dpr, 0, TAU); x.stroke();
      x.globalAlpha = 1;
    }

    // what the camera is looking at
    const halfW = (this.c.width / 2) / this.scene.cam.zoom;
    const halfH = (this.c.height / 2) / this.scene.cam.zoom;
    x.strokeStyle = 'rgba(232,220,194,.35)';
    x.lineWidth = 1 * this.dpr;
    x.strokeRect((this.scene.cam.x - halfW) * sx, (this.scene.cam.y - halfH) * sy, halfW * 2 * sx, halfH * 2 * sy);
  }
}
