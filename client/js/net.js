// ============================================================================
//  WebSocket transport. Reconnects on its own; the game keeps rendering the
//  last known world while it is down.
// ============================================================================
/** localStorage throws in some privacy modes; nothing here is worth a crash. */
function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
export function safeSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

/**
 * Where the game server lives.
 *
 * The page may be served from anywhere — a CDN, a static host, a file — but
 * the match itself has to run somewhere that can hold a socket open for
 * fifteen minutes, and those need not be the same place.
 *
 * `?server=` on the address wins, which is how you point a deployed client at
 * a scratch server without rebuilding it. Then whatever the build baked into
 * config.js. Failing both, this same origin, which is the right answer when
 * the Node server is serving the page itself.
 */
function serverBase() {
  const q = new URLSearchParams(location.search);
  const want = (q.get('server') || (typeof window !== 'undefined' && window.AAC_SERVER) || '').trim();
  if (!want) return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
  // Take it however it happens to be written: wss://host, https://host, or a
  // bare host with no scheme at all.
  const m = /^(wss?|https?):\/\/(.+)$/i.exec(want);
  const host = (m ? m[2] : want).replace(/\/+$/, '');
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
  const scheme = m ? (/^(wss|https)$/i.test(m[1]) ? 'wss' : 'ws') : (local ? 'ws' : 'wss');
  return `${scheme}://${host}`;
}

export class Net {
  constructor(handlers) {
    this.h = handlers;
    this.ws = null;
    this.state = 'connecting';
    this.tries = 0;
    this.outQ = [];
    this.bytesIn = 0; this.bytesOut = 0;
    this.lastMsgAt = 0;
    this.stopped = false;
    if (handlers.autoConnect !== false) this.connect();
  }

  /** Give up for good — used when the room is full and retrying is pointless. */
  stop() { this.stopped = true; try { this.ws?.close(); } catch {} }

  url() {
    const q = new URLSearchParams(location.search);
    const p = new URLSearchParams();
    p.set('room', q.get('room') || 'main');
    const nm = q.get('name') || safeGet('aac_name');
    if (nm) p.set('name', nm);
    const team = q.get('team') || safeGet('aac_team');
    if (team === 'scarlet' || team === 'cobalt') p.set('team', team);
    return `${serverBase()}/?${p.toString()}`;
  }

  /** The state, plus what a person would need to diagnose it. */
  report() { this.h.status?.(this.state, { tries: this.tries, server: serverBase() }); }

  connect() {
    if (this.stopped) return;
    this.state = 'connecting';
    this.report();
    let ws;
    try { ws = new WebSocket(this.url()); } catch { return this.retry(); }
    this.ws = ws;

    ws.onopen = () => {
      this.state = 'open'; this.tries = 0;
      this.report();
      for (const m of this.outQ) ws.send(m);
      this.outQ.length = 0;
    };
    ws.onmessage = (ev) => {
      this.bytesIn += ev.data.length;
      this.lastMsgAt = performance.now();
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.k === 'ping') { this.send({ k: 'pong' }); return; }
      this.h.msg?.(m);
    };
    ws.onclose = () => { this.state = 'closed'; this.report(); this.retry(); };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }

  retry() {
    if (this.stopped) return;
    this.tries++;
    const wait = Math.min(6000, 400 * Math.pow(1.6, this.tries));
    setTimeout(() => this.connect(), wait);
  }

  send(obj) {
    const s = JSON.stringify(obj);
    this.bytesOut += s.length;
    if (this.ws && this.ws.readyState === 1) this.ws.send(s);
    else if (this.outQ.length < 24) this.outQ.push(s);
  }
}
