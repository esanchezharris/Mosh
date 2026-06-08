// Snapshot shape from MoshOps.snapshot() (docs/02_MOSHOPS_CONTRACT.md). The UI
// renders this; no Tracktion/audio concepts leak across the seam.

export type RenderColor = { name: string; value: number };
export type RenderLayer = {
  id: string;
  status: "empty" | "dirty" | "queued" | "rendering" | "ready" | "error" | "bypassed" | "frozen" | "bounced";
  adapter: string;
  mode: string;
  seed: number;
  userKept: boolean;
  hasArtifact: boolean;
  prompt?: string;
  nl?: number;
  colors?: RenderColor[];
};

export type Clip = {
  id: string;
  name: string;
  type: "wave" | "midi" | "clip";
  start: number;
  length: number;
  offset: number;
  sourceFile?: string;
  sourceLength?: number;
  hasRenderLayer: boolean;
  renderLayer?: RenderLayer;
};

export type PluginParam = { index: number; name: string; value: number };

export type NeuralParam = { id: string; ui: number; safeMaxUi: number };
export type NeuralInsert = {
  model: string;
  labMode: boolean;
  latencySamples: number;
  latencySeconds: number;
  params: NeuralParam[];
};

export type Plugin = {
  index: number;
  name: string;
  type: string;
  enabled: boolean;
  external: boolean;
  isInstrument: boolean;
  params: PluginParam[];
  neural?: NeuralInsert;
  labMode?: boolean;
};

export type AvailablePlugin = {
  id: string;
  name: string;
  format: string;
  manufacturer: string;
  isInstrument: boolean;
};

export type Track = {
  id: string;
  index: number;
  name: string;
  type: string;
  clips: Clip[];
  plugins?: Plugin[];
  volumeDb?: number;
  pan?: number;
  mute?: boolean;
  solo?: boolean;
};

export type Transport = {
  playing: boolean;
  recording: boolean;
  position: number;
  looping: boolean;
  loopStart: number;
  loopEnd: number;
};

export type Snapshot = {
  schemaVersion: number;
  session: { sampleRate: number; tempo: number; editFile: string };
  tracks: Track[];
  transport: Transport;
};

export type CommandResult<T = unknown> = {
  ok: boolean;
  command: string;
  data?: T;
  error?: string;
};

export type MoshEvent = { type: string; payload?: unknown };
