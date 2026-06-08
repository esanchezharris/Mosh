/**
 * store.ts — the dumb client store (02 §4, 03 §3).
 *
 * Two clearly separated halves:
 *
 *  1. BACKEND MIRROR — the last `getSnapshot()` plus typed events applied
 *     incrementally. This half owns NO domain logic: every mutation the user
 *     makes goes out through `executeCommand` (in components), and the only way
 *     this mirror changes is by applying an event the backend emitted.
 *
 *  2. VIEW STATE — selection, zoom (pixels-per-second), horizontal scroll, and
 *     the decimated live meter readouts. This is UI-LOCAL: it NEVER becomes a
 *     command. It lives here purely so components can share it.
 *
 * Keeping these apart is the swappability discipline: the mirror is the backend
 * contract; the view state is ours to throw away with the React layer.
 */

import { create } from "zustand";
import {
  backendKind,
  getSnapshot,
  subscribe,
  type BackendKind,
  type ClipState,
  type MoshEvent,
  type Snapshot,
  type TrackState,
} from "./bridge";

/** Live, decimated meter readout for one track (view-only; from meter_update). */
export interface MeterLevel {
  rms: number;
  peak: number;
}

interface MoshStore {
  // --- backend mirror ----------------------------------------------------
  backend: BackendKind;
  snapshot: Snapshot | null;
  loading: boolean;
  error: string | null;
  /** Pull a fresh snapshot from the backend (load / resync). */
  refresh: () => Promise<void>;
  /** Apply one typed event to the mirrored snapshot. */
  applyEvent: (event: MoshEvent) => void;

  // --- UI-local view state (NEVER a command) -----------------------------
  /** pixels per second — horizontal zoom of the timeline. */
  pxPerSec: number;
  /** horizontal scroll offset of the timeline, in seconds. */
  scrollSec: number;
  /** currently selected clip id, or null. */
  selectedClip: string | null;
  /** currently selected track id, or null. */
  selectedTrack: string | null;
  /** per-track live meter levels, keyed by track id (decimated events). */
  meters: Record<string, MeterLevel>;

  setZoom: (pxPerSec: number) => void;
  setScroll: (scrollSec: number) => void;
  selectClip: (id: string | null) => void;
  selectTrack: (id: string | null) => void;
}

// Apply a partial-fields update to a track in an immutable tracks array.
function patchTrack(
  tracks: TrackState[],
  id: string,
  fields: Partial<TrackState>
): TrackState[] {
  return tracks.map((t) => (t.id === id ? { ...t, ...fields } : t));
}

// Replace one track's clips array immutably.
function withClips(
  tracks: TrackState[],
  trackId: string,
  fn: (clips: ClipState[]) => ClipState[]
): TrackState[] {
  return tracks.map((t) =>
    t.id === trackId ? { ...t, clips: fn(t.clips) } : t
  );
}

// Find which track owns a clip id (events sometimes give only the clip id).
function trackOfClip(tracks: TrackState[], clipId: string): string | null {
  for (const t of tracks) {
    if (t.clips.some((c) => c.id === clipId)) return t.id;
  }
  return null;
}

export const useStore = create<MoshStore>((set, get) => ({
  backend: backendKind,
  snapshot: null,
  loading: true,
  error: null,

  pxPerSec: 80,
  scrollSec: 0,
  selectedClip: null,
  selectedTrack: null,
  meters: {},

  async refresh() {
    set({ loading: true, error: null });
    try {
      const snap = await getSnapshot();
      set({ snapshot: snap, loading: false });
    } catch (e) {
      set({
        loading: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },

  applyEvent(event) {
    const snap = get().snapshot;

    switch (event.type) {
      case "snapshot_invalidated": {
        void get().refresh();
        return;
      }

      // --- tracks ----------------------------------------------------------
      case "track_added": {
        if (!snap) return;
        // Idempotent: ignore if we already mirror this track.
        if (snap.tracks.some((t) => t.id === event.track.id)) return;
        set({ snapshot: { ...snap, tracks: [...snap.tracks, event.track] } });
        return;
      }
      case "track_removed": {
        if (!snap) return;
        set({
          snapshot: {
            ...snap,
            tracks: snap.tracks.filter((t) => t.id !== event.id),
          },
          selectedTrack:
            get().selectedTrack === event.id ? null : get().selectedTrack,
        });
        return;
      }
      case "track_changed": {
        if (!snap) return;
        set({
          snapshot: {
            ...snap,
            tracks: patchTrack(snap.tracks, event.id, event.fields),
          },
        });
        return;
      }

      // --- clips -----------------------------------------------------------
      case "clip_added": {
        if (!snap) return;
        set({
          snapshot: {
            ...snap,
            tracks: withClips(snap.tracks, event.trackId, (clips) =>
              clips.some((c) => c.id === event.clip.id)
                ? clips
                : [...clips, event.clip]
            ),
          },
        });
        return;
      }
      case "clip_moved": {
        if (!snap) return;
        const trackId = trackOfClip(snap.tracks, event.id);
        if (!trackId) return;
        set({
          snapshot: {
            ...snap,
            tracks: withClips(snap.tracks, trackId, (clips) =>
              clips.map((c) =>
                c.id === event.id ? { ...c, range: event.range } : c
              )
            ),
          },
        });
        return;
      }
      case "clip_split": {
        if (!snap) return;
        // Replace the original clip (first of clips shares its id) with the
        // returned pieces, preserving order within the lane. Written to be
        // IDEMPOTENT: applying the same clip_split twice yields the same lane,
        // so a duplicate delivery can't produce duplicate clips.
        set({
          snapshot: {
            ...snap,
            tracks: withClips(snap.tracks, event.trackId, (clips) => {
              const pieceIds = new Set(event.clips.map((c) => c.id));
              // Drop any existing copies of the pieces (incl. the reused
              // original id) wherever they sit, remembering the insert point.
              let insertAt = clips.findIndex((c) => pieceIds.has(c.id));
              if (insertAt === -1) insertAt = clips.length;
              const remaining = clips.filter((c) => !pieceIds.has(c.id));
              const head = remaining.slice(0, insertAt);
              const tail = remaining.slice(insertAt);
              return [...head, ...event.clips, ...tail];
            }),
          },
        });
        return;
      }
      case "clip_removed": {
        if (!snap) return;
        const trackId = trackOfClip(snap.tracks, event.id);
        if (!trackId) return;
        set({
          snapshot: {
            ...snap,
            tracks: withClips(snap.tracks, trackId, (clips) =>
              clips.filter((c) => c.id !== event.id)
            ),
          },
          selectedClip:
            get().selectedClip === event.id ? null : get().selectedClip,
        });
        return;
      }

      // --- plugins ---------------------------------------------------------
      case "plugin_added": {
        if (!snap) return;
        set({
          snapshot: {
            ...snap,
            tracks: snap.tracks.map((t) =>
              t.id === event.trackId
                ? t.plugins.some((p) => p.id === event.plugin.id)
                  ? t
                  : { ...t, plugins: [...t.plugins, event.plugin] }
                : t
            ),
          },
        });
        return;
      }
      case "plugin_bypassed": {
        if (!snap) return;
        set({
          snapshot: {
            ...snap,
            tracks: snap.tracks.map((t) => ({
              ...t,
              plugins: t.plugins.map((p) =>
                p.id === event.pluginId
                  ? { ...p, bypassed: event.bypassed }
                  : p
              ),
            })),
          },
        });
        return;
      }
      case "plugin_param_changed": {
        // Param values are not part of the snapshot schema (faceplate-local);
        // nothing to mirror. Components that show params subscribe separately.
        return;
      }

      // --- render layers ---------------------------------------------------
      case "layer_status": {
        if (!snap) return;
        set({
          snapshot: {
            ...snap,
            tracks: snap.tracks.map((t) => ({
              ...t,
              renderLayers: t.renderLayers.map((l) =>
                l.id === event.id ? { ...l, status: event.status } : l
              ),
            })),
          },
        });
        return;
      }
      case "layer_render_progress":
      case "layer_rendered": {
        // Progress/eta and take ids are transient/auxiliary; the Timeline reads
        // them off a small view-side map kept by the badge component. The
        // durable status lives in the snapshot via layer_status above.
        return;
      }

      // --- decimated telemetry (view-only) ---------------------------------
      case "transport_position": {
        if (!snap) return;
        set({
          snapshot: {
            ...snap,
            transport: { ...snap.transport, position: event.pos },
          },
        });
        return;
      }
      case "meter_update": {
        // Meters are pure view state — keep them OUT of the snapshot mirror so
        // 60 Hz updates don't churn the backend-state object.
        const meters = get().meters;
        set({
          meters: {
            ...meters,
            [event.trackId]: { rms: event.rms, peak: event.peak },
          },
        });
        return;
      }

      default: {
        // Exhaustiveness guard: if a new event type is added to the union and
        // not handled, TypeScript flags `event` as `never` here.
        const _exhaustive: never = event;
        void _exhaustive;
        return;
      }
    }
  },

  // --- view-state setters (UI-local; never commands) ---------------------
  setZoom(pxPerSec) {
    set({ pxPerSec: Math.max(16, Math.min(400, pxPerSec)) });
  },
  setScroll(scrollSec) {
    set({ scrollSec: Math.max(0, scrollSec) });
  },
  selectClip(id) {
    set({ selectedClip: id });
  },
  selectTrack(id) {
    set({ selectedTrack: id });
  },
}));

/** Start the snapshot+events feed. Call once on app mount. */
export function connectFeed(): () => void {
  const { refresh, applyEvent } = useStore.getState();
  void refresh();
  return subscribe(applyEvent);
}
