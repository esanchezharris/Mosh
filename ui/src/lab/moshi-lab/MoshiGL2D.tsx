// Candidate C — the trimmed 2D shader. One WebGL1 fragment shader with a 2D SDF of the
// EXACT MoshMark silhouette (smin union of the same six circles), flat-sticker shading by
// default, and a mode toggle that walks the look range the owner asked about:
//   flat      → the pure sticker (candidate A's twin, GPU-drawn)
//   porcelain → fake-3D clay: SDF-gradient pseudo-normals, banded diffuse, soft spec,
//               rim AO — the ChatGPT clay render's look WITHOUT the 3D raymarcher
//   ps2       → porcelain + low-res pixel grid + Bayer dither + band quantization: the
//               current moshi.js texture, recovered at ~1/7 of the code
// Same shared brain as candidate A: the pose lands here as uniforms.

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import {
  MoshiBrain, mouthShape, type MoshiBody, type MoshiDriveKey, type MoshiStateName,
} from "./moshiModel";

export type MoshiGLMode = "flat" | "porcelain" | "ps2";
export const GL_MODES: readonly MoshiGLMode[] = ["flat", "porcelain", "ps2"];

const VERT = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FRAG = `
precision highp float;
uniform vec2  u_res;
uniform vec2  u_sq;                    // squash sx, sy
uniform float u_y, u_rot;              // bounce offset + lean
uniform vec2  u_gaze;
uniform float u_blink;
uniform vec4  u_mouth;                 // cx, cy, hw, depth
uniform float u_throat;                // throat visibility 0..1
uniform float u_lobes[5];
uniform float u_heat;
uniform float u_mode;                  // 0 flat · 1 porcelain · 2 ps2

float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}
float sdSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}
float bayer(vec2 fc) {
  fc = floor(fc);
  float b = mod(fc.x, 2.0) * 2.0 + mod(fc.y, 2.0);
  vec2 f2 = floor(fc / 2.0);
  return (b * 4.0 + mod(f2.x, 2.0) * 2.0 + mod(f2.y, 2.0)) / 16.0;
}
float bodySD(vec2 p) {
  float d = length(p - vec2(50.0, 50.0)) - 23.0;
  d = smin(d, length(p - vec2(50.0, 30.0)) - 22.0 * u_lobes[0], 6.0);
  d = smin(d, length(p - vec2(69.0, 43.8)) - 22.0 * u_lobes[1], 6.0);
  d = smin(d, length(p - vec2(61.8, 66.2)) - 22.0 * u_lobes[2], 6.0);
  d = smin(d, length(p - vec2(38.2, 66.2)) - 22.0 * u_lobes[3], 6.0);
  d = smin(d, length(p - vec2(31.0, 43.8)) - 22.0 * u_lobes[4], 6.0);
  return d;
}
float chevSD(vec2 p) { // left chevron; the right one is the x-mirror around 50
  vec2 q = vec2(min(p.x, 100.0 - p.x), p.y);
  return min(sdSeg(q, vec2(37.0, 41.0), vec2(45.0, 47.5)),
             sdSeg(q, vec2(45.0, 47.5), vec2(37.0, 54.0))) - 2.6;
}
float mouthSD(vec2 p) {
  float cx = u_mouth.x, cy = u_mouth.y, hw = u_mouth.z, depth = u_mouth.w;
  float top = sdSeg(p, vec2(cx - hw, cy), vec2(cx + hw, cy)) - (1.1 + depth * 0.12);
  float bot = length(p - vec2(cx, cy + depth * 0.55)) - max(0.7, depth * 0.52);
  return smin(top, bot, 2.5);
}

void main() {
  vec2 p = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y) / u_res * 100.0;
  if (u_mode > 1.5) p = floor(p / 1.35) * 1.35 + 0.675; // ps2: the low-res buffer

  // inverse pose transform (bounce + lean + squash) around the viewBox center
  vec2 q = p - vec2(50.0, 50.0 + u_y);
  float cr = cos(-u_rot), sr = sin(-u_rot);
  q = mat2(cr, -sr, sr, cr) * q;
  q /= u_sq;
  q += vec2(50.0, 50.0);

  float d = bodySD(q);
  if (d > 3.4) discard;

  vec3 INK  = vec3(0.082, 0.082, 0.082);
  vec3 BONE = vec3(0.965, 0.949, 0.922);
  vec3 LIME = vec3(0.800, 1.000, 0.137);

  // ── body shading ──
  vec3 body = INK;
  if (u_mode > 0.5) {
    float e = 0.9;
    vec2 g = vec2(bodySD(q + vec2(e, 0.0)) - bodySD(q - vec2(e, 0.0)),
                  bodySD(q + vec2(0.0, e)) - bodySD(q - vec2(0.0, e)));
    vec3 n = normalize(vec3(-g * 0.9, 1.0));
    vec3 L = normalize(vec3(-0.45, -0.62, 0.72)); // key light, top-left (y-down space)
    float diff = clamp(dot(n, L), 0.0, 1.0);
    if (u_mode > 1.5) diff = floor(diff * 3.0) / 3.0; // ps2 banded light
    float core = smoothstep(0.0, -14.0, d);           // 1 deep inside the silhouette
    // relief: the puffy lobes catch the key light, the flat face plate stays dark
    // (that's the reference clay render — charcoal middle, lit rounded edges)
    float relief = smoothstep(-18.0, -1.5, d);
    float lift = pow(diff, 1.6) * (0.12 * core + relief);
    body = INK + vec3(0.52, 0.52, 0.54) * lift * 0.7;
    float spec = pow(clamp(dot(reflect(-L, n), vec3(0.0, 0.0, 1.0)), 0.0, 1.0), 34.0) * relief;
    body += spec * (u_mode > 1.5 ? 0.4 : 0.16);
    body *= 0.6 + 0.4 * smoothstep(0.0, -6.0, d);     // rim AO
    if (u_mode > 1.5) {
      body += (bayer(gl_FragCoord.xy) - 0.5) * 0.07;  // ordered dither
      body = floor(body * 6.0 + 0.5) / 6.0;           // band quantization
    }
  }
  body = mix(body, LIME, u_heat * smoothstep(-8.0, 0.0, d) * 0.55); // REC heat glow

  // ── face (flat on top of the body, like the sticker) ──
  vec2 f = q - u_gaze * vec2(3.4, 2.4);
  vec2 fe = f;
  fe.y = 47.5 + (fe.y - 47.5) / max(0.06, 1.0 - u_blink); // lid-squash blink
  float de = chevSD(fe);
  float dm = mouthSD(f);
  float dt = length((f - vec2(u_mouth.x, u_mouth.y + u_mouth.w * 0.66)) *
                    vec2(1.0, 0.78)) - max(0.6, u_mouth.w * 0.3);
  float aa = 0.9;
  vec3 col = body;
  col = mix(col, LIME, smoothstep(aa, -aa, dm));
  col = mix(col, INK, smoothstep(aa, -aa, dt) * u_throat);
  col = mix(col, BONE, smoothstep(aa, -aa, de));

  // sticker rim ring outside the body, then the outer cut
  float m = smoothstep(0.6, -0.6, d);
  col = mix(BONE * 0.92, col, m);
  float alpha = smoothstep(3.4, 2.0, d);
  gl_FragColor = vec4(col, alpha);
}
`;

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.warn("MoshiGL2D shader:", gl.getShaderInfoLog(sh));
    return null;
  }
  return sh;
}

export const MoshiGL2D = forwardRef<MoshiBody, {
  size?: number;
  mode?: MoshiGLMode;
  interactive?: boolean;
}>(({ size = 260, mode = "porcelain", interactive = true }, ref) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const brainRef = useRef<MoshiBrain | null>(null);
  if (!brainRef.current) brainRef.current = new MoshiBrain();
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const cpu = useRef(0);

  useImperativeHandle(ref, (): MoshiBody => ({
    set(key: MoshiDriveKey, v: number) { brainRef.current?.set(key, v); },
    setState(s: MoshiStateName) { brainRef.current?.setState(s); },
    poke() { brainRef.current?.poke(); },
    celebrate() { brainRef.current?.celebrate(); },
    lookAt(nx: number, ny: number) { brainRef.current?.lookAt(nx, ny); },
    speak(on: boolean) { brainRef.current?.speak(on); },
    cpuMs() { return cpu.current; },
    destroy() { /* rAF cleanup owns teardown */ },
  }), []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    const gl = canvas.getContext("webgl", { alpha: true, antialias: true, premultipliedAlpha: false });
    if (!gl) return; // no GL → the lab card shows the canvas blank but stays alive

    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return;
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, "a_pos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);

    const U = (n: string) => gl.getUniformLocation(prog, n);
    const uRes = U("u_res"), uSq = U("u_sq"), uY = U("u_y"), uRot = U("u_rot");
    const uGaze = U("u_gaze"), uBlink = U("u_blink"), uMouth = U("u_mouth");
    const uThroat = U("u_throat"), uLobes = U("u_lobes[0]"), uHeat = U("u_heat"), uMode = U("u_mode");
    const lobesArr = new Float32Array(5);
    const modeNum = (m: MoshiGLMode) => (m === "flat" ? 0 : m === "porcelain" ? 1 : 2);

    const brain = brainRef.current!;
    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      const t0 = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const p = brain.tick(dt);
      const m = mouthShape(p.mouthOpen, p.mouthWide, p.smile);
      for (let i = 0; i < 5; i++) lobesArr[i] = p.lobes[i];

      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform2f(uSq, p.sx, p.sy);
      gl.uniform1f(uY, p.y);
      gl.uniform1f(uRot, p.rot);
      gl.uniform2f(uGaze, p.gazeX, p.gazeY);
      gl.uniform1f(uBlink, p.blink);
      gl.uniform4f(uMouth, m.cx, m.cy, m.hw, m.depth);
      gl.uniform1f(uThroat, m.throatOpacity);
      gl.uniform1fv(uLobes, lobesArr);
      gl.uniform1f(uHeat, p.heat);
      gl.uniform1f(uMode, modeNum(modeRef.current));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      cpu.current += (performance.now() - t0 - cpu.current) * 0.05;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      // NOTE: no loseContext() here — dev StrictMode double-mounts effects, and a lost
      // context poisons the canvas for the second mount (getContext returns the dead
      // one). The two lab canvases are cheap; the GC reclaims them with the page.
      cancelAnimationFrame(raf);
    };
  }, [size]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: size, height: size, display: "block", cursor: interactive ? "pointer" : "default" }}
      role="img"
      aria-label="Moshi — 2D shader candidate"
      onClick={interactive ? () => brainRef.current?.poke() : undefined}
    />
  );
});
MoshiGL2D.displayName = "MoshiGL2D";
