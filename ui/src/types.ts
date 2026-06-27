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
  target?: string;    // Route B: transform target (instrument or free-text)
  strength?: number;  // Route B: transform strength (0–100)
  // The render's time scope (seconds). A section-scoped render carries a sub-range of
  // the clip; a whole-clip render's range equals the clip span.
  regionStart?: number;
  regionEnd?: number;
};

// LYR-001 — Finish-My-Song lyric sheet (per-track), from MoshOps.lyricSheetToVar().
// One line carries its constraint spec (§5); the v2 Lyrics tab renders the flow meter
// + rhyme tool from this. Transient generation output (proposals) arrives in L2.
// L2 — one ranked generation proposal for a line (constraint-checked by phonology).
export type LyricProposal = {
  text: string;
  endWord: string;
  syllables: number;
  passes: boolean;           // meets all hard constraints (syllables within tol + rhyme)
  syllableOk?: boolean;
  rhymeOk?: boolean;
  grade?: string;            // "perfect" | "slant" | "anchor" | "free" | "none"
  score?: number;
};
export type LyricLine = {
  index: number;
  role: "verse" | "hook" | "bridge" | "adlib" | string;
  seedText: string;          // partial line with ___ gaps
  text: string;              // finalized line
  syllableTarget: number;    // 0 ⇒ infer from the grid
  syllableTol: number;
  stress: string;            // contour, e.g. "xXxxxX" ('?' = free)
  rhymeGroup: string;        // lines sharing a group must rhyme
  rhymeStrictness: string;   // "perfect"|"slant"|"free" ("" ⇒ inherit sheet)
  locked: boolean;
  sectionId: string;
  status: "empty" | "seed" | "generating" | "proposed" | "accepted" | "locked" | string;
  proposals?: LyricProposal[];  // L2 — transient ranked proposals (cleared on accept/reject)
  regen?: number;
};
export type LyricSheet = {
  id: string;
  grid: string;              // "1/4" | "1/8" | "1/16"
  language: string;
  topic: string;
  mood: string;
  explicit: "allow" | "clean" | "mild" | string;
  rhymeStrictness: "perfect" | "slant" | "free" | string;
  specVersion: number;
  lines: LyricLine[];
};
// A ranked rhyme candidate from get_rhymes (phonology, no LLM).
export type RhymeCandidate = { word: string; syllables: number; grade: "perfect" | "slant" | "none" | string };

// SA3 colour-rack metadata from GET /colors (via list_colors).
export type AvailableColor = {
  name: string;
  astd_max: number;
  peak_layer: number;
  more_sign: number;
  verdict: string;
  no_stack_with: string[];
};

// Route B transform target from GET /transform_targets (via list_transform_targets).
export type AvailableTransformTarget = { name: string };

// Quality readout from a completed render's manifest (judge panel, 05 §7).
// `reasoning` is the Audiobox judge's one-line explanation of the score; `axes` are its
// raw aesthetic axes (PQ/CE/CU/PC on a 0–10 scale). Both are best-effort (AL-006).
export type RenderQA = {
  pq?: number | null;
  pq_base?: number | null;
  flags?: string[];
  adapter?: string;
  reasoning?: string | null;
  axes?: Record<string, number> | null;
};

// One entry in a wave clip's native take tree (Tracktion). Present on the clip
// only when it has takes (recording over a region stacks takes); the UI renders
// them as separate lanes. set_current_take / keep_take act on this tree.
export type ClipTake = {
  index: number;        // position in the take tree (the command handle)
  description?: string; // engine-supplied take description (file/name), if any
  isCurrent?: boolean;  // the take that currently plays
};

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
  sourceMissing?: boolean;   // gap 3 — source file absent on disk; offer relink
  sourceLength?: number;
  notes?: MidiNote[];
  // Audio warp (auto-tempo): the clip re-anchors in beats and time-stretches to
  // follow the tempo map (SoundTouch). Wave clips only.
  autoTempo?: boolean;
  stretchMode?: string;
  sourceBpm?: number;
  hasRenderLayer: boolean;
  renderLayer?: RenderLayer;
  // Take lanes (wave clips). Present only when the clip has takes in the engine's
  // native take tree; the UI stacks them as lanes within the clip footprint.
  numTakes?: number;
  currentTakeIndex?: number;
  takes?: ClipTake[];
};

export type ControllerEventName =
  | "TRANSPORT_TOGGLE"
  | "TRANSPORT_SCRUB"
  | "TAKE_LISTEN"
  | "TAKE_KEEP"
  | "TAKE_REDO"
  | "TAKE_MARK";

export type ControllerTake = {
  exists: boolean;
  clipId?: string;
  trackId?: string;
  name?: string;
  start?: number;
  length?: number;
  hasLanes?: boolean;
  canKeep?: boolean;
  kept?: boolean;
  numTakes?: number;
  currentTakeIndex?: number;
};

export type ControllerState = {
  mode: "capture" | "judgment";
  record: "idle" | "armed" | "recording";
  take: ControllerTake;
  agent: "idle" | "working" | "done" | "confused";
};

export type AutoPoint = { t: number; v: number }; // t seconds, v normalised 0..1
export type PluginParam = {
  index: number;
  name: string;
  value: number;
  automated?: boolean;
  points?: AutoPoint[];
};

// Route C.2 — the real-time RAVE insert's snapshot view (present iff this plugin is one).
export type RaveInsert = {
  model: string;
  modelName?: string;
  modelPath?: string;
  modelLoaded: boolean;
  mix: number;             // 0–100 dry/wet
  latencySeconds: number;
};

export type MoshFxCut = {
  frequencyHz: number;
  score?: number;
  depthDb?: number;
};

export type MoshFxReadout = {
  kind: "autotune" | "ott" | "feedback";
  inputHz?: number;
  targetHz?: number;
  correctionCents?: number;
  confidence?: number;
  amount?: number;
  timeMs?: number;
  candidates?: MoshFxCut[];
  activeCuts?: MoshFxCut[];
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
  rave?: RaveInsert;       // present iff this is a real-time RAVE insert (anira build)
  moshFx?: MoshFxReadout;
};

export type AvailablePlugin = {
  id: string;
  name: string;
  format: string;       // "VST3" | "AudioUnit"
  manufacturer: string;
  isInstrument: boolean;
};

// Per-format catalog counts (INS-005) — rides on the list_plugins result.
export type PluginCounts = { vst3: number; au: number; total: number };

// Engine built-in plugin (from list_builtins) — loaded via load_builtin by type.
export type BuiltinPlugin = {
  type: string;
  name: string;
  category: string;
  isInstrument: boolean;
  builtin: true;
};

export type Send = { bus: number; db: number; mute: boolean };
export type Track = {
  id: string;
  // MP-001 — stable cross-peer logical id (the relay's lock key). Present once the
  // backend stamps it; used to map a track to its multiplayer lock owner.
  logicalId?: string;
  index: number;
  name: string;
  type: string;
  clips: Clip[];
  plugins?: Plugin[];
  volumeDb?: number;
  pan?: number;
  mute?: boolean;
  solo?: boolean;
  armed?: boolean;
  monitor?: "off" | "automatic" | "on";
  hasInput?: boolean;
  inputType?: "wave" | "midi";  // kind of the routed input (CTL-001)
  midiInputName?: string;       // name of the routed MIDI input device, when inputType=="midi"
  isInstrument?: boolean;       // hosts a synth/builtin instrument -> live MIDI armable (CTL-001)
  // FL drum-lane mute/solo — the GM pitches whose sampler pad is muted / soloed on a
  // drum track (set_drum_lane). Empty/absent = all lanes audible.
  drumMutedPitches?: number[];
  drumSoloPitches?: number[];
  sends?: Send[];
  isReturn?: boolean;
  returnBus?: number;
  meterEnabled?: boolean;
  // MIX-008 — group (submix) tracks. A group entry has isGroup + type "group" and
  // an empty clips array; a track nested under a group carries parentId.
  isGroup?: boolean;
  parentId?: string;
  // RTG-001/002 — routing. input = the explicitly-chosen input device; output =
  // the track's destination (absent = default out; isTrack = routed into a track).
  input?: { deviceID: string; name?: string };
  output?: { isTrack: boolean; destId?: string; name: string; deviceID?: string };
  // LYR-001 — the per-track lyric sheet (absent ⇒ no sheet; the Lyrics tab shows its
  // empty state). Additive + optional.
  lyricSheet?: LyricSheet;
};

// RTG-001/002 — routing enumerations (read-only, on-demand like AudioDevices).
export type WaveInput = { deviceID: string; name: string; enabled: boolean; isStereoPair: boolean };
export type TrackOutputs = {
  outputs: { deviceID: string; name: string; enabled: boolean }[];
  tracks: { id: string; name: string }[];
  audioEnabled: boolean;
};

export type Level = { l: number; r: number };           // peak dBFS, -100 floor

export type Bus = { bus: number; name: string; trackId: string };

export type Transport = {
  playing: boolean;
  recording: boolean;
  position: number;
  looping: boolean;
  loopStart: number;
  loopEnd: number;
};

// Current audio-device selection summary (snapshot.audio) — the settings edit form.
export type AudioSelection = {
  type: string;
  outputDevice: string;
  inputDevice: string;
  sampleRate: number;
  bufferSize: number;
};

// Full device enumeration from list_audio_devices (on-demand, NOT in the snapshot).
export type AudioDevices = {
  types: { name: string; outputs: string[]; inputs: string[] }[];
  current: AudioSelection;
  sampleRates: number[];
  bufferSizes: number[];
  defaultBufferSize: number;
  audioEnabled: boolean;
};

// BRW-001 — content/file browser (read-only list_directory). Pure view data; the
// only mutation is the existing import_clip command on a chosen file.
export type DirEntry = {
  name: string;
  path: string;       // full absolute path
  isDir: boolean;
  size: number | null; // bytes (null for directories)
};
export type DirListing = {
  path: string;          // normalized absolute dir actually listed
  parent: string | null; // parent dir, or null at the filesystem root (drives Up)
  exists: boolean;       // false when missing / not a dir / no read access
  error: string | null;  // human-readable reason when exists==false
  roots: { name: string; path: string }[]; // always present (recovery targets)
  entries: DirEntry[];
};

// Musical key for the session (Moshi sings in-key). ALWAYS present in the snapshot,
// backend-defaulted, so the UI never sees a missing field. tonic ∈ voice.js NOTE_PC,
// mode ∈ voice.js SCALES — the two domains must match the voice module exactly.
export type SessionKey = { tonic: string; mode: string };

export type TrainingSource = {
  index: number;
  source_id: string;
  title: string;
  creator: string;
  source_url: string;
  local_path: string;
  user_claimed_license: string;
  license_name?: string;
  proof_of_rights: string;
  approved_for_training: boolean;
  expiration?: string | null;
  notes: string;
  eligible?: boolean;
  blocked_reason?: string;
};

export type TrainingAdapter = {
  adapterId: string;
  bundleHash: string;
  bundlePath: string;
  artifactPath: string;
  manifestPath: string;
  active: boolean;
  quality?: Record<string, unknown>;
};

export type TrainingJob = {
  jobId: string;
  status: string;
  progress: number;
  bundlePath?: string;
  outputDir?: string;
  artifactPath?: string;
  manifestPath?: string;
  error?: string;
  result?: Record<string, unknown> | null;
};

export type TrainingState = {
  registryPath: string;
  statePath: string;
  activeAdapterId: string;
  activeAdapterPath: string;
  activeCorpusHash: string;
  sources: TrainingSource[];
  adapters: TrainingAdapter[];
  jobs: TrainingJob[];
};

// A named song-structure region (Intro / Verse / Hook / …). Beat-based so it's
// tempo-independent; used by the section navigator and (later) as an agent scope
// handle ("rework the hook"). Frontend-first against the mock; the real backend is
// a MOSH_SECTIONS ValueTree + create/rename/move/remove_section commands.
export type Section = {
  id: string;
  name: string;
  startBeat: number;
  endBeat: number;
  color?: string;
};

// ANN-001 — an authored timeline comment pin, beat-anchored. Synced over multiplayer
// with `author` (who flagged it).
export type Annotation = {
  id: string;
  text: string;
  beat: number;
  color?: string;
  author?: string;
};

// PRJ-FMT — the snapshot WIRE-CONTRACT version this UI build expects. If the backend
// reports a higher snapshot.schemaVersion, the UI is older than its engine and shows a
// soft "please update the app" banner (it keeps running, degraded). DISTINCT from the
// project file format version (which the backend refuses outright when too new). Bump in
// lockstep with kSnapshotSchemaVersion in src/state/Migrations.h.
export const EXPECTED_SNAPSHOT_SCHEMA = 1;

// PRJ-FMT — the version-banner decision, pure + testable. Two distinct cases, both via the
// store's lastError:
//  • file-format refusal (cold start): the launch session file was made by a NEWER Mosh,
//    so the backend loaded a safe empty fallback — a BLOCKING "update Mosh" message.
//  • snapshot wire-contract mismatch: this UI build is older than its engine — a SOFT advisory.
// Returns null when neither applies. Structural param so it's trivial to unit-test.
export function versionBannerError(
  snap: { schemaVersion: number; session: { loadError?: string } },
): string | null {
  if (snap.session.loadError) return snap.session.loadError;
  if (snap.schemaVersion > EXPECTED_SNAPSHOT_SCHEMA)
    return "This Mosh app is older than its engine. Please update the app.";
  return null;
}

export type Snapshot = {
  schemaVersion: number;
  session: {
    sampleRate: number;
    tempo: number;
    timeSigNumerator?: number;
    timeSigDenominator?: number;
    metronome?: boolean;
    raveAvailable?: boolean;   // Route C.2 — anira build hosts the real-time RAVE insert
    // Musical key (set_key command writes it; always defaulted on the backend).
    key: SessionKey;
    length?: number;
    editFile: string;
    dirty?: boolean;           // gap 1 — unsaved changes (drives auto-save; advisory in UI)
    // PRJ-FMT — cold-start refusal: the launch session file was made by a NEWER Mosh than
    // this build. A safe empty fallback is live; this is the blocking "please update Mosh"
    // reason the UI surfaces. Absent ⇒ the project loaded fine.
    loadError?: string;
    // A2 — the prior session ended uncleanly (crashed); autosave already restored the last
    // good save. Drives a one-time, dismissable recovery notice. Absent ⇒ clean last exit.
    recoveryAvailable?: boolean;
    recentProjects?: { path: string; name: string }[]; // gap 2 — Recent list (newest-first)
    projectExtension?: string; // backend-owned project container extension (no leading dot)
    // SES-001 — the tempo MAP (additive; tempo/timeSig* above stay point 0).
    // curve: 1 = step (hold-then-jump), values in (-1,1) ramp to the next point.
    tempoMap?: { time: number; bpm: number; curve?: number }[];
    timeSigMap?: { time: number; numerator: number; denominator: number }[];
    // Ramps only: the engine-faithful fine sections (its own subdivision
    // boundaries), making the UI mapping exact-by-construction through a ramp.
    tempoSections?: { time: number; bpm: number }[];
    // Audio-engine gate + readout (wave: settings — MON-007 / FLY-004).
    audioEnabled?: boolean;
    bitDepth?: number;
    bufferSize?: number;
    outputLatencyMs?: number;
    // PRF-001 — multicore audio processing. availableCores is what the engine sees;
    // audioThreads is the RESOLVED count it actually uses (== availableCores when auto);
    // audioThreadsAuto shows "Auto (N)". A real preference (drives setNumThreads on the
    // parallel graph), not a cosmetic readout. Single-thread is threads=1.
    availableCores?: number;
    audioThreads?: number;
    audioThreadsAuto?: boolean;
    // Plugin delay compensation readout (MON-004): the whole-edit reported latency the
    // playback graph compensates (neural insert + all hosted plugins). Null context
    // (no audio device / idle engine) → latencyContextReady=false, label "PDC —".
    totalLatencySamples?: number;
    totalLatencyMs?: number;
    latencyContextReady?: boolean;
    // Monitoring round-trip latency (MON-003): hardware input + output latency, i.e. the
    // delay a performer hears through software input monitoring. 0 with no open device
    // (show "—"). Smaller buffer size lowers it; monitoring is software-only.
    roundTripLatencyMs?: number;
    roundTripLatencySamples?: number;
    audioDeviceName?: string;
    audioDeviceError?: string;
    // PRJ-008 — per-project format / time-base intent (the export/format default +
    // timeline display base). Generic media-format values, persisted with the project;
    // each field falls back to the live device readout when unset.
    project?: {
      sampleRate: number;
      bitDepth: number;
      timeBase: "seconds" | "barsBeats";
    };
  };
  tracks: Track[];
  transport: Transport;
  controller?: ControllerState;
  master?: { volumeDb: number; pan: number };
  buses?: Bus[];
  sections?: Section[];
  annotations?: Annotation[];
  audio?: AudioSelection;
  training?: TrainingState;
};

export type CommandResult<T = unknown> = {
  ok: boolean;
  command: string;
  data?: T;
  error?: string;
};

export type MoshEvent = { type: string; payload?: unknown };

// export_audio result data (IOX-002 / IOX-007). file/format/bitDepth/sampleRate
// echo the resolved render settings; format is a generic media format keyword.
export type ExportFormat = "wav" | "aiff" | "flac";
export type ExportResult = {
  file: string;
  format: ExportFormat;
  bitDepth: number;
  sampleRate: number;
  bytes: number;
  renderMode: string;
};

// get_command_log result (AGT-001): a read-only window over the canonical command
// log (mosh-log.jsonl). Most-recent-first, bounded by `limit`. `total` is the full
// count of parsed lines in the log (entries.length <= total).
export type CommandLogEntry = {
  ts?: number;
  seq?: number;
  command: string;
  ok: boolean;
  undoable: boolean;
  error?: string;
};
export type CommandLog = {
  entries: CommandLogEntry[];
  total: number;
};
