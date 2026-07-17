import { describe, it, expect, beforeEach } from "vitest";
import { mockExecute, mockSnapshot, __resetMockForTests } from "./bridge.mock";
import type { CommandResult, Snapshot } from "./types";

// G4A — clip inspector gain/mute/rename mock-bridge coverage. These three
// commands (rename_clip / set_clip_mute / set_clip_gain) already existed as
// agent-only MoshOps commands and mock handlers; this pins their undo/redo
// behavior through the mock bridge now that a UI surface (the Inspector's
// "Clip" tab) drives them. Fades are a separate, deferred ticket (G4b).

const exec = <T = CommandResult>(command: string, args: Record<string, unknown>) =>
  mockExecute<T>({ command, args });

async function waveClip(): Promise<{ clipId: string }> {
  const s = await mockSnapshot<Snapshot>();
  const track = s.tracks.find((t) => t.clips.some((c) => c.type === "wave"))!;
  const clip = track.clips.find((c) => c.type === "wave")!;
  return { clipId: clip.id };
}

async function midiClip(): Promise<{ clipId: string }> {
  const s = await mockSnapshot<Snapshot>();
  const track = s.tracks.find((t) => t.clips.some((c) => c.type === "midi"))!;
  const clip = track.clips.find((c) => c.type === "midi")!;
  return { clipId: clip.id };
}

async function findClip(clipId: string) {
  const s = await mockSnapshot<Snapshot>();
  return s.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)!;
}

describe("clip inspector: rename_clip / set_clip_mute / set_clip_gain via the mock bridge", () => {
  beforeEach(() => __resetMockForTests());

  it("rename_clip renames the clip and undo restores the prior name", async () => {
    const { clipId } = await waveClip();
    const before = await findClip(clipId);
    const originalName = before.name;

    const r = await exec("rename_clip", { clipId, name: "verse chords" });
    expect(r.ok).toBe(true);
    expect((await findClip(clipId)).name).toBe("verse chords");

    const u = await exec("undo", {});
    expect(u.ok).toBe(true);
    expect((await findClip(clipId)).name).toBe(originalName);

    const rd = await exec("redo", {});
    expect(rd.ok).toBe(true);
    expect((await findClip(clipId)).name).toBe("verse chords");
  });

  it("set_clip_mute mutes/unmutes and undo/redo round-trips", async () => {
    const { clipId } = await waveClip();
    expect((await findClip(clipId)).mute).toBeFalsy();

    const r = await exec("set_clip_mute", { clipId, mute: true });
    expect(r.ok).toBe(true);
    expect((await findClip(clipId)).mute).toBe(true);

    await exec("undo", {});
    expect((await findClip(clipId)).mute).toBeFalsy();

    await exec("redo", {});
    expect((await findClip(clipId)).mute).toBe(true);
  });

  it("set_clip_gain sets gainDb and undo restores the prior value", async () => {
    const { clipId } = await waveClip();

    const r = await exec("set_clip_gain", { clipId, gainDb: 6 });
    expect(r.ok).toBe(true);
    expect((await findClip(clipId)).gainDb).toBe(6);

    await exec("set_clip_gain", { clipId, gainDb: -12 });
    expect((await findClip(clipId)).gainDb).toBe(-12);

    await exec("undo", {});
    expect((await findClip(clipId)).gainDb).toBe(6);
  });

  it("set_clip_mute and rename_clip also work on a MIDI clip (gain is wave-only in the UI, not blocked by the mock)", async () => {
    const { clipId } = await midiClip();
    const r1 = await exec("set_clip_mute", { clipId, mute: true });
    expect(r1.ok).toBe(true);
    expect((await findClip(clipId)).mute).toBe(true);

    const r2 = await exec("rename_clip", { clipId, name: "renamed midi" });
    expect(r2.ok).toBe(true);
    expect((await findClip(clipId)).name).toBe("renamed midi");
  });

  it("errors on an unknown clipId rather than silently no-op'ing", async () => {
    const r = await exec("set_clip_gain", { clipId: "does-not-exist", gainDb: 3 });
    expect(r.ok).toBe(false);
  });
});
