// G9 — audio warp / time-stretch (`set_clip_warp`) modelled in the dev mock.
//
// The mock mirrors the native contract (src/moshops/MoshOps.cpp::cmdSetClipWarp):
// wave clips only, `autoTempo` is required, enabling defaults the stretch mode to
// SoundTouch (Better), and — like the native snapshot serialiser — `stretchMode`
// is carried on the clip ONLY while warp is on. The edit is undoable.

import { describe, it, expect, beforeEach } from "vitest";
import { __resetMockForTests, mockExecute, mockSnapshot } from "./bridge.mock";
import type { CommandResult, Snapshot, Clip } from "./types";

type WarpData = { clipId: string; autoTempo: boolean; stretchMode?: string };

async function snap(): Promise<Snapshot> {
  return mockSnapshot<Snapshot>();
}
function clipsOf(s: Snapshot): Clip[] {
  return s.tracks.flatMap((t) => t.clips);
}
async function waveClipId(): Promise<string> {
  return clipsOf(await snap()).find((c) => c.type === "wave")!.id;
}
async function midiClipId(): Promise<string> {
  return clipsOf(await snap()).find((c) => c.type === "midi")!.id;
}
async function clipById(id: string): Promise<Clip | undefined> {
  return clipsOf(await snap()).find((c) => c.id === id);
}

describe("bridge.mock set_clip_warp", () => {
  beforeEach(() => __resetMockForTests());

  it("enabling warp defaults the stretch mode to SoundTouch (Better) and marks the clip", async () => {
    const clipId = await waveClipId();
    const res = await mockExecute<CommandResult<WarpData>>({
      command: "set_clip_warp",
      args: { clipId, autoTempo: true },
    });
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ clipId, autoTempo: true, stretchMode: "SoundTouch (Better)" });

    const clip = await clipById(clipId);
    expect(clip?.autoTempo).toBe(true);
    expect(clip?.stretchMode).toBe("SoundTouch (Better)");
  });

  it("passes an explicit stretch mode through", async () => {
    const clipId = await waveClipId();
    const res = await mockExecute<CommandResult<WarpData>>({
      command: "set_clip_warp",
      args: { clipId, autoTempo: true, mode: "SoundTouch (Normal)" },
    });
    expect(res.ok).toBe(true);
    expect(res.data?.stretchMode).toBe("SoundTouch (Normal)");
    expect((await clipById(clipId))?.stretchMode).toBe("SoundTouch (Normal)");
  });

  it("disabling warp drops the stretchMode from the clip (mirrors the native snapshot)", async () => {
    const clipId = await waveClipId();
    await mockExecute({ command: "set_clip_warp", args: { clipId, autoTempo: true } });
    await mockExecute({ command: "set_clip_warp", args: { clipId, autoTempo: false } });
    const clip = await clipById(clipId);
    expect(clip?.autoTempo).toBe(false);
    expect(clip?.stretchMode).toBeUndefined();
  });

  it("is undoable — undo restores the pre-warp clip", async () => {
    const clipId = await waveClipId();
    await mockExecute({ command: "set_clip_warp", args: { clipId, autoTempo: true } });
    expect((await clipById(clipId))?.autoTempo).toBe(true);
    const u = await mockExecute<CommandResult>({ command: "undo", args: {} });
    expect(u.ok).toBe(true);
    expect((await clipById(clipId))?.autoTempo).toBeFalsy();
  });

  it("rejects a missing autoTempo, a bad clipId, and a non-audio clip", async () => {
    const clipId = await waveClipId();
    const missing = await mockExecute<CommandResult>({ command: "set_clip_warp", args: { clipId } });
    expect(missing.ok).toBe(false);

    const bad = await mockExecute<CommandResult>({ command: "set_clip_warp", args: { clipId: "no-such", autoTempo: true } });
    expect(bad.ok).toBe(false);

    const midi = await midiClipId();
    const notAudio = await mockExecute<CommandResult>({ command: "set_clip_warp", args: { clipId: midi, autoTempo: true } });
    expect(notAudio.ok).toBe(false);
  });
});
