import { describe, it, expect } from "vitest";
import { __resetMockForTests, mockExecute, mockSnapshot } from "./bridge.mock";
import type { CommandResult, Snapshot, TrackOutputs } from "./types";

// RTG-002 — the mock backend for per-track OUTPUT routing. Mirrors the native
// set_track_output contract (three destination forms + cycle/self rejection +
// undo) so the v2 inspector's output selector is honest in dev/e2e/vitest.

const snap = () => mockSnapshot<Snapshot>();
const trackByName = (s: Snapshot, name: string) => s.tracks.find((t) => t.name === name)!;

describe("bridge.mock set_track_output (RTG-002)", () => {
  it("list_track_outputs surfaces hardware outs + candidate tracks", async () => {
    __resetMockForTests();
    const res = await mockExecute<CommandResult<TrackOutputs>>({ command: "list_track_outputs", args: {} });
    expect(res.ok).toBe(true);
    expect(res.data?.outputs.length).toBeGreaterThan(0);
    expect(res.data?.tracks.length).toBeGreaterThan(0);
    expect(res.data?.audioEnabled).toBe(true);
  });

  it("routes a track INTO another track (implicit submix) and reflects it in the snapshot", async () => {
    __resetMockForTests();
    const s0 = await snap();
    const keys = trackByName(s0, "Keys");
    const bass = trackByName(s0, "Bass");
    // Default output emits no `output` field.
    expect(keys.output).toBeUndefined();

    const res = await mockExecute<CommandResult>({
      command: "set_track_output",
      args: { trackId: keys.id, destTrackId: bass.id },
    });
    expect(res.ok).toBe(true);

    const s1 = await snap();
    const keys1 = trackByName(s1, "Keys");
    expect(keys1.output).toEqual({ isTrack: true, destId: bass.id, name: "Bass" });
  });

  it("routes a track to a hardware DEVICE", async () => {
    __resetMockForTests();
    const s0 = await snap();
    const keys = trackByName(s0, "Keys");
    const outs = (await mockExecute<CommandResult<TrackOutputs>>({ command: "list_track_outputs", args: {} })).data!;
    const dev = outs.outputs[0];

    const res = await mockExecute<CommandResult>({
      command: "set_track_output",
      args: { trackId: keys.id, deviceID: dev.deviceID },
    });
    expect(res.ok).toBe(true);
    const keys1 = trackByName(await snap(), "Keys");
    expect(keys1.output).toEqual({ isTrack: false, deviceID: dev.deviceID, name: dev.name });
  });

  it("resets to the default output (removes the output field)", async () => {
    __resetMockForTests();
    const s0 = await snap();
    const keys = trackByName(s0, "Keys");
    const bass = trackByName(s0, "Bass");
    await mockExecute({ command: "set_track_output", args: { trackId: keys.id, destTrackId: bass.id } });
    expect(trackByName(await snap(), "Keys").output).toBeDefined();

    const res = await mockExecute<CommandResult>({
      command: "set_track_output",
      args: { trackId: keys.id, output: "default" },
    });
    expect(res.ok).toBe(true);
    expect(trackByName(await snap(), "Keys").output).toBeUndefined();
  });

  it("rejects a self-route and a cycle (A→B then B→A)", async () => {
    __resetMockForTests();
    const s0 = await snap();
    const keys = trackByName(s0, "Keys");
    const bass = trackByName(s0, "Bass");

    expect((await mockExecute<CommandResult>({ command: "set_track_output", args: { trackId: keys.id, destTrackId: keys.id } })).ok).toBe(false);

    expect((await mockExecute<CommandResult>({ command: "set_track_output", args: { trackId: keys.id, destTrackId: bass.id } })).ok).toBe(true);
    // Bass → Keys would loop, since Keys already feeds Bass.
    expect((await mockExecute<CommandResult>({ command: "set_track_output", args: { trackId: bass.id, destTrackId: keys.id } })).ok).toBe(false);
  });

  it("errors on a bad track and on a missing destination form", async () => {
    __resetMockForTests();
    const s0 = await snap();
    const keys = trackByName(s0, "Keys");
    expect((await mockExecute<CommandResult>({ command: "set_track_output", args: { trackId: "nope", destTrackId: keys.id } })).ok).toBe(false);
    expect((await mockExecute<CommandResult>({ command: "set_track_output", args: { trackId: keys.id } })).ok).toBe(false);
  });

  it("is undoable — undo restores the prior output", async () => {
    __resetMockForTests();
    const s0 = await snap();
    const keys = trackByName(s0, "Keys");
    const bass = trackByName(s0, "Bass");
    await mockExecute({ command: "set_track_output", args: { trackId: keys.id, destTrackId: bass.id } });
    expect(trackByName(await snap(), "Keys").output).toBeDefined();

    await mockExecute({ command: "undo", args: {} });
    expect(trackByName(await snap(), "Keys").output).toBeUndefined();
  });
});
