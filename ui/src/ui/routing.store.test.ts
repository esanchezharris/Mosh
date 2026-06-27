// G8 — loadRouting() (was orphaned) populates the routing state from the seam,
// and set_track_output flows through store.exec like every other mutation.
// Driven through the real store → bridge.mock (the same contract the native
// backend implements; see SelfTest.cpp Wave S).

import { describe, it, expect, beforeEach } from "vitest";
import { useStore } from "../store";
import { __resetMockForTests } from "../bridge.mock";
import type { Snapshot } from "../types";

function snap(): Snapshot {
  const s = useStore.getState().snapshot;
  if (!s) throw new Error("store has no snapshot");
  return s;
}
const exec = (c: string, a?: Record<string, unknown>) => useStore.getState().exec(c, a);
const trackById = (id: string) => snap().tracks.find((t) => t.id === id)!;

describe("G8 loadRouting + set_track_output", () => {
  beforeEach(async () => {
    __resetMockForTests();
    await useStore.getState().refresh();
  });

  it("loadRouting populates trackOutputs (with candidate tracks) and waveInputs", async () => {
    expect(useStore.getState().trackOutputs).toBeNull();
    await exec("create_track", { name: "A" });
    await exec("create_track", { name: "B" });
    await useStore.getState().refresh();

    await useStore.getState().loadRouting();

    const to = useStore.getState().trackOutputs;
    expect(to).not.toBeNull();
    expect(Array.isArray(to!.outputs)).toBe(true);
    expect(to!.tracks.length).toBeGreaterThanOrEqual(2);
    expect(useStore.getState().waveInputs).not.toBeNull();
  });

  it("set_track_output routes a track into another track (reflected in the snapshot)", async () => {
    const a = (await exec("create_track", { name: "A" })).data as { trackId: string };
    const b = (await exec("create_track", { name: "B" })).data as { trackId: string };
    await useStore.getState().refresh();
    expect(trackById(a.trackId).output).toBeUndefined();

    await exec("set_track_output", { trackId: a.trackId, destTrackId: b.trackId });
    await useStore.getState().refresh();

    const out = trackById(a.trackId).output;
    expect(out?.isTrack).toBe(true);
    expect(out?.destId).toBe(b.trackId);
  });

  it("set_track_output output:'default' clears the route", async () => {
    const a = (await exec("create_track", { name: "A" })).data as { trackId: string };
    const b = (await exec("create_track", { name: "B" })).data as { trackId: string };
    await useStore.getState().refresh();
    await exec("set_track_output", { trackId: a.trackId, destTrackId: b.trackId });
    await useStore.getState().refresh();
    expect(trackById(a.trackId).output).toBeDefined();

    await exec("set_track_output", { trackId: a.trackId, output: "default" });
    await useStore.getState().refresh();
    expect(trackById(a.trackId).output).toBeUndefined();
  });
});
