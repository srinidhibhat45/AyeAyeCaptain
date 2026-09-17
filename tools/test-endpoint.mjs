// ============================================================================
//  Where the client decides the game server lives.
//
//  This is the single value a split deployment hangs on: the page is on one
//  host and the match is on another, and if this resolves wrongly the game
//  loads perfectly and then sits there with a frozen clock. Cheap to get
//  wrong, miserable to debug in front of ten waiting people — so it is tested.
//
//  The function is pulled out of the shipped file rather than copied, so this
//  cannot quietly drift from what the browser actually runs.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'client/js/net.js'), 'utf8');
const found = /function serverBase\(\) \{[\s\S]*?\n\}/.exec(src);
if (!found) {
  console.error('serverBase() is no longer in client/js/net.js — this test needs rewriting');
  process.exit(1);
}

function resolve(proto, host, search, baked) {
  globalThis.location = { protocol: proto, host, search };
  globalThis.window = { AAC_SERVER: baked };
  return new Function('URLSearchParams', found[0] + '; return serverBase();')(URLSearchParams);
}

const cases = [
  // page is served by the game server itself — the local case, and the fallback
  ['http:',  'localhost:8787', '',                            '',                    'ws://localhost:8787'],
  ['https:', 'x.vercel.app',   '',                            '',                    'wss://x.vercel.app'],
  // a static host, told at build time where the match runs
  ['https:', 'x.vercel.app',   '',                            'wss://a.fly.dev',     'wss://a.fly.dev'],
  ['https:', 'x.vercel.app',   '',                            'https://a.fly.dev',   'wss://a.fly.dev'],
  ['https:', 'x.vercel.app',   '',                            'a.fly.dev',           'wss://a.fly.dev'],
  ['https:', 'x.vercel.app',   '',                            'a.fly.dev/',          'wss://a.fly.dev'],
  ['https:', 'x.vercel.app',   '',                            '  wss://a.fly.dev  ', 'wss://a.fly.dev'],
  // ?server= overrides the build, for trying a server without redeploying
  ['https:', 'x.vercel.app',   '?server=wss://b.fly.dev',     'wss://a.fly.dev',     'wss://b.fly.dev'],
  ['https:', 'x.vercel.app',   '?server=a.fly.dev',           '',                    'wss://a.fly.dev'],
  ['https:', 'x.vercel.app',   '?server=HTTPS://A.fly.dev',   '',                    'wss://A.fly.dev'],
  ['http:',  'localhost:8080', '?server=ws://localhost:8787', '',                    'ws://localhost:8787'],
  // a bare loopback host means plain ws — nothing is serving TLS on your laptop
  ['http:',  'localhost:8080', '',                            'localhost:8787',      'ws://localhost:8787'],
  ['http:',  'localhost:8080', '',                            '127.0.0.1:8787',      'ws://127.0.0.1:8787'],
  // other query parameters must not confuse it
  ['https:', 'x.vercel.app',   '?room=abc',                   'wss://a.fly.dev',     'wss://a.fly.dev'],
];

let bad = 0;
for (const [proto, host, search, baked, want] of cases) {
  const got = resolve(proto, host, search, baked);
  if (got !== want) {
    bad++;
    console.error(`  FAIL  page ${proto}//${host}${search}  AAC_SERVER=${JSON.stringify(baked)}`);
    console.error(`        got ${got}  wanted ${want}`);
  }
}

if (bad) { console.error(`\n${bad} of ${cases.length} resolved wrongly`); process.exit(1); }
console.log(`game server endpoint resolves correctly in all ${cases.length} cases`);
