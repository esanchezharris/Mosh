import { beforeEach, describe, expect, it } from "vitest";
import { __resetMockForTests, mockExecute, mockSnapshot } from "./bridge.mock";
import type { CommandResult, Snapshot } from "./types";

// Mirrors the engine fix of 2026-09-23 (MoshOps::cmdStopRecording): a Booth pass is a
// Booth pass however it ends. The installed app's TopBar stop landed the take on Takes but
// the Booth never listed it; the engine now finalizes an in-flight pass on EVERY recording
// stop, and the dev mock the e2e suite runs against has to tell the same story.
const exec = (command: string, args: Record<string, unknown> = {}) =>
  mockExecute<CommandResult>({ command, args });

async function boothWithVocal(): Promise<{ takesId: string }> {
  const created = await exec("create_track", { name: "Vocal" });
  const trackId = (created.data as { trackId?: string } | undefined)?.trackId;
  if (!trackId) throw new Error("create_track did not name the track");
  const setup = await exec("loop_setup", { trackId });
  const takesId = (setup.data as { takesTrackId?: string } | undefined)?.takesTrackId;
  if (!takesId) throw new Error("loop_setup did not pair a Takes track");
  return { takesId };
}

describe("bridge mock: a Booth pass ended from outside the Booth", () => {
  beforeEach(() => __resetMockForTests());

  it.each([
    ["the TopBar stop", "set_transport", { action: "stop" }],
    ["Space", "set_transport", { action: "toggle" }],
    // Shift+Space -- Live's Continue Playback. While recording it is a stop like any other;
    // it used to skip the finalize and leave the pass "in flight" (review of PR #730).
    ["Shift+Space", "set_transport", { action: "continue" }],
    ["a bare stop_recording", "stop_recording", {}],
    // A loop toggle mid-take, with the real range menuActions.ts's loopToggleArgs always
    // sends -- Tracktion's own stopIfRecording (2026-09-24 finding a) is a stop too.
    ["a loop toggle (set_transport {loop, loopStart, loopEnd})", "set_transport",
      { loop: true, loopStart: 0, loopEnd: 8 }],
  ] as const)("registers as a Part when %s ends it", async (_how, command, args) => {
    const { takesId } = await boothWithVocal();
    const rec = await exec("loop_record");
    const passId = (rec.data as { currentId?: string } | undefined)?.currentId;
    expect(passId, "loop_record minted a pass").toBeTruthy();

    const stopped = await exec(command, args);
    expect(stopped.ok).toBe(true);

    const loop = (await mockSnapshot<Snapshot>()).loop!;
    expect(loop.contributions.map((part) => part.id)).toEqual([passId]);
    expect(loop.contributions[0]!.trackId).toBe(takesId);
    expect(loop.currentId).toBeNull();
    expect(loop.lastId).toBe(passId);
    expect(loop.transport.recording).toBe(false);
  });

  it("mutes the older unkept pass when a later one ends from the TopBar", async () => {
    await boothWithVocal();
    await exec("loop_record");
    await exec("loop_stop");
    await exec("loop_record");
    await exec("set_transport", { action: "stop" });

    const snap = await mockSnapshot<Snapshot>();
    const parts = snap.loop!.contributions;
    expect(parts).toHaveLength(2);
    const clipOf = (clipId: string | undefined) => snap.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
    expect(clipOf(parts[0]!.clipId)?.mute).toBe(true);
    expect(clipOf(parts[1]!.clipId)?.mute).toBe(false);
  });
});
