// DRM-001 — drums make sound / default-instrument policy, exercised through the
// real seam (store.exec → bridge.mock). Guards the catalog ⇄ mock contract for the
// new commands and the auto-instrument behaviour the native backend implements.

import { describe, it, expect, beforeEach } from "vitest";
import { useStore } from "../store";
import { __resetMockForTests } from "../bridge.mock";
import { validateCommand, AGENT_COMMANDS } from "../agent/commands";
import type { Snapshot } from "../types";

function snap(): Snapshot {
  const s = useStore.getState().snapshot;
  if (!s) throw new Error("store has no snapshot");
  return s;
}
const exec = (c: string, a?: Record<string, unknown>) => useStore.getState().exec(c, a);
const trackById = (id: string) => snap().tracks.find((t) => t.id === id)!;

describe("DRM-001 drum tracks + default instruments", () => {
  beforeEach(async () => {
    __resetMockForTests();
    await useStore.getState().refresh();
  });

  it("create_track type:drum makes a drum track that hosts a sampler instrument", async () => {
    const r = await exec("create_track", { name: "Beat", type: "drum" });
    const id = (r.data as { trackId: string }).trackId;
    await useStore.getState().refresh();

    const t = trackById(id);
    expect(t.type).toBe("drum");
    expect(t.isInstrument).toBe(true);
    expect(t.plugins?.some((p) => p.type === "sampler" && p.isInstrument)).toBe(true);
  });

  it("set_track_type flips a plain track to drum and auto-loads the kit", async () => {
    const id = (await exec("create_track", { name: "Flip" })).data as { trackId: string };
    await useStore.getState().refresh();
    expect(trackById(id.trackId).type).toBe("audio");

    await exec("set_track_type", { trackId: id.trackId, type: "drum" });
    await useStore.getState().refresh();
    const t = trackById(id.trackId);
    expect(t.type).toBe("drum");
    expect(t.isInstrument).toBe(true);
  });

  it("a MIDI clip on a plain audio track auto-loads the 4OSC default instrument", async () => {
    const id = (await exec("create_track", { name: "Mel" })).data as { trackId: string };
    await exec("add_midi_clip", { trackId: id.trackId, length: 1 });
    await useStore.getState().refresh();

    const t = trackById(id.trackId);
    expect(t.isInstrument).toBe(true);
    expect(t.plugins?.some((p) => p.type === "4osc")).toBe(true);
  });

  it("load_drum_kit and assign_sample resolve through the seam", async () => {
    const id = (await exec("create_track", { name: "Kit" })).data as { trackId: string };
    expect((await exec("load_drum_kit", { trackId: id.trackId })).ok).toBe(true);
    const as = await exec("assign_sample", { trackId: id.trackId, note: 60, file: "/tmp/x.wav", name: "X" });
    expect(as.ok).toBe(true);
    expect((as.data as { file: string }).file).toBe("/tmp/x.wav");
    // assign_sample requires a file (mirrors the native "file not found" guard).
    expect((await exec("assign_sample", { trackId: id.trackId, note: 60, file: "" })).ok).toBe(false);
  });

  it("the new commands are in the agent catalog and validate", () => {
    const names = new Set(AGENT_COMMANDS.map((c) => c.command));
    for (const c of ["set_track_type", "load_drum_kit", "assign_sample"]) expect(names.has(c)).toBe(true);

    expect(validateCommand("set_track_type", { trackId: "1", type: "drum" })).toBeNull();
    expect(validateCommand("assign_sample", { trackId: "1", note: 36, file: "/a.wav" })).toBeNull();
    // create_track's new optional type validates
    expect(validateCommand("create_track", { name: "x", type: "drum" })).toBeNull();
    // missing required arg is rejected
    expect(validateCommand("assign_sample", { trackId: "1" })).not.toBeNull();
  });
});
