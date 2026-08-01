import { beforeEach, describe, expect, it } from "vitest";
import { __resetMockForTests, mockExecute, mockSnapshot } from "./bridge.mock";
import type { CommandResult, Snapshot } from "./types";

const exec = (command: string, args: Record<string, unknown> = {}) =>
  mockExecute<CommandResult>({ command, args });

describe("bridge mock recording finalization parity", () => {
  beforeEach(() => __resetMockForTests());

  it("lands an armed take when generic stop ends recording", async () => {
    const before = await mockSnapshot<Snapshot>();
    const trackId = before.tracks[0]!.id;
    const clipCount = before.tracks[0]!.clips.length;
    expect((await exec("arm_track", { trackId, armed: true })).ok).toBe(true);
    expect((await exec("set_transport", { action: "record" })).ok).toBe(true);

    const stopped = await exec("set_transport", { action: "stop" });
    const after = await mockSnapshot<Snapshot>();

    expect(stopped.ok).toBe(true);
    expect(after.transport.recording).toBe(false);
    expect(after.tracks[0]!.clips.length).toBe(clipCount + 1);
  });

  it("fails generic finalization without an armed capture target", async () => {
    const before = await mockSnapshot<Snapshot>();
    const clipCount = before.tracks[0]!.clips.length;
    expect((await exec("set_transport", { action: "record" })).ok).toBe(true);

    const stopped = await exec("set_transport", { action: "stop" });
    const after = await mockSnapshot<Snapshot>();

    expect(stopped.ok).toBe(false);
    expect(after.transport.recording).toBe(false);
    expect(after.tracks[0]!.clips.length).toBe(clipCount);
  });

  it("does not fabricate an explicit take on the first unarmed track", async () => {
    const before = await mockSnapshot<Snapshot>();
    const clipCount = before.tracks[0]!.clips.length;
    expect((await exec("set_transport", { action: "record" })).ok).toBe(true);

    const stopped = await exec("stop_recording");
    const data = stopped.data as { applied?: boolean; clips?: unknown[] } | undefined;
    const after = await mockSnapshot<Snapshot>();

    expect(data?.applied).toBe(false);
    expect(data?.clips).toEqual([]);
    expect(after.tracks[0]!.clips.length).toBe(clipCount);
  });

  it("generic record while active lands the take and stays stopped", async () => {
    const trackId = (await mockSnapshot<Snapshot>()).tracks[0]!.id;
    await exec("arm_track", { trackId, armed: true });
    await exec("set_transport", { action: "record" });

    const stopped = await exec("set_transport", { action: "record" });
    const after = await mockSnapshot<Snapshot>();

    expect(stopped.ok).toBe(true);
    expect(after.transport.recording).toBe(false);
    expect(after.transport.playing).toBe(false);
  });
});
