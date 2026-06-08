/**
 * store.ts — the dumb client store (02 §4, 03 §3).
 *
 * It mirrors backend state: holds the last snapshot and applies typed events.
 * It owns NO domain logic — every mutation goes through executeCommand. View
 * state (selection, zoom, scroll, drawers) would also live here in later
 * stages, but Stage 0 only needs the backend mirror + connection status.
 */

import { create } from "zustand";
import {
  backendKind,
  getSnapshot,
  subscribe,
  type BackendKind,
  type MoshEvent,
  type Snapshot,
} from "./bridge";

interface MoshStore {
  backend: BackendKind;
  snapshot: Snapshot | null;
  loading: boolean;
  error: string | null;
  /** Pull a fresh snapshot from the backend (load / resync). */
  refresh: () => Promise<void>;
  /** Apply one typed event to the mirrored snapshot. */
  applyEvent: (event: MoshEvent) => void;
}

export const useStore = create<MoshStore>((set, get) => ({
  backend: backendKind,
  snapshot: null,
  loading: true,
  error: null,

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
    // Stage 0: only structural events that affect the placeholder readout are
    // handled; a resync hint just refetches. Stage 2 fleshes this out fully.
    switch (event.type) {
      case "snapshot_invalidated": {
        void get().refresh();
        return;
      }
      case "track_added": {
        const snap = get().snapshot;
        if (!snap) return;
        set({
          snapshot: { ...snap, tracks: [...snap.tracks, event.track] },
        });
        return;
      }
      case "track_removed": {
        const snap = get().snapshot;
        if (!snap) return;
        set({
          snapshot: {
            ...snap,
            tracks: snap.tracks.filter((t) => t.id !== event.id),
          },
        });
        return;
      }
      case "transport_position": {
        const snap = get().snapshot;
        if (!snap) return;
        set({
          snapshot: {
            ...snap,
            transport: { ...snap.transport, position: event.pos },
          },
        });
        return;
      }
      default:
        // Other event kinds are wired in Stage 2 when the arrange view exists.
        return;
    }
  },
}));

/** Start the snapshot+events feed. Call once on app mount. */
export function connectFeed(): () => void {
  const { refresh, applyEvent } = useStore.getState();
  void refresh();
  return subscribe(applyEvent);
}
