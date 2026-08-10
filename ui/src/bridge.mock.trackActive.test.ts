import { beforeEach, describe, expect, it } from "vitest";
import { __resetMockForTests, mockExecute, mockSnapshot } from "./bridge.mock";
import type { CommandResult, Snapshot } from "./types";

const exec = <T = unknown>(command: string, args: Record<string, unknown> = {}) =>
  mockExecute<CommandResult<T>>({ command, args });
const snap = () => mockSnapshot<Snapshot>();

describe("bridge.mock set_track_active", () => {
  beforeEach(() => __resetMockForTests());

  it("makes a track inactive and restores it with one undo", async () => {
    // Given a newly created track is active by default.
    const created = await exec<{ readonly trackId: string }>(
      "create_track",
      { name: "Print Stem", type: "audio" },
    );
    const trackId = created.data?.trackId;
    if (!trackId) throw new Error("create_track did not return a trackId");
    expect((await snap()).tracks.find((track) => track.id === trackId)?.active ?? true).toBe(true);

    // When the track is made inactive through the command seam.
    const result = await exec("set_track_active", { trackId, active: false });

    // Then the snapshot exposes the inactive state and one undo restores processing.
    expect(result.ok).toBe(true);
    expect((await snap()).tracks.find((track) => track.id === trackId)?.active).toBe(false);
    expect((await exec("undo")).ok).toBe(true);
    expect((await snap()).tracks.find((track) => track.id === trackId)?.active ?? true).toBe(true);
  });

  it("rejects an unknown track without mutating the session", async () => {
    // Given the default project snapshot.
    const before = await snap();

    // When an unknown track is targeted.
    const result = await exec("set_track_active", { trackId: "missing-track", active: false });

    // Then the command fails and the track snapshot is unchanged.
    expect(result).toMatchObject({ ok: false, command: "set_track_active" });
    expect((await snap()).tracks).toEqual(before.tracks);
  });
});
