import { beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../store";
import { __resetMockForTests } from "../bridge.mock";
import { presetKey, usePresetMemory } from "./presetMemory";
import type { Snapshot } from "../types";

// Review fix 3: the "preset loaded on this instrument" label is view-state that mirrors an edit,
// so it must not outlive that edit. It was only ever added to, so it survived a project switch
// (track ids repeat across fresh Edits, so a different instrument could show a name never
// loaded on it), a deleted track or instrument, and an undo of the load itself.

const st = () => useStore.getState();
const labels = () => usePresetMemory.getState().byKey;

/** The Bass track (MIDI clips) with a built-in 4OSC and a preset loaded through the engine. */
async function loadedSynth(): Promise<{ trackId: string; index: number }> {
  const trackId = st().snapshot!.tracks[1]!.id;
  expect((await st().exec("load_builtin", { trackId, type: "4osc" })).ok).toBe(true);
  await st().refresh();
  const synth = st().snapshot!.tracks[1]!.plugins!.find((p) => p.type === "4osc")!;
  expect((await st().exec("load_preset", { trackId, index: synth.index, file: "/presets/4osc/mosh-bass.json" })).ok).toBe(true);
  await st().refresh();
  usePresetMemory.getState().remember(trackId, synth.index, "mosh-bass");
  expect(labels()[presetKey(trackId, synth.index)]).toBe("mosh-bass");   // anti-vacuity: the label is up
  return { trackId, index: synth.index };
}

describe("the Presets pane label forgets what it can no longer vouch for", () => {
  beforeEach(async () => {
    __resetMockForTests();
    usePresetMemory.setState({ byKey: {} });
    await st().refresh();
  });

  it("⌘Z of the preset load clears the label", async () => {
    const { trackId, index } = await loadedSynth();
    expect((await st().exec("undo")).ok).toBe(true);
    await st().refresh();
    expect(labels()[presetKey(trackId, index)]).toBeUndefined();
  });

  it("redo and a History jump clear it too", async () => {
    const a = await loadedSynth();
    await st().exec("undo");
    usePresetMemory.getState().remember(a.trackId, a.index, "mosh-bass");
    expect((await st().exec("redo")).ok).toBe(true);
    expect(labels()).toEqual({});
    usePresetMemory.getState().remember(a.trackId, a.index, "mosh-bass");
    expect((await st().exec("jump_to_history", { txn: "not-a-stamp" })).ok).toBe(false);   // a refused jump moved nothing
    expect(labels()[presetKey(a.trackId, a.index)]).toBe("mosh-bass");
  });

  it("a project change forgets every label (track ids repeat across fresh Edits)", async () => {
    const { trackId, index } = await loadedSynth();
    const epoch = st().projectEpoch;
    expect((await st().exec("new_project", {})).ok).toBe(true);
    expect(st().projectEpoch).toBeGreaterThan(epoch);
    expect(labels()[presetKey(trackId, index)]).toBeUndefined();
    expect(labels()).toEqual({});
  });

  it("a label whose track or instrument is gone from the snapshot is dropped; the others stay", async () => {
    const { trackId, index } = await loadedSynth();
    const otherId = st().snapshot!.tracks.find((t) => t.id !== trackId)!.id;
    expect((await st().exec("load_builtin", { trackId: otherId, type: "4osc" })).ok).toBe(true);
    await st().refresh();
    const snap = st().snapshot!;
    const other = snap.tracks.find((t) => t.id === otherId)!;
    const otherIndex = other.plugins!.find((p) => p.type === "4osc")!.index;
    usePresetMemory.getState().remember(other.id, otherIndex, "kept");
    // the instrument is removed from the track
    const noSynth: Snapshot = {
      ...snap,
      tracks: snap.tracks.map((t) => (t.id === trackId ? { ...t, plugins: (t.plugins ?? []).filter((p) => p.index !== index) } : t)),
    };
    useStore.setState({ snapshot: noSynth });
    expect(labels()[presetKey(trackId, index)]).toBeUndefined();
    // the track itself is removed
    usePresetMemory.getState().remember(trackId, 0, "gone");
    useStore.setState({ snapshot: { ...snap, tracks: snap.tracks.filter((t) => t.id !== trackId) } });
    expect(labels()[presetKey(trackId, 0)]).toBeUndefined();
    // an entry whose track and plugin are still in the snapshot survives both snapshot changes
    expect(labels()[presetKey(other.id, otherIndex)]).toBe("kept");
  });
});
