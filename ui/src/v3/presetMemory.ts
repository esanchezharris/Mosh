import { create } from "zustand";
import { useStore } from "../store";
import type { Snapshot } from "../types";

// A24 (demo readiness) — which preset was last loaded onto each instrument, so the V3 Presets pane
// can name the sound that is on (the picker is a one-shot <select> that snaps back to "Presets…").
// View-state only: set after a load_preset the engine accepted, never read back from the engine.
// Keyed per instrument (track id + plugin index).
//
// A name is shown only while it can still be vouched for, so the memory forgets:
//   · everything on a project change (projectEpoch) — track ids repeat across fresh Edits, so a
//     kept name could land on a different instrument that never loaded it;
//   · everything on an undo / redo / History jump (historyEpoch) — the move may have reverted
//     the load, and the snapshot does not say which preset is on. Clearing all is the simple
//     correct answer; the next pick names the sound again;
//   · an entry whose track or plugin index is gone from the snapshot.

export const presetKey = (trackId: string, pluginIndex: number) => `${trackId}:${pluginIndex}`;

interface PresetMemory {
  byKey: Record<string, string>;
  remember: (trackId: string, pluginIndex: number, name: string) => void;
  forgetAll: () => void;
}

export const usePresetMemory = create<PresetMemory>((set) => ({
  byKey: {},
  remember: (trackId, pluginIndex, name) =>
    set((s) => ({ byKey: { ...s.byKey, [presetKey(trackId, pluginIndex)]: name } })),
  forgetAll: () => set((s) => (Object.keys(s.byKey).length ? { byKey: {} } : {})),
}));

/** The entries whose track and plugin index are still in the snapshot (the same object when
 *  nothing is dropped, so an ordinary refresh does not re-render the pane). */
export function prunePresetMemory(byKey: Record<string, string>, snapshot: Snapshot): Record<string, string> {
  const live = new Set(snapshot.tracks.flatMap((t) => (t.plugins ?? []).map((p) => presetKey(t.id, p.index))));
  const kept = Object.entries(byKey).filter(([key]) => live.has(key));
  return kept.length === Object.keys(byKey).length ? byKey : Object.fromEntries(kept);
}

useStore.subscribe((s, prev) => {
  const memory = usePresetMemory.getState();
  if (s.projectEpoch !== prev.projectEpoch || s.historyEpoch !== prev.historyEpoch) {
    memory.forgetAll();
    return;
  }
  if (s.snapshot && s.snapshot !== prev.snapshot) {
    const pruned = prunePresetMemory(memory.byKey, s.snapshot);
    if (pruned !== memory.byKey) usePresetMemory.setState({ byKey: pruned });
  }
});
