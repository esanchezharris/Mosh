import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import type { CommandResult, Snapshot } from "../types";
import { executeProToolsMixFanout, proToolsMixActionTrackIds } from "./proToolsMixFanout";

const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  session: { sampleRate: 48_000, tempo: 120, editFile: "/tmp/mix-fanout.mosh", key: { tonic: "C", mode: "major" } },
  tracks: [
    { id: "drums", index: 0, name: "Drums", type: "audio", clips: [] },
    { id: "bass", index: 1, name: "Bass", type: "audio", clips: [] },
    { id: "group", index: 2, name: "Band", type: "group", isGroup: true, clips: [] },
    { id: "aux", index: 3, name: "Verb", type: "audio", isReturn: true, clips: [] },
  ],
  trackGroups: [{
    id: "rhythm",
    name: "Rhythm",
    kind: "mix",
    enabled: true,
    trackIds: ["drums", "bass"],
    mixAttributes: ["main_volume"],
  }],
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
};

describe("Pro Tools Mix modifier targets", () => {
  it("resolves direct, all-compatible, and selected-compatible targets in shown order", () => {
    const base = {
      snapshot: SNAPSHOT,
      sourceTrackId: "drums",
      shownTrackIds: ["drums", "bass", "group", "aux"],
      selectedTrackIds: ["bass", "aux"],
      supports: (track: Snapshot["tracks"][number]) => !track.isGroup,
    };
    expect(proToolsMixActionTrackIds({ ...base, modifiers: { altKey: false, shiftKey: false } }))
      .toEqual(["drums"]);
    expect(proToolsMixActionTrackIds({ ...base, modifiers: { altKey: true, shiftKey: false } }))
      .toEqual(["drums", "bass", "aux"]);
    expect(proToolsMixActionTrackIds({ ...base, modifiers: { altKey: true, shiftKey: true } }))
      .toEqual(["bass", "aux"]);
  });

  it("falls back to the source when Option-Shift has no compatible selection", () => {
    expect(proToolsMixActionTrackIds({
      snapshot: SNAPSHOT,
      sourceTrackId: "drums",
      shownTrackIds: SNAPSHOT.tracks.map((track) => track.id),
      selectedTrackIds: ["group"],
      modifiers: { altKey: true, shiftKey: true },
      supports: (track) => !track.isGroup,
    })).toEqual(["drums"]);
  });
});

describe("Pro Tools Mix serial fan-out", () => {
  const original = useStore.getState();
  let exec: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    exec = vi.fn(async (command: string): Promise<CommandResult> => ({ ok: true, command }));
    useStore.setState({ snapshot: SNAPSHOT, projectEpoch: 31, exec, lastError: null });
  });

  afterEach(() => useStore.setState({
    snapshot: original.snapshot,
    projectEpoch: original.projectEpoch,
    exec: original.exec,
    lastError: original.lastError,
  }));

  it("deduplicates linked faders while retaining an Aux target", async () => {
    await executeProToolsMixFanout({
      snapshot: SNAPSHOT,
      targetTrackIds: ["drums", "bass", "aux"],
      mixAttribute: "main_volume",
      commandForTrack: (trackId) => ({ command: "set_track_volume", args: { trackId, db: -4 } }),
    });

    expect(exec.mock.calls).toEqual([
      ["set_track_volume", { trackId: "drums", db: -4 }],
      ["set_track_volume", { trackId: "aux", db: -4 }],
    ]);
  });

  it("stops after a rejected command and exposes its error", async () => {
    exec
      .mockResolvedValueOnce({ ok: true, command: "set_track_output" })
      .mockResolvedValueOnce({ ok: false, command: "set_track_output", error: "route unavailable" });

    const applied = await executeProToolsMixFanout({
      snapshot: SNAPSHOT,
      targetTrackIds: ["drums", "bass", "aux"],
      commandForTrack: (trackId) => ({ command: "set_track_output", args: { trackId, deviceID: "main" } }),
    });

    expect(applied).toBe(false);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(useStore.getState().lastError).toBe("route unavailable");
  });

  it("stops when an ok result reports that hardware did not apply it", async () => {
    exec.mockResolvedValueOnce({
      ok: true,
      command: "set_track_input",
      data: { applied: false, reason: "input device is unavailable" },
    });

    const applied = await executeProToolsMixFanout({
      snapshot: SNAPSHOT,
      targetTrackIds: ["drums", "bass"],
      commandForTrack: (trackId) => ({ command: "set_track_input", args: { trackId, deviceID: "mic" } }),
      resultFailure: (result) => (result.data as { applied?: boolean; reason?: string } | undefined)?.applied === false
        ? "input device is unavailable" : null,
    });

    expect(applied).toBe(false);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(useStore.getState().lastError).toBe("input device is unavailable");
  });

  it("cancels remaining commands when the project changes", async () => {
    exec.mockImplementation(async (command: string): Promise<CommandResult> => {
      useStore.setState({ projectEpoch: 32 });
      return { ok: true, command };
    });

    const applied = await executeProToolsMixFanout({
      snapshot: SNAPSHOT,
      targetTrackIds: ["drums", "bass"],
      commandForTrack: (trackId) => ({ command: "set_track_output", args: { trackId, deviceID: "main" } }),
    });

    expect(applied).toBe(false);
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
