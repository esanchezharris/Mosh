import { create } from "zustand";

// A24 (demo readiness) — which preset was last loaded onto each instrument, so the V3 Presets pane
// can name the sound that is on (the picker is a one-shot <select> that snaps back to "Presets…").
// View-state only: set after a load_preset the engine accepted, never read back from the engine,
// so an undo of the load leaves the name standing until the next pick. Keyed per instrument.

export const presetKey = (trackId: string, pluginIndex: number) => `${trackId}:${pluginIndex}`;

interface PresetMemory {
  byKey: Record<string, string>;
  remember: (trackId: string, pluginIndex: number, name: string) => void;
}

export const usePresetMemory = create<PresetMemory>((set) => ({
  byKey: {},
  remember: (trackId, pluginIndex, name) =>
    set((s) => ({ byKey: { ...s.byKey, [presetKey(trackId, pluginIndex)]: name } })),
}));
