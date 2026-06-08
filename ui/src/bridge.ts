/**
 * bridge.ts — the ONLY coupling between the Mosh frontend and the C++ backend.
 *
 * The UI talks to the backend through exactly two things:
 *   1. executeCommand(name, args) -> Promise<MoshResult>   (UI -> C++, mutations)
 *   2. the snapshot + events feed:
 *        getSnapshot() -> Promise<Snapshot>                 (C++ -> UI, full state)
 *        subscribe(listener) -> unsubscribe                 (C++ -> UI, typed deltas)
 *
 * NO Tracktion / audio concepts cross this seam. The frontend vocabulary is the
 * snapshot schema (02 §4.1) and the command catalog (02 §3) — nothing else.
 *
 * Real build: the bridge reaches C++ via JUCE 8's WebView integration
 * (`window.__JUCE__.backend`, native functions registered C++-side, plus a
 * C++->JS event emit). When `window.__JUCE__` is absent (plain browser dev),
 * it falls back to an in-memory mock so the app still renders and never crashes.
 */

// ---------------------------------------------------------------------------
// Result envelope (02 §2) — every command returns exactly this shape.
// ---------------------------------------------------------------------------

export interface MoshResult {
  ok: boolean;
  message: string;
  changed_entities: string[]; // stable entity refs, e.g. "track:vocal"
  error_code: string | null; // stable machine code on failure, else null
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Snapshot schema (02 §4.1) — the full session as plain data; render-cold.
// ---------------------------------------------------------------------------

export interface ClipState {
  id: string;
  range: [number, number];
  takeCount?: number;
  activeTake?: number;
}

export interface PluginState {
  id: string;
  type: string; // e.g. "vst3", "neural", "builtin"
  name: string;
  bypassed: boolean;
}

export type RenderLayerStatus =
  | "idle"
  | "rendering"
  | "ready"
  | "error"
  | "frozen";

export interface ColorSetting {
  name: string;
  value: number; // 0–100 ASTD slider (50 = neutral)
}

// The judge readout carried on a rendered layer (05 §7). All optional — a learned
// judge or no judge leaves fields absent.
export interface LayerQuality {
  pq?: number; // production quality 0–10 (DSP proxy, or learned Audiobox PQ)
  pqBase?: number; // the reimagine source's pq (for a delta)
  pqDelta?: number; // pq - pqBase
  flags?: string[]; // human-readable signal-hygiene flags
  initLatentCache?: "hit" | "miss";
  steering?: { layer: number; alpha: number }[];
  judge?: string; // "dsp" (heuristic) | "audiobox" (learned)
  aesthetics?: { PQ?: number; PC?: number; CE?: number; CU?: number };
}

// A Color Rack color's descriptor from the service (05 §6): the ASTD ceiling + meta.
export interface ColorDescriptor {
  name: string;
  astd_max: number;
  peak_layer: number;
  more_sign: number;
  verdict: string;
  no_stack_with: string[];
}

export interface RenderLayerState {
  id: string;
  status: RenderLayerStatus;
  mode?: string; // e.g. "reimagine", "generate"
  prompt?: string;
  colors?: ColorSetting[];
  lab?: boolean;
  quality?: LayerQuality;
}

export interface TrackState {
  id: string;
  name: string;
  gain: number;
  mute?: boolean;
  solo?: boolean;
  armed?: boolean;
  clips: ClipState[];
  plugins: PluginState[];
  renderLayers: RenderLayerState[];
}

export interface TransportState {
  position: number;
  playing: boolean;
  loop: [number, number] | null;
}

export interface TempoState {
  bpm: number;
  sig: string; // e.g. "4/4"
}

export interface Snapshot {
  tracks: TrackState[];
  transport: TransportState;
  tempo: TempoState;
}

// ---------------------------------------------------------------------------
// Typed events (02 §4.2) — small deltas the store applies incrementally.
// Discriminated union on `type`. transport_position / meter_update are
// DECIMATED 30-60 Hz on the C++ side; nothing audio-rate crosses the bridge.
// ---------------------------------------------------------------------------

export type MoshEvent =
  | { type: "track_added"; track: TrackState }
  | { type: "track_removed"; id: string }
  | { type: "track_changed"; id: string; fields: Partial<TrackState> }
  | { type: "clip_added"; trackId: string; clip: ClipState }
  | { type: "clip_moved"; id: string; range: [number, number] }
  | { type: "clip_split"; trackId: string; clips: ClipState[] }
  | { type: "clip_removed"; id: string }
  | { type: "plugin_added"; trackId: string; plugin: PluginState }
  | { type: "plugin_param_changed"; pluginId: string; param: string; value: number }
  | { type: "plugin_bypassed"; pluginId: string; bypassed: boolean }
  | { type: "layer_status"; id: string; status: RenderLayerStatus }
  | { type: "layer_render_progress"; id: string; pct: number; etaSec: number }
  | { type: "layer_rendered"; id: string; takeId: string }
  | { type: "transport_position"; pos: number } // DECIMATED
  | { type: "meter_update"; trackId: string; rms: number; peak: number } // DECIMATED
  | { type: "snapshot_invalidated" }; // resync hint: refetch getSnapshot()

export type MoshEventListener = (event: MoshEvent) => void;

// ---------------------------------------------------------------------------
// Bridge transport selection: JUCE if present, else in-memory mock.
// ---------------------------------------------------------------------------

export type BackendKind = "juce" | "mock";

interface Bridge {
  readonly kind: BackendKind;
  executeCommand(name: string, args: Record<string, unknown>): Promise<MoshResult>;
  getSnapshot(): Promise<Snapshot>;
  subscribe(listener: MoshEventListener): () => void;
}

// --- JUCE 8 native-integration shape -----------------------------------------
// RESOLVED against juce_gui_extra/native/javascript/index.js (JUCE 8.0.8). A native
// function registered C++-side via WebBrowserComponent::Options::withNativeFunction
// is NOT exposed as backend.getNativeFunction(); instead the frontend invokes it by
// emitting "__juce__invoke" {name, params, resultId} and awaiting a matching
// "__juce__complete" {promiseId, result} event. C++->JS events arrive via
// backend.addEventListener(eventId, handler).
interface JuceBackend {
  emitEvent: (eventId: string, payload: unknown) => void;
  addEventListener: (eventId: string, handler: (payload: unknown) => void) => void;
  removeEventListener?: (
    eventId: string,
    handler: (payload: unknown) => void
  ) => void;
}

interface JuceGlobal {
  backend?: JuceBackend;
  initialisationData?: { __juce__functions?: string[] };
}

declare global {
  interface Window {
    __JUCE__?: JuceGlobal;
    // Injected by the C++ HttpBridge when the UI is served by the real backend over
    // HTTP (used when the JUCE WebView2 backend is unavailable, e.g. on Windows).
    __MOSH_BACKEND__?: string;
  }
}

// VERIFY: JUCE 8 WebView native-fn registration + window.__JUCE__.backend emit
// API (resolve against JUCE 8 when wiring the C++ bridge in module 03). The
// channel id below ("mosh_event") is a placeholder for whatever id the C++
// side emits on.
const JUCE_EVENT_CHANNEL = "mosh_event";

function makeJuceBridge(backend: JuceBackend): Bridge {
  // Replicate JUCE's getNativeFunction protocol (index.js PromiseHandler): emit
  // "__juce__invoke" and resolve when the matching "__juce__complete" arrives.
  const pending = new Map<number, (result: unknown) => void>();
  let nextId = 0;
  backend.addEventListener("__juce__complete", (payload) => {
    const { promiseId, result } = (payload ?? {}) as {
      promiseId?: number;
      result?: unknown;
    };
    if (typeof promiseId === "number" && pending.has(promiseId)) {
      pending.get(promiseId)!(result);
      pending.delete(promiseId);
    }
  });

  const invoke = (name: string, params: unknown[]): Promise<unknown> => {
    const promiseId = nextId++;
    const result = new Promise<unknown>((resolve) =>
      pending.set(promiseId, resolve)
    );
    backend.emitEvent("__juce__invoke", { name, params, resultId: promiseId });
    return result;
  };

  return {
    kind: "juce",

    async executeCommand(name, args) {
      // C++ withNativeFunction("executeCommand", [name, argsJson]) → MoshResult var.
      const raw = await invoke("executeCommand", [name, JSON.stringify(args ?? {})]);
      return normalizeResult(raw);
    },

    async getSnapshot() {
      const raw = await invoke("getSnapshot", []);
      return normalizeSnapshot(raw);
    },

    subscribe(listener) {
      // C++ emits typed events on the "mosh_event" channel (emitEventIfBrowserIsVisible).
      const handler = (payload: unknown) => {
        const ev = payload as MoshEvent;
        if (ev && typeof (ev as { type?: unknown }).type === "string") {
          listener(ev);
        }
      };
      backend.addEventListener(JUCE_EVENT_CHANNEL, handler);
      return () => backend.removeEventListener?.(JUCE_EVENT_CHANNEL, handler);
    },
  };
}

// ---------------------------------------------------------------------------
// In-memory mock bridge (dev / standalone browser).
//
// This is a CONTRACT-FAITHFUL backend: it maintains a real session model,
// applies every command in the Stage-2 catalog, emits the matching typed
// events, and returns correct MoshResult envelopes + snapshots. It exists so
// the entire arrangement UI is exercisable in a plain browser with no C++.
// It is isolated to the mock path; the JUCE path (makeJuceBridge) is untouched.
//
// Discipline note: the mock plays the role of C++. It is therefore ALLOWED to
// hold domain state and decide outcomes — that is exactly what the real backend
// does. The UI still only ever sees this seam (executeCommand + snapshot/events).
// ---------------------------------------------------------------------------

function makeMockBridge(): Bridge {
  const listeners = new Set<MoshEventListener>();

  const snapshot: Snapshot = {
    tracks: [],
    transport: { position: 0, playing: false, loop: null },
    tempo: { bpm: 120, sig: "4/4" },
  };

  const emit = (event: MoshEvent) => listeners.forEach((l) => l(event));
  const ok = (
    message: string,
    changed: string[] = [],
    data: Record<string, unknown> = {}
  ): MoshResult => ({
    ok: true,
    message,
    changed_entities: changed,
    error_code: null,
    data,
  });
  const fail = (
    error_code: string,
    message: string,
    data: Record<string, unknown> = {}
  ): MoshResult => ({
    ok: false,
    message,
    changed_entities: [],
    error_code,
    data,
  });

  let trackSeq = 0;
  let clipSeq = 0;
  let pluginSeq = 0;
  let layerSeq = 0;

  // --- helpers over the session model -------------------------------------
  const findTrack = (id: unknown): TrackState | undefined =>
    snapshot.tracks.find((t) => t.id === id);

  const findClip = (
    id: unknown
  ): { track: TrackState; clip: ClipState } | undefined => {
    for (const track of snapshot.tracks) {
      const clip = track.clips.find((c) => c.id === id);
      if (clip) return { track, clip };
    }
    return undefined;
  };

  const findPlugin = (
    id: unknown
  ): { track: TrackState; plugin: PluginState } | undefined => {
    for (const track of snapshot.tracks) {
      const plugin = track.plugins.find((p) => p.id === id);
      if (plugin) return { track, plugin };
    }
    return undefined;
  };

  const num = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  const str = (v: unknown, fallback: string): string =>
    typeof v === "string" ? v : fallback;
  const bool = (v: unknown, fallback: boolean): boolean =>
    typeof v === "boolean" ? v : fallback;

  // --- decimated playhead timer (emulates the C++ transport_position tap) ---
  // Real backend decimates audio-thread position to 30-60 Hz before it crosses
  // the seam. We tick at 60 Hz and advance position by wall-clock delta, looping
  // when a loop range is set. Meters are faked off the same tick (decimated).
  let timer: number | null = null;
  let lastTick = 0;

  const stopTimer = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  const startTimer = () => {
    if (timer !== null) return;
    lastTick = performance.now();
    timer = setInterval(() => {
      const now = performance.now();
      const dt = (now - lastTick) / 1000;
      lastTick = now;

      let pos = snapshot.transport.position + dt;
      const loop = snapshot.transport.loop;
      if (loop && pos >= loop[1]) {
        const span = loop[1] - loop[0];
        pos = span > 0 ? loop[0] + ((pos - loop[0]) % span) : loop[0];
      }
      snapshot.transport.position = pos;
      emit({ type: "transport_position", pos });

      // Fake decimated meters: only tracks with a clip under the playhead are
      // "hot". RMS/peak are plausible non-audio values derived from the clock.
      for (const track of snapshot.tracks) {
        const live =
          !track.mute &&
          track.clips.some((c) => pos >= c.range[0] && pos < c.range[1]);
        const base = live ? 0.35 + 0.45 * Math.abs(Math.sin(now / 140 + pos)) : 0;
        const g = track.gain;
        emit({
          type: "meter_update",
          trackId: track.id,
          rms: base * g * 0.8,
          peak: base * g,
        });
      }
    }, 1000 / 60) as unknown as number;
  };

  // --- fake render-layer progress (emulates the generative job service) -----
  const runFakeRender = (layerId: string) => {
    emit({ type: "layer_status", id: layerId, status: "rendering" });
    let pct = 0;
    const iv = setInterval(() => {
      pct += 12 + Math.random() * 10;
      if (pct >= 100) {
        clearInterval(iv);
        emit({ type: "layer_render_progress", id: layerId, pct: 100, etaSec: 0 });
        emit({ type: "layer_status", id: layerId, status: "ready" });
        emit({
          type: "layer_rendered",
          id: layerId,
          takeId: `take:${layerId}_0`,
        });
      } else {
        const etaSec = Math.max(0, ((100 - pct) / 22) * 0.4);
        emit({ type: "layer_render_progress", id: layerId, pct, etaSec });
      }
    }, 400);
  };

  return {
    kind: "mock",

    async executeCommand(name, args) {
      const a = args ?? {};
      switch (name) {
        // --- tracks --------------------------------------------------------
        case "create_track": {
          trackSeq += 1;
          const id = `track:mock_${trackSeq}`;
          const track: TrackState = {
            id,
            name: str(a.name, `Track ${trackSeq}`),
            gain: 0.8,
            mute: false,
            solo: false,
            armed: false,
            clips: [],
            plugins: [],
            renderLayers: [],
          };
          snapshot.tracks.push(track);
          emit({ type: "track_added", track });
          return ok(`Created ${track.name}`, [id], { id });
        }
        case "delete_track": {
          const t = findTrack(a.track ?? a.id);
          if (!t) return fail("no_such_track", "Track not found");
          snapshot.tracks = snapshot.tracks.filter((x) => x.id !== t.id);
          emit({ type: "track_removed", id: t.id });
          return ok(`Deleted ${t.name}`, [t.id], {});
        }
        case "rename_track": {
          const t = findTrack(a.track ?? a.id);
          if (!t) return fail("no_such_track", "Track not found");
          t.name = str(a.name, t.name);
          emit({ type: "track_changed", id: t.id, fields: { name: t.name } });
          return ok(`Renamed to ${t.name}`, [t.id], {});
        }
        case "set_track_gain": {
          const t = findTrack(a.track ?? a.id);
          if (!t) return fail("no_such_track", "Track not found");
          t.gain = Math.max(0, Math.min(1.5, num(a.gain, t.gain)));
          emit({ type: "track_changed", id: t.id, fields: { gain: t.gain } });
          return ok("Gain set", [t.id], { gain: t.gain });
        }
        case "set_track_mute": {
          const t = findTrack(a.track ?? a.id);
          if (!t) return fail("no_such_track", "Track not found");
          t.mute = bool(a.mute, !t.mute);
          emit({ type: "track_changed", id: t.id, fields: { mute: t.mute } });
          return ok("Mute set", [t.id], { mute: t.mute });
        }
        case "set_track_solo": {
          const t = findTrack(a.track ?? a.id);
          if (!t) return fail("no_such_track", "Track not found");
          t.solo = bool(a.solo, !t.solo);
          emit({ type: "track_changed", id: t.id, fields: { solo: t.solo } });
          return ok("Solo set", [t.id], { solo: t.solo });
        }
        case "arm_track": {
          const t = findTrack(a.track ?? a.id);
          if (!t) return fail("no_such_track", "Track not found");
          t.armed = bool(a.armed, !t.armed);
          emit({ type: "track_changed", id: t.id, fields: { armed: t.armed } });
          return ok("Arm set", [t.id], { armed: t.armed });
        }

        // --- clips ---------------------------------------------------------
        case "import_clip": {
          const t = findTrack(a.track ?? a.trackId);
          if (!t) return fail("no_such_track", "Track not found");
          clipSeq += 1;
          const start = num(a.start, 0);
          const length = num(a.length, 4);
          const clip: ClipState = {
            id: `clip:mock_${clipSeq}`,
            range: [start, start + length],
          };
          t.clips.push(clip);
          emit({ type: "clip_added", trackId: t.id, clip });
          return ok(`Imported clip`, [t.id, clip.id], { id: clip.id });
        }
        case "move_clip": {
          const found = findClip(a.clip ?? a.id);
          if (!found) return fail("no_such_clip", "Clip not found");
          const { clip } = found;
          const len = clip.range[1] - clip.range[0];
          const start = Math.max(0, num(a.start, clip.range[0]));
          clip.range = [start, start + len];
          emit({ type: "clip_moved", id: clip.id, range: clip.range });
          return ok("Moved clip", [clip.id], { range: clip.range });
        }
        case "trim_clip": {
          const found = findClip(a.clip ?? a.id);
          if (!found) return fail("no_such_clip", "Clip not found");
          const { clip } = found;
          let [s, e] = clip.range;
          if (typeof a.start === "number") s = Math.max(0, a.start as number);
          if (typeof a.end === "number") e = a.end as number;
          // Keep a minimum length so clips stay grabbable.
          if (e - s < 0.05) {
            if (typeof a.start === "number") s = e - 0.05;
            else e = s + 0.05;
          }
          clip.range = [s, e];
          emit({ type: "clip_moved", id: clip.id, range: clip.range });
          return ok("Trimmed clip", [clip.id], { range: clip.range });
        }
        case "split_clip": {
          const found = findClip(a.clip ?? a.id);
          if (!found) return fail("no_such_clip", "Clip not found");
          const { track, clip } = found;
          const at = num(a.at, (clip.range[0] + clip.range[1]) / 2);
          if (at <= clip.range[0] || at >= clip.range[1]) {
            return fail("bad_split", "Split point outside clip");
          }
          clipSeq += 1;
          const left: ClipState = {
            id: clip.id,
            range: [clip.range[0], at],
          };
          clipSeq += 1;
          const right: ClipState = {
            id: `clip:mock_${clipSeq}`,
            range: [at, clip.range[1]],
          };
          const idx = track.clips.findIndex((c) => c.id === clip.id);
          track.clips.splice(idx, 1, left, right);
          emit({ type: "clip_split", trackId: track.id, clips: [left, right] });
          return ok("Split clip", [track.id, left.id, right.id], {
            clips: [left.id, right.id],
          });
        }
        case "delete_clip":
        case "remove_clip": {
          const found = findClip(a.clip ?? a.id);
          if (!found) return fail("no_such_clip", "Clip not found");
          const { track, clip } = found;
          track.clips = track.clips.filter((c) => c.id !== clip.id);
          emit({ type: "clip_removed", id: clip.id });
          return ok("Removed clip", [clip.id], {});
        }

        // --- transport / tempo --------------------------------------------
        case "set_transport": {
          const tr = snapshot.transport;
          if (typeof a.position === "number") {
            tr.position = a.position as number;
            emit({ type: "transport_position", pos: tr.position });
          }
          if (
            typeof a.loopStart === "number" ||
            typeof a.loopEnd === "number" ||
            typeof a.looping === "boolean"
          ) {
            if (a.looping === false) {
              tr.loop = null;
            } else {
              const cur = tr.loop ?? [0, 8];
              const ls = num(a.loopStart, cur[0]);
              const le = num(a.loopEnd, cur[1]);
              tr.loop = a.looping === false ? null : [ls, le];
            }
          }
          if (typeof a.playing === "boolean") {
            tr.playing = a.playing as boolean;
            if (tr.playing) startTimer();
            else stopTimer();
          }
          // `record` is accepted but, like a real transport, just flips playing
          // with armed semantics handled track-side; we surface it in data.
          return ok("Transport updated", [], {
            playing: tr.playing,
            position: tr.position,
            loop: tr.loop,
            record: bool(a.record, false),
          });
        }
        case "set_tempo": {
          snapshot.tempo.bpm = Math.max(20, Math.min(300, num(a.bpm, snapshot.tempo.bpm)));
          if (typeof a.sig === "string") snapshot.tempo.sig = a.sig as string;
          // Tempo lives in the snapshot; signal a resync so the ruler refits.
          emit({ type: "snapshot_invalidated" });
          return ok("Tempo set", [], { bpm: snapshot.tempo.bpm });
        }

        // --- plugins -------------------------------------------------------
        case "load_plugin": {
          const t = findTrack(a.track ?? a.trackId);
          if (!t) return fail("no_such_track", "Track not found");
          pluginSeq += 1;
          const plugin: PluginState = {
            id: `plugin:mock_${pluginSeq}`,
            type: str(a.type, "vst3"),
            name: str(a.name, `Plugin ${pluginSeq}`),
            bypassed: false,
          };
          t.plugins.push(plugin);
          emit({ type: "plugin_added", trackId: t.id, plugin });
          return ok(`Loaded ${plugin.name}`, [t.id, plugin.id], { id: plugin.id });
        }
        case "add_neural_insert": {
          const t = findTrack(a.track ?? a.trackId);
          if (!t) return fail("no_such_track", "Track not found");
          pluginSeq += 1;
          const plugin: PluginState = {
            id: `plugin:mock_${pluginSeq}`,
            type: "neural",
            name: str(a.model, str(a.name, `Neural ${pluginSeq}`)),
            bypassed: false,
          };
          t.plugins.push(plugin);
          emit({ type: "plugin_added", trackId: t.id, plugin });
          return ok(`Added ${plugin.name}`, [t.id, plugin.id], { id: plugin.id });
        }
        case "remove_plugin": {
          const found = findPlugin(a.plugin ?? a.id);
          if (!found) return fail("no_such_plugin", "Plugin not found");
          const { track, plugin } = found;
          track.plugins = track.plugins.filter((p) => p.id !== plugin.id);
          // No dedicated plugin_removed event in the union; resync is correct.
          emit({ type: "snapshot_invalidated" });
          return ok(`Removed ${plugin.name}`, [track.id, plugin.id], {});
        }
        case "bypass_plugin": {
          const found = findPlugin(a.plugin ?? a.id);
          if (!found) return fail("no_such_plugin", "Plugin not found");
          const { plugin } = found;
          plugin.bypassed = bool(a.bypassed, !plugin.bypassed);
          emit({
            type: "plugin_bypassed",
            pluginId: plugin.id,
            bypassed: plugin.bypassed,
          });
          return ok("Bypass set", [plugin.id], { bypassed: plugin.bypassed });
        }
        case "set_plugin_param": {
          const found = findPlugin(a.plugin ?? a.id);
          if (!found) return fail("no_such_plugin", "Plugin not found");
          const { plugin } = found;
          const param = str(a.param, "param");
          const value = num(a.value, 0);
          emit({ type: "plugin_param_changed", pluginId: plugin.id, param, value });
          return ok("Param set", [plugin.id], { param, value });
        }

        // --- render layers (fake generative job) --------------------------
        case "create_render_layer": {
          const t = findTrack(a.track ?? a.trackId);
          if (!t) return fail("no_such_track", "Track not found");
          layerSeq += 1;
          const layer: RenderLayerState = {
            id: `layer:mock_${layerSeq}`,
            status: "idle",
            mode: str(a.mode, "generate"),
          };
          t.renderLayers.push(layer);
          emit({ type: "snapshot_invalidated" });
          return ok("Created render layer", [t.id, layer.id], { id: layer.id });
        }
        case "render_layer": {
          const id = str(a.layer ?? a.id, "");
          if (!id) return fail("no_such_layer", "Layer not found");
          runFakeRender(id);
          return ok("Render started", [id], { id });
        }

        default:
          // Unknown-but-harmless: report success with a note (mock is permissive
          // toward commands not yet exercised by the Stage-2 UI).
          return ok(`(mock) ${name}`, [], { mock: true, args: a });
      }
    },

    async getSnapshot() {
      // Return a deep copy so callers can't mutate mock internal state.
      return JSON.parse(JSON.stringify(snapshot)) as Snapshot;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// ---------------------------------------------------------------------------
// Normalizers: JUCE native functions may hand back already-parsed values or
// JSON strings depending on registration. Be tolerant; never throw on bad data.
// ---------------------------------------------------------------------------

function asObject(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  return {};
}

function normalizeResult(raw: unknown): MoshResult {
  const o = asObject(raw);
  return {
    ok: o.ok === true,
    message: typeof o.message === "string" ? o.message : "",
    changed_entities: Array.isArray(o.changed_entities)
      ? (o.changed_entities as string[])
      : [],
    error_code: typeof o.error_code === "string" ? o.error_code : null,
    data: asObject(o.data),
  };
}

function normalizeSnapshot(raw: unknown): Snapshot {
  const o = asObject(raw);
  const transport = asObject(o.transport);
  const tempo = asObject(o.tempo);
  return {
    tracks: Array.isArray(o.tracks) ? (o.tracks as TrackState[]) : [],
    transport: {
      position: typeof transport.position === "number" ? transport.position : 0,
      playing: transport.playing === true,
      loop: Array.isArray(transport.loop)
        ? (transport.loop as [number, number])
        : null,
    },
    tempo: {
      bpm: typeof tempo.bpm === "number" ? tempo.bpm : 120,
      sig: typeof tempo.sig === "string" ? tempo.sig : "4/4",
    },
  };
}

// ---------------------------------------------------------------------------
// Singleton selection + public API.
// ---------------------------------------------------------------------------

// --- HTTP transport: the REAL C++ backend over HTTP (C++ HttpBridge) ---------
// Same MoshOps seam, different transport: executeCommand -> POST /api/command,
// getSnapshot -> GET /api/snapshot, events long-polled from GET /api/events. Lets a
// plain browser drive the real Tracktion backend when the WebView is unavailable.
function makeHttpBridge(): Bridge {
  return {
    kind: "juce", // it IS the real C++ backend (just reached over HTTP)

    async executeCommand(name, args) {
      const r = await fetch("/api/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, args: args ?? {} }),
      });
      return normalizeResult(await r.json());
    },

    async getSnapshot() {
      const r = await fetch("/api/snapshot");
      return normalizeSnapshot(await r.json());
    },

    subscribe(listener) {
      // Non-destructive sequence-cursor feed: send our last-seen seq, apply the
      // events the server returns, and advance `since` ONLY on a delivered
      // response. A dropped/refused response leaves `since` unchanged, so the next
      // poll re-fetches the same events — at-least-once delivery with no loss
      // window (applyEvent handlers are idempotent). `resync` means we fell behind
      // the server's retained window; refetch the snapshot to catch up.
      let stopped = false;
      let since = 0;
      const poll = async () => {
        if (stopped) return;
        try {
          const r = await fetch(`/api/events?since=${since}`);
          const body = (await r.json()) as {
            events?: MoshEvent[];
            seq?: number;
            resync?: boolean;
          };
          if (body && Array.isArray(body.events)) {
            if (body.resync) listener({ type: "snapshot_invalidated" });
            for (const ev of body.events)
              if (ev && typeof (ev as { type?: unknown }).type === "string")
                listener(ev);
            if (typeof body.seq === "number") since = body.seq;
          }
        } catch {
          /* backend momentarily unreachable — keep `since`, retry (no loss) */
        }
        if (!stopped) window.setTimeout(poll, 150);
      };
      void poll();
      return () => {
        stopped = true;
      };
    },
  };
}

function selectBridge(): Bridge {
  const juce = typeof window !== "undefined" ? window.__JUCE__ : undefined;
  if (juce && juce.backend) {
    // Use the real JUCE backend; fall back to the mock if native init throws (so the
    // app always renders rather than white-screening on a partial __JUCE__ object).
    try {
      return makeJuceBridge(juce.backend);
    } catch (e) {
      console.error("Mosh: JUCE bridge init failed, using mock", e);
    }
  }
  // Real C++ backend over HTTP (injected marker), else the in-browser mock.
  if (typeof window !== "undefined" && window.__MOSH_BACKEND__ === "http") {
    return makeHttpBridge();
  }
  return makeMockBridge();
}

const bridge: Bridge = selectBridge();

/** Which backend is live: "juce" inside the WebView, "mock" in a plain browser. */
export const backendKind: BackendKind = bridge.kind;

/** Run a MoshOps command. The ONLY mutation path from the UI. */
export function executeCommand(
  name: string,
  args: Record<string, unknown> = {}
): Promise<MoshResult> {
  return bridge.executeCommand(name, args);
}

/** Fetch the full session snapshot (load / project-open / resync). */
export function getSnapshot(): Promise<Snapshot> {
  return bridge.getSnapshot();
}

/** Subscribe to typed backend events. Returns an unsubscribe function. */
export function subscribe(listener: MoshEventListener): () => void {
  return bridge.subscribe(listener);
}
