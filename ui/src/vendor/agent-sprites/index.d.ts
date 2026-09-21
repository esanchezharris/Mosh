export type ColorwayId =
  | "encre"
  | "creme"
  | "carnaval"
  | "fools"
  | "block"
  | "sea"
  | "exhalation"
  | "cruller"
  | "sanctuary"
  | "bodega"
  | "wallet"
  | "passage";

export type AgentState =
  | "idle"
  | "thinking"
  | "wink"
  | "wide"
  | "laugh"
  | "notify"
  | "egg"
  | "hexagon"
  | "orbit"
  | "burst"
  | "sleep";

export interface ColorwayRow {
  id: ColorwayId | string;
  name?: string;
  hex: string;
  accent: string;
  voidHex?: string;
  body?: string;
  eye?: string;
  voidFill?: string;
  void?: string;
}

export interface ResolvedColorway {
  id: string;
  body: string;
  accent: string;
  eye: string;
  void: string;
  voidHex: string;
  dark: boolean;
  highlight: string;
  mid: string;
  rim: string;
  sheen: string;
  edge: string;
}

export interface World {
  colorway?: ColorwayId | string | ColorwayRow;
  state?: AgentState | string;
  prevState?: AgentState | string;
  changedAt?: number;
  seed?: number;
  morphDur?: number;
  mouthOpen?: number;
  reducedMotion?: boolean;
  reduced?: boolean;
  laughChangedAt?: number;
  laughMorphDur?: number;
}

/** paper defaults to "transparent"; flat defaults to true; shadow defaults to false. */
export interface DrawOpts {
  size?: number;
  x?: number;
  y?: number;
  paper?: string;
  flat?: boolean;
  shadow?: boolean;
  pad?: number;
}

export interface Pose {
  cx: number;
  cy: number;
  sx: number;
  sy: number;
  rot?: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Eye {
  kind?: string;
  d?: string;
  cx?: number;
  cy?: number;
  rx?: number;
  ry?: number;
  rot?: number;
  width?: number;
}

export interface MouthVoid {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  rot?: number;
  kind?: string;
}

export interface FrameMouth {
  d?: string;
  void?: MouthVoid;
  fill: string;
  voidFill: string;
  cx: number;
  cy: number;
  w: number;
  h: number;
  rot: number;
  open: number;
  curve: number;
  smile: boolean;
}

export interface FrameFace {
  expression: string;
  kind: string;
  eyeAlpha: number;
  rot: number;
  eyes: {
    kind: string;
    left: Eye;
    right: Eye;
    fill: string;
    stroke: string;
    width: number;
  };
  mouth: FrameMouth;
}

export interface FrameDot {
  x: number;
  y: number;
  r: number;
  fill?: string;
  alpha: number;
}

export interface FrameRing {
  cx?: number;
  cy?: number;
  r: number;
  a0: number;
  a1: number;
  width?: number;
  alpha: number;
  behind?: boolean;
}

export interface FrameBadge {
  x: number;
  y: number;
  r: number;
  fill: string;
  alpha?: number;
}

export interface Frame {
  t: number;
  state: AgentState | string;
  prevState: AgentState | string;
  mix: number;
  radii: number[];
  pose: Pose;
  points: Point[];
  path: string;
  eyeAlpha: number;
  blink: number;
  gaze: { yaw: number; pitch: number };
  dots: FrameDot[];
  rings: FrameRing[];
  badge: FrameBadge | null;
  face: FrameFace;
  colorway: ResolvedColorway;
}

export interface EngineSnapshot {
  colorway: ColorwayId | string;
  state: AgentState | string;
  prevState: AgentState | string;
  changedAt: number;
  seed: number;
  morphDur: number;
}

export interface EngineHandle {
  setColorway(id: ColorwayId | string | ColorwayRow): void;
  setState(next: AgentState | string, atT: number): void;
  getState(): EngineSnapshot;
  sample(t: number): Frame;
}

export interface StateDef {
  duration: number;
  morph: number;
  [key: string]: unknown;
}

export const COLORWAYS: ColorwayRow[];
export const COLORWAY_BY_ID: Record<string, ColorwayRow>;
export const STATES: AgentState[];
export const SEQUENCE: AgentState[];
export const SEQUENCE_DUR: number;
export const STATE_DEFS: Record<string, StateDef>;
export const LAUGH_MORPH_DUR: number;
export const IDLE_ORBIT_PERIOD: number;

export function sample(t: number, world?: World): Frame;
export function toSVG(frame: Frame, opts?: DrawOpts): string;
export function drawCanvas(
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  opts?: DrawOpts
): void;
export function createEngine(initial?: World): EngineHandle;
export function catalogueWorld(
  t: number,
  colorway?: ColorwayId | string | ColorwayRow,
  seed?: number,
  out?: World
): World;
export function heroWorld(
  t: number,
  colorway?: ColorwayId | string | ColorwayRow,
  seed?: number
): World;
export function resolveColorway(
  input?: ColorwayId | string | ColorwayRow | null
): ResolvedColorway;
export function resolveState(name?: string): AgentState;
export function blinkAmount(t: number, seed?: number): number;
export function mouthOpenAmount(t: number, seed?: number): number;

declare const api: {
  COLORWAYS: typeof COLORWAYS;
  COLORWAY_BY_ID: typeof COLORWAY_BY_ID;
  STATES: typeof STATES;
  SEQUENCE: typeof SEQUENCE;
  SEQUENCE_DUR: typeof SEQUENCE_DUR;
  STATE_DEFS: typeof STATE_DEFS;
  LAUGH_MORPH_DUR: typeof LAUGH_MORPH_DUR;
  IDLE_ORBIT_PERIOD: typeof IDLE_ORBIT_PERIOD;
  sample: typeof sample;
  toSVG: typeof toSVG;
  drawCanvas: typeof drawCanvas;
  createEngine: typeof createEngine;
  catalogueWorld: typeof catalogueWorld;
  heroWorld: typeof heroWorld;
  resolveColorway: typeof resolveColorway;
  resolveState: typeof resolveState;
  blinkAmount: typeof blinkAmount;
  mouthOpenAmount: typeof mouthOpenAmount;
  [key: string]: unknown;
};

export default api;
