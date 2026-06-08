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

export interface RenderLayerState {
  id: string;
  status: RenderLayerStatus;
  mode?: string; // e.g. "reimagine", "generate"
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

// --- JUCE shape (minimal; we only touch what we use) -----------------------
// VERIFY: JUCE 8 WebView native-fn registration + window.__JUCE__.backend emit
// API (resolve against JUCE 8 when wiring the C++ bridge in module 03). The
// exact accessor names below (getNativeFunction, addEventListener / emit
// channel) must be confirmed against the JUCE 8 WebBrowserComponent example;
// JUCE's JS layer typically exposes registered native functions via
// `window.__JUCE__.backend.getNativeFunction("name")(...args) -> Promise` and
// C++->JS events via an emit/event-listener channel on the same backend object.
interface JuceBackend {
  getNativeFunction?: (
    name: string
  ) => (...args: unknown[]) => Promise<unknown>;
  // C++ -> JS event push. VERIFY exact API name/signature on JUCE 8.
  addEventListener?: (
    eventId: string,
    handler: (payload: unknown) => void
  ) => void;
  removeEventListener?: (
    eventId: string,
    handler: (payload: unknown) => void
  ) => void;
}

interface JuceGlobal {
  backend?: JuceBackend;
}

declare global {
  interface Window {
    __JUCE__?: JuceGlobal;
  }
}

// VERIFY: JUCE 8 WebView native-fn registration + window.__JUCE__.backend emit
// API (resolve against JUCE 8 when wiring the C++ bridge in module 03). The
// channel id below ("mosh_event") is a placeholder for whatever id the C++
// side emits on.
const JUCE_EVENT_CHANNEL = "mosh_event";

function makeJuceBridge(backend: JuceBackend): Bridge {
  const call = (name: string) => {
    if (!backend.getNativeFunction) {
      throw new Error("JUCE backend missing getNativeFunction");
    }
    return backend.getNativeFunction(name);
  };

  return {
    kind: "juce",

    async executeCommand(name, args) {
      // C++ side registers `executeCommand(name, argsJson)`; it marshals to the
      // message thread, runs DslExecutor::execute, and resolves the envelope.
      const raw = await call("executeCommand")(name, JSON.stringify(args ?? {}));
      return normalizeResult(raw);
    },

    async getSnapshot() {
      const raw = await call("getSnapshot")();
      return normalizeSnapshot(raw);
    },

    subscribe(listener) {
      // VERIFY: JUCE 8 WebView native-fn registration + window.__JUCE__.backend
      // emit API (resolve against JUCE 8 when wiring the C++ bridge in module
      // 03). If the real emit API differs, only this block changes.
      const handler = (payload: unknown) => {
        const ev = payload as MoshEvent;
        if (ev && typeof (ev as { type?: unknown }).type === "string") {
          listener(ev);
        }
      };
      backend.addEventListener?.(JUCE_EVENT_CHANNEL, handler);
      return () => backend.removeEventListener?.(JUCE_EVENT_CHANNEL, handler);
    },
  };
}

// ---------------------------------------------------------------------------
// In-memory mock bridge (dev / standalone browser). Returns plausible
// envelopes and a tiny seeded session so the placeholder renders without C++.
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

  let trackSeq = 0;

  return {
    kind: "mock",

    async executeCommand(name, args) {
      // Just enough behavior to make the seam observable in dev. Stage 1+ adds
      // real command handling on the C++ side; this mock is intentionally thin.
      switch (name) {
        case "create_track": {
          trackSeq += 1;
          const id = `track:mock_${trackSeq}`;
          const track: TrackState = {
            id,
            name: (args?.name as string) ?? `Track ${trackSeq}`,
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
        case "set_transport": {
          if (typeof args?.playing === "boolean") {
            snapshot.transport.playing = args.playing as boolean;
          }
          if (typeof args?.position === "number") {
            snapshot.transport.position = args.position as number;
            emit({ type: "transport_position", pos: args.position as number });
          }
          return ok("Transport updated", [], {});
        }
        default:
          // Unknown-but-harmless: report success with a note (mock is permissive).
          return ok(`(mock) ${name}`, [], { mock: true, args: args ?? {} });
      }
    },

    async getSnapshot() {
      // Return a deep-ish copy so callers can't mutate mock internal state.
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

function selectBridge(): Bridge {
  const juce = typeof window !== "undefined" ? window.__JUCE__ : undefined;
  if (juce && juce.backend) {
    return makeJuceBridge(juce.backend);
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
