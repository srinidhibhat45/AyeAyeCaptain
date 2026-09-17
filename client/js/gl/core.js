// ============================================================================
//  Thin WebGL2 helpers. Nothing clever — just enough structure that the
//  renderer can read like drawing code instead of state-machine bookkeeping.
// ============================================================================

export function initGL(canvas) {
  const gl = canvas.getContext('webgl2', {
    alpha: false, antialias: false, depth: false, stencil: false,
    premultipliedAlpha: false, powerPreference: 'high-performance',
    preserveDrawingBuffer: false, desynchronized: true,
  });
  if (!gl) return null;
  gl.getExtension('EXT_color_buffer_float');
  gl.getExtension('OES_texture_float_linear');
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);
  gl.enable(gl.BLEND);
  gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  return gl;
}

function compile(gl, type, src, label) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    const numbered = src.split('\n').map((l, i) => `${String(i + 1).padStart(3)} | ${l}`).join('\n');
    console.error(`[${label}] shader failed:\n${log}\n${numbered}`);
    throw new Error(`${label}: ${log}`);
  }
  return sh;
}

export class Program {
  constructor(gl, vs, fs, label = 'program') {
    this.gl = gl;
    this.p = gl.createProgram();
    const v = compile(gl, gl.VERTEX_SHADER, vs, label + '.vs');
    const f = compile(gl, gl.FRAGMENT_SHADER, fs, label + '.fs');
    gl.attachShader(this.p, v); gl.attachShader(this.p, f);
    gl.linkProgram(this.p);
    if (!gl.getProgramParameter(this.p, gl.LINK_STATUS)) {
      throw new Error(`${label} link: ${gl.getProgramInfoLog(this.p)}`);
    }
    gl.deleteShader(v); gl.deleteShader(f);
    this.u = new Map();
    this.units = 0;
  }
  use() { this.gl.useProgram(this.p); this.units = 0; return this; }
  loc(name) {
    if (!this.u.has(name)) this.u.set(name, this.gl.getUniformLocation(this.p, name));
    return this.u.get(name);
  }
  f(n, v)      { this.gl.uniform1f(this.loc(n), v); return this; }
  i(n, v)      { this.gl.uniform1i(this.loc(n), v); return this; }
  v2(n, x, y)  { this.gl.uniform2f(this.loc(n), x, y); return this; }
  v3(n, x, y, z) { this.gl.uniform3f(this.loc(n), x, y, z); return this; }
  v4(n, x, y, z, w) { this.gl.uniform4f(this.loc(n), x, y, z, w); return this; }
  tex(n, texture) {
    const gl = this.gl, unit = this.units++;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(this.loc(n), unit);
    return this;
  }
}

/** A single fullscreen triangle. Cheaper and seam-free versus two triangles. */
export class FullScreen {
  constructor(gl) {
    this.gl = gl;
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }
  draw() {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

export function makeTexture(gl, opts = {}) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  const wrap = opts.wrap || gl.CLAMP_TO_EDGE;
  const filter = opts.filter || gl.LINEAR;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, opts.mips ? gl.LINEAR_MIPMAP_LINEAR : filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  return t;
}

export function texFromCanvas(gl, canvas, opts = {}) {
  const t = makeTexture(gl, opts);
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  if (opts.mips) gl.generateMipmap(gl.TEXTURE_2D);
  return t;
}

export function texFromData(gl, w, h, data, opts = {}) {
  const t = makeTexture(gl, opts);
  gl.bindTexture(gl.TEXTURE_2D, t);
  const internal = opts.float ? gl.RGBA16F : gl.RGBA8;
  const type = opts.float ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, gl.RGBA, type, data);
  if (opts.mips) gl.generateMipmap(gl.TEXTURE_2D);
  return t;
}

/** An offscreen render target that can be resized. */
export class Target {
  constructor(gl, w, h, opts = {}) {
    this.gl = gl;
    this.opts = opts;
    this.fbo = gl.createFramebuffer();
    this.tex = makeTexture(gl, { filter: gl.LINEAR });
    this.resize(w, h);
  }
  resize(w, h) {
    w = Math.max(1, w | 0); h = Math.max(1, h | 0);
    if (w === this.w && h === this.h) return this;
    const gl = this.gl;
    this.w = w; this.h = h;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    const internal = this.opts.float ? gl.RGBA16F : gl.RGBA8;
    const type = this.opts.float ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, gl.RGBA, type, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return this;
  }
  bind(clear = true) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.w, this.h);
    if (clear) { gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
    return this;
  }
}

export function bindScreen(gl, w, h) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, w, h);
}

/** Shared GLSL prelude: noise and a few small utilities. */
export const GLSL_COMMON = /* glsl */`
float hash11(float p){ p=fract(p*0.1031); p*=p+33.33; p*=p+p; return fract(p); }
float hash12(vec2 p){ vec3 p3=fract(vec3(p.xyx)*0.1031); p3+=dot(p3,p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
vec2 hash22(vec2 p){
  vec3 p3=fract(vec3(p.xyx)*vec3(0.1031,0.1030,0.0973));
  p3+=dot(p3,p3.yzx+33.33);
  return fract((p3.xx+p3.yz)*p3.zy);
}
float vnoise(vec2 p){
  vec2 i=floor(p), f=fract(p);
  vec2 u=f*f*(3.0-2.0*f);
  float a=hash12(i), b=hash12(i+vec2(1,0)), c=hash12(i+vec2(0,1)), d=hash12(i+vec2(1,1));
  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y);
}
float fbm(vec2 p, int oct){
  float v=0.0, a=0.5;
  mat2 rot=mat2(0.80,0.60,-0.60,0.80);
  for(int i=0;i<8;i++){
    if(i>=oct) break;
    v+=a*vnoise(p); p=rot*p*2.03; a*=0.5;
  }
  return v;
}
float sstep(float a, float b, float x){ return smoothstep(a,b,x); }
// The scene is authored in display space, so the only job here is to stop
// bright things clipping flat. Everything below the knee passes through
// untouched; above it, highlights roll off smoothly toward white.
const float KNEE = 0.78;
vec3 tonemap(vec3 c){
  c = max(vec3(0.0), c);
  vec3 over = max(vec3(0.0), c - KNEE);
  return min(c, vec3(KNEE)) + (1.0 - KNEE) * (vec3(1.0) - exp(-over / (1.0 - KNEE)));
}
`;
