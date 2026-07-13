// A single-context WebGL2 renderer for one waveform (glsl) candidate. Compiles in
// isolation — a bad shader returns an error string and never tears down the app. The
// fullscreen-triangle VERT + uData texture + uniform contract mirror the material lab,
// so a shader authored here ports to the real shell unchanged.

import { UNIFORMS, type Params } from "../reference/params";
import type { FixtureData } from "../kit/fixtures";

const VERT = `#version 300 es
void main(){ vec2 p=vec2((gl_VertexID<<1)&2, gl_VertexID&2); gl_Position=vec4(p*2.0-1.0,0.,1.); }`;

const RUNTIME = ["uRes", "uTime", "uPlayhead", "uPlaying", "uMode", "uCount", "uNCols", "uBeats", "uData"] as const;

const hx2v = (h: string): [number, number, number] => [
  parseInt(h.slice(1, 3), 16) / 255,
  parseInt(h.slice(3, 5), 16) / 255,
  parseInt(h.slice(5, 7), 16) / 255,
];

export interface GlslRenderer {
  setParams(p: Params): void;
  setFixture(f: FixtureData): void;
  render(time: number, playhead: number, playing: boolean): number; // returns last frame ms
  dispose(): void;
}

export interface GlslCreateResult {
  renderer?: GlslRenderer;
  error?: string;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s) || "compile failed";
    gl.deleteShader(s);
    throw new Error(log);
  }
  return s;
}

export function createGlslRenderer(canvas: HTMLCanvasElement, frag: string, params: Params): GlslCreateResult {
  const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, premultipliedAlpha: false });
  if (!gl) return { error: "WebGL2 unavailable" };

  let prog: WebGLProgram;
  try {
    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, frag);
    prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || "link failed");
    gl.deleteShader(vs);
    gl.deleteShader(fs);
  } catch (e) {
    return { error: String((e as Error).message || e) };
  }
  gl.useProgram(prog);

  const U: Record<string, WebGLUniformLocation | null> = {};
  for (const n of RUNTIME) U[n] = gl.getUniformLocation(prog, n);
  for (const b of UNIFORMS) U[b.uniform] = gl.getUniformLocation(prog, b.uniform);

  const tex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.uniform1i(U.uData!, 0);

  let p: Params = params;
  let fix: FixtureData = { mode: 0, w: 1, data: new Float32Array(4), count: 0, ncols: 192, beats: 16 };
  let disposed = false;

  const uploadFixture = () => {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, fix.w, 1, 0, gl.RGBA, gl.FLOAT, fix.data);
  };

  const applyParams = () => {
    for (const b of UNIFORMS) {
      const loc = U[b.uniform];
      if (!loc) continue;
      const v = p[b.key];
      if (b.type === "color") gl.uniform3fv(loc, hx2v(String(v)));
      else if (b.type === "int") gl.uniform1i(loc, Number(v) | 0);
      else gl.uniform1f(loc, Number(v));
    }
  };

  const resize = () => {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
  };

  return {
    renderer: {
      setParams(next) {
        p = next;
      },
      setFixture(f) {
        fix = f;
        uploadFixture();
      },
      render(time, playhead, playing) {
        if (disposed || gl.isContextLost()) return 0;
        const t0 = performance.now();
        resize();
        gl.useProgram(prog);
        gl.uniform2f(U.uRes!, canvas.width, canvas.height);
        gl.uniform1f(U.uTime!, time);
        gl.uniform1f(U.uPlayhead!, playhead);
        gl.uniform1f(U.uPlaying!, playing ? 1 : 0);
        gl.uniform1i(U.uMode!, fix.mode);
        gl.uniform1i(U.uCount!, fix.count);
        gl.uniform1f(U.uNCols!, fix.ncols);
        gl.uniform1f(U.uBeats!, fix.beats);
        applyParams();
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        return performance.now() - t0;
      },
      dispose() {
        disposed = true;
        gl.deleteTexture(tex);
        gl.deleteProgram(prog);
        const lose = gl.getExtension("WEBGL_lose_context");
        lose?.loseContext();
      },
    },
  };
}
