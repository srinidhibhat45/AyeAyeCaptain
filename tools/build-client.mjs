// ============================================================================
//  Assemble the static site.
//
//  The browser imports the physics from '/shared/physics.js' — the very same
//  file the server steps the world with, which is the whole reason prediction
//  agrees with the authority. Running locally, the dev server maps /shared/*
//  to the repo root and that just works. A static host has no such trick, so
//  the build lays the files down where the imports already point.
//
//  It also settles config.js, which is the one thing that differs between your
//  laptop and the live site: where the game server actually lives.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT  = path.join(ROOT, 'dist');

fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'client'), OUT, { recursive: true });
fs.cpSync(path.join(ROOT, 'shared'), path.join(OUT, 'shared'), { recursive: true });

// Where the match runs. Two ways to say it, and the env var wins so a host can
// still override without a commit:
//
//   1. AAC_SERVER in the environment — what a Vercel project setting does.
//   2. client/config.js, committed — survives every redeploy on its own, which
//      is why it is the one to reach for. An env var set in a dashboard is
//      baked in at build time, so changing it without redeploying silently
//      keeps the old address, and that failure looks exactly like a dead
//      server. A committed address cannot drift that way.
//
// With neither, the client looks for the game server on its own origin, which
// is right when the Node server is serving the page itself and wrong on a
// static host.
const fromEnv = (process.env.AAC_SERVER || '').trim();
const committed = (() => {
  try {
    const src = fs.readFileSync(path.join(ROOT, 'client', 'config.js'), 'utf8');
    // Line by line, skipping comments — the file documents itself with an
    // example assignment, and a naive match reads that example as the
    // setting and ships a client aimed at a server nobody ever deployed.
    for (const line of src.split('\n')) {
      if (line.trim().startsWith('//')) continue;
      const m = /window\.AAC_SERVER\s*=\s*['"]([^'"]*)['"]/.exec(line);
      if (m) return m[1].trim();
    }
    return '';
  } catch { return ''; }
})();

const raw = fromEnv || committed;
const via = fromEnv ? 'AAC_SERVER in the environment' : 'client/config.js';

fs.writeFileSync(path.join(OUT, 'config.js'),
  raw
    ? `// Written by tools/build-client.mjs at build time — do not edit.\n` +
      `// Source: ${via}\n` +
      `window.AAC_SERVER = ${JSON.stringify(raw)};\n`
    : `// Written by tools/build-client.mjs at build time.\n` +
      `// No game server was named, so the client will look for one on this same\n` +
      `// origin. That is correct when the Node server serves the page itself,\n` +
      `// and wrong on a static host: put the address in client/config.js,\n` +
      `// e.g. window.AAC_SERVER = 'wss://your-app.onrender.com';\n` +
      `window.AAC_SERVER = '';\n`);

let n = 0, bytes = 0;
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else { n++; bytes += fs.statSync(p).size; }
  }
})(OUT);

console.log(`dist/  ${n} files, ${(bytes / 1024).toFixed(0)} KB`);
console.log(raw ? `game server: ${raw}  (from ${via})` : `game server: (same origin — name one in client/config.js for a static host)`);
