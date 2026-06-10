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

// MIDI note as the snapshot carries it (beats domain, Stage 14).
export type Note = { pitch: number; startBeats: number; durBeats: number; vel: number };

export type Clip = {
  id: string;
  name: string;
  type: "wave" | "midi" | "clip";
  start: number;
  length: number;
  offset: number;
  sourceFile?: string;
  sourceLength?: number;
  notes?: Note[]; // MIDI clips only (capped at 512)
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

// A sampler pad: one loaded sound with its key mapping (drum rack, Stage 14).
export type SamplerSound = { name: string; keyNote: number; minNote: number; maxNote: number };

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
  sounds?: SamplerSound[]; // sampler plugins only
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
  // Engine-output levels in dB, riding the 30 Hz transport event (Stage 14).
  levels?: { master?: [number, number]; tracks?: Record<string, [number, number]> };
};

export type AudioOutputDevice = { name: string; virtualSink: boolean };

export type Snapshot = {
  schemaVersion: number;
  session: {
    sampleRate: number;
    tempo: number;
    editFile: string;
    timeSigNumerator?: number;
    timeSigDenominator?: number;
    hasAudio?: boolean;
    audioOutputDevice?: string;
    audioWarning?: string;
    audioError?: string;
    masterVolumeDb?: number;
    metronome?: boolean;
  };
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
