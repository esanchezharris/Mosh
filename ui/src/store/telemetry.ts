// Telemetry slice — the 30 Hz rails (transport / levels / spectrum) that
// deliberately live OUTSIDE the snapshot (CLAUDE.md Stage 2 correction): a moving
// playhead or meter tick must never re-create the snapshot object, so the whole
// tree doesn't re-render 30×/s. Fed by the per-rail handlers in store/events.ts
// (onTransport / onLevels / onSpectrum); refresh() seeds `transport` from the
// snapshot for the structural fields (recording / loop region). Pure state — the
// rails have no actions of their own.
import type { StateCreator } from "zustand";
import type { Transport, Level } from "../types";
// Type-only imports from the store module (erased at compile time — no runtime cycle).
import type { State, Spectrum } from "../store";

export type TelemetrySlice = {
  // Live level meters (Wave 9) — fed by the 30Hz "levels" event, NOT the snapshot.
  levels: { tracks: Record<string, Level>; master: Level };

  // CAP-AUT-006 — the mute button's live automation state, fed by the 30Hz
  // "mute_automation" event. Keyed by trackId; PRESENCE means "this track's mute is
  // automated", the value means "the curve has it closed at the playhead right now".
  // Same rail discipline as `levels`: a mute edge crossing the playhead must not
  // re-create the snapshot object. Read it through ui/muteState.ts, never inline.
  muteAutomation: Record<string, boolean>;

  // Live spectral feed (Moshi reactivity) — fed by the 30Hz "spectrum" event (master
  // Goertzel). bands = per-band energy 0..1 (low→high); level/flux 0..1. Pure telemetry
  // like `levels`; never a command, no audio concepts leak across the seam (just numbers).
  spectrum: Spectrum;

  // Live transport — fed by the 30Hz "transport" event (NOT folded into the
  // snapshot, so a moving playhead never re-creates the snapshot object and the
  // whole tree no longer re-renders 30×/s). Seeded from the snapshot on refresh
  // for the structural fields (recording / loop region).
  transport: Transport;
  reconcileTransport: (transport: Partial<Transport>) => void;
};

export const createTelemetrySlice: StateCreator<State, [], [], TelemetrySlice> = (set) => ({
  levels: { tracks: {}, master: { l: -100, r: -100 } },
  muteAutomation: {},
  spectrum: { bands: [], level: 0, flux: 0 },
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
  reconcileTransport: (transport) => set((state) => ({
    transport: { ...state.transport, ...transport },
  })),
});
