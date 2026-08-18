// Event-rail handlers for the store's single "mosh_event" subscription (see
// store.ts init(), which stays the dispatcher: order + conditions live THERE and
// are load-bearing). Each handler is the verbatim body of one former init()
// branch, taking the event plus only the zustand set/get it actually uses.
// transport / levels / spectrum deliberately bypass the snapshot — they are the
// 30 Hz telemetry rails and must never re-create the snapshot object.
import type { StoreApi } from "zustand";
import {
  sendLevelKey,
  type MoshEvent,
  type Transport,
  type Level,
  type RenderQA,
  type SendLevel,
} from "../types";
import { isTrackPatch, applyTrackPatch } from "../snapshotPatch";
// Collaborator video (redesign). The store routes inbound WebRTC signaling + presence
// changes into the video room; the room couples back to the seam only via mp_send_signal.
import { useVideo } from "../webrtc/useVideo";
import type { SignalMessage } from "../webrtc/signal";
import { useSettings } from "../settings/store";
// Which shell is active — the v2 shell also surfaces collaborator video, so the
// webrtc_signal gate must honor it (not just the legacy redesignShell flag).
import { isV2Active } from "../v2/shellFlag";
import { pruneOfflineLocks, type PeerInfo, type PeerPresence } from "../multiplayer/sync";
// Type-only imports from the store module (erased at compile time — no runtime cycle).
import type { State, Spectrum } from "../store";

type Set = StoreApi<State>["setState"];
type Get = StoreApi<State>["getState"];

export function onSnapshotInvalidated(ev: MoshEvent, set: Set, get: Get): void {
  // Scoped patch: splice one changed track in place, skipping the full O(project) re-pull.
  if (isTrackPatch(ev.payload)) {
    const snap = get().snapshot;
    const patched = snap ? applyTrackPatch(snap, ev.payload) : null;
    if (patched) { set({ snapshot: patched }); return; }
  }
  void get().refresh();   // full invalidation (or a scoped target not in the snapshot → resync)
}

export function onTransport(ev: MoshEvent, set: Set): void {
  // Targeted set — does NOT touch the snapshot (so the tree doesn't churn).
  set({ transport: ev.payload as Transport });
}

export function onLevels(ev: MoshEvent, set: Set): void {
  // Targeted set (no snapshot refetch) — same lightweight path as transport.
  const p = ev.payload as {
    tracks?: { id: string; l: number; r: number }[];
    master?: Level;
    sends?: SendLevel[];
  };
  const tracks: Record<string, Level> = {};
  for (const t of p.tracks ?? []) tracks[t.id] = { l: t.l, r: t.r };
  const sendLevels: Record<string, Level> = {};
  for (const send of p.sends ?? []) {
    sendLevels[sendLevelKey(send.trackId, send.bus)] = { l: send.l, r: send.r };
  }
  set({ levels: { tracks, master: p.master ?? { l: -100, r: -100 } }, sendLevels });
}

export function onMuteAutomation(ev: MoshEvent, set: Set): void {
  // CAP-AUT-006 — the mute button's follow-the-curve rail. Targeted set, no snapshot
  // refetch (same lightweight path as transport/levels). The backend sends the FULL set
  // of automated tracks every tick and one final empty payload on the falling edge, so
  // rebuilding the map wholesale is what clears a deleted curve — merging would leave
  // the last track that had one stuck lit forever.
  const p = ev.payload as { tracks?: { id: string; muted: boolean }[] };
  const muteAutomation: Record<string, boolean> = {};
  for (const t of p.tracks ?? []) muteAutomation[t.id] = !!t.muted;
  set({ muteAutomation });
}

export function onSpectrum(ev: MoshEvent, set: Set): void {
  // Master Goertzel feed (Moshi reactivity) — targeted set, no snapshot refetch.
  const p = ev.payload as Partial<Spectrum>;
  set({ spectrum: { bands: p.bands ?? [], level: p.level ?? 0, flux: p.flux ?? 0 } });
}

export function onPluginScanProgress(ev: MoshEvent, set: Set, get: Get): void {
  // INS-005 — async (AU) rescan lifecycle. On done, refresh the catalog list.
  // FIT-003 — the backend now emits periodic samples with a live running `count`
  // + `elapsedMs` (decimated ~2/s) for the whole sweep, not just start/done; both
  // fields are optional so this stays compatible with any older {format,done}-only
  // sender (e.g. a stale mock).
  const p = ev.payload as {
    format: string;
    done: boolean;
    count?: number;
    elapsedMs?: number;
    quarantined?: string[];
  };
  if (p.done) {
    const quarantined = p.quarantined ?? [];
    const quarantineError = quarantined.length > 0
      ? `${p.format.toUpperCase()} scan quarantined ${quarantined.join(", ")} because ${quarantined.length === 1 ? "it" : "they"} stopped responding.`
      : undefined;
    set({ scanProgress: null, ...(quarantineError ? { lastError: quarantineError } : {}) });
    void get().refreshPluginList();
    void get().refreshPluginBlocklist();
  } else {
    set({ scanProgress: { format: p.format, done: false, count: p.count, elapsedMs: p.elapsedMs } });
  }
}

export function onTranscribeStatus(ev: MoshEvent, set: Set): void {
  // Audio→MIDI status for a SOURCE clip: working | done | error. On done the
  // backend's snapshot_invalidated (from add_midi_clip) reveals the new track.
  const p = ev.payload as { clipId: string; state: string; error?: string };
  set((s) => {
    const next = { ...s.transcribing };
    if (p.state === "working") next[p.clipId] = true;
    else delete next[p.clipId];
    return { transcribing: next };
  });
  if (p.state === "error") set({ lastError: p.error ?? "transcription failed" });
}

export function onBuildLyricsStatus(ev: MoshEvent, set: Set): void {
  // Mumble-take status for a SOURCE clip: working | done | error. On done the
  // backend's snapshot_invalidated reveals the new lyric sheet (Inspector → Lyrics).
  const p = ev.payload as { clipId: string; state: string; error?: string };
  set((s) => {
    const next = { ...s.buildingLyrics };
    if (p.state === "working") next[p.clipId] = true;
    else delete next[p.clipId];
    return { buildingLyrics: next };
  });
  if (p.state === "error") set({ lastError: p.error ?? "could not build lyrics from the take" });
}

export function onSkeletonStatus(ev: MoshEvent, set: Set): void {
  // Mumble→skeleton status for a SOURCE clip: working | done | error. Mirrors
  // build_lyrics_status above — was previously unhandled, so "Build flow from this
  // take" showed no spinner and swallowed its error silently (guest-degradation
  // pass: a venv-less guest Mac hits this constantly). On done the backend's
  // snapshot_invalidated reveals the new lyric sheet (Inspector → Lyrics).
  const p = ev.payload as { clipId: string; state: string; error?: string };
  set((s) => {
    const next = { ...s.buildingSkeleton };
    if (p.state === "working") next[p.clipId] = true;
    else delete next[p.clipId];
    return { buildingSkeleton: next };
  });
  if (p.state === "error") set({ lastError: p.error ?? "could not build a flow from the take" });
}

export function onSketchStatus(ev: MoshEvent, set: Set): void {
  // Sketch Phase 0 (beatbox → drum) status for a SOURCE FILE PATH: working | done |
  // error. Keyed by file, not clipId — sketch_beatbox lands a brand-new track+clip,
  // so there is no existing clip to key against (mirrors transcribe_status/
  // skeleton_status otherwise). The command is install-gated and does NOT degrade
  // gracefully (service/server.py's /sketch returns a 503 "sketch_unavailable (run
  // service/sketch/setup-sketch.sh)" when the venv is absent) — surface that exact,
  // honest message rather than swallowing it or leaving the UI hung. On done the
  // backend's snapshot_invalidated (from add_midi_clip) reveals the new drum track.
  const p = ev.payload as { file: string; state: string; error?: string };
  set((s) => {
    const next = { ...s.sketchingBeatbox };
    if (p.state === "working") next[p.file] = true;
    else delete next[p.file];
    return { sketchingBeatbox: next };
  });
  if (p.state === "error") set({ lastError: p.error ?? "could not sketch a beat from that take" });
}

export function onLayerRenderProgress(ev: MoshEvent, set: Set): void {
  const p = ev.payload as { clipId: string; progress: number };
  set((s) => ({ renderProgress: { ...s.renderProgress, [p.clipId]: p.progress } }));
}

export function onLayerStatus(ev: MoshEvent, set: Set, get: Get): void {
  const p = ev.payload as { clipId?: string; qa?: RenderQA; status?: string };
  if (p?.clipId) {
    // A render resolves here (ready / error / cache-hit — anything but the "rendering"
    // submit tick). Clear its progress entry (the leak: it was only ever spread-added)
    // and land the quality readout.
    const terminal = p.status !== "rendering";
    set((s) => {
      const patch: Partial<State> = {};
      if (p.qa) patch.qaByClip = { ...s.qaByClip, [p.clipId!]: p.qa as RenderQA };
      if (terminal && p.clipId! in s.renderProgress) {
        const renderProgress = { ...s.renderProgress };
        delete renderProgress[p.clipId!];
        patch.renderProgress = renderProgress;
      }
      return patch;
    });
  }
  void get().refresh();
}

export function onMpState(ev: MoshEvent, set: Set, get: Get): void {
  // MP-001 — session + roster + lock table (the native poll loop pushes the
  // relay's {peers, locks} here). Targeted set, no snapshot refetch.
  const p = ev.payload as {
    active: boolean; roomCode?: string | null; selfPeer?: string | null;
    peers?: Record<string, Partial<PeerInfo>>; locks?: Record<string, string>;
  };
  const peers: Record<string, PeerInfo> = {};
  for (const [id, v] of Object.entries(p.peers ?? {}))
    peers[id] = { name: v.name ?? id, color: v.color ?? "#888888", online: v.online ?? true };
  set((s) => {
    const peerPresence: Record<string, PeerPresence> = {};
    if (p.active) {
      for (const [peerId, presence] of Object.entries(s.peerPresence))
        if (peers[peerId]?.online) peerPresence[peerId] = presence;
    }
    return {
      mp: { active: p.active, roomCode: p.roomCode ?? null, selfPeer: p.selfPeer ?? null, connected: p.active },
      peers,
      peerPresence,
      // Drop a lock whose owner has dropped/gone offline so no stale read-only
      // badge survives the owner (defense-in-depth with the relay's lease GC).
      locksByLogicalId: pruneOfflineLocks(p.locks ?? {}, peers, p.selfPeer ?? null),
    };
  });
  // Keep the video room's peer set in lockstep with presence (open links to new
  // collaborators, drop departed ones); tear it down entirely when the session ends.
  if (p.active) useVideo.getState().syncPeers(Object.keys(peers));
  else useVideo.getState().teardown();
  // MP-003 — piggyback the idle-checkpoint check on this already-~4/s-while-active
  // event rather than a dedicated timer (see mpIdleCheckpointTick's own doc
  // comment). A no-op on almost every tick (the clock hasn't elapsed yet).
  if (p.active) void get().mpIdleCheckpointTick();
}

export function onWebrtcSignal(ev: MoshEvent): void {
  // Inbound SDP/ICE from a peer (relayed point-to-point) → the video room. Video is
  // surfaced by the redesign AND the v2 shells; a shell with no video UI must NOT
  // silently negotiate / hold a peer connection (prime directive: flag-off == unchanged).
  if (Boolean(useSettings.getState().get("redesignShell")) || isV2Active()) {
    const p = ev.payload as { from?: string; payload?: SignalMessage };
    if (p?.from && p.payload) useVideo.getState().onSignal(p.from, p.payload);
  }
}

export function onPeerSelection(ev: MoshEvent, set: Set): void {
  // The other peer's current track/clip selection (the highlight we draw).
  const p = ev.payload as { peerId: string; trackId?: string | null; clipId?: string | null };
  set((s) => ({
    peerSelection: { ...s.peerSelection, [p.peerId]: { trackId: p.trackId ?? null, clipId: p.clipId ?? null } },
  }));
}

export function onPeerPresence(ev: MoshEvent, set: Set): void {
  const p = ev.payload as { peerId?: string; position?: number; playing?: boolean; recording?: boolean };
  const peerId = p.peerId;
  if (!peerId) return;
  set((s) => {
    if (peerId === s.mp.selfPeer) return {};
    return {
      peerPresence: {
        ...s.peerPresence,
        [peerId]: {
          position: Number(p.position ?? 0),
          playing: Boolean(p.playing),
          recording: Boolean(p.recording),
          updatedAtMs: Date.now(),
        },
      },
    };
  });
}

export function onMpCommitDone(ev: MoshEvent, set: Set): void {
  // PR-2 adversarial-review BLOCKER: previously had NO frontend consumer at all
  // (dropped silently by the lack of an else-if branch here) — a failed stem
  // upload (commit-on-move via syncActiveTrack, or a manual commit) left a
  // track's audio sourceMissing for the peer with no visible signal to the
  // producer that anything went wrong. Surface it: clear the "uploading"
  // marker either way; on failure, keep a "failed — retry" entry (cleared by a
  // later successful commit of the same logicalId, in syncActiveTrack/
  // retryFailedCommit) AND raise the shared lastError toast + a console
  // warning (belt-and-suspenders — the error bar can be dismissed/missed).
  const p = ev.payload as { logicalId?: string; ok?: boolean; error?: string };
  const lid = p.logicalId;
  if (!lid) return;
  if (p.ok) {
    set((s) => {
      const pendingCommits = { ...s.pendingCommits };
      const failedCommits = { ...s.failedCommits };
      delete pendingCommits[lid];
      delete failedCommits[lid];
      return { pendingCommits, failedCommits };
    });
  } else {
    const message = p.error || "stem upload failed — the peer may not receive this track's audio";
    console.warn("[mp] mp_commit_done: commit failed for", lid, "-", message);
    set((s) => {
      const pendingCommits = { ...s.pendingCommits };
      delete pendingCommits[lid];
      return {
        pendingCommits,
        failedCommits: { ...s.failedCommits, [lid]: message },
        lastError: message,
      };
    });
  }
}
