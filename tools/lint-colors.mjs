// Scans the source for malformed colour literals. A stray non-hex character
// inside a #rrggbb token renders as transparent black and stays invisible
// until something looks subtly wrong on screen — so check for it mechanically.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const HEX = /^([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const bad = [];

// Ids and class names that legitimately appear as '#foo' selectors in JS.
// Not every id lives in the HTML: the HUD builds markup in template literals
// and then queries it back, so scan the scripts for id="..." as well, or a
// perfectly good selector gets reported as a broken colour.
const SELECTORS = new Set();
function harvest(src) {
  for (const m of src.matchAll(/\b(?:id|class)="([^"]+)"/g)) {
    for (const w of m[1].split(/\s+/)) SELECTORS.add('#' + w);
  }
}
harvest(readFileSync('client/index.html', 'utf8'));
(function scanJs(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) { scanJs(p); continue; }
    if (['.js', '.mjs'].includes(extname(p))) harvest(readFileSync(p, 'utf8'));
  }
})('client');

function checkJs(p, src) {
  // Only look inside string literals; '#foo' elsewhere is a selector or an id.
  for (const m of src.matchAll(/(['"`])((?:[^'"`\\\n]|\\.)*)\1/g)) {
    const body = m[2];
    if (!body.includes('#')) continue;
    // Hyphens are part of the token on purpose: '#sb-room' cut at the dash
    // becomes '#sb', which matches no known selector and gets reported as a
    // broken colour. No hex literal contains a dash, so nothing is lost.
    for (const c of body.matchAll(/#[0-9a-zA-Z-]{2,24}/g)) {
      if (HEX.test(c[0].slice(1))) continue;
      if (/^#\d+$/.test(c[0])) continue;                    // html entity like &#39
      if (SELECTORS.has(c[0])) continue;                    // a real DOM selector
      const line = src.slice(0, m.index).split('\n').length;
      bad.push(`${p}:${line}  ${c[0]}   in ${JSON.stringify(body.slice(0, 48))}`);
    }
  }
}

function checkCss(p, src) {
  // Only colour positions: after ':' or inside a value list / function call.
  src.split('\n').forEach((line, i) => {
    // Step over the selector first. 'a:hover,#b:hover{...}' has a colon in the
    // pseudo-class, so slicing from the first ':' leaves a second id selector
    // sitting in what we are about to read as a value.
    const body = line.includes('{') ? line.slice(line.indexOf('{')) : line;
    const decl = body.includes(':') ? body.slice(body.indexOf(':')) : '';
    if (!decl.includes('#')) return;
    for (const c of decl.matchAll(/#[0-9a-zA-Z]{2,12}/g)) {
      if (HEX.test(c[0].slice(1))) continue;
      bad.push(`${p}:${i + 1}  ${c[0]}   ${line.trim().slice(0, 70)}`);
    }
  });
}

const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    const ext = extname(p);
    const src = readFileSync(p, 'utf8');
    if (ext === '.js' || ext === '.mjs') checkJs(p, src);
    else if (ext === '.css') checkCss(p, src);
    else if (ext === '.html') { checkCss(p, src); checkJs(p, src); }
  }
};
['client', 'server', 'shared'].forEach(walk);

if (bad.length) {
  console.error('malformed colour literals:\n' + bad.map(b => '  ' + b).join('\n'));
  process.exit(1);
}
console.log('colour literals OK');
