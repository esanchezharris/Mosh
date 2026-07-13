// The candidate contract. A candidate is a self-contained rendered LOOK — either an
// HTML document (a component or whole-shell mockup, sandboxed in an iframe) or a GLSL
// fragment shader (the waveform material, over the uniform contract). Everything the
// judging UI, the library, and the porting step need travels on this one shape.

import type { Params } from "../reference/params";
import type { Theme } from "../kit/tokens";

export type Pass = "elevate" | "bolder";
export type CandidateKind = "html" | "glsl";

// what the candidate redesigns. 'waveform' (the clip MATERIAL, audio/midi/drums) is glsl;
// the rest are html. 'moshi' + 'stage' candidates may mount the real Moshi creature.
export type Target =
  | "shell" | "moshi" | "stage" | "waveform"
  | "transport" | "trackHeader" | "clip" | "composer" | "inspector" | "button"
  | "companion";

export const TARGETS: { id: Target; label: string; kind: CandidateKind }[] = [
  { id: "shell", label: "Whole shell", kind: "html" },
  { id: "moshi", label: "Moshi", kind: "html" },
  { id: "stage", label: "Ambient stage", kind: "html" },
  { id: "waveform", label: "Clip material", kind: "glsl" },
  { id: "composer", label: "Agent composer", kind: "html" },
  { id: "transport", label: "Transport bar", kind: "html" },
  { id: "trackHeader", label: "Track header", kind: "html" },
  { id: "inspector", label: "Inspector card", kind: "html" },
  { id: "button", label: "Controls / buttons", kind: "html" },
  { id: "companion", label: "Companion app", kind: "html" },
];

// The native design resolution each candidate is authored at. HTML candidates render at
// this size and are scaled to fit (crisp miniature, not a cramped reflow); glsl fills.
// Per-candidate designW/designH override.
export const DESIGN_SIZE: Record<Target, { w: number; h: number }> = {
  shell: { w: 1440, h: 900 },
  moshi: { w: 1280, h: 800 },
  stage: { w: 1440, h: 900 },
  waveform: { w: 1280, h: 800 },
  composer: { w: 1000, h: 620 },
  transport: { w: 920, h: 380 },
  trackHeader: { w: 820, h: 320 },
  inspector: { w: 940, h: 660 },
  clip: { w: 820, h: 380 },
  button: { w: 820, h: 480 },
  companion: { w: 390, h: 844 }, // iPhone portrait (logical points) — near 1:1 on-device
};

export function designSizeFor(c: { target: Target; designW?: number; designH?: number }): { w: number; h: number } {
  if (c.designW && c.designH) return { w: c.designW, h: c.designH };
  return DESIGN_SIZE[c.target] ?? { w: 1280, h: 800 };
}

export const PASS_LABEL: Record<Pass, string> = {
  elevate: "ELEVATE",
  bolder: "BOLDER",
};

export interface Candidate {
  id: string;
  title: string;
  target: Target;
  pass: Pass;
  kind: CandidateKind;
  /** provenance: 'seed' | 'opus-insession' | a model id like 'claude-opus-4-8' */
  model: string;
  /** html document (kind:'html') OR glsl fragment source (kind:'glsl') */
  source: string;
  /** for glsl candidates: the material param set */
  params?: Params;
  /** for glsl candidates: pin the fixture kind (0 audio · 1 midi · 2 drums) regardless of the global toggle */
  fixtureMode?: 0 | 1 | 2;
  /** preferred theme for html candidates (defaults to dark) */
  theme?: Theme;
  /** native design resolution override (else DESIGN_SIZE[target]) */
  designW?: number;
  designH?: number;
  /** inject the real Moshi creature runtime (window.Moshi) into this candidate's doc */
  usesMoshi?: boolean;
  prompt?: string;
  seed?: string;
  createdAt: number;
  savedAt?: number;
  notes?: string;
  /** set by the sandbox when a candidate is rejected/slow, so the UI can flag it */
  flag?: string;
}

export const uid = (() => {
  let n = 0;
  return (p = "c") => `${p}_${(n++).toString(36)}_${Math.floor(performance.now()).toString(36)}`;
})();
