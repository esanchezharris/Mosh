// Jobs slice — generative/render job progress plus the lazily-fetched,
// service-backed state (colours / transform targets / LoRAs / RAVE models /
// capabilities). Slice boundary = event rail + laziness class (RFC 004): the
// progress maps are fed by the job-status events in store/events.ts; the load*
// actions are LAZY BY CONTRACT — list_transform_targets' native handler calls
// jobManager.ensureServiceRunning(), which synchronously spawns the Python
// service on the unthreaded execute_command binding, so none of these may ever
// be called from init() (see loadCapabilities below).
import type { StateCreator } from "zustand";
import { executeCommand } from "../bridge";
import type {
  CommandResult, AvailableColor, AvailableTransformTarget, AvailableLora,
  AvailableRaveModel, RenderQA, ServiceCapabilities,
} from "../types";
// Type-only imports from the store module (erased at compile time — no runtime cycle).
import type { State } from "../store";

// GEN-WARMUP — cold-launch retry/backoff. ensureServiceRunning() (native) can take several
// real seconds on a cold launch (spawn python3, import the interpreter, and under
// MOSH_ENABLE_SA3=1 load the MLX model, ~1.7s+). A single failed response from that window
// ("generative service unavailable") is NOT a terminal error — it's the service still
// coming up. These fixed backoff delays (ms) bound how long loadColors/loadTransformTargets/
// loadLoras keep retrying before giving up for real; they sum to ~18s, comfortably inside
// the ticket's ~15-20s cold-SA3-load ceiling.
const WARMUP_RETRY_DELAYS_MS = [400, 800, 1200, 1600, 2000, 2500, 3000, 3500, 3500];

/** Overall generative-service reachability, as observed by the lazy list_* loaders below.
 *  "warming" = at least one attempt has failed but retries remain (a cold-starting service
 *  reads exactly like this); "error" = retries exhausted with no success — a genuine,
 *  actionable failure (dead python3, broken venv); "ready" = at least one loader has landed
 *  a real response. Shared across all three loaders because they all gate on the same
 *  native ensureServiceRunning()/spawnLock, so in practice they rise and fall together. */
export type GenServiceState = "idle" | "warming" | "ready" | "error";

export type JobsSlice = {
  renderProgress: Record<string, number>; // clipId → 0..1 (Tier-B render)
  transcribing: Record<string, boolean>;  // source clipId → audio→MIDI in flight (Basic Pitch)
  buildingLyrics: Record<string, boolean>; // source clipId → mumble-take lyric build in flight
  buildingSkeleton: Record<string, boolean>; // source clipId → "Build flow from this take" in flight
  // Sketch Phase 0 — keyed by the SOURCE FILE PATH, not a clipId: sketch_beatbox lands a
  // brand-new drum track+clip, so there is no existing clip to key the in-flight state
  // against (unlike transcribing/buildingLyrics/buildingSkeleton above).
  sketchingBeatbox: Record<string, boolean>;
  availableColors: AvailableColor[];       // SA3 colour rack (from list_colors)
  // Whether THIS Mac's generative service is actually running the real Stable Audio 3
  // model, straight from /colors' `sa3` field (server.py's SA3_ENABLED). undefined means
  // the service didn't report it — an older service, or /colors errored internally — and
  // callers fall back to the colour-rack-nonempty proxy (see ui/src/ui/engineBadge.ts)
  // rather than silently claiming SA3.
  sa3Available: boolean | undefined;
  availableTransformTargets: AvailableTransformTarget[]; // Route B targets (from list_transform_targets)
  availableLoras: AvailableLora[];         // LoRA rack library (from list_loras)
  availableRaveModels: AvailableRaveModel[]; // Lane B — RAVE model library (from list_rave_models)
  transformFreeText: boolean;              // Route B: does the transform tier allow free-text targets
  // Guest-degradation capability summary (from list_transform_targets' piggybacked
  // `capabilities` field — see loadCapabilities below). null until the lazy fetch
  // (first clip-menu/Gen-drawer open — NEVER init(), which must stay service-free)
  // resolves; callers treat null as "assume available" (see capabilities.ts).
  capabilities: ServiceCapabilities | null;
  labMode: boolean;                        // ASTD unlock for generative colours
  qaByClip: Record<string, RenderQA>;      // last render's quality readout

  // GEN-WARMUP: overall service reachability + the last terminal error message (only
  // meaningful when genServiceState === "error"). GenDrawer reads these to distinguish
  // "still starting up" from "actually broken" instead of collapsing both into one state.
  genServiceState: GenServiceState;
  genServiceError: string | null;
  // In-flight guards so a remount (or a second caller — e.g. ClipView's menu AND GenDrawer
  // both touching loadTransformTargets) doesn't stack a duplicate retry loop on top of one
  // already running.
  colorsRetrying: boolean;
  loraRetrying: boolean;
  transformTargetsRetrying: boolean;

  loadColors: () => void;
  loadTransformTargets: () => void;        // Route B: fetch transform targets (lazy)
  loadLoras: () => void;                   // LoRA rack: fetch the adapter library (lazy)
  loadRaveModels: () => void;              // Lane B: fetch the RAVE model library (lazy)
  loadCapabilities: () => void;            // guest-degradation: fetch lazily on first clip-menu/Gen-drawer open (see capabilities field)
  setLab: (b: boolean) => void;
};

export const createJobsSlice: StateCreator<State, [], [], JobsSlice> = (set, get) => ({
  renderProgress: {},
  transcribing: {},
  buildingLyrics: {},
  buildingSkeleton: {},
  sketchingBeatbox: {},
  availableColors: [],
  sa3Available: undefined,
  availableTransformTargets: [],
  availableLoras: [],
  availableRaveModels: [],
  transformFreeText: true,
  capabilities: null,
  labMode: false,
  qaByClip: {},
  genServiceState: "idle",
  genServiceError: null,
  colorsRetrying: false,
  loraRetrying: false,
  transformTargetsRetrying: false,

  // GEN-WARMUP: retry a still-cold-starting service instead of latching its first failure.
  // `attempt` finishes one HTTP round trip and returns whether it landed real data; the
  // caller schedules the next attempt through WARMUP_RETRY_DELAYS_MS until either it
  // succeeds or the budget runs out. `retryingKey` gates re-entrancy (a remount that fires
  // the same load* again while a loop is already in flight is a no-op, not a second loop),
  // and `genServiceState` never regresses from "ready" — one loader landing data means the
  // service IS up, even if a sibling loader's own retry loop hasn't caught up yet.
  loadColors: () => {
    if (get().availableColors.length > 0 || get().colorsRetrying) return;
    set({ colorsRetrying: true });
    let attemptIndex = 0;
    const attempt = () => {
      void executeCommand<CommandResult<{ colors: AvailableColor[]; sa3?: boolean }>>({
        command: "list_colors",
        args: {},
      }).then((res) => {
        if (res.ok && res.data?.colors) {
          set({
            availableColors: res.data.colors, sa3Available: res.data.sa3,
            colorsRetrying: false, genServiceState: "ready", genServiceError: null,
          });
          return;
        }
        if (attemptIndex >= WARMUP_RETRY_DELAYS_MS.length) {
          const ready = get().genServiceState === "ready";
          set({
            colorsRetrying: false,
            genServiceState: ready ? "ready" : "error",
            genServiceError: ready ? get().genServiceError : (res.error ?? "list_colors failed"),
          });
          return;
        }
        if (get().genServiceState !== "ready") set({ genServiceState: "warming" });
        const delay = WARMUP_RETRY_DELAYS_MS[attemptIndex];
        attemptIndex += 1;
        setTimeout(attempt, delay);
      });
    };
    attempt();
  },

  loadLoras: () => {
    if (get().availableLoras.length > 0 || get().loraRetrying) return;
    set({ loraRetrying: true });
    let attemptIndex = 0;
    const attempt = () => {
      void executeCommand<CommandResult<{ loras: AvailableLora[] }>>({
        command: "list_loras",
        args: {},
      }).then((res) => {
        if (res.ok && res.data?.loras) {
          set({ availableLoras: res.data.loras, loraRetrying: false, genServiceState: "ready", genServiceError: null });
          return;
        }
        if (attemptIndex >= WARMUP_RETRY_DELAYS_MS.length) {
          const ready = get().genServiceState === "ready";
          set({
            loraRetrying: false,
            genServiceState: ready ? "ready" : "error",
            genServiceError: ready ? get().genServiceError : (res.error ?? "list_loras failed"),
          });
          return;
        }
        if (get().genServiceState !== "ready") set({ genServiceState: "warming" });
        const delay = WARMUP_RETRY_DELAYS_MS[attemptIndex];
        attemptIndex += 1;
        setTimeout(attempt, delay);
      });
    };
    attempt();
  },

  loadRaveModels: () => {
    if (get().availableRaveModels.length > 0) return;
    void executeCommand<CommandResult<{ models: AvailableRaveModel[] }>>({
      command: "list_rave_models",
      args: {},
    }).then((res) => {
      if (res.ok && res.data?.models) set({ availableRaveModels: res.data.models });
    });
  },

  loadTransformTargets: () => {
    if (get().availableTransformTargets.length > 0 || get().transformTargetsRetrying) return;
    set({ transformTargetsRetrying: true });
    let attemptIndex = 0;
    const attempt = () => {
      void executeCommand<CommandResult<{ targets: string[]; freeText: boolean; capabilities?: ServiceCapabilities }>>({
        command: "list_transform_targets",
        args: {},
      }).then((res) => {
        if (res.ok && res.data?.targets) {
          set({
            availableTransformTargets: res.data.targets.map((name) => ({ name })),
            transformFreeText: res.data.freeText !== false,
            transformTargetsRetrying: false, genServiceState: "ready", genServiceError: null,
          });
          // Whichever caller (this or loadCapabilities) hits the service first lands the
          // capability summary — both read the same GET, so this is a harmless overwrite.
          if (res.data.capabilities) set({ capabilities: res.data.capabilities });
          return;
        }
        if (attemptIndex >= WARMUP_RETRY_DELAYS_MS.length) {
          const ready = get().genServiceState === "ready";
          set({
            transformTargetsRetrying: false,
            genServiceState: ready ? "ready" : "error",
            genServiceError: ready ? get().genServiceError : (res.error ?? "list_transform_targets failed"),
          });
          return;
        }
        if (get().genServiceState !== "ready") set({ genServiceState: "warming" });
        const delay = WARMUP_RETRY_DELAYS_MS[attemptIndex];
        attemptIndex += 1;
        setTimeout(attempt, delay);
      });
    };
    attempt();
  },

  // Guest-degradation: the frontend has no per-C++ session flag for "is transcribe /
  // skeleton / whisper / phonology / a real RAVE model / a real training backend
  // installed on this Mac" (unlike session.raveAvailable etc., which ARE native
  // session fields) — so it fetches the honest summary directly from the service via
  // the existing list_transform_targets/`capabilities` carrier (see that endpoint's
  // server.py comment).
  //
  // CALLED LAZILY ONLY — never from init(). list_transform_targets' native handler
  // calls jobManager.ensureServiceRunning(), which can synchronously spawn the Python
  // service and block the (unthreaded) execute_command message-thread binding for
  // 1-2+ seconds on a cold start. That's an accepted, pre-existing cost of opening the
  // generative drawer for the first time (loadColors/loadTransformTargets/loadLoras all
  // pay it already) — it must never become a guaranteed launch-time freeze. Trigger
  // points: ClipView.tsx's clip-menu mount (so the AI-menu gating can resolve before a
  // Gen-drawer visit) and Dock.tsx's GenDrawer mount (via loadTransformTargets, which
  // lands the same `capabilities` field). Guarded so a second call once resolved is a
  // no-op.
  loadCapabilities: () => {
    if (get().capabilities !== null) return;
    void executeCommand<CommandResult<{ capabilities?: ServiceCapabilities }>>({
      command: "list_transform_targets",
      args: {},
    }).then((res) => {
      if (res.ok && res.data?.capabilities) set({ capabilities: res.data.capabilities });
    });
  },

  setLab: (b) => set({ labMode: b }),
});
