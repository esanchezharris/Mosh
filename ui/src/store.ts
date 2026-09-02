import { create } from "zustand";
import {
  executeCommand, getSnapshot, onEvent, isNative, notifyUiReady,
  getRemoteStatus, startRemotePairing, stopRemoteCompanion,
} from "./bridge";
import type {
  Snapshot, MoshEvent, CommandResult, Clip,
} from "./types";
import { versionBannerError } from "./types";
import type { RemoteStatus } from "./bridge";
import { type SnapDiv, meterFrom, snapTimeMap, tempoMapFrom } from "./time";
import { adaptiveDivision } from "./adaptiveGrid";
import type { ChangeSet } from "./agent/executor";
// Schema-driven settings (UI-local, localStorage-backed). The store mirrors a few
// of its values (theme/uiScale/voiceOn/voiceVol) so existing consumers stay reactive
// while the SettingsPanel and these mutators both write through the single source.
import { useSettings } from "./settings/store";
// AGT-MEM (M3) — drops the cached agent-memory pools on a project switch.
import { invalidateMemoryHydration } from "./agent/memory/hydrate";
// AGT-MEM (M3, item 5) — mirrors every exec() call into the in-session ring buffer
// sessionSummary.ts digests into a project note on the next project switch.
import { recordSessionCommand } from "./agent/memory/sessionLog";
// Per-rail "mosh_event" handler bodies (verbatim motion from init(); the dispatch
// order + conditions stay in init() below, which is load-bearing).
import {
  onSnapshotInvalidated, onTransport, onLevels, onMuteAutomation, onSpectrum, onPluginScanProgress,
  onTranscribeStatus, onBuildLyricsStatus, onSkeletonStatus, onSketchStatus,
  onLayerRenderProgress, onLayerStatus, onMpState, onWebrtcSignal,
  onPeerSelection, onPeerPresence, onMpCommitDone,
} from "./store/events";
// RFC 004 step 2 — the store is composed from StateCreator slices along the
// existing rails (telemetry / mp / jobs / catalogs) inside the SINGLE create()
// call below. Slice files own their fields + actions; `State` stays the one seam
// type and `useStore` the one store — consumers keep importing from ui/src/store.
import { createTelemetrySlice, type TelemetrySlice } from "./store/telemetry";
import { createMpSlice, type MpSlice } from "./store/mp";
import { createJobsSlice, type JobsSlice } from "./store/jobs";
import { createCatalogsSlice, type CatalogsSlice } from "./store/catalogs";
// LoRA Lab (train -> audition -> keep). Its own slice: the Lab owns run polling,
// take auditions and UI-local cue/dismissal state, none of which any other
// surface reads.
import { createLoraLabSlice, type LoraLabSlice } from "./store/loraLab";
// Keep main's WIDER recordingLifecycle import: it grew observeRecordingLane +
// two types while this branch was out. Taking either side wholesale would have
// dropped the other — the Lab slice or the recording lane.
import {
  landedRecordingClipIds, observeRecordingLane, type RecordingCommandData,
  type RecordingLaneObservationV1, type RecordingStoreOutcomeV1,
} from "./recordingLifecycle";
import { cancelTransportActions, enqueueTransportAction } from "./transportActionQueue";
import { useShell } from "./v2/shellState";

export type Tool = "move" | "split" | "range";
export type View = "arrange" | "mixer";
export type Peaks = [number, number][];
// Live spectral feed (Moshi reactivity), fed by the 30Hz "spectrum" event.
export type Spectrum = { bands: number[]; level: number; flux: number };
// ARR-010 — a UI-local edit time-range [start,end] in seconds. Never a command;
// only delete_time_range sends {start,end} across the bridge when invoked.
export type TimeRange = { start: number; end: number };

export type State = {
  snapshot: Snapshot | null;
  projectEpoch: number;
  projectTransitioning: boolean;
  connected: boolean;
  lastError: string | null;
  // REC-001 — a named setter for the shared banner, so runAction (which sees only the
  // ActionStore interface, never the raw Zustand set) can report Capture's outcome.
  setLastError: (message: string | null) => void;
  // A2 — UI-local: the crash-recovery notice is dismissed for this session (view state, not
  // a command — the prime directive keeps pure view state off the bridge).
  recoveryDismissed: boolean;
  dismissRecovery: () => void;

  // UI-local view state (NOT commands — the swappable-seam rule: zoom, tool,
  // snap, selection never cross the bridge).
  pxPerSec: number;
  // Piano-roll horizontal zoom, in px per BEAT. Deliberately NOT pxPerSec: the
  // arrangement drives that from a ResizeObserver on every window resize and
  // section-zoom change, so sharing it would yank the MIDI editor's zoom whenever
  // the window moved. Not persisted — a modal editor resetting per session is right.
  pianoRollBeatPx: number;
  setPianoRollBeatPx: (v: number) => void;
  tool: Tool;
  snap: boolean;
  snapDivision: SnapDiv; // musical grid resolution (bar, 1/4, 1/8, …)
  // Triplet arrangement grid (⌘3, Live's Options → Triplet Grid). UI-local like
  // snap/snapDivision; the lane grid paint does NOT draw triplet lines (documented
  // in PARITY.md) — this governs snapping only.
  snapTriplet: boolean;
  setSnapTriplet: (b: boolean) => void;
  // CAP-CLP-017 — RIPPLE EDIT mode. When on, dragging or trimming a clip carries every
  // later clip on the SAME track with it (move_clip/trim_clip {ripple:true}) instead of
  // leaving a hole or an overlap.
  //
  // MODAL AND VISIBLE, not a held modifier, and that is the whole point. Two of the four
  // reference DAWs (Pro Tools' Shuffle mode, Reaper's ripple-all/ripple-per-track) make
  // this a mode the user is TOLD is on, because a ripple drag silently rearranges material
  // far off-screen — a hidden one is a way to destroy an arrangement by accident. It is
  // therefore off by default and announced by a lit chip in the top bar for as long as it
  // is on. It is UI-local view state like `snap`: the backend learns about it only as the
  // `ripple` argument on the command a gesture actually issues.
  ripple: boolean;
  selection: Set<string>;
  peaks: Record<string, Peaks>;
  // The audio source each cached peaks array was fetched for (clipId → sourceFile).
  // Peaks are keyed on it so an in-place repoint (applyRenderInPlace / relink_clip keep
  // the clip id but swap sourceFile) invalidates the stale waveform instead of showing it.
  peaksSourceKey: Record<string, string>;

  // ARR-010 — the active edit time-range (UI-local; set by the Range tool, sent
  // to the backend only via delete_time_range). null when no range is drawn.
  timeRange: TimeRange | null;

  // Stage 3: plugin browser (the catalog lists themselves live in the catalogs
  // slice — ./store/catalogs; these are the pure view-state companions).
  selectedTrackId: string | null;
  expandedTracks: Set<string>;            // UI-local: tracks whose inline FX drawer is open
  browserOpen: boolean;
  remoteStatus: RemoteStatus | null;       // iPhone companion server state

  // Clip clipboard — pure UI-local view state. The captured clip descriptors only
  // cross the bridge on paste (paste_clip); copy/cut never touch the backend
  // (swappable-seam rule).
  //
  // Holds the WHOLE selection. It used to hold one clip, with a written reason ("the
  // single-clip clipboard must not delete more than it can restore") that was correct
  // while nothing in the shipped shell could multi-select by mouse. Marquee select
  // changed that: a lasso over 8 clips feeding a clipboard that copies 1 would be a new
  // lie, so the two shipped together.
  //
  // `anchor` is the earliest start among the copied clips, so paste can rebuild their
  // relative spacing from the playhead instead of stacking them.
  clipboard: { clips: { clip: Clip; sourceTrackId: string }[]; anchor: number } | null;

  refresh: () => Promise<void>;
  // FS-B2a — the optional third argument is the agent-transaction envelope. It rides
  // BESIDE command/args (never inside args) all the way to MoshOps::executeImpl, which
  // reads it off the command object; WebBridge passes args[0] whole, so the sibling field
  // survives untouched. Omitted by every existing caller ⇒ behaviour unchanged.
  exec: (
    command: string,
    args?: Record<string, unknown>,
    transaction?: { transactionId: string; requestId: string; index: number },
  ) => Promise<CommandResult>;
  // AGT-MEM (M3) — satisfies menuActions.ts's ActionStore.invalidateMemory: drops
  // the cached agent-memory pools so a project switch never leaks a stale project's
  // notes into the newly-opened one's prompts.
  invalidateMemory: () => void;
  init: () => void;
  refreshRemote: () => Promise<void>;
  startRemotePairing: () => Promise<void>;
  stopRemote: () => Promise<void>;

  setPxPerSec: (v: number) => void;
  setTool: (t: Tool) => void;
  setSnap: (b: boolean) => void;
  setSnapDivision: (d: SnapDiv) => void;
  snapAuto: boolean;
  setSnapAuto: (b: boolean) => void;
  /** snapDivision, or the zoom-derived one when snapAuto. */
  effectiveSnapDivision: () => SnapDiv;
  setRipple: (b: boolean) => void;
  select: (ids: string[], additive?: boolean) => void;
  clearSelection: () => void;
  snapTime: (t: number) => number;
  ensurePeaks: (clipId: string) => void;

  // ARR-010 — time-range view-state actions (never cross the bridge).
  setTimeRange: (r: TimeRange | null) => void;

  // Clipboard actions (UI-local until paste). copy/cut capture a snapshot clip;
  // paste reconstructs it on the backend via the paste_clip command.
  copySelection: () => void;
  cutSelection: () => Promise<void>;
  pasteClipboard: () => Promise<void>;
  /** Run several commands as ONE undo step when the engine allows it; see the impl. */
  runAtomic: (label: string, body: (exec: State["exec"]) => Promise<void>) => Promise<void>;

  setSelectedTrack: (id: string | null) => void;
  toggleTrackExpanded: (id: string) => void;
  editingClipId: string | null;            // MIDI clip open in the piano-roll
  openPianoRoll: (clipId: string) => void;
  closePianoRoll: () => void;
  automationTrackId: string | null;        // track open in the automation editor
  openAutomation: (trackId: string) => void;
  closeAutomation: () => void;
  feltWrongOpen: boolean;                  // taste loop: the ⌘⇧F capture dialog
  setFeltWrongOpen: (open: boolean) => void;
  openBrowser: () => void;
  closeBrowser: () => void;

  view: View;
  setView: (v: View) => void;

  theme: "dark" | "light";
  toggleTheme: () => void;

  // Moshi creature — UI-local signals the character watches (never cross the bridge).
  // celebrateTick is bumped when a render is accepted (his reward moment); the voice
  // settings are UI-local + persisted, exactly like theme/uiScale.
  celebrateTick: number;
  bumpCelebrate: () => void;
  voiceOn: boolean;
  voiceVol: number;
  toggleVoice: () => void;
  // Agent (Moshi running the session) — UI-local. agentChangeSet drives Monster
  // changes; agentUtter signals the creature to react (voice + pose) to a reply.
  agentBusy: boolean;
  agentChangeSet: ChangeSet | null;
  agentUtter: { intent: string; say?: string; tick: number } | null;
  setAgentBusy: (b: boolean) => void;
  setAgentChangeSet: (cs: ChangeSet | null) => void;
  pushAgentUtter: (intent: string, say?: string) => void;

  // AGT-MEM (M3) — the "remember that…" fastPath rule's confirm toast. A memory
  // write is non-undoable BY DESIGN (M1) — this toast's Undo therefore calls
  // agent_memory_delete on the just-written item's `ts`, never the real undo
  // command. UI-local (mirrors agentChangeSet's ChangeToast posture, one level down).
  memoryToast: { text: string; scope: "global" | "project"; kind: string; ts: number } | null;
  setMemoryToast: (t: State["memoryToast"]) => void;

  // Performer mode (hands-free voice take recording). `recording` is derived from the
  // live snapshot; `takeDecisionPending` marks "a just-recorded take awaits keep/redo".
  takeDecisionPending: boolean;
  lastTakeClipId: string | null;
  // Skill Foundry Slice B, Task 2 — the last OBSERVED stable-id take-lane state (Task 1's
  // native takeIds/currentTakeId), refreshed on every start/stop/audition/keep. Null
  // whenever there is no take under review, or the observation could not be verified
  // (e.g. ids not yet backfilled) — never a stale or fabricated value.
  takeReview: RecordingLaneObservationV1 | null;
  currentMode: () => "idle" | "recording" | "reviewing";
  enterRecord: (bar?: number) => Promise<RecordingStoreOutcomeV1>;
  toggleRecord: () => Promise<void>;
  stopRecord: () => Promise<RecordingStoreOutcomeV1>;
  keepTake: (takeId?: string) => Promise<RecordingStoreOutcomeV1>;
  navTake: (delta: number) => Promise<RecordingStoreOutcomeV1>;

  // UI scale (ACC-005) — pure UI-local view state (like theme): never a command,
  // never crosses the bridge. Applied via document zoom so the whole WebView reflows.
  uiScale: number;
} & TelemetrySlice & MpSlice & JobsSlice & CatalogsSlice & LoraLabSlice;

type StateGet = () => State;
type StateSet = (state: Partial<State> | ((state: State) => Partial<State>)) => void;

// App mounts under React.StrictMode in development, which deliberately replays
// effects. The bridge and settings subscriptions live for the page lifetime, so
// wiring them twice would reduce every native event twice (notably advancing a
// project-replacement epoch by two in the dev/e2e shell).
let storeInitialized = false;

function clearProjectLocalShellRange(): void {
  const shell = useShell.getState();
  shell.setTimeRange(null);
  shell.setTimeRangeDragging(false);
}

async function startRecording(
  get: StateGet, set: StateSet, projectEpoch: number, bar?: number,
): Promise<RecordingStoreOutcomeV1> {
  const blocked = (reason: string): RecordingStoreOutcomeV1 => ({ kind: "blocked", reason });
  if (get().projectEpoch !== projectEpoch) return blocked("the project changed");
  if (get().projectTransitioning) {
    set({ lastError: "Wait for the project to finish opening before recording." });
    return blocked("Wait for the project to finish opening before recording.");
  }
  const s = get();
  const snap = s.snapshot;
  const armedTrack = snap?.tracks.find((track) => track.armed);
  const trackId = armedTrack?.id
    ?? s.selectedTrackId
    ?? snap?.tracks.find((track) => track.type === "audio")?.id
    ?? snap?.tracks[0]?.id;
  if (!trackId) {
    s.pushAgentUtter("HUH", "no track to record into");
    set({ lastError: "Add a track before recording." });
    return blocked("Add a track before recording.");
  }
  if (!armedTrack) {
    const arm = await s.exec("arm_track", { trackId, armed: true });
    if (get().projectEpoch !== projectEpoch || get().projectTransitioning) return blocked("the project changed");
    const armApplied = (arm.data as { applied?: boolean } | undefined)?.applied;
    if (!arm.ok || arm.command !== "arm_track" || armApplied !== true) {
      s.pushAgentUtter("UHOH", "can't — no input");
      set({ lastError: "No usable audio input — check Settings → Audio (device and input selection)." });
      return { kind: "recording_failed", reason: "No usable audio input." };
    }
  }
  set({ lastError: null });
  if (bar && bar > 0 && snap) {
    const tempo = snap.session?.tempo ?? 120;
    const num = snap.session?.timeSigNumerator ?? 4;
    await s.exec("set_transport", { position: (bar - 1) * num * (60 / tempo) });
    if (get().projectEpoch !== projectEpoch || get().projectTransitioning) return blocked("the project changed");
  }
  const record = await s.exec("set_transport", { action: "record" });
  if (get().projectEpoch !== projectEpoch || get().projectTransitioning) return blocked("the project changed");
  const recordState = record.data as { playing?: boolean; recording?: boolean } | undefined;
  if (!record.ok || record.command !== "set_transport" || recordState?.recording !== true) {
    const reason = record.error ?? "Could not start recording.";
    set({ lastError: reason });
    return { kind: "recording_failed", reason };
  }
  set({
    takeDecisionPending: false,
    takeReview: null,
    transport: {
      ...get().transport,
      recording: true,
      ...(typeof recordState.playing === "boolean" ? { playing: recordState.playing } : {}),
    },
  });
  await s.refresh();
  // Skill Foundry Slice B, Task 2 — the BASELINE is the take-lane state observed right
  // after record started (before any new take has landed): whatever the target track's
  // most recent take clip already looked like, or null on a genuinely first recording.
  const baseline = trackId
    ? (get().snapshot?.tracks.find((t) => t.id === trackId)?.clips
        .map((clip) => observeRecordingLane(get().snapshot!, clip.id))
        .find((observation): observation is RecordingLaneObservationV1 => observation !== null) ?? null)
    : null;
  return { kind: "started", baseline };
}

async function stopRecording(
  get: StateGet, set: StateSet, projectEpoch: number,
): Promise<RecordingStoreOutcomeV1> {
  if (get().projectEpoch !== projectEpoch || get().projectTransitioning)
    return { kind: "blocked", reason: "the project changed" };
  const s = get();
  const res = await s.exec("stop_recording", {});
  if (get().projectEpoch !== projectEpoch || get().projectTransitioning)
    return { kind: "blocked", reason: "the project changed" };
  const stopData = res.data as RecordingCommandData | undefined;
  const landedIds = landedRecordingClipIds(res);
  if (!landedIds) {
    // "not recording" degrades gracefully to an observed idle state rather than an
    // error — every OTHER unrecognised/failed shape is a genuine landing failure.
    if (res.ok && stopData?.applied === false && stopData.reason === "not recording") {
      return { kind: "not_recording" };
    }
    const reason = res.error ?? stopData?.reason ?? "Could not land the recording take.";
    set({ lastError: reason });
    return { kind: "recording_failed", reason };
  }
  await s.refresh();
  if (get().projectEpoch !== projectEpoch || get().projectTransitioning)
    return { kind: "blocked", reason: "the project changed" };
  const projectClipIds = new Set(
    (get().snapshot?.tracks ?? []).flatMap((track) => track.clips.map((clip) => clip.id)),
  );
  const landed = landedIds.find((id) => projectClipIds.has(id));
  if (!landed) {
    const reason = "Could not find the landed recording take.";
    set({ lastError: reason });
    return { kind: "landed_unverified", reason };
  }
  const review = observeRecordingLane(get().snapshot!, landed);
  set({ takeDecisionPending: true, lastTakeClipId: landed, takeReview: review });
  if (!review) {
    return { kind: "landed_unverified", reason: "the landed take's stable id could not be verified" };
  }
  return { kind: "reviewing", review };
}

async function refreshSnapshot(
  get: StateGet,
  set: StateSet,
  projectEpoch: number,
  allowProjectTransition: boolean,
): Promise<boolean> {
  if (!isNative() || (get().projectTransitioning && !allowProjectTransition)) return false;
  try {
    const snap = await getSnapshot<Snapshot>();
    if (get().projectEpoch !== projectEpoch
      || (get().projectTransitioning && !allowProjectTransition)) return false;
    set({ snapshot: snap, connected: true, transport: snap.transport });
    // PRJ-FMT — surface a version banner (file-format refusal or snapshot-schema mismatch).
    const banner = versionBannerError(snap);
    if (banner) set({ lastError: banner });
    // Prune selection / fetch peaks for current clips. Only emit a new Set when
    // pruning actually REMOVED something — an unchanged reference swap would fire
    // every selection subscriber on EVERY refresh (and, for the live shell's
    // selection-follow, would read as a phantom deselect after any command).
    const ids = new Set(snap.tracks.flatMap((t) => t.clips.map((c) => c.id)));
    set((s) => {
      const kept = [...s.selection].filter((id) => ids.has(id));
      return kept.length === s.selection.size ? {} : { selection: new Set(kept) };
    });
    // Prune the inline-FX expand set against current tracks (mirror the selection
    // prune) so a removed track's id can't make a later id-reused track open by itself.
    const trackIds = new Set(snap.tracks.map((t) => t.id));
    set((s) => ([...s.expandedTracks].every((id) => trackIds.has(id))
      ? {}
      : { expandedTracks: new Set([...s.expandedTracks].filter((id) => trackIds.has(id))) }));
    // Auto-select a track for the rack if none is selected.
    set((s) => {
      const exists = snap.tracks.some((t) => t.id === s.selectedTrackId);
      return exists ? {} : { selectedTrackId: snap.tracks[0]?.id ?? null };
    });
    // Prune stale render-quality readouts (judge scores). A clip keeps its qa only while its
    // render layer is still a LIVE render; once the layer is removed, reset, or rejected
    // (reverted to "dirty"/"error") the score is dead and must not linger.
    set((s) => {
      if (Object.keys(s.qaByClip).length === 0) return {};
      const live = new Set<string>();
      for (const t of snap.tracks) for (const c of t.clips) {
        const rl = c.renderLayer;
        if (rl && rl.status !== "dirty" && rl.status !== "error") live.add(c.id);
      }
      const stale = Object.keys(s.qaByClip).filter((id) => !live.has(id));
      if (stale.length === 0) return {};
      const qaByClip = { ...s.qaByClip };
      for (const id of stale) delete qaByClip[id];
      return { qaByClip };
    });
    for (const t of snap.tracks) for (const c of t.clips) get().ensurePeaks(c.id);
    return true;
  } catch (e) {
    if (get().projectEpoch !== projectEpoch
      || (get().projectTransitioning && !allowProjectTransition)) return false;
    set({ lastError: String(e) });
    return false;
  }
}

export const useStore = create<State>((set, get, api) => ({
  // RFC 004 slices — field groups + their actions along the existing rails.
  // Composed FIRST so the core fields below read as the remainder; no key overlaps.
  ...createTelemetrySlice(set, get, api),
  ...createMpSlice(set, get, api),
  ...createJobsSlice(set, get, api),
  ...createCatalogsSlice(set, get, api),
  ...createLoraLabSlice(set, get, api),

  snapshot: null,
  projectEpoch: 0,
  projectTransitioning: false,
  connected: isNative(),
  lastError: null,
  recoveryDismissed: false,
  dismissRecovery: () => set({ recoveryDismissed: true }),

  pxPerSec: 80,
  // 42 is load-bearing, not aesthetic: PianoRoll.dragAxes.test.ts and
  // PianoRoll.scaleLock.test.ts both declare BEAT_PX = 42 and compute expected beat
  // deltas from it. Changing the default is a deliberate change to those fixtures.
  pianoRollBeatPx: 42,
  tool: "move",
  snap: true,
  snapDivision: "1/4",
  snapAuto: false,
  snapTriplet: false,  // ⌘3 (ableton preset) — the arrangement's triplet grid; off elsewhere
  ripple: false,   // CAP-CLP-017 — OFF by default; a hidden ripple mode destroys arrangements
  selection: new Set<string>(),
  peaks: {},
  peaksSourceKey: {},
  timeRange: null,
  selectedTrackId: null,
  expandedTracks: new Set(),
  browserOpen: false,
  remoteStatus: null,
  clipboard: null,

  refresh: async () => {
    const projectEpoch = get().projectEpoch;
    await refreshSnapshot(get, set, projectEpoch, false);
  },

  exec: async (command, args = {}, transaction) => {
    const replacesProject = ["new_project", "open_project", "open_recent", "reload", "recover_session", "open_without_plugins"].includes(command);
    let transitionEpoch: number | undefined;
    if (replacesProject) {
      cancelTransportActions();
      clearProjectLocalShellRange();
      set((state) => ({
        projectEpoch: state.projectEpoch + 1,
        projectTransitioning: true,
        agentChangeSet: null,
        takeDecisionPending: false,
        lastTakeClipId: null,
        takeReview: null,
      }));
      transitionEpoch = get().projectEpoch;
    }
    let res: CommandResult;
    try {
      res = await executeCommand<CommandResult>({
        command,
        args,
        ...(transaction ? { transaction } : {}),
        ...(replacesProject ? { _moshProjectEpochPrepared: true } : {}),
      });
    } catch (error) {
      if (replacesProject && get().projectEpoch === transitionEpoch)
        set({ projectTransitioning: false });
      throw error;
    }
    if (replacesProject && get().projectEpoch === transitionEpoch) {
      const replacementReady = !res.ok
        || await refreshSnapshot(get, set, transitionEpoch, true);
      if (get().projectEpoch === transitionEpoch && replacementReady)
        set({ projectTransitioning: false });
      if (!replacementReady) {
        if (get().projectEpoch === transitionEpoch) {
          // The edit did change, so the previous snapshot is no longer safe to expose.
          // Reopen the UI on an honest blank state, then retry once through the normal
          // refresh path. Recording cannot target stale armed/selected track ids while
          // that retry is pending, and a second failure leaves the app recoverable.
          set({
            snapshot: null,
            connected: false,
            projectTransitioning: false,
            selection: new Set<string>(),
            selectedTrackId: null,
            expandedTracks: new Set<string>(),
            transport: {
              playing: false,
              recording: false,
              position: 0,
              looping: false,
              loopStart: 0,
              loopEnd: 0,
            },
          });
          await get().refresh();
        }
        recordSessionCommand(command, args, res.ok);
        return res;
      }
    }
    recordSessionCommand(command, args, res.ok);
    if (!res.ok) set({ lastError: res.error ?? `${command} failed` });
    else {
      // A success clears a stale transient error — but never the persistent version
      // banner (a newer-file refusal / schema mismatch), which refresh() re-derives and
      // which must survive until the underlying condition is gone.
      const snap = get().snapshot;
      const banner = snap ? versionBannerError(snap) : null;
      if (get().lastError !== banner) set({ lastError: banner });
    }
    return res;
  },

  invalidateMemory: () => invalidateMemoryHydration(),

  init: () => {
    if (storeInitialized) return;
    storeInitialized = true;
    // Thin dispatcher over the per-rail handlers in store/events.ts (verbatim body
    // motion). The order + conditions here are load-bearing and must not change:
    // transport / levels / spectrum are the 30 Hz telemetry rails that deliberately
    // bypass the snapshot.
    onEvent("mosh_event", (raw) => {
      const ev = raw as MoshEvent;
      if (ev.type === "snapshot_invalidated") {
        const projectReplaced = ev.payload !== null
          && typeof ev.payload === "object"
          && (ev.payload as { projectReplaced?: unknown }).projectReplaced === true;
        const epochManagedByUi = projectReplaced
          && (ev.payload as { epochManagedByUi?: unknown }).epochManagedByUi === true;
        if (projectReplaced) {
          cancelTransportActions();
          clearProjectLocalShellRange();
          set((state) => ({
            projectEpoch: state.projectEpoch + (epochManagedByUi ? 0 : 1),
            projectTransitioning: epochManagedByUi ? state.projectTransitioning : false,
            agentChangeSet: null,
            takeDecisionPending: false,
            lastTakeClipId: null,
            takeReview: null,
            selection: new Set<string>(),
            selectedTrackId: null,
            expandedTracks: new Set<string>(),
            timeRange: null,
          }));
        }
        onSnapshotInvalidated(ev, set, get);
      } else if (ev.type === "transport") {
        onTransport(ev, set);
      } else if (ev.type === "levels") {
        onLevels(ev, set);
      } else if (ev.type === "mute_automation") {
        onMuteAutomation(ev, set);
      } else if (ev.type === "spectrum") {
        onSpectrum(ev, set);
      } else if (ev.type === "plugin_scan_progress") {
        onPluginScanProgress(ev, set, get);
      } else if (ev.type === "transcribe_status") {
        onTranscribeStatus(ev, set);
      } else if (ev.type === "build_lyrics_status") {
        onBuildLyricsStatus(ev, set);
      } else if (ev.type === "skeleton_status") {
        onSkeletonStatus(ev, set);
      } else if (ev.type === "sketch_status") {
        onSketchStatus(ev, set);
      } else if (ev.type === "layer_render_progress") {
        onLayerRenderProgress(ev, set);
      } else if (ev.type === "layer_status") {
        onLayerStatus(ev, set, get);
      } else if (ev.type === "lab_take") {
        // LoRA Lab audition render finished (or progressed). Event-driven, unlike
        // the training run's 1s poll: a take becoming playable is the moment the
        // producer is actually waiting on.
        get().onLabTakeEvent((ev as unknown as { payload?: unknown }).payload ?? ev);
      } else if (ev.type === "mp_state") {
        onMpState(ev, set, get);
      } else if (ev.type === "webrtc_signal") {
        onWebrtcSignal(ev);
      } else if (ev.type === "peer_selection") {
        onPeerSelection(ev, set);
      } else if (ev.type === "peer_presence") {
        onPeerPresence(ev, set);
      } else if (ev.type === "mp_commit_done") {
        onMpCommitDone(ev, set);
      }
    });
    // Keep the mirrored settings fields in sync with the schema-driven settings
    // store: the SettingsPanel writes through useSettings, so without this a theme
    // or voice change made in the panel wouldn't reach Topbar/Moshi. Seed once
    // (settings were hydrated from localStorage before render) then subscribe.
    const mirrorSettings = () => {
      const g = useSettings.getState();
      set({
        theme: g.get("theme") as "dark" | "light",
        uiScale: g.get("uiScale") as number,
        voiceOn: g.get("voiceOn") as boolean,
        voiceVol: g.get("voiceVol") as number,
      });
    };
    mirrorSettings();
    useSettings.subscribe(mirrorSettings);

    void notifyUiReady();
    void get().refresh();
    void get().refreshRemote();
    // Guest-degradation: deliberately NOT fetched here. list_transform_targets' native
    // handler (MoshOps::cmdListTransformTargets) calls jobManager.ensureServiceRunning(),
    // which SYNCHRONOUSLY spawns the Python service and blocks on its /health handshake
    // (WebBridge.cpp's execute_command native binding is not threaded, unlike brain_chat —
    // it resolves the completion inline on the message thread). Firing it from init()
    // would freeze the UI on EVERY launch (~1.3-2s on a healthy Mac, worse under
    // MOSH_ENABLE_SA3=1), invisible to the mock backend used by vitest/e2e since it
    // resolves instantly. loadCapabilities() is instead triggered lazily, at the same
    // first-user-interaction points loadColors/loadTransformTargets already use (see
    // ClipView.tsx's clip-menu mount and Dock.tsx's GenDrawer mount) — matching the
    // existing, accepted cost of opening the generative drawer for the first time.
    // Start the live level meters: insert a post-fader LevelMeterPlugin on every track
    // so the backend begins emitting the 30 Hz `levels` telemetry the meters draw. Once
    // at init only — the command runs a Tracktion transaction, so re-issuing it on every
    // structural change would clutter undo. (Mock returns ok; see bridge.mock.)
    void get().exec("enable_all_meters");
  },

  refreshRemote: async () => {
    if (!isNative()) return;
    const res = await getRemoteStatus();
    if (res.ok && res.data) set({ remoteStatus: res.data });
  },

  startRemotePairing: async () => {
    const res = await startRemotePairing();
    if (res.ok && res.data) set({ remoteStatus: res.data });
    else set({ lastError: res.error ?? "remote pairing failed" });
  },

  stopRemote: async () => {
    const res = await stopRemoteCompanion();
    if (!res.ok) set({ lastError: res.error ?? "remote stop failed" });
    await get().refreshRemote();
  },

  setPxPerSec: (v) => set({ pxPerSec: Math.max(20, Math.min(400, v)) }),
  // 12px/beat ≈ a whole 8-bar loop in view; 160 puts 1/32 notes ~5px apart.
  setPianoRollBeatPx: (v) => set({ pianoRollBeatPx: Math.max(12, Math.min(160, v)) }),
  setTool: (t) => set({ tool: t }),
  setSnap: (b) => set({ snap: b }),
  setSnapTriplet: (b) => set({ snapTriplet: b }),
  setSnapDivision: (d) => set({ snapDivision: d, snapAuto: false }),
  setSnapAuto: (b) => set({ snapAuto: b }),
  setRipple: (b) => set({ ripple: b }),
  select: (ids, additive = false) => {
    set((s) => {
      const next = new Set(additive ? s.selection : []);
      for (const id of ids) next.add(id);
      return { selection: next };
    });
    void get().syncActiveTrack();
  },
  clearSelection: () => { set({ selection: new Set<string>() }); void get().syncActiveTrack(); },
  setTimeRange: (r) => set({ timeRange: r }),
  // CAP-CLP-002 — "auto" is a POLICY for choosing a division, not a division, so it lives
  // as a flag beside snapDivision rather than inside the SnapDiv union (which every
  // consumer converts to seconds and would need its own fallback for). Everything
  // downstream keeps receiving a real division.
  effectiveSnapDivision: () => {
    const { snapAuto, snapDivision, snapshot, pxPerSec } = get();
    return snapAuto ? adaptiveDivision(meterFrom(snapshot?.session), pxPerSec) : snapDivision;
  },
  snapTime: (t) => {
    const { snap, snapshot } = get();
    if (!snap) return t;
    const snapDivision = get().effectiveSnapDivision();
    // SES-001 — snap over the piecewise tempo map (the grid restarts at every
    // tempo/meter change; constant-tempo sessions behave exactly as before).
    // snapTriplet (⌘3, ableton preset) shortens every step to 2/3 — see time.ts.
    return snapTimeMap(tempoMapFrom(snapshot?.session), t, snapDivision, get().snapTriplet);
  },

  ensurePeaks: (clipId) => {
    // Key the cache on the clip's CURRENT source: an in-place repoint (applyRenderInPlace /
    // relink_clip) keeps the id but swaps sourceFile, so a plain "have peaks for this id?"
    // short-circuit would keep drawing the pre-render waveform forever. Re-fetch on mismatch.
    const clip = get().snapshot?.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
    const srcKey = clip?.sourceFile ?? "";
    if (get().peaks[clipId] && get().peaksSourceKey[clipId] === srcKey) return;
    void executeCommand<CommandResult<{ peaks: Peaks }>>({
      command: "get_clip_peaks",
      args: { clipId, buckets: 800 },
    }).then((res) => {
      if (res.ok && res.data)
        set((s) => ({
          peaks: { ...s.peaks, [clipId]: res.data!.peaks },
          peaksSourceKey: { ...s.peaksSourceKey, [clipId]: srcKey },
        }));
    });
  },

  // Capture EVERY selected clip, in timeline order, with the track each came from.
  copySelection: () => {
    const { snapshot, selection } = get();
    if (!snapshot) return;
    const clips: { clip: Clip; sourceTrackId: string }[] = [];
    for (const t of snapshot.tracks)
      for (const c of t.clips)
        if (selection.has(c.id)) clips.push({ clip: c, sourceTrackId: t.id });
    if (clips.length === 0) return;                 // nothing selected: keep the old clipboard
    clips.sort((a, b) => a.clip.start - b.clip.start);
    set({ clipboard: { clips, anchor: clips[0].clip.start } });
  },

  cutSelection: async () => {
    if (!get().snapshot) return;
    // Cut stays a faithful inverse of paste: capture exactly what will be removed, then
    // remove exactly that. Both halves are the whole selection now, so the invariant the
    // old single-clip comment protected ("must not delete more than it can restore")
    // still holds — it just holds at a bigger size.
    get().copySelection();
    const cb = get().clipboard;
    if (!cb || cb.clips.length === 0) return;
    await get().runAtomic("cut clips", async (exec) => {
      for (const { clip } of cb.clips) await exec("remove_clip", { clipId: clip.id });
    });
    get().clearSelection();
    await get().refresh();
  },

  pasteClipboard: async () => {
    const { clipboard, selectedTrackId, snapshot } = get();
    if (!clipboard || clipboard.clips.length === 0) return;
    const at = get().transport.position;
    const trackExists = (id: string) => !!snapshot?.tracks.some((t) => t.id === id);

    // ONE clip keeps the long-standing behaviour: it lands on the track you have
    // selected, which is how you move a clip to another track by copy/paste.
    if (clipboard.clips.length === 1) {
      const { clip, sourceTrackId } = clipboard.clips[0];
      await get().exec("paste_clip", {
        trackId: selectedTrackId ?? sourceTrackId,
        start: at,
        clip,
      });
      await get().refresh();
      return;
    }

    // MANY clips keep their own tracks and their relative spacing — re-homing a
    // multi-track selection onto one track would scramble an arrangement. A source
    // track that has since been deleted falls back to the selected track rather than
    // erroring the whole paste.
    await get().runAtomic("paste clips", async (exec) => {
      for (const { clip, sourceTrackId } of clipboard.clips) {
        const trackId = trackExists(sourceTrackId) ? sourceTrackId : (selectedTrackId ?? sourceTrackId);
        await exec("paste_clip", { trackId, start: at + (clip.start - clipboard.anchor), clip });
      }
    });
    await get().refresh();
  },

  // Run a multi-command edit as ONE undo step where possible.
  //
  // `batch_begin` (legacy mode — no transactionId) opens a single Tracktion transaction
  // and fails closed with "a batch is already open" if the agent is mid-batch. That
  // failure is not an error here: we simply run the commands unbatched, which is
  // correct but costs N undo steps. Never leave a batch open — `batch_end` runs even if
  // a command throws, or the next agent turn would inherit our transaction.
  runAtomic: async (label, body) => {
    const exec = get().exec;
    const opened = (await exec("batch_begin", { name: label }))?.ok === true;
    try {
      await body(exec);
    } finally {
      if (opened) await exec("batch_end", {});
    }
  },

  setSelectedTrack: (id) => { set({ selectedTrackId: id }); void get().syncActiveTrack(); },
  toggleTrackExpanded: (id) => set((s) => {
    const next = new Set(s.expandedTracks);
    if (next.has(id)) next.delete(id); else next.add(id);
    return { expandedTracks: next };
  }),

  editingClipId: null,
  openPianoRoll: (clipId) => set({ editingClipId: clipId }),
  closePianoRoll: () => set({ editingClipId: null }),
  feltWrongOpen: false,
  setFeltWrongOpen: (open) => set({ feltWrongOpen: open }),
  setLastError: (message) => set({ lastError: message }),
  automationTrackId: null,
  openAutomation: (trackId) => set({ automationTrackId: trackId }),
  closeAutomation: () => set({ automationTrackId: null }),
  openBrowser: () => { set({ browserOpen: true }); get().ensurePluginCatalog(); },
  closeBrowser: () => set({ browserOpen: false }),

  view: "arrange",
  setView: (v) => set({ view: v }),

  // theme / uiScale / voiceOn / voiceVol are now schema-driven settings (see
  // settings/store). These fields MIRROR the settings store (synced in init via a
  // subscription) so the many existing consumers keep their useStore subscriptions;
  // the mutators write THROUGH useSettings, which persists + applies the DOM effect.
  theme: useSettings.getState().get("theme") as "dark" | "light",
  toggleTheme: () => {
    const next = get().theme === "dark" ? "light" : "dark";
    useSettings.getState().set("theme", next); // persists + applies data-theme
    set({ theme: next });
  },

  celebrateTick: 0,
  voiceOn: useSettings.getState().get("voiceOn") as boolean,
  voiceVol: useSettings.getState().get("voiceVol") as number,
  bumpCelebrate: () => set((s) => ({ celebrateTick: s.celebrateTick + 1 })),
  toggleVoice: () => {
    const next = !get().voiceOn;
    useSettings.getState().set("voiceOn", next); // persists through the settings store
    set({ voiceOn: next });
  },
  agentBusy: false,
  agentChangeSet: null,
  agentUtter: null,
  setAgentBusy: (b) => set({ agentBusy: b }),
  setAgentChangeSet: (cs) => set({ agentChangeSet: cs }),
  pushAgentUtter: (intent, say) =>
    set((s) => ({ agentUtter: { intent, say, tick: (s.agentUtter?.tick ?? 0) + 1 } })),

  memoryToast: null,
  setMemoryToast: (t) => set({ memoryToast: t }),

  takeDecisionPending: false,
  lastTakeClipId: null,
  takeReview: null,
  currentMode: () => {
    const s = get();
    if (s.transport.recording) return "recording";
    if (s.takeDecisionPending) return "reviewing";
    return "idle";
  },
  enterRecord: async (bar) => {
    const projectEpoch = get().projectEpoch;
    const outcome = await enqueueTransportAction(() => startRecording(get, set, projectEpoch, bar));
    return outcome ?? { kind: "blocked", reason: "cancelled" };
  },
  toggleRecord: () => {
    const projectEpoch = get().projectEpoch;
    return enqueueTransportAction(async () => {
      if (get().projectEpoch !== projectEpoch) return;
      if (get().projectTransitioning) {
        set({ lastError: "Wait for the project to finish opening before recording." });
        return;
      }
      if (get().currentMode() === "recording") {
        const result = await get().exec("set_transport", { action: "record" });
        const transport = result.data as { playing?: boolean; recording?: boolean } | undefined;
        if (result.ok && result.command === "set_transport" && typeof transport?.recording === "boolean") {
          set({
            transport: {
              ...get().transport,
              recording: transport.recording,
              ...(typeof transport.playing === "boolean" ? { playing: transport.playing } : {}),
            },
          });
        }
        return;
      }
      await startRecording(get, set, projectEpoch);
    });
  },
  stopRecord: async () => {
    const projectEpoch = get().projectEpoch;
    const outcome = await enqueueTransportAction(() => stopRecording(get, set, projectEpoch));
    return outcome ?? { kind: "blocked", reason: "cancelled" };
  },
  keepTake: async (takeId) => {
    const s = get();
    if (!s.lastTakeClipId) {
      s.pushAgentUtter("HUH", "nothing to keep");
      return { kind: "blocked", reason: "nothing to keep" };
    }
    const res = await s.exec(
      "keep_take",
      takeId ? { clipId: s.lastTakeClipId, takeId } : { clipId: s.lastTakeClipId },
    );
    if (!res.ok) {
      s.pushAgentUtter("UHOH", "can't keep that yet");
      return { kind: "blocked", reason: res.error ?? "can't keep that yet" };
    }
    set({ takeDecisionPending: false, lastTakeClipId: null, takeReview: null });
    await s.refresh();
    return { kind: "kept", review: null };
  },
  navTake: async (delta) => {
    const s = get();
    const clipId = s.lastTakeClipId;
    if (!clipId) {
      s.pushAgentUtter("HUH", "no takes");
      return { kind: "blocked", reason: "no takes" };
    }
    const clip = s.snapshot?.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId) as
      (Clip & { currentTakeIndex?: number; numTakes?: number }) | undefined;
    const next = Math.max(0, Math.min((clip?.numTakes ?? 1) - 1, (clip?.currentTakeIndex ?? 0) + delta));
    const res = await s.exec("set_current_take", { clipId, takeIndex: next });
    if (!res.ok) {
      s.pushAgentUtter("UHOH", "no other takes yet");
      return { kind: "blocked", reason: "no other takes yet" };
    }
    await s.exec("set_transport", { action: "to_start" });
    await s.refresh();
    const review = observeRecordingLane(get().snapshot!, clipId);
    set({ takeReview: review });
    if (!review) return { kind: "landed_unverified", reason: "the take's stable id could not be verified" };
    return { kind: "reviewing", review };
  },

  uiScale: useSettings.getState().get("uiScale") as number,
}));

// Browser-test only: expose the store so Playwright can drive state the in-memory mock
// cannot reproduce. Production uses neither development nor the isolated e2e mode.
if (
  (import.meta.env.MODE === "development" ||
    import.meta.env.MODE === "e2e" ||
    import.meta.env.MODE === "test") &&
  typeof window !== "undefined"
) {
  (window as unknown as { __moshStore?: typeof useStore }).__moshStore = useStore;
}
