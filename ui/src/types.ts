// Snapshot shape from MoshOps.snapshot() (docs/02_MOSHOPS_CONTRACT.md). The UI
// renders this; no Tracktion/audio concepts leak across the seam.

export type RenderColor = { name: string; value: number };
export type RenderLora = { name: string; value: number };   // LoRA rack: 0–100 UI strength
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
  loras?: RenderLora[];  // LoRA rack selection (unbounded, ordered — stacks merge sequentially)
  target?: string;    // Route B: transform target (instrument or free-text)
  strength?: number;  // Route B: transform strength (0–100)
  // The render's time scope (seconds). A section-scoped render carries a sub-range of
  // the clip; a whole-clip render's range equals the clip span.
  regionStart?: number;
  regionEnd?: number;
  error?: string;     // the service's reason, populated when status === "error"
  appliedInPlace?: boolean;  // wave clips: the clip's own audio IS the render (instant in-place preview)
  hasOriginal?: boolean;     // wave clips: a pre-render original is stored → Reset is available
  coverage?: "auto" | "loop" | "stitch";  // whole-clip: how a clip longer than the model window is covered
  reimagineActive?: boolean; // MIDI/drum clips: a hidden audio render plays beneath the muted MIDI → Reset is available
  liveArmed?: boolean;       // Lane A: "Live" render-ahead is armed — playback lays the re-imagine ahead of the playhead
  reactive?: boolean;        // false ⇒ FROZEN: edits no longer auto-re-render this layer (freeze_layer / unfreeze_layer).
                             // Absent ⇒ true. This, not `status`, is the freeze: a param edit overwrites status with "dirty"
                             // while the layer stays frozen, so a status-driven badge would lose it.
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
// L1 — precise per-line phonology from analyze_lyrics (dictionary path; the flow
// visualizer's feed). Transient + recomputable; agrees with the generation gate.
export type LyricWordSlot = { w: string; syllables: number; stress: string; inDict: boolean };
export type LyricAnalysis = {
  syllables: number;
  target: number;
  tol: number;
  syllableOk: boolean;
  endWord: string;
  rhymeGroup: string;
  rhymeAnchor: string;       // the group's anchor end word ("" = none)
  rhymeGrade: "perfect" | "slant" | "none" | "anchor" | "free" | string;
  rhymeOk: boolean;
  stress: string;            // per-line contour, e.g. "XxxX" (X=stressed, x=unstressed)
  words: LyricWordSlot[];    // per-word slots for the visualizer
  hasGap: boolean;
  analyzed: "text" | "seed" | "empty" | string;  // what content was analyzed
  complete: boolean;         // finalized text, no remaining gaps
  endInDict: boolean;        // end word found in the dictionary (confidence)
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
  status: "empty" | "seed" | "generating" | "proposed" | "accepted" | "asserted" | "locked" | "skeleton" | string;
  proposals?: LyricProposal[];  // L2 — transient ranked proposals (cleared on accept/reject)
  regen?: number;
  analysis?: LyricAnalysis;     // L1 — precise phonology (from analyze_lyrics)
  hasScore?: boolean;           // FMS Phase-3 — line carries a persisted lyricScore (take flow)
  asserted?: boolean;
  singable?: boolean;
  origin?: string;              // extraction provenance: sung|partial|mixed|generated|edited
  hasHeard?: boolean;           // line carries a persisted lyricHeard blob (raw ASR words)
};
export type LyricSheet = {
  id: string;
  grid: string;              // "1/4" | "1/8" | "1/16"
  language: string;
  topic: string;
  mood: string;
  explicit: "allow" | "clean" | "mild" | string;
  rhymeStrictness: "perfect" | "slant" | "free" | string;
  styleBias?: boolean;       // §7 style-RAG — bias generation toward the artist's own voice
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
  // Colors sharing a `group` are one control with a `mode` toggle in the UI
  // (e.g. Sustain · Gentle ⇄ Swell). Absent on ungrouped colors.
  group?: string;
  mode?: string;
};

// Route B transform target from GET /transform_targets (via list_transform_targets).
export type AvailableTransformTarget = { name: string };

// Guest-degradation capability summary — piggybacked onto GET /transform_targets'
// `capabilities` field (service/server.py's _guest_capability_summary(); see its
// docstring for why that endpoint specifically carries this). Honest, live-checked
// "is the per-feature AI setup installed on THIS Mac" flags: a guest Mac with no
// ~/Library/Mosh/venvs, no RAVE models, and no MOSH_TRAINING_REMOTE_URL sees every
// venv-backed flag false and both backends "fake" — used to disable/label the
// clip-menu transcription actions, the transform target picker, and the training
// popover instead of letting them fail cryptically.
export type ServiceCapabilities = {
  transcribe: boolean;
  skeleton: boolean;
  whisper: boolean;
  phonology: boolean;
  transformReal: boolean;    // Route B/C: a real RAVE model is installed vs the fake tilt/saturation
  trainingBackend: string;  // "fake" | "remote_http"
};

// LoRA library card from GET /loras (via list_loras) — the drop-in adapter dir.
export type AvailableLora = {
  name: string;
  displayName: string;
  trigger: string;   // prompt token — auto-injected server-side (tooltip-only)
  hint: string;      // suggested prompt vocabulary
  notes?: string;    // free-form sidecar notes (tooltip)
  valid?: boolean;   // false = listed but unusable (corrupt/unsupported file)
  reason?: string;   // why it's unusable (when valid === false)
  rank?: number;     // adapter rank from the safetensors header
  sha12?: string;    // content identity (retrain-in-place ⇒ new sha ⇒ cache MISS)
};

// Lane B — a RAVE model in the library (RAVE_MODEL_DIR / ~/AI/rave-models), from list_rave_models.
export type AvailableRaveModel = {
  name: string;      // .ts stem (the load_rave_model `target`)
  sizeMB?: number;
};

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
  /** Per-take waveform peaks ([min,max] bucket pairs — the main-lane shape).
   *  Additive (take-lanes wave): absent when the take's source file is missing
   *  or unreadable — the lane falls back to the labeled bar. */
  peaks?: [number, number][];
};

// A MIDI note as serialised in the snapshot — beats within the clip sequence.
export type MidiNote = {
  i: number;        // index into the clip's note list (the command handle)
  pitch: number;    // 0..127
  start: number;    // beats
  length: number;   // beats
  velocity: number; // 1..127
  // Deactivated (Ableton's `0`): still in the clip and still editable, just silent.
  // Serialized by the backend ONLY when true, so an ordinary note's payload is unchanged.
  mute?: boolean;
};

export type ClipGainPoint = {
  /** Seconds from the clip's current visible start; may be negative after a head trim. */
  t: number;
  /** Dynamic dB offset applied after the clip's static gain. */
  gainDb: number;
  curve?: number;
};

export type Clip = {
  id: string;
  name: string;
  type: "wave" | "midi" | "clip";
  start: number;
  length: number;
  offset: number;
  mute?: boolean;
  // Phase 2 — a HIDDEN beneath-render: the audio a MIDI/drum re-imagine produced, living on the
  // same track beneath the muted source. Filtered out of the lanes (it's not a clip to manage).
  hidden?: boolean;
  gainDb?: number;
  /** Clip-local dynamic gain envelope. Absent means no dynamic envelope. */
  clipGainPoints?: ClipGainPoint[];
  // G4b — clip-edge fades (wave clips only). Seconds; type is 1=linear 2=convex
  // 3=concave 4=sCurve (optional — the v1 UI only drives durations).
  fadeInSec?: number;
  fadeOutSec?: number;
  fadeInType?: number;
  fadeOutType?: number;
  // clip-ops wave — reverse / auto-crossfade (wave clips only). autoCrossfade only
  // has an audible effect when this clip overlaps a neighbor on the same track.
  reversed?: boolean;
  autoCrossfade?: boolean;
  // CLP-LOOP — clip loop region (wave clips). loopEnabled mirrors the engine's own
  // "is this clip looping" state (loop length > 0); start/length are in seconds.
  loopEnabled?: boolean;
  loopStart?: number;
  loopLength?: number;
  /** MIDI clip looping (Live 12's brace): content-relative beats, present ONLY
   *  while the clip loops (additive — absent otherwise). set_clip_loop's MIDI
   *  branch writes them; arrangement/editor paint ghost repeats from them. */
  midiLoopStartBeats?: number;
  midiLoopLengthBeats?: number;
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

/** Pro Tools-style arrangement group. Unlike a routing folder, this owns no signal
 *  path: active members select and move as one clip object. Inactive definitions are
 *  retained so the documented Regroup command can restore the last Ungroup. */
export type ClipGroup = {
  id: string;
  name: string;
  clipIds: string[];
  active: boolean;
};

export type TrackGroupKind = "edit" | "mix" | "edit_mix";

/** Pro Tools-style non-routing track linkage. These groups never create folder
 *  tracks or alter the signal path: Edit membership links selection, while Mix
 *  membership links volume, pan, mute, and solo. */
export type TrackGroup = {
  id: string;
  name: string;
  trackIds: string[];
  kind: TrackGroupKind;
  enabled: boolean;
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
  /** Stepped, not continuous: the engine snaps every applied value (including each
   *  sample off the curve) to the nearest of `states` evenly-spaced states, so the
   *  editor snaps its points to the same grid. Absent means continuous. */
  discrete?: boolean;
  states?: number;
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
// One loaded sound on a track's sampler. `index` is the sampler's own pad index and is
// how every pad command addresses it; `pitch` is the note that triggers it. A pad whose
// minNote..maxNote spans a wide range was assigned in melodic mode — it is a pitched
// instrument across the keyboard, not a single pad.
export type DrumPad = {
  index: number;
  pitch: number;
  minNote: number;
  maxNote: number;
  name: string;
  file: string;
  gainDb: number;
  pan: number;
  openEnded: boolean;
  /** 1-16, absent = none. Pads sharing a group cut each other off. */
  chokeGroup?: number;
};
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
  // CAP-AUT-006 — the mixer strip's own automatable plugins: the fader (volume/pan) and
  // the mute gate. They are deliberately absent from `plugins` (a rack row for either
  // would be noise), but their parameters automate through exactly the same
  // (trackId, pluginIndex, paramIndex) addressing as anything in `plugins` — the indices
  // here are real pluginList indices. Split out solely so the automation picker can
  // offer them; nothing else should render this.
  mixerPlugins?: Plugin[];
  volumeDb?: number;
  pan?: number;
  /** The routing mute (`set_track_mute`). NOT the mute-gate parameter — see
   *  src/plugins/mixer/TrackMutePlugin.h for how the two differ and why both exist. */
  mute?: boolean;
  solo?: boolean;
  /** Playback/resource state. `false` retains the track but removes it and its plug-ins
   *  from processing; absent snapshots are active for backward compatibility. */
  active?: boolean;
  // G10 — automation record-arm mode. Absent (legacy/never-set track) means "read".
  // Track-wide, not per-parameter: while "write", every automatable param change on
  // this track captures a point. Only "write" is behavioral in v0 — "touch"/"latch"
  // round-trip losslessly but are inert (Phase 2).
  automationMode?: "read" | "touch" | "latch" | "write";
  /** "#rrggbb" (lowercase), or absent for the track type's default colour. */
  color?: string;
  /** Chosen track icon NAME (see ui/src/trackIconNames.ts), or absent for the track
   *  type's default glyph. Deliberately `string` and not `TrackIconName`: a project saved
   *  by a newer Mosh can carry a name this build has no glyph for, and the renderer falls
   *  back to the type icon rather than the type system pretending that cannot happen. */
  icon?: string;
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
  // The sampler's loaded PADS, on any track that hosts one. Unlike drumMutedPitches
  // (which describes the eight fixed GM lanes the step grid assumes) this is what the
  // track actually holds, so a pad grid can render the real kit. `gainDb` is the RAW
  // engine gain — a muted pad reads at the engine's -48 dB floor, and the pad's own
  // gain is restored on unmute. minNote/maxNote span the whole keyboard for a sample
  // assigned in melodic mode, which is a pitched instrument rather than a pad.
  drumPads?: DrumPad[];
  /** The kit id last loaded onto this track (list_drum_kits reports the available ids). */
  drumKit?: string;
  sends?: Send[];
  isReturn?: boolean;
  returnBus?: number;
  meterEnabled?: boolean;
  /** Freeze Track (⌥⇧⌘F) — present+true only while the track is frozen: its clips
   *  are the rendered WAV and the device chain is parked (every plugin disabled).
   *  Additive; absent on unfrozen tracks and pre-freeze snapshots. */
  frozen?: boolean;
  // MIX-008 — group (submix) tracks. A group entry has isGroup + type "group" and
  // an empty clips array; a track nested under a group carries parentId.
  isGroup?: boolean;
  parentId?: string;
  // RTG-001/002 — routing. input = the explicitly-chosen input device; output =
  // the track's destination (absent = default out; isTrack = routed into a track).
  // `kind` distinguishes the two device families, which matters because a track can
  // carry a wave input and a MIDI input at once; absent on a choice stored before the
  // device could be resolved.
  input?: { deviceID: string; name?: string; kind?: "wave" | "midi" };
  output?: { isTrack: boolean; destId?: string; name: string; deviceID?: string };
  // LYR-001 — the per-track lyric sheet (absent ⇒ no sheet; the Lyrics tab shows its
  // empty state). Additive + optional.
  lyricSheet?: LyricSheet;
};

// RTG-001/002 — routing enumerations (read-only, on-demand like AudioDevices).
export type WaveInput = { deviceID: string; name: string; enabled: boolean; isStereoPair: boolean };
// CTL-001 — MIDI-input enumeration (read-only, on-demand like WaveInput). Feeds the
// per-instrument-track MIDI-input picker in the v2 inspector (list_midi_inputs).
export type MidiInput = { deviceID: string; name: string; alias: string; enabled: boolean; monitor: "off" | "on" | "automatic" };
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
  /** CAP-TRN-005 — where the CLICK can be routed. A separate list from `types` above on
   *  purpose: tracktion routes the click by te::OutputDevice name across wave AND MIDI
   *  outs, which is a different vocabulary from the JUCE device-type enumeration. Absent
   *  on an older backend. */
  clickOutputs?: ClickOutput[];
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
  truncated?: boolean;   // true when the native bounded scan found more rows
  limit?: number;        // maximum rows returned by this listing
  visited?: number;      // filesystem entries inspected before the bound stopped it
};

// Musical key for the session (Moshi sings in-key). ALWAYS present in the snapshot,
// backend-defaulted, so the UI never sees a missing field. tonic ∈ voice.js NOTE_PC,
// mode ∈ voice.js SCALES — the two domains must match the voice module exactly.
export type SessionKey = { tonic: string; mode: string };

// CAP-TRN-005 — the metronome's sound, level and routing, read straight off
// tracktion_engine's own click-track surface (te::Edit's CLICKTRACK child plus two
// app-global PropertyStorage settings). Not a Mosh model: every field maps 1:1 to
// something the engine already had.
export type ClickSettings = {
  /** Same value as session.metronome — the click is on. */
  enabled: boolean;
  /** LINEAR gain, and the engine clamps it to [levelMin, levelMax] on both read and
   *  write. So 0 is NOT silence: to silence the click you turn it off. */
  level: number;
  /** The engine's hard floor (0.2) and ceiling (1.0) for `level`. Sent so the UI can
   *  draw the range that is actually honoured instead of a dead-bottomed 0..1 slider. */
  levelMin: number;
  levelMax: number;
  /** Accent the first beat of each bar with the louder "big" click. Engine default off. */
  emphasizeBars: boolean;
  /** Only audible while recording (or while an input is armed and recording). */
  recordingOnly: boolean;
  /** The STORED routing intent — an OutputDevice name, or "" when nothing was ever
   *  chosen. Note this is a device NAME, not the deviceID the track-output commands
   *  use: routing the click is name-based in tracktion (findOutputDeviceWithName). */
  outputDevice: string;
  /** What the engine will ACTUALLY use — `outputDevice` when it resolves, otherwise
   *  the default-audio-out sentinel. Differs from `outputDevice` whenever the stored
   *  device is not currently present (unplugged interface, or any headless run). */
  outputDeviceResolved: string;
  /** The "(default audio output)" sentinel string, backend-owned so the UI never
   *  hard-codes it. Selecting it follows whatever the default device becomes. */
  defaultOutputDevice: string;
  /** WAV paths for the downbeat ("big") and other-beat ("small") clicks. "" ⇒ the
   *  engine's built-in click. The engine's loader is WAV-only, so the backend rejects
   *  anything else rather than silently falling back. */
  soundBig: string;
  soundSmall: string;
  /** MIDI notes (0-127) for the two clicks. Only audible when the click is routed to a
   *  MIDI output — inert on an audio out, which is why the UI reveals them only then. */
  midiNoteBig: number;
  midiNoteSmall: number;
};

/** One destination the click can be routed to (from list_audio_devices' `clickOutputs`).
 *  Deliberately separate from the JUCE device-type list in the same result: tracktion
 *  routes the click by te::OutputDevice NAME, spanning wave and MIDI outs. */
export type ClickOutput = { name: string; isMidi: boolean };

// REC-001 — how a live MIDI take behaves. Producer INTENT stored with the project; the
// backend pushes it into te::MidiInputDevice (mergeRecordings / replaceExistingClips /
// quantisation) and te::Edit::recordingPunchInOut whenever it could matter, so these are
// engine-wired settings rather than remembered ones.
export type RecordOptions = {
  /** A new take MERGES into the clip it lands on instead of starting a fresh one. */
  overdub: boolean;
  /** A take REPLACES clips it overlaps. Distinct from overdub: this is about the clips
   *  already on the timeline, not about the take's own contents. */
  replaceExisting: boolean;
  /** Record-quantise grid in BEATS, 0 = off. Same domain as quantize_notes' `division`,
   *  but the engine implements an irregular set (1/9 and 1/12 exist, 1/48 does not), so
   *  the backend refuses a value outside it rather than snapping. */
  quantize: number;
  /** The engine's own name for `quantize` ("1/16 beat", "(none)") — display only. */
  quantizeLabel: string;
  /** Capture only inside the punch/loop range. */
  punchInOut: boolean;
  /** How far back capture_midi can reach for MIDI you played without recording. */
  retrospectiveSeconds: number;
};

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
    // CAP-TRN-005 — the click's sound, level and routing. Sits next to `metronome`
    // (which stays the on/off flag) rather than under session.project, because unlike
    // countInBars/recordOptions this is the ENGINE's own click-track state, not
    // Mosh-owned MOSH_PROJECT intent. Every field is always present.
    click?: ClickSettings;
    // G2b — count-in / pre-roll bars before recording (0=off, 1=one bar, 2=two
    // bars). Mirrors session.project.countInBars (set_count_in writes it); ALWAYS
    // present, defaulting to 0. tracktion_engine plays an audible click through
    // the pre-roll and delays capture until the actual punch-in point.
    countInBars?: number;
    raveAvailable?: boolean;   // Route C.2 — anira build hosts the real-time RAVE insert
    singVoiceEnrolled?: boolean;  // FMS Phase-3 — ~/Library/Mosh/voice reference exists (locked-to-self)
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
    // A3 — how many unsaved arrangement commands the crash-recovery journal can replay
    // (recover_session) to restore work done since the last save. 0 ⇒ nothing to replay
    // (the notice is purely informational).
    recoverableCount?: number;
    // FS-T2 — third-party plugins implicated in a crash while the project was LOADING.
    // Present ⇒ the previous launch died mid-load with these being instantiated. Note this
    // is independent of recoveryAvailable: a load-time crash dies BEFORE the session.running
    // sentinel is written, so it reports a clean prior exit while being the worst case.
    pluginCrashSuspects?: string[];
    // The single plugin that taking safe mode will also quarantine (block_plugin). Empty
    // unless there is exactly ONE suspect — blocklisting is permanent, so with several
    // candidates Mosh skips them all but blocklists none. Backend-decided; never re-derived
    // in the UI.
    pluginQuarantineTarget?: string;
    // FS-T2 — the live Edit was loaded with third-party plugin nodes scrubbed out, so the
    // project is READ-ONLY (the backend refuses save(), including the 30s auto-save, rather
    // than overwrite the producer's plugin chain with the stripped version).
    safeModeActive?: boolean;
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
    /** The SYSTEM default output right now — may differ from audioDeviceName,
     *  because Mosh restores the device you last chose rather than following the
     *  system. Empty when nothing has enumerated devices yet (an honest unknown). */
    audioDeviceSystemDefault?: string;
    audioDeviceError?: string;
    // PRJ-008 — per-project format / time-base intent (the export/format default +
    // timeline display base). Generic media-format values, persisted with the project;
    // each field falls back to the live device readout when unset.
    project?: {
      sampleRate: number;
      bitDepth: number;
      timeBase: "seconds" | "barsBeats";
      // G2b — the source of truth cmdSetCountIn writes to; mirrored to the
      // top-level session.countInBars above (like session.project.key vs
      // session.key). Additive/optional so this stays a non-breaking type change.
      countInBars?: number;
      // REC-001 — what a live MIDI take DOES, alongside the count-in that precedes it.
      // Every field is always present on the wire (the backend defaults them), so the
      // recording panel never has to tell "false" from "missing" — but the object itself
      // is optional here, because a snapshot from an older backend simply won't have it.
      recordOptions?: RecordOptions;
    };
  };
  tracks: Track[];
  transport: Transport;
  controller?: ControllerState;
  master?: { volumeDb: number; pan: number; plugins?: Plugin[] };
  buses?: Bus[];
  sections?: Section[];
  annotations?: Annotation[];
  /** Additive Pro Tools-style arrangement groups; absent means no clip groups. */
  clipGroups?: ClipGroup[];
  /** The dormant definition eligible for Pro Tools Regroup. */
  lastUngroupedClipGroupId?: string;
  /** Additive, non-routing Pro Tools Edit/Mix group definitions. */
  trackGroups?: TrackGroup[];
  /** Temporarily bypasses every Track Group without deleting its membership. */
  trackGroupsSuspended?: boolean;
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
  // G1: export range (78) + delay-tail policy (81) — all optional/additive.
  range?: "full" | "loop" | "custom";
  rangeStart?: number;
  rangeEnd?: number;
  tail?: "cut" | "include";
  endAllowance?: number;
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
  // CAP-PRJ-005 — the undo point this command left the session at, as
  // "<sessionToken>:<transactionId>". ABSENT on lines written before the stamp shipped.
  // Two lines sharing a stamp is the normal case, not a bug: a command that opened no
  // undo transaction (set_metronome, a preference write) leaves the point where it was,
  // and every command inside one agent batch shares that batch's single transaction.
  txn?: string;
};
export type CommandLog = {
  entries: CommandLogEntry[];
  total: number;
  // CAP-PRJ-005 — where the session is NOW, and every point a jump can still reach.
  // Reachability is a property of the LIVE undo timeline, not of the log file: a point
  // undone past and then overwritten by a new edit, evicted as the history filled, or
  // stamped by an earlier process is simply not in this list.
  currentTxn?: string;
  restorableTxns?: string[];
};
