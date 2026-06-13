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

import type { Snapshot, Clip, Track, Transport, CommandResult, RenderLayer } from "./types";

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
    },
    tracks,
    transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
    master: { volumeDb: 0, pan: 0 },
    buses: [],
  };
}

let snapshot: Snapshot = seedSnapshot();
const clone = (s: Snapshot): Snapshot => JSON.parse(JSON.stringify(s)) as Snapshot;
const history: Snapshot[] = [];
const future: Snapshot[] = [];

// ── event bus (mirrors window.__JUCE__.backend on the real side) ─────────────

type Listener = (payload: unknown) => void;
const listeners = new Map<string, Set<Listener>>();
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
  }, 1000 / 30);
}
function stopPlayback() {
  if (playTimer) { clearInterval(playTimer); playTimer = null; }
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
function pushUndo() { history.push(clone(snapshot)); future.length = 0; if (history.length > 100) history.shift(); }

const ok = (command: string, data?: unknown): CommandResult => ({ ok: true, command, data });
const err = (command: string, error: string): CommandResult => ({ ok: false, command, error });

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
      const t: Track = {
        id: nextTrackId(), index: snapshot.tracks.length, name: str(args.name, "Audio"),
        type: "audio", volumeDb: 0, pan: 0, mute: false, solo: false, clips: [], plugins: [],
      };
      snapshot.tracks.push(t);
      invalidate();
      return ok(command, { trackId: t.id });
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
      const c = waveClip("tone", num(args.start, snapshot.transport.position), num(args.length, 2));
      t.clips.push(c); invalidate(); return ok(command, { clipId: c.id });
    }
    case "import_clip": {
      const t = findTrack(str(args.trackId)) ?? snapshot.tracks[0];
      if (!t) return err(command, "no track");
      pushUndo();
      const name = str(args.name) || (str(args.file).split("/").pop() ?? "clip");
      const c = waveClip(name.replace(/\.[^.]+$/, ""), num(args.start, 0), num(args.length, 4));
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
    case "set_clip_gain": { const f = findClip(str(args.clipId)); if (!f) return err(command, "clip not found"); pushUndo(); f.clip.gainDb = num(args.db); invalidate(); return ok(command); }

    case "set_tempo": { pushUndo(); snapshot.session.tempo = Math.max(20, num(args.tempo, snapshot.session.tempo)); invalidate(); return ok(command); }
    case "set_master_volume": { pushUndo(); if (snapshot.master) snapshot.master.volumeDb = num(args.db); invalidate(); return ok(command); }

    case "undo": {
      if (!history.length) return ok(command, { undone: false });
      future.push(clone(snapshot)); snapshot = history.pop()!; stopPlayback(); invalidate(); return ok(command, { undone: true });
    }
    case "redo": {
      if (!future.length) return ok(command, { redone: false });
      history.push(clone(snapshot)); snapshot = future.pop()!; stopPlayback(); invalidate(); return ok(command, { redone: true });
    }
    case "save": case "reload": return ok(command);

    case "get_clip_peaks": {
      const f = findClip(str(args.clipId));
      const buckets = Math.max(8, Math.min(2000, num(args.buckets, 800)));
      const peaks = makePeaks(f?.clip ?? null, buckets);
      return ok(command, { peaks });
    }

    // ── plugins / neural rack ────────────────────────────────────────────────
    case "list_plugins": return ok(command, { plugins: VST3S, counts: { vst3: VST3S.length, au: 0, total: VST3S.length } });
    case "list_builtins": return ok(command, { plugins: BUILTINS });
    case "set_master_pan": { pushUndo(); if (snapshot.master) snapshot.master.pan = num(args.pan); invalidate(); return ok(command); }
    case "enable_all_meters": case "enable_track_meter": case "disable_track_meter": return ok(command);
    case "list_wave_inputs": return ok(command, { inputs: [] });
    case "list_track_outputs": return ok(command, { outputs: [], tracks: snapshot.tracks.map((t) => ({ id: t.id, name: t.name })), audioEnabled: true });

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
    case "reset_neural": case "open_plugin_editor": case "set_neural_latency": return ok(command);

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
  return Promise.resolve(res as unknown as T);
}
export function mockSnapshot<T = unknown>(): Promise<T> {
  return Promise.resolve(clone(snapshot) as unknown as T);
}
