// ── Browser dev-mock of the MoshOps contract ─────────────────────────────────
// An in-memory backend that implements the SAME execute_command + snapshot +
// events seam the C++ MoshOps exposes (docs/02_MOSHOPS_CONTRACT.md), so the React
// UI runs fully interactive in a plain browser (Vite dev) with no JUCE WebView.
//
// This exists ONLY to make the UI iterable with real DOM/CSS introspection — it
// is NOT the engine and ships nowhere: bridge.ts wires it in solely under
// import.meta.env.DEV when the real native backend is absent. A production
// `vite build` (the bundle staged into Mosh.app) strips it entirely.
//
// Fidelity rule: the mock speaks the contract, not the engine. It returns the
// same { ok, command, data } envelopes, emits snapshot_invalidated on structural
// change and 30 Hz transport while playing, and keeps an undo/redo history — so
// behaviour the UI relies on is exercised, while audio/Tracktion concepts never
// appear (the swappable seam holds on the web side too).

import type { Snapshot, Clip, Track, Transport, CommandResult, RenderLayer, TrainingState } from "./types";

export const MOCK_ENABLED: boolean =
  typeof import.meta !== "undefined" && Boolean(import.meta.env?.DEV);

// ── seed session ─────────────────────────────────────────────────────────────

const SR = 48000;
let clipSeq = 100;
let trackSeq = 10;
const nextClipId = () => String(++clipSeq);
const nextTrackId = () => String(++trackSeq);

function waveClip(name: string, start: number, length: number): Clip {
  return {
    id: nextClipId(),
    name,
    type: "wave",
    start,
    length,
    offset: 0,
    sourceFile: `/mock/${name}.wav`,
    sourceLength: length,
    hasRenderLayer: false,
  };
}

function seedSnapshot(): Snapshot {
  const tracks: Track[] = [
    {
      id: nextTrackId(), index: 0, name: "Drums", type: "audio",
      volumeDb: 0, pan: 0, mute: false, solo: false,
      clips: [waveClip("loop", 0, 4), waveClip("fill", 6, 2)],
      plugins: [],
    },
    {
      id: nextTrackId(), index: 1, name: "Bass", type: "audio",
      volumeDb: -3, pan: 0, mute: false, solo: false,
      clips: [waveClip("sub", 0, 8)],
      plugins: [],
    },
    {
      id: nextTrackId(), index: 2, name: "Keys", type: "audio",
      volumeDb: -6, pan: 0.2, mute: false, solo: false,
      clips: [waveClip("chords", 2, 6)],
      plugins: [],
    },
  ];
  return {
    schemaVersion: 1,
    session: {
      sampleRate: SR, tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4,
      metronome: false, length: 16, editFile: "/mock/session.mosh",
      audioEnabled: true, bitDepth: 24, bufferSize: 512,
      availableCores: 8, audioThreads: 8, audioThreadsAuto: true,
      key: { tonic: "A", mode: "minor" },
    },
    tracks,
    transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
    master: { volumeDb: 0, pan: 0 },
    buses: [],
  };
}

// A blank edit — what the native new_project (createEmptyEdit) yields: valid session
// scaffolding, no tracks, transport parked at zero. Reuses seedSnapshot for the
// session shape so the two stay in lockstep.
function emptySession(): Snapshot {
  const s = seedSnapshot();
  s.tracks = [];
  s.buses = [];
  s.transport = { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 };
  return s;
}

let snapshot: Snapshot = seedSnapshot();
const clone = (s: Snapshot): Snapshot => JSON.parse(JSON.stringify(s)) as Snapshot;
const history: Snapshot[] = [];
const future: Snapshot[] = [];
// Agent batch grouping (mirrors the backend batch_begin/batch_end): while a batch
// is open, per-command pushUndo() is suppressed so the whole batch is ONE undo step.
let inBatch = false;

// ── event bus (mirrors window.__JUCE__.backend on the real side) ─────────────

type Listener = (payload: unknown) => void;
const listeners = new Map<string, Set<Listener>>();

// Mock command log (drives the CommandLog panel). Read-only commands don't log.
const cmdLog: { command: string; ok: boolean; undoable: boolean; ts: number }[] = [];
const READONLY = new Set(["get_snapshot", "get_clip_peaks", "file_peaks", "audition_file", "stop_audition", "get_command_log", "list_plugins", "list_builtins", "list_colors", "list_audio_devices", "list_wave_inputs", "list_track_outputs", "list_takes", "list_training_sources", "training_job_status", "list_lora_adapters"]);
const NON_UNDOABLE = new Set(["set_transport", "arm_track", "set_input_monitor", "undo", "redo", "save", "reload", "new_project", "render_layer", "open_plugin_editor", "set_plugin_param", "set_neural_param", "export_audio", "import_training_source", "approve_training_source", "build_training_corpus", "submit_training_job", "cancel_training_job", "import_lora_adapter", "activate_lora_adapter"]);
function emit(type: string, payload?: unknown) {
  const ls = listeners.get("mosh_event");
  if (ls) for (const fn of ls) fn({ type, payload });
}
export function mockOnEvent(eventId: string, fn: Listener): () => void {
  let set = listeners.get(eventId);
  if (!set) { set = new Set(); listeners.set(eventId, set); }
  set.add(fn);
  return () => set?.delete(fn);
}
const invalidate = () => emit("snapshot_invalidated");

// ── transport simulation (the 30 Hz decimated playhead feed) ─────────────────

let playTimer: ReturnType<typeof setInterval> | null = null;
let lastTick = 0;
function startPlayback() {
  if (playTimer) return;
  lastTick = Date.now();
  playTimer = setInterval(() => {
    const now = Date.now();
    const dt = (now - lastTick) / 1000;
    lastTick = now;
    const t = snapshot.transport;
    let pos = t.position + dt;
    if (t.looping && t.loopEnd > t.loopStart && pos >= t.loopEnd) pos = t.loopStart;
    snapshot.transport = { ...t, position: pos };
    emit("transport", snapshot.transport);

    // Fake master spectrum (8 bands, low→high) so Moshi reacts in browser dev where
    // there's no real audio. Animated off the playhead; a sharp ~2Hz flux pulse stands
    // in for onsets, low end tilted louder like real music.
    const N = 8;
    const bands = Array.from({ length: N }, (_, i) => {
      const base = 0.5 + 0.5 * Math.sin(pos * (1.5 + i * 0.45) + i * 1.7);
      const tilt = 1 - i / (N * 1.5);
      return Math.max(0, Math.min(1, base * tilt * 0.92));
    });
    const level = bands.reduce((a, b) => a + b, 0) / N;
    const flux = Math.max(0, Math.sin(pos * Math.PI * 4)) ** 6;
    emit("spectrum", { bands, level, flux });

    // Fake per-track + master peak levels (dBFS) so the meters move in browser dev,
    // where there's no real audio. Wobbles per track off the playhead; muted tracks
    // read the floor. Shape matches the native `levels` event the store hydrates.
    const toDb = (g: number) => (g <= 0.001 ? -100 : -60 + Math.max(0, Math.min(1, g)) * 60);
    const tracks = snapshot.tracks
      .filter((t) => !t.isGroup)
      .map((t, i) => {
        const g = t.mute ? 0 : level * (0.6 + 0.4 * Math.abs(Math.sin(pos * 2.3 + i)));
        const db = toDb(g);
        return { id: t.id, l: db, r: toDb(g * 0.94) };
      });
    emit("levels", { tracks, master: { l: toDb(level), r: toDb(level * 0.96) } });
  }, 1000 / 30);
}
function stopPlayback() {
  if (playTimer) { clearInterval(playTimer); playTimer = null; }
  emit("spectrum", { bands: Array(8).fill(0), level: 0, flux: 0 }); // calm on stop
  // Drop the meters to the floor when the transport stops.
  const tracks = snapshot.tracks.filter((t) => !t.isGroup).map((t) => ({ id: t.id, l: -100, r: -100 }));
  emit("levels", { tracks, master: { l: -100, r: -100 } });
}

// ── helpers ──────────────────────────────────────────────────────────────────

const num = (v: unknown, d = 0): number => (typeof v === "number" && isFinite(v) ? v : d);
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
function findClip(clipId: string): { track: Track; clip: Clip } | null {
  for (const track of snapshot.tracks)
    for (const clip of track.clips) if (clip.id === clipId) return { track, clip };
  return null;
}
function findTrack(trackId: string): Track | null {
  return snapshot.tracks.find((t) => t.id === trackId) ?? null;
}
// DRM-001 — mirror the native default-instrument policy: a track that needs an
// instrument gets the sane default (drum → sampler, melodic → 4OSC) unless it
// already hosts one. Keeps UI tests honest about the auto-load behaviour.
function ensureInstrument(t: Track, drum: boolean): void {
  t.plugins = t.plugins ?? [];
  if (!t.plugins.some((p) => p.isInstrument)) {
    const b = drum ? { type: "sampler", name: "Sampler" } : { type: "4osc", name: "4OSC Synth" };
    t.plugins.unshift({ index: 0, name: b.name, type: b.type, enabled: true, external: false, builtin: true, category: "Instrument", isInstrument: true, params: [] });
    t.plugins.forEach((p, i) => (p.index = i));
  }
  t.isInstrument = t.plugins.some((p) => p.isInstrument);
}
function pushUndo() { if (inBatch) return; history.push(clone(snapshot)); future.length = 0; if (history.length > 100) history.shift(); }

const ok = (command: string, data?: unknown): CommandResult => ({ ok: true, command, data });
const err = (command: string, error: string): CommandResult => ({ ok: false, command, error });

function trainingState(): TrainingState {
  if (!snapshot.training) {
    snapshot.training = {
      registryPath: "/mock/training/rights_registry.json",
      statePath: "/mock/training/training_state.json",
      activeAdapterId: "",
      activeAdapterPath: "",
      activeCorpusHash: "",
      sources: [],
      adapters: [],
      jobs: [],
    };
  }
  return snapshot.training as TrainingState;
}

// ── plugin / neural / generative catalog (dev-mock only) ─────────────────────
const BUILTINS = [
  { type: "4osc", name: "4OSC", category: "Instruments", isInstrument: true, builtin: true as const },
  { type: "reverb", name: "Reverb", category: "Effects", isInstrument: false, builtin: true as const },
  { type: "delay", name: "Delay", category: "Effects", isInstrument: false, builtin: true as const },
  { type: "eq", name: "4-Band EQ", category: "Effects", isInstrument: false, builtin: true as const },
];
const VST3S = [
  { id: "vital", name: "Vital", format: "VST3", manufacturer: "Vital Audio", isInstrument: true },
  { id: "ott", name: "OTT", format: "VST3", manufacturer: "Xfer", isInstrument: false },
];
const COLORS = [
  { name: "grit", astd_max: 0.55, peak_layer: 2, more_sign: 1, verdict: "STRONG", no_stack_with: [] as string[] },
  { name: "brightness", astd_max: 0.5, peak_layer: 3, more_sign: 1, verdict: "STRONG", no_stack_with: ["air"] },
  { name: "air", astd_max: 0.08, peak_layer: 1, more_sign: 1, verdict: "WEAK", no_stack_with: ["brightness"] },
];

const reindex = (t: Track) => t.plugins!.forEach((p, i) => (p.index = i));
const reindexNotes = (c: Clip) => c.notes!.forEach((n, i) => (n.i = i));
function findPlugin(trackId: string, index: number): { track: Track; idx: number } | null {
  const t = findTrack(trackId);
  if (!t || !t.plugins || index < 0 || index >= t.plugins.length) return null;
  return { track: t, idx: index };
}
function mkParams(n: number) {
  return Array.from({ length: n }, (_, i) => ({ index: i, name: ["Drive", "Tone", "Mix", "Decay", "Size", "Rate", "Depth", "Gain"][i] ?? `P${i}`, value: 0.5 }));
}

// ── command dispatch ─────────────────────────────────────────────────────────

function dispatch(command: string, args: Record<string, unknown>): CommandResult {
  switch (command) {
    case "set_transport": {
      const t = snapshot.transport;
      const action = str(args.action);
      if (action === "toggle") {
        const playing = !t.playing;
        snapshot.transport = { ...t, playing };
        playing ? startPlayback() : stopPlayback();
        emit("transport", snapshot.transport);
        return ok(command, { playing });
      }
      if (action === "stop") {
        stopPlayback();
        snapshot.transport = { ...t, playing: false, recording: false, position: num(args.position, 0) };
        emit("transport", snapshot.transport);
        return ok(command);
      }
      if (action === "to_end") {
        snapshot.transport = { ...t, position: snapshot.session.length ?? 16 };
        emit("transport", snapshot.transport);
        return ok(command);
      }
      if (action === "record") {
        snapshot.transport = { ...t, recording: !t.recording, playing: true };
        startPlayback();
        emit("transport", snapshot.transport);
        return ok(command);
      }
      // direct field sets: position / loop
      const next: Transport = { ...t };
      if ("position" in args) next.position = Math.max(0, num(args.position));
      if ("loop" in args) { next.looping = Boolean(args.loop); next.loopStart = num(args.loopStart, t.loopStart); next.loopEnd = num(args.loopEnd, t.loopEnd); }
      snapshot.transport = next;
      emit("transport", snapshot.transport);
      return ok(command);
    }

    case "create_track": {
      pushUndo();
      // DRM-001 — type:"drum" auto-loads the sampler + kit (modelled here so UI tests
      // see an instrument-bearing drum track, mirroring the native default policy).
      const type = str(args.type, "audio") === "drum" ? "drum" : "audio";
      const t: Track = {
        id: nextTrackId(), index: snapshot.tracks.length, name: str(args.name, "Audio"),
        type, volumeDb: 0, pan: 0, mute: false, solo: false, clips: [], plugins: [],
      };
      if (type === "drum") ensureInstrument(t, true);
      snapshot.tracks.push(t);
      invalidate();
      return ok(command, { trackId: t.id, type, isInstrument: !!t.isInstrument });
    }
    case "create_group_track": {
      // MIX-008 — wrap the given tracks in a submix (group) track. Dispatched by the
      // configurable keymap's GROUP action (Mod+G). Minimal mock: append a group track
      // and reparent the members so the UI shows the submix.
      const ids = (Array.isArray(args.trackIds) ? (args.trackIds as unknown[]) : []).map(String);
      if (ids.length === 0) return err(command, "no trackIds");
      pushUndo();
      const g: Track = {
        id: nextTrackId(), index: snapshot.tracks.length, name: "Group",
        type: "group", isGroup: true, volumeDb: 0, pan: 0, mute: false, solo: false, clips: [], plugins: [],
      };
      snapshot.tracks.push(g);
      for (const t of snapshot.tracks) if (ids.includes(t.id)) t.parentId = g.id;
      invalidate();
      return ok(command, { trackId: g.id });
    }
    case "set_track_type": {
      const t = findTrack(str(args.trackId));
      if (!t) return err(command, "track not found");
      const type = str(args.type, "audio") === "drum" ? "drum" : "audio";
      pushUndo();
      t.type = type;
      if (type === "drum") ensureInstrument(t, true);
      invalidate();
      return ok(command, { trackId: t.id, type, isInstrument: !!t.isInstrument });
    }
    case "load_drum_kit": {
      const t = findTrack(str(args.trackId));
      if (!t) return err(command, "track not found");
      pushUndo();
      ensureInstrument(t, true);
      invalidate();
      return ok(command, { trackId: t.id, pads: 8 });
    }
    case "assign_sample": {
      const t = findTrack(str(args.trackId));
      if (!t) return err(command, "track not found");
      // Mirror the native guard: a sample is required (native also checks the file
      // exists on disk, which the mock can't, so it only enforces a non-empty path).
      const file = str(args.file);
      if (!file) return err(command, "file not found: " + file);
      pushUndo();
      ensureInstrument(t, true);
      invalidate();
      return ok(command, { trackId: t.id, note: num(args.note, 60), name: str(args.name, "Sample"), file });
    }
    case "set_drum_lane": {
      const t = findTrack(str(args.trackId));
      if (!t) return err(command, "track not found");
      const note = num(args.note, -1);
      if (note < 0) return err(command, "note (0-127) required");
      const toggle = (arr: number[] | undefined, on: boolean): number[] => {
        const set = new Set(arr ?? []);
        if (on) set.add(note); else set.delete(note);
        return [...set].sort((a, b) => a - b);
      };
      pushUndo();
      if ("mute" in args) t.drumMutedPitches = toggle(t.drumMutedPitches, Boolean(args.mute));
      if ("solo" in args) t.drumSoloPitches = toggle(t.drumSoloPitches, Boolean(args.solo));
      invalidate();
      return ok(command, { trackId: t.id, note, muted: (t.drumMutedPitches ?? []).includes(note), solo: (t.drumSoloPitches ?? []).includes(note) });
    }
    case "rename_track": {
      const t = findTrack(str(args.trackId));
      if (!t) return err(command, "track not found");
      pushUndo(); t.name = str(args.name, t.name); invalidate(); return ok(command);
    }
    case "remove_track": {
      const idx = snapshot.tracks.findIndex((t) => t.id === str(args.trackId));
      if (idx < 0) return err(command, "track not found");
      pushUndo(); snapshot.tracks.splice(idx, 1);
      snapshot.tracks.forEach((t, i) => (t.index = i));
      invalidate(); return ok(command);
    }
    case "set_track_volume": { const t = findTrack(str(args.trackId)); if (!t) return err(command, "track not found"); pushUndo(); t.volumeDb = num(args.db); invalidate(); return ok(command); }
    case "set_track_pan":    { const t = findTrack(str(args.trackId)); if (!t) return err(command, "track not found"); pushUndo(); t.pan = num(args.pan); invalidate(); return ok(command); }
    case "set_track_mute":   { const t = findTrack(str(args.trackId)); if (!t) return err(command, "track not found"); pushUndo(); t.mute = Boolean(args.mute); invalidate(); return ok(command); }
    case "set_track_solo":   { const t = findTrack(str(args.trackId)); if (!t) return err(command, "track not found"); pushUndo(); t.solo = Boolean(args.solo); invalidate(); return ok(command); }

    case "add_test_tone_clip": {
      const t = findTrack(str(args.trackId)) ?? snapshot.tracks[0];
      if (!t) return err(command, "no track");
      pushUndo();
      const c = waveClip("tone", num(args.start, snapshot.transport.position), num(args.seconds, 2));
      t.clips.push(c); invalidate(); return ok(command, { clipId: c.id });
    }
    case "import_clip": {
      const t = findTrack(str(args.trackId)) ?? snapshot.tracks[0];
      if (!t) return err(command, "no track");
      pushUndo();
      const name = str(args.name) || (str(args.file).split("/").pop() ?? "clip");
      // Honor startSeconds (the real cmdImportClip contract); fall back to `start`.
      // The real engine imports the whole file at its own duration and models no
      // trim, so use a fixed placeholder length here rather than an args.length the
      // engine would ignore (matching cmdImportClip, not faking a trimmed clip).
      const c = waveClip(name.replace(/\.[^.]+$/, ""), num(args.startSeconds, num(args.start, 0)), 4);
      t.clips.push(c); invalidate(); return ok(command, { clipId: c.id });
    }
    case "move_clip": {
      const f = findClip(str(args.clipId)); if (!f) return err(command, "clip not found");
      pushUndo(); f.clip.start = Math.max(0, num(args.start, f.clip.start));
      if ("trackId" in args) { // move across tracks
        const dest = findTrack(str(args.trackId));
        if (dest && dest !== f.track) { f.track.clips = f.track.clips.filter((c) => c.id !== f.clip.id); dest.clips.push(f.clip); }
      }
      invalidate(); return ok(command);
    }
    case "trim_clip": {
      const f = findClip(str(args.clipId)); if (!f) return err(command, "clip not found");
      pushUndo();
      if ("start" in args) f.clip.start = Math.max(0, num(args.start, f.clip.start));
      if ("length" in args) f.clip.length = Math.max(0.05, num(args.length, f.clip.length));
      if ("offset" in args) f.clip.offset = Math.max(0, num(args.offset, f.clip.offset));
      invalidate(); return ok(command);
    }
    case "split_clip": {
      const f = findClip(str(args.clipId)); if (!f) return err(command, "clip not found");
      const t = num(args.time);
      if (t <= f.clip.start || t >= f.clip.start + f.clip.length) return err(command, "split point outside clip");
      pushUndo();
      const right = waveClip(f.clip.name, t, f.clip.start + f.clip.length - t);
      right.offset = f.clip.offset + (t - f.clip.start);
      f.clip.length = t - f.clip.start;
      f.track.clips.push(right);
      invalidate(); return ok(command, { clipId: right.id });
    }
    case "remove_clip": {
      const f = findClip(str(args.clipId)); if (!f) return err(command, "clip not found");
      pushUndo(); f.track.clips = f.track.clips.filter((c) => c.id !== f.clip.id); invalidate(); return ok(command);
    }
    case "duplicate_clip": {
      const f = findClip(str(args.clipId)); if (!f) return err(command, "clip not found");
      pushUndo();
      const dup = waveClip(f.clip.name, f.clip.start + f.clip.length, f.clip.length);
      f.track.clips.push(dup); invalidate(); return ok(command, { clipId: dup.id });
    }
    case "rename_clip": { const f = findClip(str(args.clipId)); if (!f) return err(command, "clip not found"); pushUndo(); f.clip.name = str(args.name, f.clip.name); invalidate(); return ok(command); }
    case "set_clip_mute": { const f = findClip(str(args.clipId)); if (!f) return err(command, "clip not found"); pushUndo(); f.clip.mute = Boolean(args.mute); invalidate(); return ok(command); }
    case "set_clip_gain": { const f = findClip(str(args.clipId)); if (!f) return err(command, "clip not found"); pushUndo(); f.clip.gainDb = num(args.gainDb); invalidate(); return ok(command); }

    // ── recording transport + take lanes (comp tree) ─────────────────────────
    // No audio I/O in the browser dev mock, so "recording" is simulated against
    // session state: arming flags the track; stop_recording lands a take on each
    // armed track. Repeat recordings stack onto the same clip's native take tree
    // (the UI shows lanes once a clip has ≥2 takes); set_current_take / keep_take
    // act on that tree. arm/monitor mirror the backend's transport-config nature
    // (non-undoable); landing/comping a take IS a document edit (undoable).
    case "arm_track": {
      const t = findTrack(str(args.trackId)); if (!t) return err(command, "track not found");
      t.armed = Boolean(args.armed); invalidate(); return ok(command, { armed: t.armed });
    }
    case "set_input_monitor": {
      const t = findTrack(str(args.trackId)); if (!t) return err(command, "track not found");
      const mode = str(args.mode, "automatic");
      t.monitor = mode === "off" || mode === "on" ? mode : "automatic";
      invalidate(); return ok(command, { monitor: t.monitor });
    }
    case "stop_recording": {
      stopPlayback();
      snapshot.transport = { ...snapshot.transport, playing: false, recording: false };
      emit("transport", snapshot.transport);
      if (Boolean(args.discardRecordings)) { invalidate(); return ok(command, { clips: [] }); }
      pushUndo(); // bracket only the actual take landing (the undoable document edit)
      const armed = snapshot.tracks.filter((t) => t.armed);
      const targets = armed.length ? armed : snapshot.tracks[0] ? [snapshot.tracks[0]] : [];
      const landed: { id: string }[] = [];
      for (const t of targets) {
        // Stack onto an existing take-bearing clip if present, else start one.
        const existing = t.clips.find((c) => c.takes && c.takes.length > 0);
        if (existing && existing.takes) {
          const idx = existing.takes.length;
          existing.takes.forEach((tk) => (tk.isCurrent = false));
          existing.takes.push({ index: idx, description: `Take ${idx + 1}`, isCurrent: true });
          existing.numTakes = existing.takes.length;
          existing.currentTakeIndex = idx;
          landed.push({ id: existing.id });
        } else {
          const c = waveClip("take", Math.max(0, snapshot.transport.position - 2), 2);
          c.takes = [{ index: 0, description: "Take 1", isCurrent: true }];
          c.numTakes = 1; c.currentTakeIndex = 0;
          t.clips.push(c);
          landed.push({ id: c.id });
        }
      }
      invalidate(); return ok(command, { clips: landed });
    }
    case "list_takes": {
      const f = findClip(str(args.clipId)); if (!f) return err(command, "clip not found");
      const takes = f.clip.takes ?? [];
      return ok(command, { takes, numTakes: f.clip.numTakes ?? takes.length, currentTakeIndex: f.clip.currentTakeIndex ?? 0 });
    }
    case "set_current_take": {
      const f = findClip(str(args.clipId)); if (!f?.clip.takes) return err(command, "clip has no takes");
      const idx = num(args.takeIndex);
      if (idx < 0 || idx >= f.clip.takes.length) return err(command, "take index out of range");
      pushUndo();
      f.clip.takes.forEach((tk) => (tk.isCurrent = tk.index === idx));
      f.clip.currentTakeIndex = idx;
      invalidate(); return ok(command);
    }
    case "keep_take": {
      const f = findClip(str(args.clipId)); if (!f) return err(command, "clip not found");
      if (!f.clip.takes || f.clip.takes.length === 0) return err(command, "clip has no takes");
      pushUndo();
      const cur = f.clip.currentTakeIndex ?? f.clip.takes.findIndex((tk) => tk.isCurrent);
      const kept = f.clip.takes[cur >= 0 ? cur : 0] ?? f.clip.takes[0];
      if (kept?.description) f.clip.name = kept.description; // flatten the comp to the kept take
      delete f.clip.takes; delete f.clip.numTakes; delete f.clip.currentTakeIndex;
      invalidate(); return ok(command);
    }

    case "set_tempo": { pushUndo(); snapshot.session.tempo = Math.max(20, num(args.bpm, snapshot.session.tempo)); invalidate(); return ok(command); }
    case "set_key": { pushUndo(); snapshot.session.key = { tonic: str(args.tonic, snapshot.session.key?.tonic ?? "A"), mode: str(args.mode, snapshot.session.key?.mode ?? "minor") }; invalidate(); return ok(command); }
    case "set_master_volume": { pushUndo(); if (snapshot.master) snapshot.master.volumeDb = num(args.db); invalidate(); return ok(command); }

    case "undo": {
      if (!history.length) return ok(command, { undone: false });
      future.push(clone(snapshot)); snapshot = history.pop()!; stopPlayback(); invalidate(); return ok(command, { undone: true });
    }
    case "redo": {
      if (!future.length) return ok(command, { redone: false });
      history.push(clone(snapshot)); snapshot = future.pop()!; stopPlayback(); invalidate(); return ok(command, { redone: true });
    }
    case "batch_begin": {
      if (inBatch) return err(command, "a batch is already open");
      pushUndo(); inBatch = true; return ok(command);
    }
    case "batch_end": {
      if (!inBatch) return err(command, "no batch is open");
      inBatch = false; invalidate(); return ok(command);
    }
    case "save": case "reload": return ok(command);

    case "get_clip_peaks": {
      const f = findClip(str(args.clipId));
      const buckets = Math.max(8, Math.min(2000, num(args.buckets, 800)));
      const peaks = makePeaks(f?.clip ?? null, buckets);
      return ok(command, { peaks });
    }
    // file_peaks / audition — sample-browser thumbnail + preview seam. The mock can't
    // read real files or play audio, so it returns a synthetic waveform + a no-sound
    // ack (faithful to the backend's command shape; real audio lives in the app).
    case "file_peaks": {
      if (!str(args.path)) return err(command, "missing 'path'");
      const buckets = Math.max(16, Math.min(4000, num(args.buckets, 200)));
      const peaks = Array.from({ length: buckets }, (_, i) => {
        const a = 0.15 + 0.8 * Math.abs(Math.sin(i / 5) * Math.cos(i / 17));
        return [-a, a] as [number, number];
      });
      return ok(command, { path: str(args.path), buckets, peaks });
    }
    case "audition_file":
      return str(args.path) ? ok(command, { path: str(args.path), playing: false }) : err(command, "missing 'path'");
    case "stop_audition":
      return ok(command);

    // ── plugins / neural rack ────────────────────────────────────────────────
    case "list_plugins": return ok(command, { plugins: VST3S, counts: { vst3: VST3S.length, au: 0, total: VST3S.length } });
    case "list_builtins": return ok(command, { plugins: BUILTINS });
    case "set_master_pan": { pushUndo(); if (snapshot.master) snapshot.master.pan = num(args.pan); invalidate(); return ok(command); }
    case "enable_all_meters": case "enable_track_meter": case "disable_track_meter": return ok(command);
    case "list_wave_inputs": return ok(command, { inputs: [] });
    case "list_track_outputs": return ok(command, { outputs: [], tracks: snapshot.tracks.map((t) => ({ id: t.id, name: t.name })), audioEnabled: true });

    // ── settings / export / command log (topbar utilities) ───────────────────
    case "list_audio_devices": return ok(command, {
      types: [{ name: "CoreAudio", outputs: ["MacBook Pro Speakers", "External Headphones"], inputs: ["MacBook Pro Microphone"] }],
      current: { type: "CoreAudio", outputDevice: "MacBook Pro Speakers", inputDevice: "MacBook Pro Microphone", sampleRate: SR, bufferSize: snapshot.session.bufferSize ?? 512 },
      sampleRates: [44100, 48000, 96000], bufferSizes: [128, 256, 512, 1024], defaultBufferSize: 512, audioEnabled: true,
    });
    case "set_buffer_size": { if (snapshot.session) snapshot.session.bufferSize = num(args.bufferSize, 512); invalidate(); return ok(command); }
    case "set_audio_threads": { if (snapshot.session) { snapshot.session.audioThreads = num(args.threads, 8); snapshot.session.audioThreadsAuto = false; } invalidate(); return ok(command); }
    case "set_audio_device": case "set_project_settings": case "open_project": case "save_as": return ok(command);
    // New project = a fresh empty edit (createEmptyEdit on the native side). Resets to a
    // blank session and clears undo history — you can't undo across a New, same as a DAW.
    case "new_project": {
      snapshot = emptySession();
      history.length = 0; future.length = 0;
      stopPlayback();
      invalidate();
      return ok(command);
    }
    case "relink_clip": return ok(command);   // gap 3 — re-point a missing wave source (mock no-op)
    case "set_metronome": { pushUndo(); snapshot.session.metronome = Boolean(args.enabled); invalidate(); return ok(command); }
    case "set_time_signature": {
      pushUndo();
      snapshot.session.timeSigNumerator = Math.max(1, num(args.numerator, snapshot.session.timeSigNumerator));
      snapshot.session.timeSigDenominator = num(args.denominator, snapshot.session.timeSigDenominator);
      invalidate(); return ok(command);
    }
    case "export_audio": return ok(command, { file: str(args.file) || "/mock/mixdown." + str(args.format, "wav"), format: str(args.format, "wav"), bitDepth: num(args.bitDepth, 24), sampleRate: num(args.sampleRate, SR), bytes: 794000, renderMode: "offline" });
    case "get_command_log": {
      const limit = Math.max(1, num(args.limit, 50));
      return ok(command, { entries: cmdLog.slice(-limit).reverse(), total: cmdLog.length });
    }

    case "load_builtin": {
      const t = findTrack(str(args.trackId)); if (!t) return err(command, "track not found");
      const b = BUILTINS.find((x) => x.type === str(args.type)); if (!b) return err(command, "unknown builtin");
      pushUndo(); t.plugins = t.plugins ?? [];
      t.plugins.push({ index: t.plugins.length, name: b.name, type: b.type, enabled: true, external: false, builtin: true, category: b.category, isInstrument: b.isInstrument, params: mkParams(b.isInstrument ? 0 : 4) });
      invalidate(); return ok(command);
    }
    case "load_plugin": {
      const t = findTrack(str(args.trackId)); if (!t) return err(command, "track not found");
      const v = VST3S.find((x) => x.id === str(args.pluginId)); if (!v) return err(command, "unknown plugin");
      pushUndo(); t.plugins = t.plugins ?? [];
      t.plugins.push({ index: t.plugins.length, name: v.name, type: v.format, enabled: true, external: true, isInstrument: v.isInstrument, params: mkParams(6) });
      invalidate(); return ok(command);
    }
    case "add_neural_insert": {
      const t = findTrack(str(args.trackId)); if (!t) return err(command, "track not found");
      pushUndo(); t.plugins = t.plugins ?? [];
      const model = str(args.modelId, "nam");
      t.plugins.push({ index: t.plugins.length, name: `Neural · ${model}`, type: "neural", enabled: true, external: false, isInstrument: false, params: [],
        neural: { model, labMode: false, latencySamples: 64, latencySeconds: 64 / SR,
          params: [{ id: "drive", ui: 40, safeMaxUi: 70 }, { id: "tone", ui: 50, safeMaxUi: 100 }, { id: "mix", ui: 100, safeMaxUi: 100 }] } });
      invalidate(); return ok(command);
    }
    case "bypass_plugin": { const f = findPlugin(str(args.trackId), num(args.index)); if (!f) return err(command, "plugin not found"); pushUndo(); f.track.plugins![f.idx].enabled = !Boolean(args.bypassed); invalidate(); return ok(command); }
    case "remove_plugin": { const f = findPlugin(str(args.trackId), num(args.index)); if (!f) return err(command, "plugin not found"); pushUndo(); f.track.plugins!.splice(f.idx, 1); reindex(f.track); invalidate(); return ok(command); }
    case "reorder_plugin": {
      const f = findPlugin(str(args.trackId), num(args.index)); if (!f) return err(command, "plugin not found");
      const to = num(args.toIndex); if (to < 0 || to >= f.track.plugins!.length) return ok(command);
      pushUndo(); const [p] = f.track.plugins!.splice(f.idx, 1); f.track.plugins!.splice(to, 0, p); reindex(f.track); invalidate(); return ok(command);
    }
    case "set_plugin_param": {
      const f = findPlugin(str(args.trackId), num(args.index)); if (!f) return err(command, "plugin not found");
      const p = f.track.plugins![f.idx].params?.find((x) => x.index === num(args.paramIndex)); if (p) p.value = num(args.value);
      invalidate(); return ok(command);
    }
    case "set_neural_param": {
      const f = findPlugin(str(args.trackId), num(args.index)); if (!f?.track.plugins![f.idx].neural) return err(command, "not a neural insert");
      const np = f.track.plugins![f.idx].neural!.params.find((x) => x.id === str(args.paramId)); if (np) np.ui = num(args.value);
      invalidate(); return ok(command);
    }
    case "set_neural_lab_mode": { const f = findPlugin(str(args.trackId), num(args.index)); if (f?.track.plugins![f.idx].neural) { pushUndo(); f.track.plugins![f.idx].neural!.labMode = Boolean(args.on); invalidate(); } return ok(command); }
    case "load_neural_model": {
      const f = findPlugin(str(args.trackId), num(args.pluginIndex));
      if (!f?.track.plugins![f.idx].neural) return err(command, "not a neural insert");
      pushUndo();
      const n = f.track.plugins![f.idx].neural!;
      const p = str(args.path);
      n.modelPath = p;
      n.modelName = p.split("/").pop() || p; // describe() reports the loaded file's name
      invalidate(); return ok(command, { modelName: n.modelName, modelPath: n.modelPath });
    }
    case "reset_neural": case "open_plugin_editor": case "set_neural_latency": return ok(command);

    // ── parameter automation (buried editor) ─────────────────────────────────
    case "add_automation_point": case "set_automation_point": case "remove_automation_point": case "clear_automation": {
      const f = findPlugin(str(args.trackId), num(args.pluginIndex));
      const p = f?.track.plugins![f.idx].params?.find((x) => x.index === num(args.paramIndex));
      if (!p) return err(command, "param not found");
      pushUndo();
      p.points = p.points ?? [];
      if (command === "add_automation_point") p.points.push({ t: Math.max(0, num(args.time)), v: Math.min(1, Math.max(0, num(args.value))) });
      else if (command === "set_automation_point") { const pt = p.points[num(args.pointIndex)]; if (pt) { pt.t = Math.max(0, num(args.time)); pt.v = Math.min(1, Math.max(0, num(args.value))); } }
      else if (command === "remove_automation_point") p.points.splice(num(args.pointIndex), 1);
      else p.points = [];
      p.automated = p.points.length > 0;
      invalidate(); return ok(command);
    }

    // ── generative (Tier-B) render layers ────────────────────────────────────
    case "list_colors": return ok(command, { colors: COLORS });
    case "create_render_layer": {
      const f = findClip(str(args.clipId)); if (!f) return err(command, "clip not found");
      pushUndo();
      f.clip.hasRenderLayer = true;
      f.clip.renderLayer = { id: "rl-" + f.clip.id, status: "dirty", adapter: str(args.adapter, "fake"), mode: str(args.mode, "reimagine"), seed: 1, userKept: false, hasArtifact: false, nl: 0.45, colors: [] };
      invalidate(); return ok(command);
    }
    case "set_render_param": {
      const f = findClip(str(args.clipId)); if (!f?.clip.renderLayer) return err(command, "no render layer");
      const rl = f.clip.renderLayer;
      if ("colors" in args) rl.colors = args.colors as RenderLayer["colors"];
      if ("nl" in args) rl.nl = num(args.nl, rl.nl);
      if ("seed" in args) rl.seed = num(args.seed, rl.seed);
      rl.status = "dirty"; rl.hasArtifact = false;
      invalidate(); return ok(command);
    }
    case "render_layer": {
      const f = findClip(str(args.clipId)); if (!f?.clip.renderLayer) return err(command, "no render layer");
      f.clip.renderLayer.status = "ready"; f.clip.renderLayer.hasArtifact = true;
      emit("layer_status", { clipId: f.clip.id, qa: { pq: 5.1, pq_base: 5.66, flags: ["quality_degraded"], adapter: f.clip.renderLayer.adapter } });
      invalidate(); return ok(command);
    }
    case "accept_render": case "freeze_layer": case "bounce_layer_to_clip": {
      const f = findClip(str(args.clipId)); if (!f?.clip.renderLayer) return err(command, "no render layer");
      pushUndo();
      f.clip.renderLayer.userKept = true;
      f.clip.renderLayer.status = command === "freeze_layer" ? "frozen" : command === "bounce_layer_to_clip" ? "bounced" : "ready";
      invalidate(); return ok(command);
    }
    case "reject_render": { const f = findClip(str(args.clipId)); if (f?.clip.renderLayer) { f.clip.renderLayer.status = "dirty"; f.clip.renderLayer.userKept = false; invalidate(); } return ok(command); }
    case "bypass_layer": { const f = findClip(str(args.clipId)); if (f?.clip.renderLayer) { f.clip.renderLayer.status = Boolean(args.bypassed) ? "bypassed" : "ready"; invalidate(); } return ok(command); }
    case "cancel_render": { const f = findClip(str(args.clipId)); if (f?.clip.renderLayer) { f.clip.renderLayer.status = "dirty"; invalidate(); } return ok(command); }
    case "remove_render_layer": { const f = findClip(str(args.clipId)); if (f) { pushUndo(); f.clip.hasRenderLayer = false; delete f.clip.renderLayer; invalidate(); } return ok(command); }

    // ── MIDI clips + notes (piano-roll) ──────────────────────────────────────
    case "add_midi_clip": {
      const t = findTrack(str(args.trackId)) ?? snapshot.tracks[0]; if (!t) return err(command, "no track");
      pushUndo();
      // DRM-001 — default-instrument policy: a MIDI clip on an instrument-less track
      // auto-loads the sane default so the notes are audible (drum track → sampler).
      ensureInstrument(t, t.type === "drum");
      // Phase 1 — empty by default (matches the backend: "+ MIDI" makes an empty
      // clip). A caller that passes `notes` seeds them; otherwise the clip is blank.
      const seed = Array.isArray(args.notes)
        ? (args.notes as Array<Record<string, unknown>>).map((n, k) => ({ i: k, pitch: num(n.pitch, 60), start: num(n.start, 0), length: num(n.length, 0.5), velocity: num(n.velocity, 100) }))
        : [];
      const c: Clip = { id: nextClipId(), name: "midi", type: "midi", start: num(args.start, snapshot.transport.position), length: 4, offset: 0, hasRenderLayer: false, notes: seed };
      t.clips.push(c); invalidate(); return ok(command, { clipId: c.id });
    }
    case "add_note": {
      const f = findClip(str(args.clipId)); if (!f?.clip.notes) return err(command, "not a midi clip");
      pushUndo();
      f.clip.notes.push({ i: f.clip.notes.length, pitch: num(args.pitch, 60), start: num(args.start, 0), length: num(args.length, 0.5), velocity: num(args.velocity, 100) });
      reindexNotes(f.clip); invalidate(); return ok(command);
    }
    case "transcribe_clip": {
      // Audio→MIDI (Basic Pitch) — async like the native path: emit working now, then
      // after a simulated inference land a new time-aligned MIDI track + emit done.
      const f = findClip(str(args.clipId));
      if (!f || f.clip.type !== "wave") return err(command, "no wave clip");
      const mode = str(args.mode, "mono");
      const src = f.clip;
      emit("transcribe_status", { clipId: src.id, state: "working", mode });
      window.setTimeout(() => {
        pushUndo();
        const pitches = mode === "poly" ? [60, 64, 67] : [62, 64, 65, 67];
        const t: Track = {
          id: nextTrackId(), index: snapshot.tracks.length, name: "MIDI • " + src.name,
          type: "audio", volumeDb: 0, pan: 0, mute: false, solo: false, clips: [], plugins: [],
        };
        t.clips.push({
          id: nextClipId(), name: "MIDI • " + src.name, type: "midi",
          start: src.start, length: Math.max(2, src.length), offset: 0, hasRenderLayer: false,
          notes: pitches.map((pitch, k) => ({ i: k, pitch, start: k * 0.5, length: 0.5, velocity: 100 })),
        });
        snapshot.tracks.push(t);
        emit("transcribe_status", { clipId: src.id, state: "done", noteCount: pitches.length });
        invalidate();
      }, 400);
      return ok(command, { status: "started" });
    }
    case "sketch_beatbox": {
      // Sketch Phase 0 — beatbox WAV → drum MoshOps. Async like the native path:
      // emit working now, then after a simulated transduction set the tempo and land a
      // drum track carrying kick/snare/hat notes on the 16th grid. No audio analysis
      // here (no librosa); the mock plays a fixed, recognisable boom-bap so UI tests
      // exercise the same command contract the native cmdSketchBeatbox drives.
      const file = str(args.file, "");
      if (!file) return err(command, "no audio file");
      const bpm = num(args.bpm, 120);
      const bars = num(args.bars, 1) >= 2 ? 2 : 1;
      emit("sketch_status", { file, state: "working", bpm, bars });
      window.setTimeout(() => {
        pushUndo();
        snapshot.session.tempo = Math.max(20, bpm);
        // role → GM pitch (mirrors kDefaultKit: kick 36, snare 38, closed hat 42).
        const PITCH: Record<string, number> = { kick: 36, snare: 38, hat: 42 };
        const hits: Array<{ step: number; role: string; velocity: number }> = [];
        for (let bar = 0; bar < bars; bar++) {
          const base = bar * 16;
          for (const s of [0, 8]) hits.push({ step: base + s, role: "kick", velocity: 112 });
          for (const s of [4, 12]) hits.push({ step: base + s, role: "snare", velocity: 100 });
          for (const s of [0, 2, 4, 6, 8, 10, 12, 14]) hits.push({ step: base + s, role: "hat", velocity: 80 });
        }
        const t: Track = {
          id: nextTrackId(), index: snapshot.tracks.length, name: "Sketch",
          type: "drum", volumeDb: 0, pan: 0, mute: false, solo: false, clips: [], plugins: [],
        };
        ensureInstrument(t, true);
        t.clips.push({
          id: nextClipId(), name: "Sketch", type: "midi",
          // Loop length mirrors the native cmdSketchBeatbox exactly: bars*4 beats * 60/bpm, no floor.
          start: 0, length: bars * 4 * 60 / Math.max(20, bpm), offset: 0, hasRenderLayer: false,
          notes: hits.map((h, k) => ({ i: k, pitch: PITCH[h.role], start: h.step / 4, length: 0.25, velocity: h.velocity })),
        });
        snapshot.tracks.push(t);
        emit("sketch_status", { file, state: "done", hitCount: hits.length });
        invalidate();
      }, 400);
      return ok(command, { status: "started" });
    }
    case "remove_note": {
      const f = findClip(str(args.clipId)); if (!f?.clip.notes) return err(command, "not a midi clip");
      pushUndo(); f.clip.notes.splice(num(args.noteIndex), 1); reindexNotes(f.clip); invalidate(); return ok(command);
    }
    case "set_note": {
      const f = findClip(str(args.clipId)); const n = f?.clip.notes?.[num(args.noteIndex)]; if (!n) return err(command, "note not found");
      pushUndo();
      if ("start" in args) n.start = Math.max(0, num(args.start, n.start));
      if ("pitch" in args) n.pitch = Math.max(0, Math.min(127, num(args.pitch, n.pitch)));
      if ("length" in args) n.length = Math.max(0.05, num(args.length, n.length));
      if ("velocity" in args) n.velocity = Math.max(1, Math.min(127, num(args.velocity, n.velocity)));
      invalidate(); return ok(command);
    }
    case "quantize_notes": {
      const f = findClip(str(args.clipId)); if (!f?.clip.notes) return err(command, "not a midi clip");
      const div = num(args.division, 1); if (div > 0) { pushUndo(); for (const n of f.clip.notes) n.start = Math.round(n.start / div) * div; invalidate(); }
      return ok(command);
    }

    // ── content browser (read-only directory listing) ────────────────────────
    case "list_directory": {
      const path = str(args.path) || "/Users/you";
      return ok(command, {
        path, parent: path === "/" ? null : path.replace(/\/[^/]+$/, "") || "/", exists: true, error: null,
        roots: [{ name: "Home", path: "/Users/you" }, { name: "Desktop", path: "/Users/you/Desktop" }, { name: "Downloads", path: "/Users/you/Downloads" }],
        entries: [
          { name: "Samples", path: path + "/Samples", isDir: true, size: null },
          { name: "Loops", path: path + "/Loops", isDir: true, size: null },
          { name: "kick.wav", path: path + "/kick.wav", isDir: false, size: 240000 },
          { name: "snare.wav", path: path + "/snare.wav", isDir: false, size: 180000 },
          { name: "vocal_take.wav", path: path + "/vocal_take.wav", isDir: false, size: 4200000 },
        ],
      });
    }

    // ── rights-cleared type-beat training ────────────────────────────────────
    case "import_training_source": {
      const state = trainingState();
      const id = str(args.sourceId, `beat-${String(state.sources.length + 1).padStart(3, "0")}`);
      const src = {
        index: state.sources.length,
        source_id: id,
      title: str(args.title, "Untitled Type Beat"),
      creator: str(args.creator, "Unknown"),
      source_url: str(args.sourceUrl),
      local_path: str(args.localPath),
      user_claimed_license: str(args.userClaimedLicense, str(args.licenseName, "")),
      license_name: str(args.userClaimedLicense, str(args.licenseName, "")),
      proof_of_rights: str(args.proofOfRights),
      approved_for_training: Boolean(args.approvedForTraining),
        expiration: (typeof args.expiration === "string" && args.expiration) ? String(args.expiration) : null,
        notes: str(args.notes, ""),
      };
      const existing = state.sources.findIndex((s) => s.source_id === id);
      if (existing >= 0) state.sources[existing] = src; else state.sources.push(src);
      invalidate();
      return ok(command, { source: src });
    }
    case "list_training_sources": {
      const state = trainingState();
      return ok(command, { registryPath: state.registryPath, sources: state.sources, sourceCount: state.sources.length });
    }
    case "approve_training_source": {
      const state = trainingState();
      const src = state.sources.find((s) => s.source_id === str(args.sourceId));
      if (!src) return err(command, "source not found");
      src.approved_for_training = Boolean(args.approved ?? true);
      invalidate();
      return ok(command, { source: src });
    }
    case "build_training_corpus": {
      const state = trainingState();
      const eligible = state.sources.filter((s) => s.approved_for_training && s.local_path);
      if (eligible.length === 0) return err(command, "no approved local sources available for training");
      const bundleId = str(args.bundleName, `corpus-${String(eligible.length).padStart(3, "0")}`);
      const bundleHash = `mock-${bundleId}-${eligible.length}`;
      const bundlePath = `/mock/training/corpora/${bundleId}`;
      const sources = eligible.map((s, index) => ({ ...s, index, copied_path: `${bundlePath}/sources/${String(index).padStart(3, "0")}-${s.source_id}.wav`, sha256: `mock-${s.source_id}`, bytes: 123456 }));
      const bundle = { bundleId, bundleHash, bundlePath, manifestPath: `${bundlePath}/corpus.manifest.json`, indexPath: `${bundlePath}/bundle.index.json`, sourceCount: sources.length, sources, skippedSources: state.sources.filter((s) => !eligible.includes(s)).map((s) => ({ source_id: s.source_id, reason: s.approved_for_training ? "missing local file" : "not approved_for_training" })) };
      state.activeCorpusHash = bundleHash;
      invalidate();
      return ok(command, bundle);
    }
    case "submit_training_job": {
      const state = trainingState();
      const bundlePath = str(args.corpusBundle);
      if (!bundlePath) return err(command, "missing corpusBundle");
      const jobId = `job-${Math.random().toString(36).slice(2, 8)}`;
      const outputDir = str(args.outputDir, `${bundlePath}/training-output/${jobId}`);
      const job = {
        jobId,
        status: "ready",
        progress: 1,
        bundlePath,
        outputDir,
        artifactPath: `${outputDir}/adapter.lora.json`,
        manifestPath: `${outputDir}/adapter.manifest.json`,
        error: "",
        result: {
          adapter_id: `adapter-${jobId}`,
          artifact_path: `${outputDir}/adapter.lora.json`,
          manifest_path: `${outputDir}/adapter.manifest.json`,
          bundle_hash: `mock-${bundlePath}`,
          quality: { stub: true },
        },
      };
      state.jobs = [...state.jobs.filter((j) => j.jobId !== jobId), job].slice(-20);
      state.adapters = [
        ...state.adapters.filter((a) => a.adapterId !== `adapter-${jobId}`),
        {
          adapterId: `adapter-${jobId}`,
          bundleHash: `mock-${bundlePath}`,
          bundlePath,
          artifactPath: job.artifactPath,
          manifestPath: job.manifestPath,
          active: false,
          quality: { stub: true },
        },
      ];
      invalidate();
      return ok(command, { jobId, bundlePath, outputDir });
    }
    case "training_job_status": {
      const state = trainingState();
      const job = state.jobs.find((j) => j.jobId === str(args.jobId));
      if (!job) return err(command, "unknown jobId");
      return ok(command, job);
    }
    case "cancel_training_job": {
      const state = trainingState();
      const job = state.jobs.find((j) => j.jobId === str(args.jobId));
      if (!job) return err(command, "unknown jobId");
      job.status = "cancelled";
      invalidate();
      return ok(command);
    }
    case "import_lora_adapter": {
      const state = trainingState();
      const job = str(args.jobId) ? state.jobs.find((j) => j.jobId === str(args.jobId)) : null;
      const result = (job?.result ?? {}) as { adapter_id?: string; bundle_hash?: string; quality?: Record<string, unknown> };
      const artifactPath = str(args.artifactPath, job?.artifactPath ?? "");
      const manifestPath = str(args.manifestPath, job?.manifestPath ?? "");
      const adapterId = str(args.adapterId, result.adapter_id ?? `adapter-${state.adapters.length + 1}`);
      const adapter = {
        adapterId,
        bundleHash: result.bundle_hash ?? `mock-${adapterId}`,
        bundlePath: job?.bundlePath ?? "",
        artifactPath,
        manifestPath,
        active: false,
        quality: result.quality ?? { stub: true },
      };
      state.adapters = [...state.adapters.filter((a) => a.adapterId !== adapterId), adapter];
      state.activeAdapterId = adapterId;
      state.activeAdapterPath = artifactPath;
      state.activeCorpusHash = adapter.bundleHash;
      invalidate();
      return ok(command, adapter);
    }
    case "activate_lora_adapter": {
      const state = trainingState();
      const adapter = state.adapters.find((a) => a.adapterId === str(args.adapterId));
      if (!adapter) return err(command, "adapter not found");
      state.activeAdapterId = adapter.adapterId;
      state.activeAdapterPath = adapter.artifactPath;
      state.activeCorpusHash = adapter.bundleHash;
      state.adapters = state.adapters.map((a) => ({ ...a, active: a.adapterId === adapter.adapterId }));
      invalidate();
      return ok(command, { adapterId: adapter.adapterId, adapterPath: adapter.artifactPath, corpusHash: adapter.bundleHash });
    }
    case "list_lora_adapters": {
      const state = trainingState();
      return ok(command, { activeAdapterId: state.activeAdapterId, activeAdapterPath: state.activeAdapterPath, activeCorpusHash: state.activeCorpusHash, adapters: state.adapters });
    }

    // MP-001 — multiplayer (mock peer harness). Simulates a 2-peer session where a
    // peer "Bo" holds the 2nd track and has it selected, so the UI shows a peer
    // roster, a locked-by badge, and a remote selection highlight without a relay.
    case "mp_create_session":
    case "mp_join_session": {
      for (const t of snapshot.tracks) if (!t.logicalId) t.logicalId = "lid-" + t.id;
      const code = command === "mp_create_session" ? "MOCK-ROOM-abcdef0123456789" : str(args.code);
      const locked = snapshot.tracks[1];
      const locks: Record<string, string> = {};
      if (locked?.logicalId) locks[locked.logicalId] = "bo";
      emit("mp_state", {
        active: true,
        roomCode: code,
        selfPeer: "me",
        peers: {
          me: { name: str(args.name) || "You", color: str(args.color) || "#3aa0ff", online: true },
          bo: { name: "Bo", color: "#e0457b", online: true },
        },
        locks,
      });
      if (locked) emit("peer_selection", { peerId: "bo", trackId: locked.id, clipId: locked.clips[0]?.id ?? null });
      invalidate();   // surface the freshly-stamped logicalIds to the UI snapshot
      return ok(command, { code });
    }
    case "mp_leave_session": {
      emit("mp_state", { active: false, peers: {}, locks: {} });
      return ok(command);
    }
    case "mp_commit_track":
    case "mp_claim_track":
    case "mp_broadcast_selection":
      return ok(command);

    default:
      return ok(command);
  }
}

// Deterministic fake waveform — a couple of decaying sines so clips look alive.
function makePeaks(clip: Clip | null, buckets: number): [number, number][] {
  const seed = clip ? Number(clip.id) : 1;
  const out: [number, number][] = [];
  for (let i = 0; i < buckets; i++) {
    const x = i / buckets;
    const env = Math.exp(-2.2 * ((x * 4) % 1)) * (0.6 + 0.4 * Math.sin(seed + x * 40));
    const a = Math.abs(env) * (0.5 + 0.5 * Math.sin(x * 220 + seed));
    out.push([-a, a]);
  }
  return out;
}

// ── public seam used by bridge.ts ────────────────────────────────────────────

export function mockExecute<T = unknown>(command: unknown): Promise<T> {
  const c = command as { command: string; args?: Record<string, unknown> };
  const res = dispatch(c.command, c.args ?? {});
  if (!READONLY.has(c.command))
    cmdLog.push({ command: c.command, ok: res.ok, undoable: !NON_UNDOABLE.has(c.command), ts: Date.now() });
  return Promise.resolve(res as unknown as T);
}
export function mockSnapshot<T = unknown>(): Promise<T> {
  return Promise.resolve(clone(snapshot) as unknown as T);
}

// Test-only: re-seed the in-memory backend to a clean state between tests and
// stop the 30 Hz play timer (so a set_transport toggle leaves no open handle).
// This module is dev-mock only — a production `vite build` strips it entirely.
export function __resetMockForTests(): void {
  stopPlayback();
  snapshot = seedSnapshot();
  history.length = 0;
  future.length = 0;
  inBatch = false;
  cmdLog.length = 0;
}
