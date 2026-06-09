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

// SA3 colour-rack metadata from GET /colors (via list_colors).
export type AvailableColor = {
  name: string;
  astd_max: number;
  peak_layer: number;
  more_sign: number;
  verdict: string;
  no_stack_with: string[];
};

// Quality readout from a completed render's manifest (judge panel, 05 §7).
export type RenderQA = { pq?: number | null; pq_base?: number | null; flags?: string[]; adapter?: string };

// A MIDI note as serialised in the snapshot — beats within the clip sequence.
export type MidiNote = {
  i: number;        // index into the clip's note list (the command handle)
  pitch: number;    // 0..127
  start: number;    // beats
  length: number;   // beats
  velocity: number; // 1..127
};

export type Clip = {
  id: string;
  name: string;
  type: "wave" | "midi" | "clip";
  start: number;
  length: number;
  offset: number;
  mute?: boolean;
  gainDb?: number;
  sourceFile?: string;
  sourceLength?: number;
  notes?: MidiNote[];
  hasRenderLayer: boolean;
  renderLayer?: RenderLayer;
};

export type AutoPoint = { t: number; v: number }; // t seconds, v normalised 0..1
export type PluginParam = {
  index: number;
  name: string;
  value: number;
  automated?: boolean;
  points?: AutoPoint[];
};

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
  builtin?: boolean;
  category?: string;
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

// Engine built-in plugin (from list_builtins) — loaded via load_builtin by type.
export type BuiltinPlugin = {
  type: string;
  name: string;
  category: string;
  isInstrument: boolean;
  builtin: true;
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
  session: {
    sampleRate: number;
    tempo: number;
    timeSigNumerator?: number;
    timeSigDenominator?: number;
    metronome?: boolean;
    length?: number;
    editFile: string;
  };
  tracks: Track[];
  transport: Transport;
  master?: { volumeDb: number; pan: number };
};

export type CommandResult<T = unknown> = {
  ok: boolean;
  command: string;
  data?: T;
  error?: string;
};

export type MoshEvent = { type: string; payload?: unknown };
