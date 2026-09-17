// ============================================================================
//  Sound, synthesised on the fly. No audio files: every report, splash and
//  bell is built from oscillators and shaped noise at the moment it happens.
//
//  Two rules run through all of it.
//
//  Sound is POSITIONAL. Everything that happens at a place on the water is
//  panned to where it is on your screen and rolled off with distance, so your
//  ears tell you which side the fight is on before your eyes find it.
//
//  Sound is SPECIFIC. Landing a shot, taking one, and hearing somebody else's
//  shot land nearby used to be the same noise; so did a shore battery and a
//  ship's broadside. They are now four different sounds, because the whole
//  feedback loop of a gunfight is knowing which of them just happened.
// ============================================================================
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

export class Audio {
  constructor() {
    this.ctx = null;
    this.on = true;
    this.noiseBuf = null;
    this.last = {};
  }

  resume() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.on = false; return; }
    this.ctx = new AC();

    this.master = this.ctx.createGain();
    this.master.gain.value = 0.55;
    // A gentle limiter keeps a big volley from clipping into mush.
    this.comp = this.ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14;
    this.comp.ratio.value = 7;
    this.comp.attack.value = 0.003;
    this.comp.release.value = 0.22;
    this.master.connect(this.comp).connect(this.ctx.destination);

    // one second of white noise, reused for everything percussive
    const n = this.ctx.sampleRate;
    this.noiseBuf = this.ctx.createBuffer(1, n, n);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;

    this.sea();
  }

  setVolume(v) { if (this.master) this.master.gain.value = clamp(v, 0, 1); }
  toggle() { this.on = !this.on; if (this.master) this.master.gain.value = this.on ? 0.55 : 0; return this.on; }

  /** Distance falloff plus a small low-pass, so far-off guns sound far off. */
  gainFor(dist, base = 1) {
    const k = clamp(1 - dist / 2600, 0, 1);
    return base * k * k;
  }

  /**
   * The end of every voice: a stereo place on the water, then the master bus.
   * Older Safari has no StereoPannerNode, so fall back to going straight out.
   */
  out(pan) {
    if (pan == null || !this.ctx.createStereoPanner) return this.master;
    const p = this.ctx.createStereoPanner();
    p.pan.value = clamp(pan, -1, 1) * 0.85;
    p.connect(this.master);
    return p;
  }

  noise(dur, { gain = 0.4, type = 'lowpass', f0 = 1200, f1 = 120, q = 1, when = 0, pan = null } = {}) {
    const c = this.ctx, t = c.currentTime + when;
    const src = c.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const filt = c.createBiquadFilter();
    filt.type = type; filt.Q.value = q;
    filt.frequency.setValueAtTime(f0, t);
    filt.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filt).connect(g).connect(this.out(pan));
    src.start(t); src.stop(t + dur + 0.05);
  }

  tone(f0, f1, dur, { gain = 0.2, type = 'sine', when = 0, pan = null } = {}) {
    const c = this.ctx, t = c.currentTime + when;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.out(pan));
    o.start(t); o.stop(t + dur + 0.05);
  }

  /** A permanent bed of sea noise under everything. */
  sea() {
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = this.noiseBuf; src.loop = true;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 420; lp.Q.value = 0.4;
    const g = c.createGain(); g.gain.value = 0.035;
    // slow swell in the level, so it breathes
    const lfo = c.createOscillator(); lfo.frequency.value = 0.07;
    const lg = c.createGain(); lg.gain.value = 0.018;
    lfo.connect(lg).connect(g.gain);
    src.connect(lp).connect(g).connect(this.master);
    src.start(); lfo.start();
  }

  /** Rate-limit a sound so a volley does not turn into a wall of noise. */
  gate(key, ms) {
    const now = performance.now();
    if (this.last[key] && now - this.last[key] < ms) return false;
    this.last[key] = now;
    return true;
  }
  ready_() { return this.ctx && this.on; }

  // -------------------------------------------------------------------------
  //  Guns
  // -------------------------------------------------------------------------
  broadside(dist, n = 4, pan = null) {
    if (!this.ready_()) return;
    const g = this.gainFor(dist, 0.9);
    if (g < 0.01 || !this.gate('bs', 45)) return;
    // Guns do not fire as one: they ripple down the side of the ship, and the
    // ripple is as long as the battery is. A galleon's eight should not sound
    // like a cutter's three.
    const guns = clamp(n, 1, 8);
    for (let i = 0; i < guns; i++) {
      const w = i * 0.032 + Math.random() * 0.018;
      this.noise(0.42, { gain: g * 0.50, f0: 1800, f1: 70, when: w, pan });
      this.tone(160, 38, 0.30, { gain: g * 0.32, type: 'triangle', when: w, pan });
    }
    this.noise(1.3 + guns * 0.04, { gain: g * 0.14, f0: 500, f1: 90, when: 0.12, pan });  // the roll
  }

  /** A shore battery: slower, deeper, unmistakably not a ship. */
  fortFire(dist, pan = null) {
    if (!this.ready_() || !this.gate('ff', 90)) return;
    const g = this.gainFor(dist, 0.75);
    if (g < 0.01) return;
    this.noise(0.70, { gain: g * 0.55, f0: 900, f1: 50, pan });
    this.tone(88, 30, 0.58, { gain: g * 0.40, type: 'sine', pan });
  }

  /** Somebody else's shot landing somewhere near you. */
  hit(dist, pan = null) {
    if (!this.ready_() || !this.gate('hit', 35)) return;
    const g = this.gainFor(dist, 0.8);
    if (g < 0.01) return;
    this.noise(0.20, { gain: g * 0.42, f0: 2600, f1: 260, q: 2, pan });
    this.tone(320, 90, 0.16, { gain: g * 0.18, type: 'square', pan });
  }

  /** YOU landed one. Bright, short, and it cuts through everything else. */
  hitDealt(pan = null) {
    if (!this.ready_() || !this.gate('hd', 60)) return;
    this.noise(0.13, { gain: 0.30, f0: 3600, f1: 700, q: 2.4, pan });
    this.tone(1180, 760, 0.09, { gain: 0.16, type: 'square', pan });
    this.tone(1760, 1760, 0.07, { gain: 0.07, type: 'sine', when: 0.045, pan });
  }

  /** YOU were hit. Close, heavy, timber — no distance, no pan, all of it. */
  hitTaken() {
    if (!this.ready_() || !this.gate('ht', 70)) return;
    this.noise(0.34, { gain: 0.52, f0: 1500, f1: 90, q: 1.2 });
    this.tone(150, 52, 0.30, { gain: 0.34, type: 'sawtooth' });
    this.tone(74, 40, 0.46, { gain: 0.22, type: 'sine', when: 0.02 });
  }

  /** A round going past. The sound of being shot at and missed. */
  whistle(dist, pan = null) {
    if (!this.ready_() || !this.gate('wh', 260)) return;
    const near = clamp(1 - dist / 190, 0, 1);
    this.tone(2100 + near * 700, 620, 0.20, { gain: 0.035 + near * 0.070, type: 'sine', pan });
    this.noise(0.18, { gain: 0.03 + near * 0.05, f0: 2600, f1: 900, type: 'bandpass', q: 5, pan });
  }

  /** Shot falling short or wide. Water, not wood. */
  splash(dist, pan = null) {
    if (!this.ready_() || !this.gate('sp', 90)) return;
    const g = this.gainFor(dist, 0.5);
    if (g < 0.02) return;
    this.noise(0.36, { gain: g * 0.34, f0: 1900, f1: 330, type: 'bandpass', q: 0.8, pan });
  }

  /** The reticle has taken a target. A single soft tick, easy to ignore. */
  lock() { if (this.ready_() && this.gate('lk', 180)) this.tone(1560, 1560, 0.045, { gain: 0.032, type: 'sine' }); }
  /** The guns are run out again. */
  ready() { if (this.ready_() && this.gate('rdy', 320)) { this.tone(660, 880, 0.07, { gain: 0.05, type: 'triangle' }); } }
  /** You pulled the lanyard on a gun that is still being run out. */
  notLoaded() {
    if (!this.ready_() || !this.gate('nl', 220)) return;
    this.tone(300, 190, 0.07, { gain: 0.07, type: 'square' });
  }
  /** Hammer on an empty chamber. */
  dry() { if (this.ready_() && this.gate('dry', 500)) this.noise(0.08, { gain: 0.18, f0: 2400, f1: 900, type: 'bandpass', q: 6 }); }
  /** A prize taken. */
  prize() {
    if (!this.ready_()) return;
    [880, 1320, 1760].forEach((f, i) => this.tone(f, f, 0.30, { gain: 0.10 - i * 0.02, type: 'triangle', when: i * 0.075 }));
  }

  // -------------------------------------------------------------------------
  //  Everything else
  // -------------------------------------------------------------------------
  boom(dist, power = 1, pan = null) {
    if (!this.ready_()) return;
    const g = this.gainFor(dist, 1.0) * power;
    if (g < 0.01) return;
    this.noise(0.75 * power, { gain: g * 0.7, f0: 1400, f1: 45, pan });
    this.tone(110 * power, 26, 0.6 * power, { gain: g * 0.45, type: 'sine', pan });
  }

  sink(dist, pan = null) {
    if (!this.ready_()) return;
    const g = this.gainFor(dist, 1.0);
    if (g < 0.01) return;
    this.boom(dist, 1.2, pan);
    this.noise(2.4, { gain: g * 0.32, f0: 700, f1: 60, when: 0.25, pan });
    this.tone(220, 70, 1.6, { gain: g * 0.14, type: 'sawtooth', when: 0.2, pan });
    // timbers going under
    this.tone(120, 44, 2.2, { gain: g * 0.10, type: 'triangle', when: 0.5, pan });
  }

  capture(mine) {
    if (!this.ready_()) return;
    const base = mine ? 392 : 294;
    [0, 0.13, 0.26].forEach((w, i) => this.tone(base * (1 + i * 0.26), base * (1 + i * 0.26), 0.5,
      { gain: 0.14, type: 'triangle', when: w }));
  }

  thunder() {
    if (!this.ready_() || !this.gate('thunder', 900)) return;
    this.noise(2.2, { gain: 0.26, f0: 700, f1: 40, when: 0.08 });
    this.tone(70, 24, 1.8, { gain: 0.16, type: 'sine', when: 0.1 });
  }

  rope()   { if (this.ready_() && this.gate('rope', 120)) this.noise(0.28, { gain: 0.10, f0: 3200, f1: 900, type: 'bandpass', q: 3 }); }
  /** A soft two-note hail when someone in your fleet says something. */
  hail(fromCaptain) {
    if (!this.ready_() || !this.gate('hail', 220)) return;
    const f = fromCaptain ? 620 : 480;
    this.tone(f, f, 0.10, { gain: 0.055, type: 'triangle' });
    this.tone(f * 1.5, f * 1.5, 0.13, { gain: 0.040, type: 'triangle', when: 0.07 });
  }
  chime()  { if (this.ready_()) { this.tone(880, 880, 0.24, { gain: 0.10, type: 'sine' }); this.tone(1320, 1320, 0.30, { gain: 0.06, type: 'sine', when: 0.06 }); } }
  whoosh(dist, pan = null) { if (this.ready_()) this.noise(0.9, { gain: this.gainFor(dist, 0.5), f0: 900, f1: 180, type: 'bandpass', q: 0.8, pan }); }
  alarm(dist, pan = null) {
    if (!this.ready_()) return;
    const g = this.gainFor(dist, 0.8);
    if (g < 0.02) return;
    for (let i = 0; i < 3; i++) this.tone(740, 560, 0.22, { gain: g * 0.18, type: 'square', when: i * 0.26, pan });
  }
  /** She is not going to take much more. A slow, unpleasant bell. */
  bilge() {
    if (!this.ready_() || !this.gate('bilge', 2600)) return;
    this.tone(196, 196, 0.5, { gain: 0.07, type: 'triangle' });
    this.tone(233, 233, 0.6, { gain: 0.055, type: 'triangle', when: 0.26 });
  }
}
