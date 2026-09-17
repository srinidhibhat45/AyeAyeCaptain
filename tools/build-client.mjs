// ============================================================================
//  Assemble the static site.
//
//  The browser imports the physics from '/shared/physics.js' — the very same
//  file the server steps the world with, which is the whole reason prediction
//  agrees with the authority. Running locally, the dev server maps /shared/*
//  to the repo root and that just works. A static host has no such trick, so
//  the build lays the files down where the imports already point.
//
//  It also writes config.js, which is the one thing that differs between your
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

// Where the match runs. Vercel hands this in as an environment variable; with
// nothing set the client falls back to its own origin, which is what you want
// when the Node server is serving the page itself.
const raw = (process.env.AAC_SERVER || '').trim();
const esc = JSON.stringify(raw);
fs.writeFileSync(path.join(OUT, 'config.js'),
  raw
    ? `// Written by tools/build-client.mjs at build time — do not edit.\n` +
      `window.AAC_SERVER = ${esc};\n`
    : `// Written by tools/build-client.mjs at build time.\n` +
      `// No AAC_SERVER was set, so the client will look for the game server on\n` +
      `// this same origin. That is correct for local play and wrong for a static\n` +
      `// host: set AAC_SERVER to your game server, e.g. wss://your-app.fly.dev\n` +
      `window.AAC_SERVER = '';\n`);

let n = 0, bytes = 0;
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else { n++; bytes += fs.statSync(p).size; }
  }
})(OUT);

console.log(`dist/  ${n} files, ${(bytes / 1024).toFixed(0)} KB`);
console.log(raw ? `game server: ${raw}` : `game server: (same origin — set AAC_SERVER for a static host)`);
