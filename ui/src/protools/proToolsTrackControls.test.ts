import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import type { CommandResult, Snapshot } from "../types";
import { applyProToolsTrackControl } from "./proToolsTrackControls";

const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  session: { sampleRate: 48_000, tempo: 120, editFile: "/tmp/track-controls.mosh", key: { tonic: "C", mode: "major" } },
  tracks: [
    { id: "drums", index: 0, name: "Drums", type: "audio", clips: [], volumeDb: 0, pan: 0, armed: false, monitor: "automatic" },
    { id: "bass", index: 1, name: "Bass", type: "audio", clips: [], volumeDb: -3, pan: 0, armed: false, monitor: "automatic" },
  ],
  trackGroups: [{
    id: "rhythm",
    name: "Rhythm",
    trackIds: ["drums", "bass"],
    kind: "mix",
    enabled: true,
    mixAttributes: ["record_enable"],
  }],
  trackGroupsSuspended: false,
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
};

describe("Pro Tools attribute-aware track controls", () => {
  const originalStore = useStore.getState();
  let exec: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    exec = vi.fn(async (command: string): Promise<CommandResult> => ({
      ok: true,
      command,
      data: { applied: true },
    }));
    useStore.setState({ snapshot: structuredClone(SNAPSHOT), projectEpoch: 17, exec, lastError: null });
  });

  afterEach(() => {
    useStore.setState({
      snapshot: originalStore.snapshot,
      projectEpoch: originalStore.projectEpoch,
      exec: originalStore.exec,
      lastError: originalStore.lastError,
    });
  });

  it("applies Record Enable to every track linked by that exact attribute", async () => {
    await applyProToolsTrackControl("arm", "drums", ["drums"]);

    expect(exec.mock.calls).toEqual([
      ["arm_track", { trackId: "drums", armed: true }],
      ["arm_track", { trackId: "bass", armed: true }],
    ]);
  });

  it("does not link Input Monitoring when its attribute is disabled", async () => {
    await applyProToolsTrackControl("input", "drums", ["drums"]);

    expect(exec.mock.calls).toEqual([
      ["set_input_monitor", { trackId: "drums", mode: "on" }],
    ]);
  });

  it("stops a linked Record Enable operation when hardware rejects a member", async () => {
    const snapshot = structuredClone(SNAPSHOT);
    snapshot.tracks.push({
      id: "keys",
      index: 2,
      name: "Keys",
      type: "audio",
      clips: [],
      volumeDb: 0,
      pan: 0,
      armed: false,
      monitor: "automatic",
    });
    snapshot.trackGroups?.[0]?.trackIds.push("keys");
    useStore.setState({ snapshot });
    exec
      .mockResolvedValueOnce({ ok: true, command: "arm_track", data: { applied: true } })
      .mockResolvedValueOnce({ ok: true, command: "arm_track", data: { applied: false } });

    await applyProToolsTrackControl("arm", "drums", ["drums"]);

    expect(exec.mock.calls).toEqual([
      ["arm_track", { trackId: "drums", armed: true }],
      ["arm_track", { trackId: "bass", armed: true }],
    ]);
    expect(useStore.getState().lastError).toBe("Record arm could not be applied.");
  });
});
