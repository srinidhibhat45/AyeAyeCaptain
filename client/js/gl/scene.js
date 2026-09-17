// ============================================================================
//  The renderer.
//
//  Passes, in order:
//    1. ocean    — fullscreen shader: swell, sun glitter, shoals, shore break
//    2. land     — triangulated island polygons, shaded from a baked depth field
//    3. sprites  — instanced quads (ships, sails, forts, particles)
//    4. additive — muzzle flash, fire, explosions, lights
//    5. post     — bloom, tonemap, grade, vignette, grain, shockwaves
// ============================================================================
import {
  initGL, Program, FullScreen, Target, texFromCanvas, texFromData, bindScreen, GLSL_COMMON,
} from './core.js';
import { buildAtlas, buildNoise } from './art.js';

const VS_QUAD = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUV;
void main(){ vUV = aPos*0.5+0.5; gl_Position = vec4(aPos,0.0,1.0); }`;

// ---------------------------------------------------------------------------
//  Ocean
// ---------------------------------------------------------------------------
const FS_OCEAN = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 frag;

uniform vec2  uRes;
uniform vec2  uCam;
uniform float uInvZoom;
uniform vec2  uWorld;
uniform float uTime;
uniform vec2  uWind;        // unit vector
uniform float uWindSpd;
uniform sampler2D uDepth;   // R land, G offshore distance, B reef, A inland distance
uniform sampler2D uNoise;
uniform sampler2D uCtrl;    // team influence: R scarlet, G cobalt
uniform vec4  uSq[4];       // squalls: xy centre, z radius, w intensity
uniform vec3  uTeamA;
uniform vec3  uTeamB;
uniform float uDawn;        // 0..1 grading knob, drifts over a match

${GLSL_COMMON}

// Two-channel value noise from the tileable texture; cheap and smooth.
float nR(vec2 p){ return texture(uNoise, p).r; }
float nG(vec2 p){ return texture(uNoise, p).g; }
float nB(vec2 p){ return texture(uNoise, p).b; }

// Wave height in 0..1 at a world position. Each layer is stretched ACROSS the
// wind, so the swell reads as lines of sea marching downwind rather than as a
// blobby mess. Weights sum to 1 — everything downstream assumes that range.
//
// Frequencies are set against real world units: a ship is 45-80 units long, so
// nothing here may have detail finer than that or the sea turns to static.
// Each noise channel already carries its own octave stack for finer texture.
float waves(vec2 p, float t){
  vec2 w = uWind;
  vec2 across = vec2(-w.y, w.x);
  mat2 toWind = mat2(w.x, w.y, across.x, across.y);
  vec2 q = toWind * p;

  float h = 0.0;
  h += nR(vec2(q.x*0.00024 - t*0.020, q.y*0.00062)) * 0.56;   // long swell ~1000u
  h += nG(vec2(q.x*0.00052 - t*0.052, q.y*0.00132)) * 0.29;   // working sea ~430u
  h += nB(vec2(q.x*0.00105 - t*0.115, q.y*0.00250)) * 0.15;   // chop ~210u
  return h;
}

void main(){
  // The land and sprite passes put world +y DOWN the screen; match that here
  // or the ocean samples the depth field mirrored about the horizon.
  vec2 px = (vUV - 0.5) * uRes;
  px.y = -px.y;
  vec2 wp = uCam + px * uInvZoom;
  vec2 duv = wp / uWorld;

  vec4 D = texture(uDepth, duv);
  float land   = D.r;
  float offsh  = D.g;            // 0 at the waterline -> 1 in deep water
  float reef   = D.b;

  // --- squalls: local darkening and a rougher sea ------------------------
  float storm = 0.0;
  for(int i=0;i<4;i++){
    if(uSq[i].z <= 0.0) continue;
    float d = distance(wp, uSq[i].xy);
    storm = max(storm, (1.0 - smoothstep(uSq[i].z*0.35, uSq[i].z, d)) * uSq[i].w);
  }

  float t = uTime * (1.0 + uWindSpd*0.35 + storm*0.9);
  float amp = 1.0 + storm*1.6;

  // Height and its slope, by finite difference over a fixed world distance so
  // the surface keeps the same shape at every zoom. WAVE_AMP is the height of
  // the swell in world units; slope is then a real gradient.
  const float WAVE_AMP = 46.0;
  float e = 26.0;
  float h  = waves(wp, t);
  float hx = waves(wp + vec2(e,0.0), t);
  float hy = waves(wp + vec2(0.0,e), t);
  vec2  slope = vec2(hx-h, hy-h) * (amp * WAVE_AMP / e);

  // Shoaling: waves stand up and steepen as the bottom comes up.
  float shoal = 1.0 - smoothstep(0.0, 0.55, offsh);
  slope *= 1.0 + shoal*1.45;

  vec3 N = normalize(vec3(-slope.x, -slope.y, 1.0));
  vec3 V = vec3(0.0,0.0,1.0);
  vec3 L = normalize(vec3(-0.52, -0.46, 0.72));

  // --- base colour by depth ------------------------------------------------
  vec3 deep    = mix(vec3(0.022,0.075,0.140), vec3(0.030,0.090,0.155), uDawn);
  vec3 mid     = vec3(0.038,0.170,0.238);
  vec3 shallow = vec3(0.094,0.329,0.369);
  vec3 sandy   = vec3(0.243,0.447,0.404);

  float dsel = smoothstep(0.0, 0.22, offsh);
  vec3 col = mix(sandy, shallow, dsel);
  col = mix(col, mid,  smoothstep(0.16, 0.48, offsh));
  col = mix(col, deep, smoothstep(0.42, 0.92, offsh));

  // Reefs read as broken shoal water — you should SEE what will hole you,
  // without them shouting louder than the ships.
  col = mix(col, vec3(0.145,0.396,0.384), reef*0.55);

  // --- light ---------------------------------------------------------------
  float diff = max(0.0, dot(N, L));
  float sky  = 0.5 + 0.5*N.z;
  col *= 0.68 + 0.42*sky;
  col += vec3(0.055,0.082,0.086) * diff;

  // Backlit crests: the up-slope of a wave scatters light through it. h is
  // normalised 0..1, so only the top of the range should ever glow.
  float scatter = smoothstep(0.62, 0.92, h) * 0.55;
  col += vec3(0.075,0.185,0.175) * scatter * (1.0 - storm*0.6);

  // The sun path: a broad sheen, with sparse hard glints riding on it. The
  // glints come from the wave slope itself, so they travel with the swell.
  vec3 H = normalize(L + V);
  float ndh = max(0.0, dot(N,H));
  float sheen = pow(ndh, 22.0) * 0.16;
  float glint = pow(ndh, 320.0) * 3.0
              * smoothstep(0.52, 0.88, nG(wp*0.0016 + vec2(uTime*0.012, -uTime*0.009)));
  float spec = (sheen + glint) * (1.0 - storm*0.80) * (0.30 + 0.70*dsel);
  col += vec3(1.00,0.93,0.78) * spec;

  // --- foam ----------------------------------------------------------------
  // Whitecaps: only on the steep, wind-facing side of a wave, and only where
  // a second slow field says this patch of sea is breaking at all.
  float sl    = length(slope);
  float steep = smoothstep(0.34, 0.80, sl + storm*0.45);
  float breaking = smoothstep(0.50, 0.84, nG(wp*0.00085 + vec2(-uTime*0.020, uTime*0.012)));
  float caps  = steep * breaking * (0.45 + 0.55*storm);

  // Breaking water along the shore, marching in and dying on the beach.
  float band  = 1.0 - smoothstep(0.0, 0.14, offsh);
  float phase = offsh*34.0 - uTime*1.35 + nR(wp*0.0035)*3.4;
  float surf  = band * smoothstep(0.35, 0.95, 0.5+0.5*sin(phase));
  float wash  = (1.0 - smoothstep(0.0, 0.045, offsh));
  float foam  = clamp(caps*0.80 + surf*0.62 + wash*0.34 + reef*(0.18+steep*0.40), 0.0, 1.0);
  col = mix(col, vec3(0.82,0.91,0.95), foam*0.84);

  // --- territory ------------------------------------------------------------
  vec2 ctrl = texture(uCtrl, duv).rg;
  col = mix(col, uTeamA, ctrl.r*0.115);
  col = mix(col, uTeamB, ctrl.g*0.115);

  // --- weather --------------------------------------------------------------
  col *= 1.0 - storm*0.52;
  col = mix(col, vec3(0.16,0.20,0.24), storm*0.22);
  if(storm > 0.02){
    // rain, streaked along the wind
    vec2 r = wp*0.05 + uWind*uTime*26.0;
    float rain = smoothstep(0.86, 1.0, nB(vec2(r.x*0.30, r.y*0.035)));
    col += vec3(0.16,0.19,0.21) * rain * storm;
  }

  // Land is drawn in its own pass; punch a hole so it is not double-shaded.
  float a = 1.0 - smoothstep(0.42, 0.58, land);
  frag = vec4(col, 1.0) * a;
}`;

// ---------------------------------------------------------------------------
//  Land
// ---------------------------------------------------------------------------
const VS_LAND = `#version 300 es
layout(location=0) in vec2 aWorld;
layout(location=1) in float aKind;      // 0 island, 1 reef
uniform vec2 uRes; uniform vec2 uCam; uniform float uZoom;
out vec2 vW; out float vKind;
void main(){
  vW = aWorld; vKind = aKind;
  vec2 s = (aWorld - uCam) * uZoom / (uRes*0.5);
  gl_Position = vec4(s.x, -s.y, 0.0, 1.0);
}`;

const FS_LAND = `#version 300 es
precision highp float;
in vec2 vW; in float vKind;
out vec4 frag;
uniform sampler2D uDepth;
uniform sampler2D uNoise;
uniform vec2 uWorld;
uniform float uTime;
uniform float uInvZoom;
${GLSL_COMMON}
float n2(vec2 p){ return texture(uNoise, p).g; }

void main(){
  vec2 duv = vW / uWorld;
  vec4 D = texture(uDepth, duv);
  float inland = D.a;                    // 0 at the waterline -> 1 well inland

  // Slope of the inland field gives us a surface normal for free.
  float e = 2.0/2048.0;
  float ix = texture(uDepth, duv + vec2(e,0.0)).a;
  float iy = texture(uDepth, duv + vec2(0.0,e)).a;
  vec3 N = normalize(vec3(-(ix-inland)*7.0, -(iy-inland)*7.0, 1.0));
  vec3 L = normalize(vec3(-0.52,-0.46,0.72));
  float diff = 0.55 + 0.55*max(0.0, dot(N,L));

  float rough = fbm(vW*0.010, 4);
  float fine  = n2(vW*0.055);

  vec3 wetSand = vec3(0.494,0.427,0.318);
  vec3 sand    = vec3(0.839,0.769,0.576);
  vec3 scrub   = vec3(0.373,0.443,0.271);
  vec3 grass   = vec3(0.243,0.369,0.224);
  vec3 rock    = vec3(0.400,0.388,0.353);

  float veg   = smoothstep(0.13, 0.34, inland + (rough-0.5)*0.26);
  float crag  = smoothstep(0.48, 0.86, inland + (rough-0.5)*0.40);

  vec3 col = mix(wetSand, sand, smoothstep(0.0,0.07,inland));
  col = mix(col, scrub, veg*0.90);
  col = mix(col, grass, smoothstep(0.22,0.52,inland)*0.85);
  col = mix(col, rock,  crag*0.75);
  col *= 0.86 + 0.28*rough;
  col *= diff;

  // scattered trees and boulders, stable because the scatter is hashed
  float spot = n2(vW*0.085);
  float trees = smoothstep(0.62, 0.92, spot) * veg;
  col = mix(col, vec3(0.129,0.212,0.137), trees*0.72);
  // a second, coarser canopy so the greenery has structure rather than speckle
  float canopy = smoothstep(0.45, 0.80, n2(vW*0.022)) * veg;
  col = mix(col, vec3(0.180,0.290,0.180), canopy*0.45);
  col += vec3(0.06,0.05,0.03)*fine*0.5;

  // A wet, dark line right at the waterline stops the island floating.
  float rim = 1.0 - smoothstep(0.0, 0.055, inland);
  col = mix(col, vec3(0.243,0.220,0.180), rim*0.75);

  // Reefs are awash: mostly water, with rock showing through.
  if(vKind > 0.5){
    float wash = 0.35 + 0.45*n2(vW*0.03 + vec2(uTime*0.05,0.0));
    col = mix(vec3(0.086,0.259,0.263), vec3(0.204,0.192,0.169), smoothstep(0.40,0.80,rough));
    col = mix(col, vec3(0.596,0.718,0.729), wash*0.20);
    frag = vec4(col, 0.58);
    return;
  }

  float a = smoothstep(0.0, 0.03, inland);
  frag = vec4(col, a);
}`;

// ---------------------------------------------------------------------------
//  Instanced sprites
// ---------------------------------------------------------------------------
const VS_SPRITE = `#version 300 es
layout(location=0) in vec2 aCorner;       // unit quad 0..1
layout(location=1) in vec4 iPos;          // x, y, halfW, halfH  (world units)
layout(location=2) in vec4 iUV;           // u0, v0, u1, v1
layout(location=3) in vec4 iCol;          // tint rgba
layout(location=4) in vec4 iX;            // rot, glow, anchorX, anchorY
uniform vec2 uRes; uniform vec2 uCam; uniform float uZoom;
out vec2 vUV; out vec4 vCol; out float vGlow;
void main(){
  vec2 c = aCorner - vec2(0.5) + iX.zw;
  vec2 local = c * vec2(iPos.z, iPos.w) * 2.0;
  float s = sin(iX.x), co = cos(iX.x);
  vec2 rotd = vec2(local.x*co - local.y*s, local.x*s + local.y*co);
  vec2 world = iPos.xy + rotd;
  vec2 sc = (world - uCam) * uZoom / (uRes*0.5);
  gl_Position = vec4(sc.x, -sc.y, 0.0, 1.0);
  vUV = mix(iUV.xy, iUV.zw, aCorner);
  vCol = iCol; vGlow = iX.y;
}`;

const FS_SPRITE = `#version 300 es
precision highp float;
in vec2 vUV; in vec4 vCol; in float vGlow;
out vec4 frag;
uniform sampler2D uAtlas;
void main(){
  vec4 t = texture(uAtlas, vUV);
  vec4 c = t * vCol;
  c.rgb += c.rgb * vGlow;
  if(c.a < 0.003) discard;
  frag = c;
}`;

// ---------------------------------------------------------------------------
//  Post
// ---------------------------------------------------------------------------
const FS_BRIGHT = `#version 300 es
precision highp float;
in vec2 vUV; out vec4 frag;
uniform sampler2D uSrc; uniform float uThresh;
void main(){
  vec3 c = texture(uSrc, vUV).rgb;
  float l = dot(c, vec3(0.2126,0.7152,0.0722));
  float k = max(0.0, l - uThresh) / max(0.0001, l);
  frag = vec4(c * k, 1.0);
}`;

const FS_BLUR = `#version 300 es
precision highp float;
in vec2 vUV; out vec4 frag;
uniform sampler2D uSrc; uniform vec2 uDir;
void main(){
  vec3 s = texture(uSrc, vUV).rgb * 0.2270270270;
  s += texture(uSrc, vUV + uDir*1.3846153846).rgb * 0.3162162162;
  s += texture(uSrc, vUV - uDir*1.3846153846).rgb * 0.3162162162;
  s += texture(uSrc, vUV + uDir*3.2307692308).rgb * 0.0702702703;
  s += texture(uSrc, vUV - uDir*3.2307692308).rgb * 0.0702702703;
  frag = vec4(s, 1.0);
}`;

const FS_POST = `#version 300 es
precision highp float;
in vec2 vUV; out vec4 frag;
uniform sampler2D uScene, uBloom;
uniform vec2  uRes;
uniform float uTime;
uniform float uBloomK;
uniform float uFlash;       // full-screen white flash (lightning, big hits)
uniform vec3  uFlashCol;
uniform float uDamage;      // red vignette when the ship is hurt
uniform float uDesat;       // drains colour when sunk
uniform vec4  uShock[6];    // xy screen pos (px), z age 0..1, w strength
uniform int   uDebug;       // 0 off, 1 raw scene, 2 bloom only, 3 scene minus bloom
${GLSL_COMMON}

void main(){
  vec2 uv = vUV;
  vec2 px = uv * uRes;

  // Shockwaves push the image outward in a thin expanding ring.
  for(int i=0;i<6;i++){
    if(uShock[i].w <= 0.0) continue;
    vec2 d = px - uShock[i].xy;
    float r = length(d);
    float edge = uShock[i].z * 620.0;
    float ring = exp(-pow((r - edge)/46.0, 2.0));
    uv += normalize(d + 1e-5) * ring * uShock[i].w * (1.0 - uShock[i].z) * 0.030;
  }

  // Slight chromatic spread toward the corners, like a real lens.
  vec2 cdir = (uv - 0.5);
  float ca = dot(cdir,cdir) * 0.0035;
  vec3 c;
  c.r = texture(uScene, uv + cdir*ca).r;
  c.g = texture(uScene, uv).g;
  c.b = texture(uScene, uv - cdir*ca).b;

  vec3 raw = c;
  vec3 bl = texture(uBloom, uv).rgb * uBloomK;
  c += bl;
  c = tonemap(c);
  if(uDebug == 1){ frag = vec4(raw, 1.0); return; }
  if(uDebug == 2){ frag = vec4(bl, 1.0); return; }
  if(uDebug == 3){ frag = vec4(tonemap(raw), 1.0); return; }

  // grade: cool the shadows, warm the highlights
  float l = dot(c, vec3(0.2126,0.7152,0.0722));
  c = mix(c, vec3(0.055,0.086,0.125), (1.0-smoothstep(0.0,0.35,l))*0.22);
  c = mix(c, c*vec3(1.06,1.01,0.93), smoothstep(0.55,1.0,l)*0.55);
  c = mix(vec3(l), c, 1.12);

  c = mix(c, vec3(l*0.9), uDesat);
  c = mix(c, uFlashCol, uFlash);

  // vignette, and a red one when we are being hurt
  float v = smoothstep(1.15, 0.30, length((uv-0.5)*vec2(uRes.x/uRes.y,1.0))*1.35);
  c *= mix(1.0, v, 0.55);
  float dv = 1.0 - smoothstep(0.15, 0.85, length((uv-0.5)*vec2(uRes.x/uRes.y,1.0))*1.25);
  c = mix(c, mix(c, vec3(0.45,0.03,0.03), 0.62), (1.0-dv)*uDamage);

  // a whisper of grain so flat areas are not plastic
  c += (hash12(px + fract(uTime)*311.0) - 0.5) * 0.020;

  frag = vec4(c, 1.0);
}`;

// ---------------------------------------------------------------------------
//  Scene
// ---------------------------------------------------------------------------
const MAX_SPRITES = 6000;
const OFFSHORE = 340;    // world units over which the shallows fade to deep
const INLAND   = 130;    // world units from the waterline to "well inland"

export class Scene {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = initGL(canvas);
    this.ok = !!this.gl;
    if (!this.ok) return;
    const gl = this.gl;

    this.fs = new FullScreen(gl);
    this.pOcean  = new Program(gl, VS_QUAD, FS_OCEAN, 'ocean');
    this.pLand   = new Program(gl, VS_LAND, FS_LAND, 'land');
    this.pSprite = new Program(gl, VS_SPRITE, FS_SPRITE, 'sprite');
    this.pBright = new Program(gl, VS_QUAD, FS_BRIGHT, 'bright');
    this.pBlur   = new Program(gl, VS_QUAD, FS_BLUR, 'blur');
    this.pPost   = new Program(gl, VS_QUAD, FS_POST, 'post');

    const atlas = buildAtlas();
    this.uv = atlas.uv;
    this.spriteSize = atlas.size;
    this.atlasTex = texFromCanvas(gl, atlas.canvas, { mips: true });
    this.noiseTex = texFromCanvas(gl, buildNoise(256), { wrap: gl.REPEAT, mips: true });

    this.sceneT = new Target(gl, 2, 2, { float: true });
    this.brightT = new Target(gl, 2, 2, { float: true });
    this.blurA = new Target(gl, 2, 2, { float: true });
    this.blurB = new Target(gl, 2, 2, { float: true });

    this.initSprites();

    this.cam = { x: 0, y: 0, zoom: 1 };
    this.time = 0;
    this.shocks = [];
    this.flash = 0; this.flashCol = [1, 1, 1];
    this.damage = 0; this.desat = 0;
    this.dpr = 1;
    this.w = 1; this.h = 1;
    this.debug = 0;
  }

  // -- sprite batching -------------------------------------------------------
  initSprites() {
    const gl = this.gl;
    this.batches = { base: this.newBatch(), add: this.newBatch() };

    this.quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);

    for (const key of ['base', 'add']) {
      const b = this.batches[key];
      b.vao = gl.createVertexArray();
      gl.bindVertexArray(b.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      b.buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b.buf);
      gl.bufferData(gl.ARRAY_BUFFER, b.data.byteLength, gl.DYNAMIC_DRAW);
      // 4 vec4s per instance, interleaved
      for (let i = 0; i < 4; i++) {
        const loc = 1 + i;
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, 64, i * 16);
        gl.vertexAttribDivisor(loc, 1);
      }
      gl.bindVertexArray(null);
    }
  }
  newBatch() { return { data: new Float32Array(MAX_SPRITES * 16), n: 0, vao: null, buf: null }; }

  /**
   * Queue one sprite.
   *   name   atlas key
   *   x,y    world centre
   *   w,h    world size (full width/height)
   *   rot    radians
   *   col    [r,g,b,a]
   *   glow   extra emissive multiplier (drives the bloom)
   *   add    true for additive blending (fire, flash, light)
   *   ax,ay  anchor offset in units of the sprite's own size (0 = centred)
   */
  draw(name, x, y, w, h, rot = 0, col = WHITE, glow = 0, add = false, ax = 0, ay = 0) {
    const uv = this.uv[name];
    if (!uv) return;
    const b = add ? this.batches.add : this.batches.base;
    if (b.n >= MAX_SPRITES) return;
    const o = b.n * 16, d = b.data;
    d[o] = x; d[o + 1] = y; d[o + 2] = w * 0.5; d[o + 3] = h * 0.5;
    d[o + 4] = uv[0]; d[o + 5] = uv[1]; d[o + 6] = uv[2]; d[o + 7] = uv[3];
    d[o + 8] = col[0]; d[o + 9] = col[1]; d[o + 10] = col[2]; d[o + 11] = col[3];
    d[o + 12] = rot; d[o + 13] = glow; d[o + 14] = ax; d[o + 15] = ay;
    b.n++;
  }

  flushSprites(key) {
    const gl = this.gl, b = this.batches[key];
    if (!b.n) return;
    gl.bindVertexArray(b.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, b.buf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, b.data, 0, b.n * 16);
    this.pSprite.use()
      .v2('uRes', this.w, this.h).v2('uCam', this.cam.x, this.cam.y)
      .f('uZoom', this.cam.zoom).tex('uAtlas', this.atlasTex);
    if (key === 'add') gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    else gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, b.n);
    b.n = 0;
  }

  // -- world -----------------------------------------------------------------
  /**
   * Bake the world into a depth field:
   *   R land mask, G offshore distance, B reef mask, A inland distance.
   * A real chamfer distance transform, because approximating it with blurs
   * leaves visible banding in the shore break.
   */
  setWorld(world) {
    const gl = this.gl;
    this.world = world;
    const W = 1536, H = Math.max(2, Math.round(W * world.h / world.w));
    const upp = world.w / W;                       // world units per texel

    const mk = (polys) => {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const x = c.getContext('2d');
      x.fillStyle = '#000'; x.fillRect(0, 0, W, H);
      x.fillStyle = '#fff';
      for (const p of polys) {
        x.beginPath();
        x.moveTo(p.pts[0] / upp, p.pts[1] / upp);
        for (let i = 2; i < p.pts.length; i += 2) x.lineTo(p.pts[i] / upp, p.pts[i + 1] / upp);
        x.closePath(); x.fill();
      }
      const d = x.getImageData(0, 0, W, H).data;
      const m = new Uint8Array(W * H);
      for (let i = 0, j = 0; i < d.length; i += 4, j++) m[j] = d[i] > 127 ? 1 : 0;
      return m;
    };

    const landM = mk(world.islands);
    const reefM = mk(world.reefs);
    const solid = new Uint8Array(W * H);
    for (let i = 0; i < solid.length; i++) solid[i] = landM[i] | reefM[i];

    const distOut = chamfer(solid, W, H, 0);   // distance from water to nearest solid
    const distIn  = chamfer(landM, W, H, 1);   // distance from land to nearest water

    const outScale = OFFSHORE / upp;
    const inScale  = INLAND / upp;
    const data = new Uint8Array(W * H * 4);
    for (let i = 0, o = 0; i < W * H; i++, o += 4) {
      data[o]     = landM[i] * 255;
      data[o + 1] = Math.min(255, (distOut[i] / outScale) * 255);
      data[o + 2] = reefM[i] * 255;
      data[o + 3] = Math.min(255, (distIn[i] / inScale) * 255);
    }
    if (this.depthTex) gl.deleteTexture(this.depthTex);
    this.depthTex = texFromData(gl, W, H, data, { filter: gl.LINEAR });

    this.buildLandGeometry(world);
    this.buildControl(null);
  }

  buildLandGeometry(world) {
    const gl = this.gl;
    const verts = [];
    const push = (list, kind) => {
      for (const p of list) {
        const n = p.pts.length / 2;
        let cx = 0, cy = 0;
        for (let i = 0; i < p.pts.length; i += 2) { cx += p.pts[i]; cy += p.pts[i + 1]; }
        cx /= n; cy /= n;
        for (let i = 0; i < n; i++) {
          const a = i * 2, b = ((i + 1) % n) * 2;
          verts.push(cx, cy, kind, p.pts[a], p.pts[a + 1], kind, p.pts[b], p.pts[b + 1], kind);
        }
      }
    };
    this.reefStart = 0;
    push(world.reefs, 1);
    this.reefCount = verts.length / 3;
    push(world.islands, 0);
    this.landCount = verts.length / 3 - this.reefCount;

    if (!this.landVao) {
      this.landVao = gl.createVertexArray();
      this.landBuf = gl.createBuffer();
    }
    gl.bindVertexArray(this.landVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.landBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 12, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 12, 8);
    gl.bindVertexArray(null);
  }

  /** Paint who controls which water. Cheap, and regenerated only on a change. */
  buildControl(holds) {
    const gl = this.gl;
    const W = 192, H = Math.max(2, Math.round(W * this.world.h / this.world.w));
    if (!this.ctrlCanvas) {
      this.ctrlCanvas = document.createElement('canvas');
      this.ctrlCanvas.width = W; this.ctrlCanvas.height = H;
    }
    const x = this.ctrlCanvas.getContext('2d');
    x.clearRect(0, 0, W, H);
    x.fillStyle = '#000'; x.fillRect(0, 0, W, H);
    if (holds) {
      const sx = W / this.world.w, sy = H / this.world.h;
      x.globalCompositeOperation = 'lighter';
      for (const h of this.world.holds) {
        const st = holds.find(hh => hh.id === h.id);
        if (!st || !st.o) continue;
        const R = 1550 * sx;
        const g = x.createRadialGradient(h.x * sx, h.y * sy, R * 0.12, h.x * sx, h.y * sy, R);
        const col = st.o === 'scarlet' ? '255,0,0' : '0,255,0';
        g.addColorStop(0, `rgba(${col},0.95)`);
        g.addColorStop(1, `rgba(${col},0)`);
        x.fillStyle = g;
        x.beginPath(); x.arc(h.x * sx, h.y * sy, R, 0, Math.PI * 2); x.fill();
      }
      x.globalCompositeOperation = 'source-over';
    }
    if (this.ctrlTex) gl.deleteTexture(this.ctrlTex);
    this.ctrlTex = texFromCanvas(gl, this.ctrlCanvas, { filter: gl.LINEAR });
  }

  resize(w, h, dpr) {
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    this.w = w; this.h = h; this.dpr = dpr;
    this.canvas.width = w; this.canvas.height = h;
    this.sceneT.resize(w, h);
    const bw = Math.max(2, w >> 1), bh = Math.max(2, h >> 1);
    this.brightT.resize(bw, bh);
    this.blurA.resize(bw, bh);
    this.blurB.resize(bw, bh);
  }

  shock(sx, sy, strength = 1) { this.shocks.push({ x: sx, y: sy, t: 0, s: strength }); }

  /** World point -> screen pixel. */
  toScreen(wx, wy) {
    return [(wx - this.cam.x) * this.cam.zoom + this.w / 2,
            (wy - this.cam.y) * this.cam.zoom + this.h / 2];
  }
  toWorld(sx, sy) {
    return [(sx - this.w / 2) / this.cam.zoom + this.cam.x,
            (sy - this.h / 2) / this.cam.zoom + this.cam.y];
  }

  // -- frame -----------------------------------------------------------------
  beginFrame(dt, env) {
    this.time += dt;
    this.env = env;
    for (let i = this.shocks.length - 1; i >= 0; i--) {
      this.shocks[i].t += dt * 1.9;
      if (this.shocks[i].t >= 1) this.shocks.splice(i, 1);
    }
    this.flash = Math.max(0, this.flash - dt * 3.4);
  }

  /** Draw ocean + land. Sprites are queued by the caller between the two. */
  drawWorld() {
    const gl = this.gl;
    this.sceneT.bind(true);

    const e = this.env;
    const p = this.pOcean.use();
    p.v2('uRes', this.w, this.h).v2('uCam', this.cam.x, this.cam.y)
     .f('uInvZoom', 1 / this.cam.zoom).v2('uWorld', this.world.w, this.world.h)
     .f('uTime', this.time).v2('uWind', Math.cos(e.windDir), Math.sin(e.windDir))
     .f('uWindSpd', e.windSpeed).f('uDawn', e.dawn || 0)
     .v3('uTeamA', 0.94, 0.30, 0.26).v3('uTeamB', 0.24, 0.66, 0.95)
     .tex('uDepth', this.depthTex).tex('uNoise', this.noiseTex).tex('uCtrl', this.ctrlTex);
    const sq = e.squalls || [];
    for (let i = 0; i < 4; i++) {
      const s = sq[i];
      gl.uniform4f(p.loc(`uSq[${i}]`), s ? s.x : 0, s ? s.y : 0, s ? s.r : 0, s ? (s.k ?? 1) : 0);
    }
    gl.blendFunc(gl.ONE, gl.ZERO);
    this.fs.draw();
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const lp = this.pLand.use();
    lp.v2('uRes', this.w, this.h).v2('uCam', this.cam.x, this.cam.y)
      .f('uZoom', this.cam.zoom).v2('uWorld', this.world.w, this.world.h)
      .f('uTime', this.time).f('uInvZoom', 1 / this.cam.zoom)
      .tex('uDepth', this.depthTex).tex('uNoise', this.noiseTex);
    gl.bindVertexArray(this.landVao);
    if (this.reefCount) gl.drawArrays(gl.TRIANGLES, 0, this.reefCount);
    if (this.landCount) gl.drawArrays(gl.TRIANGLES, this.reefCount, this.landCount);
    gl.bindVertexArray(null);
  }

  endFrame() {
    const gl = this.gl;
    this.flushSprites('base');
    this.flushSprites('add');

    // --- bloom ---------------------------------------------------------------
    this.brightT.bind(true);
    gl.blendFunc(gl.ONE, gl.ZERO);
    this.pBright.use().tex('uSrc', this.sceneT.tex).f('uThresh', 0.55);
    this.fs.draw();

    let src = this.brightT;
    for (let i = 0; i < 2; i++) {
      this.blurA.bind(true);
      this.pBlur.use().tex('uSrc', src.tex).v2('uDir', (1.35 + i * 1.7) / this.blurA.w, 0);
      this.fs.draw();
      this.blurB.bind(true);
      this.pBlur.use().tex('uSrc', this.blurA.tex).v2('uDir', 0, (1.35 + i * 1.7) / this.blurB.h);
      this.fs.draw();
      src = this.blurB;
    }

    // --- composite -----------------------------------------------------------
    bindScreen(gl, this.w, this.h);
    const p = this.pPost.use();
    p.tex('uScene', this.sceneT.tex).tex('uBloom', src.tex)
     .v2('uRes', this.w, this.h).f('uTime', this.time)
     .f('uBloomK', 1.15).f('uFlash', this.flash)
     .v3('uFlashCol', this.flashCol[0], this.flashCol[1], this.flashCol[2])
     .f('uDamage', this.damage).f('uDesat', this.desat).i('uDebug', this.debug | 0);
    for (let i = 0; i < 6; i++) {
      const s = this.shocks[i];
      gl.uniform4f(p.loc(`uShock[${i}]`), s ? s.x : 0, s ? s.y : 0, s ? s.t : 0, s ? s.s : 0);
    }
    this.fs.draw();
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }
}

export const WHITE = [1, 1, 1, 1];

/**
 * Two-pass chamfer distance transform. `target` selects which value counts as
 * "inside" — distance is measured from every other pixel to the nearest one.
 * Weights 3/4 approximate Euclidean closely enough for a shoreline.
 */
function chamfer(mask, W, H, target) {
  const INF = 1e7;
  const d = new Float32Array(W * H);
  for (let i = 0; i < d.length; i++) d[i] = mask[i] === target ? INF : 0;
  const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H) ? INF : d[y * W + x];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (d[i] === 0) continue;
      let v = d[i];
      v = Math.min(v, at(x - 1, y - 1) + 4, at(x, y - 1) + 3, at(x + 1, y - 1) + 4, at(x - 1, y) + 3);
      d[i] = v;
    }
  }
  for (let y = H - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      if (d[i] === 0) continue;
      let v = d[i];
      v = Math.min(v, at(x + 1, y + 1) + 4, at(x, y + 1) + 3, at(x - 1, y + 1) + 4, at(x + 1, y) + 3);
      d[i] = v;
    }
  }
  for (let i = 0; i < d.length; i++) d[i] /= 3;   // back into pixel units
  return d;
}
