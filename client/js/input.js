// ============================================================================
//  Keyboard and mouse. Holds raw state; main.js turns it into input packets.
// ============================================================================
export class Input {
  constructor(el) {
    this.keys = new Set();
    this.mx = 0; this.my = 0;
    this.down = { L: false, R: false };
    this.clicked = { L: false, R: false };
    this.wheel = 0;
    this.taps = [];           // one-shot key presses drained each frame
    this.chordTaps = [];      // shift+N
    this.el = el;

    addEventListener('keydown', (e) => {
      if (e.repeat) { return; }
      // While the player is typing, the keyboard belongs to the text field —
      // including the space bar, which is both "sweeps" and a word break.
      if (this.typing()) return;
      const k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
      // Never let the browser steal the keys the game needs.
      if (['Tab', ' ', 'F1', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) e.preventDefault();
      this.keys.add(k);
      if (e.shiftKey && /^[1-9]$/.test(e.key)) this.chordTaps.push(e.key);
      else this.taps.push(k);
    });
    addEventListener('keyup', (e) => {
      const k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
      if (this.typing() && k !== 'Enter' && k !== 'Escape') { this.keys.delete(k); return; }
      this.keys.delete(k);
      // Releasing shift can strand the digit; clear both cases.
      this.keys.delete(e.key.toUpperCase());
    });
    addEventListener('blur', () => { this.keys.clear(); this.down.L = this.down.R = false; });

    el.addEventListener('contextmenu', e => e.preventDefault());
    el.addEventListener('pointermove', (e) => { this.mx = e.clientX; this.my = e.clientY; });
    el.addEventListener('pointerdown', (e) => {
      this.mx = e.clientX; this.my = e.clientY;
      if (e.button === 0) { this.down.L = true; this.clicked.L = true; }
      if (e.button === 2) { this.down.R = true; this.clicked.R = true; }
    });
    addEventListener('pointerup', (e) => {
      if (e.button === 0) this.down.L = false;
      if (e.button === 2) this.down.R = false;
    });
    addEventListener('wheel', (e) => { this.wheel += Math.sign(e.deltaY); }, { passive: true });
  }

  /** Is a text field taking the keyboard right now? */
  typing() {
    const a = document.activeElement;
    return !!a && /^(INPUT|TEXTAREA)$/.test(a.tagName);
  }
  has(...ks) { return ks.some(k => this.keys.has(k)); }
  /** Was this key pressed since the last drain? */
  tapped(k) { return this.taps.includes(k); }
  chord(n) { return this.chordTaps.includes(String(n)); }
  drain() { this.taps.length = 0; this.chordTaps.length = 0; this.clicked.L = this.clicked.R = false; this.wheel = 0; }
}
