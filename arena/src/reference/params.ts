// ============================================================================
// WAVEFORM MATERIAL CONTRACT — the param schema every waveform candidate speaks.
// SINGLE SOURCE OF TRUTH: the harness, the tuner, and the model refine-validator all
// import this. Ported verbatim from mosh-material-lab-v3. Adding a param = editing
// this one file. A winning look = referenceShader.glsl (or a variant) + a Params set.
// ============================================================================

export type ParamValue = number | string;
export type Params = Record<string, ParamValue>;

// full default schema — every key present so presets are hermetic
export const DEF: Params = {
  colorMode: 0, low: "#ff4d3d", mid: "#f5b942", high: "#55c8ff", mono: "#e6ecf7",
  duoA: "#ff2e97", duoB: "#22d3ee", bg: "#08090d", glow: "#8fb8ff", glowFollow: 0,
  goo: 0.55, weld: 0.18, merge: 0.25, glass: 0, metal: 0.3, gloss: 0.4, rim: 0.6, half: 0, grain: 0.25, fill: 1,
  wake: 0.8, trail: 0.12, flow: 0.2, flowSpd: 0.4, idle: 0.15,
  thick: 0.8, sym: 1, rhythm: 0.6, noteH: 1, atk: 0.006, rel: 0.08, hitR: 1, pulse: 0.7,
};

export type UniformType = "color" | "int" | "float";
export interface UniformBinding { key: string; uniform: string; type: UniformType; }

// key → GLSL uniform + upload type. Runtime uniforms (uRes/uTime/uPlayhead/uPlaying/
// uMode/uCount/uNCols/uBeats/uData) are driven by the harness, not by Params.
export const UNIFORMS: UniformBinding[] = [
  { key: "colorMode", uniform: "uColorMode", type: "int" },
  { key: "low", uniform: "uLow", type: "color" }, { key: "mid", uniform: "uMid", type: "color" },
  { key: "high", uniform: "uHigh", type: "color" }, { key: "mono", uniform: "uMono", type: "color" },
  { key: "duoA", uniform: "uDuoA", type: "color" }, { key: "duoB", uniform: "uDuoB", type: "color" },
  { key: "bg", uniform: "uBg", type: "color" }, { key: "glow", uniform: "uGlow", type: "color" },
  { key: "glowFollow", uniform: "uGlowFollow", type: "float" },
  { key: "goo", uniform: "uGoo", type: "float" }, { key: "weld", uniform: "uWeld", type: "float" },
  { key: "merge", uniform: "uMerge", type: "float" }, { key: "glass", uniform: "uGlass", type: "float" },
  { key: "metal", uniform: "uMetal", type: "float" }, { key: "gloss", uniform: "uGloss", type: "float" },
  { key: "rim", uniform: "uRim", type: "float" }, { key: "half", uniform: "uHalf", type: "float" },
  { key: "grain", uniform: "uGrain", type: "float" }, { key: "fill", uniform: "uFill", type: "float" },
  { key: "wake", uniform: "uWake", type: "float" }, { key: "trail", uniform: "uTrail", type: "float" },
  { key: "flow", uniform: "uFlow", type: "float" }, { key: "flowSpd", uniform: "uFlowSpd", type: "float" },
  { key: "idle", uniform: "uIdle", type: "float" }, { key: "thick", uniform: "uThick", type: "float" },
  { key: "sym", uniform: "uSym", type: "float" }, { key: "rhythm", uniform: "uRhythm", type: "float" },
  { key: "noteH", uniform: "uNoteH", type: "float" }, { key: "atk", uniform: "uAtk", type: "float" },
  { key: "rel", uniform: "uRel", type: "float" }, { key: "hitR", uniform: "uHitR", type: "float" },
  { key: "pulse", uniform: "uPulse", type: "float" },
];

export type ControlType = "range" | "color" | "seg" | "toggle";
export interface Control {
  key: string; type: ControlType; label: string;
  min?: number; max?: number; step?: number; opts?: string[];
}

// the tuner surface — kept lean (the lab's TUNE + swatches), min/max used to CLAMP
// model-proposed param sets so a bad number can never break rendering.
export const CONTROLS: Control[] = [
  { key: "colorMode", type: "seg", label: "PALETTE", opts: ["SPECTRAL", "MONO", "DUO"] },
  { key: "rhythm", type: "range", label: "RHYTHM EMPHASIS", min: 0, max: 1, step: 0.01 },
  { key: "goo", type: "range", label: "GOO · audio", min: 0, max: 1, step: 0.01 },
  { key: "wake", type: "range", label: "PLAYHEAD WAKE", min: 0, max: 1, step: 0.01 },
  { key: "metal", type: "range", label: "METAL", min: 0, max: 1, step: 0.01 },
  { key: "gloss", type: "range", label: "GLOSS", min: 0, max: 1, step: 0.01 },
  { key: "glass", type: "range", label: "GLASS", min: 0, max: 1, step: 0.01 },
  { key: "flow", type: "range", label: "INNER FLOW", min: 0, max: 1, step: 0.01 },
  { key: "fill", type: "range", label: "BODY FILL", min: 0.2, max: 1, step: 0.01 },
  { key: "half", type: "toggle", label: "HALFTONE" },
  { key: "grain", type: "range", label: "GRAIN", min: 0, max: 1, step: 0.01 },
  { key: "weld", type: "range", label: "WELD · midi", min: 0, max: 1, step: 0.01 },
  { key: "merge", type: "range", label: "MERGE · drums", min: 0, max: 1, step: 0.01 },
  { key: "pulse", type: "range", label: "PULSE · drums", min: 0, max: 1, step: 0.01 },
];

export const SWATCHES: [string, string][] = [
  ["low", "LOW"], ["mid", "MID"], ["high", "HIGH"], ["mono", "MONO"],
  ["duoA", "DUO A"], ["duoB", "DUO B"], ["bg", "BACKDROP"], ["glow", "GLOW"],
];

const mk = (o: Params): Params => ({ ...DEF, ...o });

// The three hermetic anchors from the lab — complete param sets, good seed looks.
export const ANCHORS: Record<string, { chip: string; ds: string; p: Params }> = {
  "LIQUID MERCURY": {
    chip: "#cfd8ea", ds: "chrome liquid · rhythm-swelled · minimal color",
    p: mk({ colorMode: 1, mono: "#e6ecf7", metal: 0.85, gloss: 0.7, rim: 0.75, goo: 1, glass: 0.14, wake: 0.9, flow: 0.12, rhythm: 0.7, grain: 0.14, bg: "#070a10", glow: "#a8c4ff" }),
  },
  "SPECTRAL INK": {
    chip: "#ff8a3d", ds: "3-band color · semi-liquid · beats read clearly",
    p: mk({ colorMode: 0, low: "#ff3b30", mid: "#34c759", high: "#4cc9ff", goo: 0.42, metal: 0.18, gloss: 0.34, rim: 0.55, glass: 0, wake: 0.72, flow: 0.14, rhythm: 0.85, grain: 0.22, bg: "#080a0e", glow: "#6fd3ff" }),
  },
  "RISO GLASS": {
    chip: "#ff5a4d", ds: "print halftone × refraction · flat-meets-liquid",
    p: mk({ colorMode: 2, duoA: "#141414", duoB: "#ff4438", bg: "#efe7d6", half: 1, grain: 0.4, goo: 0.3, weld: 0.1, glass: 0.5, metal: 0.12, gloss: 0.2, rim: 0.4, wake: 0.5, rhythm: 0.6, flow: 0.1, glow: "#ff8a5c" }),
  },
};

/** Clamp + type-coerce a proposed param set against the schema so it can never break
 *  rendering (the arena's Refine safety guarantee). Unknown keys dropped. */
export function sanitizeParams(input: Partial<Params>): Params {
  const out: Params = { ...DEF };
  for (const [k, v] of Object.entries(input)) {
    if (!(k in DEF)) continue;
    const ctl = CONTROLS.find((c) => c.key === k);
    if (typeof DEF[k] === "string") {
      if (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v)) out[k] = v;
    } else {
      let n = typeof v === "number" ? v : parseFloat(String(v));
      if (!Number.isFinite(n)) continue;
      if (ctl && ctl.min != null && ctl.max != null) n = Math.max(ctl.min, Math.min(ctl.max, n));
      out[k] = n;
    }
  }
  return out;
}
