import { beforeEach, describe, expect, it } from "vitest";
import { __resetMockForTests, mockExecute, mockOnEvent, mockSnapshot } from "./bridge.mock";
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
    const events: string[] = [];
    const stopListening = mockOnEvent("mosh_event", (raw) => {
      events.push((raw as { type?: string }).type ?? "");
    });
    expect((await exec("set_transport", { action: "record" })).ok).toBe(true);

    const stopped = await exec("set_transport", { action: "stop" });
    const after = await mockSnapshot<Snapshot>();
    stopListening();

    expect(stopped.ok).toBe(false);
    expect(after.transport.recording).toBe(false);
    expect(after.tracks[0]!.clips.length).toBe(clipCount);
    expect(events).toContain("snapshot_invalidated");
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

  it.each([false, true])("does not land or discard while idle (discard=%s)", async (discardRecordings) => {
    const before = await mockSnapshot<Snapshot>();
    const trackId = before.tracks[0]!.id;
    const clipCount = before.tracks[0]!.clips.length;
    const events: string[] = [];
    const stopListening = mockOnEvent("mosh_event", (raw) => {
      events.push((raw as { type?: string }).type ?? "");
    });
    await exec("arm_track", { trackId, armed: true });

    const stopped = await exec("stop_recording", { discardRecordings });
    const data = stopped.data as { applied?: boolean; clips?: unknown[]; reason?: string } | undefined;
    const after = await mockSnapshot<Snapshot>();
    stopListening();

    expect(data).toMatchObject({ applied: false, clips: [], reason: "not recording" });
    expect(after.tracks[0]!.clips.length).toBe(clipCount);
    expect(events).toContain("snapshot_invalidated");
  });

  it.each(["stop_recording", "set_transport"])("does not put a landed recording take on the undo stack via %s", async (command) => {
    const before = await mockSnapshot<Snapshot>();
    const trackId = before.tracks[0]!.id;
    const clipCount = before.tracks[0]!.clips.length;
    await exec("arm_track", { trackId, armed: true });
    await exec("set_transport", { action: "record" });
    await exec(command, command === "set_transport" ? { action: "stop" } : {});

    const undone = await exec("undo");
    const after = await mockSnapshot<Snapshot>();

    expect(undone.data).toEqual({ undone: false });
    expect(after.tracks[0]!.clips.length).toBe(clipCount + 1);
  });

  it("logs stop_recording as non-undoable", async () => {
    await exec("stop_recording");
    const log = await exec("get_command_log", { limit: 20 });
    const entries = (log.data as { entries?: { command: string; undoable: boolean }[] } | undefined)?.entries ?? [];

    expect(entries.find((entry) => entry.command === "stop_recording")?.undoable).toBe(false);
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
