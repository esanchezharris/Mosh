// Candidate B — the Rive workalike. Rive's pitch for app mascots is not its pixels (it
// renders flat vector art — visually IDENTICAL to candidate A) but its programming model:
// declarative inputs (bools / numbers / triggers) feed a state machine with explicit
// transitions and one-shot override layers, instead of imperative setState() calls.
// This module wraps the shared brain in exactly that model so the lab can A/B the
// authoring feel honestly. If the owner later authors a real .riv in the Rive editor,
// this panel's drop zone is where it lands (runtime added only then).

import { MoshiBrain, MOSHI_STATES, type MoshiStateName } from "./moshiModel";

export type SMTransition = { at: number; from: MoshiStateName; to: MoshiStateName; via: string };

// Boolean inputs, Rive-style. The active state is DERIVED from them by priority —
// you never say "go to RECORDING", you say recording=true and the machine resolves it.
export type SMBool = "playing" | "recording" | "rendering" | "tired";
export const SM_BOOLS: readonly SMBool[] = ["playing", "recording", "rendering", "tired"];

const PRIORITY: readonly { bool: SMBool; state: MoshiStateName }[] = [
  { bool: "recording", state: "RECORDING" },
  { bool: "rendering", state: "RENDERING" },
  { bool: "playing", state: "LISTENING" },
  { bool: "tired", state: "SLEEPING" },
];

// Legal direct transitions (the machine refuses + logs anything else — Rive's guard
// rails). PAUSED is reachable from LISTENING/RECORDING only; SLEEPING must wake via IDLE.
const LEGAL: Record<MoshiStateName, readonly MoshiStateName[]> = {
  IDLE: ["LISTENING", "RECORDING", "RENDERING", "SLEEPING"],
  LISTENING: ["IDLE", "PAUSED", "RECORDING", "RENDERING"],
  RECORDING: ["IDLE", "PAUSED", "RENDERING"],
  RENDERING: ["IDLE", "LISTENING"],
  PAUSED: ["IDLE", "LISTENING"],
  SLEEPING: ["IDLE"],
};

export class MoshiStateMachine {
  readonly brain: MoshiBrain;
  current: MoshiStateName = "IDLE";
  readonly transitions: SMTransition[] = [];
  private bools: Record<SMBool, boolean> = { playing: false, recording: false, rendering: false, tired: false };
  private startedAt = performance.now();

  constructor(brain = new MoshiBrain()) {
    this.brain = brain;
  }

  private stamp(): number { return Math.round((performance.now() - this.startedAt) / 10) / 100; }

  private go(to: MoshiStateName, via: string): void {
    if (to === this.current) return;
    this.transitions.push({ at: this.stamp(), from: this.current, to, via });
    if (this.transitions.length > 24) this.transitions.shift();
    this.current = to;
    this.brain.setState(to);
  }

  // ── number inputs (Rive "number" inputs) ──
  setDrive(key: "energy" | "mood" | "heat", v: number): void { this.brain.set(key, v); }
  lookAt(nx: number, ny: number): void { this.brain.lookAt(nx, ny); }
  speak(on: boolean): void { this.brain.speak(on); }

  // ── bool inputs: resolve the derived state by priority ──
  setBool(name: SMBool, v: boolean): void {
    this.bools[name] = v;
    const hit = PRIORITY.find((p) => this.bools[p.bool]);
    this.go(hit ? hit.state : "IDLE", `bool ${name}=${v}`);
  }
  getBool(name: SMBool): boolean { return this.bools[name]; }

  // ── trigger inputs: one-shot override layer (never changes the base state) ──
  fire(trigger: "poke" | "celebrate"): void {
    this.transitions.push({ at: this.stamp(), from: this.current, to: this.current, via: `trigger ${trigger}` });
    if (this.transitions.length > 24) this.transitions.shift();
    if (trigger === "poke") this.brain.poke(); else this.brain.celebrate();
  }

  // ── direct request with guard rails (what the rack's state buttons use here) ──
  request(to: MoshiStateName): boolean {
    if (!MOSHI_STATES.includes(to)) return false;
    if (to === this.current) return true;
    if (!LEGAL[this.current].includes(to)) {
      this.transitions.push({ at: this.stamp(), from: this.current, to: this.current, via: `✕ refused ${this.current}→${to}` });
      if (this.transitions.length > 24) this.transitions.shift();
      return false;
    }
    this.go(to, `request ${to}`);
    return true;
  }
}
