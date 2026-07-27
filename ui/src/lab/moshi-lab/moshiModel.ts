// Moshi Redesign Lab — the shared character model. ONE brain, many bodies: the canonical
// flat-splat geometry (lifted from v2/MoshMark.tsx — the pixel-matched sticker is the
// truth), a tiny spring integrator, and a renderer-agnostic MoshiBrain that turns the
// product's semantic drives (energy/mood/heat + agent states + poke/celebrate/gaze/speak)
// into a plain-numbers MoshiPose each frame. Candidate A (SVG) maps the pose onto DOM
// attributes; candidate C (2D shader) maps the same pose onto uniforms; candidate B wraps
// the brain's state transitions in an explicit Rive-style state machine. No React, no
// DOM, no GL here — pure math, unit-testable headless (mirrors characterLabModel.ts).

// ── geometry (the MoshMark silhouette is canonical) ─────────────────────────
export const VIEW = 100; // viewBox is 0 0 100 100
export const LOBES: readonly (readonly [number, number])[] = [
  [50, 30],
  [69.0, 43.8],
  [61.8, 66.2],
  [38.2, 66.2],
  [31.0, 43.8],
];
export const LOBE_R = 22;
export const CENTER: readonly [number, number] = [50, 50];
export const CENTER_R = 23;
// the sticker rim is the same union scaled up (MoshMark: rim r 24.5/25.5 vs body 22/23)
export const RIM_LOBE_R = 24.5;
export const RIM_CENTER_R = 25.5;
export const EYE_L: readonly (readonly [number, number])[] = [[37, 41], [45, 47.5], [37, 54]];
export const EYE_R: readonly (readonly [number, number])[] = [[63, 41], [55, 47.5], [63, 54]];
export const EYE_STROKE = 5.2;
export const FACE_CX = 50;
export const FACE_CY = 52; // gaze group pivot

export const LIME = "#ccff23";
export const INK = "#151515";
export const BONE = "#f6f2eb";

// ── mouth ───────────────────────────────────────────────────────────────────
// The mouth is ONE parametric shape: open (0 closed smile → 1 full sing), wide, smile.
// Both renderers build the same silhouette from these numbers.
export type MouthShape = {
  cx: number; cy: number;   // top-lip anchor center
  hw: number;               // half width
  depth: number;            // how far the bottom lip hangs below the top
  throatRx: number; throatRy: number; throatOpacity: number;
};

export function mouthShape(open: number, wide: number, smile: number): MouthShape {
  const o = Math.max(0, Math.min(1, open));
  const hw = 8.5 + wide * 3.5;
  const cy = 57.5 - smile * 1.2;
  const depth = 2.2 + o * 12.5;
  return {
    cx: 50, cy, hw, depth,
    throatRx: 0.01 + o * 3.4,
    throatRy: 0.01 + o * 4.6,
    throatOpacity: Math.max(0, Math.min(1, (o - 0.22) / 0.4)),
  };
}

// SVG path for the mouth silhouette (MoshMark's rounded singing mouth, parameterized).
export function mouthPath(m: MouthShape): string {
  const { cx, cy, hw, depth } = m;
  const f = (n: number) => Math.round(n * 100) / 100;
  return (
    `M ${f(cx - hw)} ${f(cy)} ` +
    `Q ${f(cx)} ${f(cy - 1.7)} ${f(cx + hw)} ${f(cy)} ` +
    `Q ${f(cx + hw * 0.62)} ${f(cy + depth * 0.92)} ${f(cx)} ${f(cy + depth)} ` +
    `Q ${f(cx - hw * 0.62)} ${f(cy + depth * 0.92)} ${f(cx - hw)} ${f(cy)} Z`
  );
}

// ── spring ──────────────────────────────────────────────────────────────────
// Semi-implicit Euler spring — the whole character's physics runs on these.
export class Spring {
  x: number;
  v = 0;
  target: number;
  constructor(x = 0, public stiffness = 140, public damping = 13) {
    this.x = x;
    this.target = x;
  }
  step(dt: number): number {
    const a = (this.target - this.x) * this.stiffness - this.v * this.damping;
    this.v += a * dt;
    this.x += this.v * dt;
    return this.x;
  }
  impulse(j: number): void { this.v += j; }
  snap(x: number): void { this.x = x; this.target = x; this.v = 0; }
}

// ── semantic contract (what every candidate body exposes) ───────────────────
export type MoshiStateName =
  | "IDLE" | "LISTENING" | "RECORDING" | "RENDERING" | "PAUSED" | "SLEEPING";
export const MOSHI_STATES: readonly MoshiStateName[] = [
  "IDLE", "LISTENING", "RECORDING", "RENDERING", "PAUSED", "SLEEPING",
];
export type MoshiDriveKey = "energy" | "mood" | "heat";

export interface MoshiBody {
  set(key: MoshiDriveKey, v: number): void;
  setState(s: MoshiStateName): void;
  poke(): void;
  celebrate(): void;
  lookAt(nx: number, ny: number): void;
  speak(on: boolean): void;
  cpuMs(): number; // avg per-frame cost — the lab's "less heavyweight" readout
  destroy(): void;
}

// ── pose (the brain's per-frame output — plain numbers, renderer-agnostic) ──
export type MoshiPose = {
  t: number;
  sx: number; sy: number;     // squash & stretch (volume-preserving: sx ≈ 1/sy)
  y: number;                  // vertical bounce offset (viewBox units, + is down)
  rot: number;                // lean, radians
  blink: number;              // 0 open → 1 shut
  gazeX: number; gazeY: number; // -1..1 face-space
  mouthOpen: number; mouthWide: number; smile: number;
  lobes: number[];            // per-lobe radius multiplier (~1 ± wobble)
  droop: number;              // 0..1 sleeping sag
  energy: number; mood: number; heat: number; // smoothed drives (pass-through)
  speaking: boolean;
};

// Per-state behaviour targets. wobble scales the lobe jiggle (energy multiplies it),
// breath scales idle swell rate, lid is the resting eyelid (sleepy droop).
const STATE_TARGETS: Record<MoshiStateName, {
  breath: number; droop: number; lean: number; mouthBase: number; lid: number; wobble: number;
}> = {
  IDLE:      { breath: 1.0, droop: 0,    lean: 0,     mouthBase: 0.06, lid: 0,    wobble: 0.5 },
  LISTENING: { breath: 1.4, droop: 0,    lean: 0.035, mouthBase: 0.12, lid: 0,    wobble: 0.9 },
  RECORDING: { breath: 1.7, droop: 0,    lean: 0.02,  mouthBase: 0.20, lid: 0,    wobble: 1.4 },
  RENDERING: { breath: 2.2, droop: 0,    lean: -0.03, mouthBase: 0.30, lid: 0,    wobble: 2.4 },
  PAUSED:    { breath: 0.4, droop: 0.06, lean: 0,     mouthBase: 0.0,  lid: 0.15, wobble: 0.15 },
  SLEEPING:  { breath: 0.55, droop: 0.5, lean: -0.06, mouthBase: 0.0,  lid: 0.9,  wobble: 0.1 },
};

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const rand = (a: number, b: number) => a + Math.random() * (b - a);

// ── the brain ───────────────────────────────────────────────────────────────
export class MoshiBrain {
  state: MoshiStateName = "IDLE";
  private drives: Record<MoshiDriveKey, { cur: number; target: number }> = {
    energy: { cur: 0.3, target: 0.3 },
    mood: { cur: 0.6, target: 0.6 },
    heat: { cur: 0.1, target: 0.1 },
  };
  private squash = new Spring(0, 170, 15);     // 0 rest; poke/celebrate excite it
  private jumpY = 0; private jumpV = 0;        // celebrate bounce (gravity-integrated)
  private blinkV = 0;                          // eased 0..1
  private blinkPhase: "open" | "closing" | "shut" | "opening" = "open";
  private blinkT = 0;
  private nextBlink = rand(2.2, 5);
  private gaze = { x: 0, y: 0, tx: 0, ty: 0 };
  private nextWander = rand(4, 9);
  private mouthOpen = 0.06;
  private speaking = false;
  private speakT = 0;
  private celebT = 0;                          // >0 while the celebrate face holds
  private droop = 0;
  private lobePh = LOBES.map((_, i) => i * 1.7);
  private t = 0;
  private pose: MoshiPose = {
    t: 0, sx: 1, sy: 1, y: 0, rot: 0, blink: 0, gazeX: 0, gazeY: 0,
    mouthOpen: 0.06, mouthWide: 0.5, smile: 0.6,
    lobes: LOBES.map(() => 1), droop: 0,
    energy: 0.3, mood: 0.6, heat: 0.1, speaking: false,
  };

  set(key: MoshiDriveKey, v: number): void { this.drives[key].target = clamp01(v); }
  setState(s: MoshiStateName): void { this.state = s; }
  lookAt(nx: number, ny: number): void {
    this.gaze.tx = Math.max(-1, Math.min(1, nx));
    this.gaze.ty = Math.max(-1, Math.min(1, ny));
  }
  poke(): void {
    this.squash.impulse(3.2);
    this.blinkPhase = "closing"; this.blinkT = 0; // a flinch blink
    this.celebT = Math.max(this.celebT, 0.15);
  }
  celebrate(): void {
    this.jumpV = -46;          // up (viewBox y is down)
    this.celebT = 1.1;
    this.squash.impulse(-2.0); // anticipatory stretch
  }
  speak(on: boolean): void { this.speaking = on; if (on) this.speakT = 0; }

  tick(dt: number): MoshiPose {
    dt = Math.min(dt, 0.05); // tab-back spikes can't explode the springs
    this.t += dt;
    const st = STATE_TARGETS[this.state];
    const d = this.drives;
    const ease = 1 - Math.exp(-4.5 * dt);
    d.energy.cur += (d.energy.target - d.energy.cur) * ease;
    d.mood.cur += (d.mood.target - d.mood.cur) * ease;
    d.heat.cur += (d.heat.target - d.heat.cur) * ease;
    const energy = d.energy.cur, mood = d.mood.cur, heat = d.heat.cur;

    // squash & stretch: breath is a slow sinus on top of the spring
    this.squash.step(dt);
    this.jumpV += 170 * dt; this.jumpY += this.jumpV * dt;
    if (this.jumpY > 0) { // landed
      this.jumpY = 0;
      if (this.jumpV > 20) this.squash.impulse(this.jumpV * 0.055);
      this.jumpV = 0;
    }
    const breath = Math.sin(this.t * 2.1 * st.breath) * (0.018 + energy * 0.012);
    const sq = this.squash.x;
    let sy = 1 + breath - sq * 0.12 - this.droop * 0.1;
    let sx = 1 / Math.sqrt(Math.max(0.6, sy)) + sq * 0.1; // crude volume preservation

    // blink: scheduled, plus state lid (sleepy)
    this.nextBlink -= dt;
    if (this.nextBlink <= 0 && this.blinkPhase === "open") {
      this.blinkPhase = "closing"; this.blinkT = 0;
      this.nextBlink = rand(2.2, 5.5);
    }
    if (this.blinkPhase !== "open") {
      this.blinkT += dt;
      if (this.blinkPhase === "closing") { this.blinkV = Math.min(1, this.blinkT / 0.06); if (this.blinkV >= 1) { this.blinkPhase = "shut"; this.blinkT = 0; } }
      else if (this.blinkPhase === "shut") { if (this.blinkT > 0.035) { this.blinkPhase = "opening"; this.blinkT = 0; } }
      else { this.blinkV = Math.max(0, 1 - this.blinkT / 0.09); if (this.blinkV <= 0) this.blinkPhase = "open"; }
    }
    const lid = st.lid + (1 - st.lid) * this.blinkV;

    // gaze: ease toward target; idle wander when nothing is going on
    this.nextWander -= dt;
    if (this.nextWander <= 0) {
      this.nextWander = rand(4, 9);
      if (this.state === "IDLE" || this.state === "SLEEPING") this.lookAt(rand(-0.4, 0.4), rand(-0.25, 0.25));
    }
    const ge = 1 - Math.exp(-6 * dt);
    this.gaze.x += (this.gaze.tx - this.gaze.x) * ge;
    this.gaze.y += (this.gaze.ty - this.gaze.y) * ge;

    // mouth: base by state, wide+smile by mood, speak flaps it, celebrate holds it open
    this.celebT = Math.max(0, this.celebT - dt);
    let speakOpen = 0;
    if (this.speaking) {
      this.speakT += dt;
      const n = Math.sin(this.speakT * 23) * 0.5 + Math.sin(this.speakT * 9.7 + 1.3) * 0.5;
      speakOpen = 0.28 + 0.5 * (n * 0.5 + 0.5);
    }
    const mouthT = clamp01(Math.max(st.mouthBase + mood * 0.08, speakOpen, this.celebT > 0 ? 0.85 : 0));
    this.mouthOpen += (mouthT - this.mouthOpen) * (1 - Math.exp(-10 * dt));

    // droop + lobe wobble
    this.droop += (st.droop - this.droop) * ease;
    const wobAmp = st.wobble * (0.25 + energy * 0.75) * 0.055;
    for (let i = 0; i < this.lobePh.length; i++) {
      this.lobePh[i] += dt * (2.2 + i * 0.31) * (0.7 + energy * 1.6) * st.breath;
      this.pose.lobes[i] = 1 + Math.sin(this.lobePh[i]) * wobAmp;
    }

    const p = this.pose;
    p.t = this.t;
    p.sx = sx; p.sy = sy; p.y = this.jumpY + this.droop * 3.5;
    p.rot = st.lean + this.squash.x * 0.01;
    p.blink = clamp01(lid);
    p.gazeX = this.gaze.x; p.gazeY = this.gaze.y;
    p.mouthOpen = this.mouthOpen;
    p.mouthWide = 0.35 + mood * 0.5;
    p.smile = mood;
    p.droop = this.droop;
    p.energy = energy; p.mood = mood; p.heat = heat;
    p.speaking = this.speaking;
    return p;
  }
}
