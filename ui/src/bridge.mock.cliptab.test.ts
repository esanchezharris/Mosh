import { describe, it, expect, beforeEach } from "vitest";
import { mockExecute, mockSnapshot, __resetMockForTests } from "./bridge.mock";
import type { CommandResult, Snapshot } from "./types";

// G4A/G4b — clip inspector gain/mute/rename/fade mock-bridge coverage. These
// commands (rename_clip / set_clip_mute / set_clip_gain / set_clip_fade)
// already existed as agent-only MoshOps commands and mock handlers; this pins
// their undo/redo behavior through the mock bridge now that a UI surface (the
// Inspector's "Clip" tab) drives them.

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

  it("write_clip_gain_curve persists a clip-local envelope and undo/clear round-trip", async () => {
    const { clipId } = await waveClip();
    const points = [
      { t: -0.25, gainDb: -9, curve: -0.2 },
      { t: 0.5, gainDb: 0 },
      { t: 1.5, gainDb: 4.5, curve: 0.4 },
    ];

    const written = await exec("write_clip_gain_curve", { clipId, points });
    expect(written.ok).toBe(true);
    expect((await findClip(clipId)).clipGainPoints).toEqual(points);

    await exec("undo", {});
    expect((await findClip(clipId)).clipGainPoints).toBeUndefined();
    await exec("redo", {});
    expect((await findClip(clipId)).clipGainPoints).toEqual(points);

    const duplicated = await exec("duplicate_clip", { clipId });
    expect(duplicated.ok).toBe(true);
    const duplicateId = (duplicated.data as { newClipId: string }).newClipId;
    expect((await findClip(duplicateId)).clipGainPoints).toEqual(points);

    const cleared = await exec("write_clip_gain_curve", { clipId, points: [] });
    expect(cleared.ok).toBe(true);
    expect((await findClip(clipId)).clipGainPoints).toBeUndefined();
  });

  it("write_clip_gain_curve accepts JSON and rejects malformed envelopes before mutation", async () => {
    const { clipId } = await waveClip();
    const written = await exec("write_clip_gain_curve", {
      clipId,
      points: '[{"t":0,"gainDb":-3},{"t":1,"gainDb":2}]',
    });
    expect(written.ok).toBe(true);
    const before = (await findClip(clipId)).clipGainPoints;

    for (const points of [
      [{ t: 1, gainDb: 0 }, { t: 1, gainDb: -3 }],
      [{ t: 0, gainDb: 6.1 }],
      [{ t: "later", gainDb: 0 }],
    ]) {
      const rejected = await exec("write_clip_gain_curve", { clipId, points });
      expect(rejected.ok).toBe(false);
      expect((await findClip(clipId)).clipGainPoints).toEqual(before);
    }
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

  it("set_clip_fade sets fadeInSec/fadeOutSec and undo restores the prior values", async () => {
    const { clipId } = await waveClip();
    expect((await findClip(clipId)).fadeInSec).toBe(0);
    expect((await findClip(clipId)).fadeOutSec).toBe(0);

    const r = await exec("set_clip_fade", { clipId, fadeInSec: 0.5, fadeOutSec: 0.25 });
    expect(r.ok).toBe(true);
    expect((await findClip(clipId)).fadeInSec).toBe(0.5);
    expect((await findClip(clipId)).fadeOutSec).toBe(0.25);

    await exec("undo", {});
    expect((await findClip(clipId)).fadeInSec).toBe(0);
    expect((await findClip(clipId)).fadeOutSec).toBe(0);

    await exec("redo", {});
    expect((await findClip(clipId)).fadeInSec).toBe(0.5);
    expect((await findClip(clipId)).fadeOutSec).toBe(0.25);
  });

  it("set_clip_fade only touches the dimension present in args", async () => {
    const { clipId } = await waveClip();
    await exec("set_clip_fade", { clipId, fadeInSec: 1 });
    expect((await findClip(clipId)).fadeInSec).toBe(1);
    expect((await findClip(clipId)).fadeOutSec).toBe(0);

    await exec("set_clip_fade", { clipId, fadeOutSec: 0.5 });
    expect((await findClip(clipId)).fadeInSec).toBe(1);
    expect((await findClip(clipId)).fadeOutSec).toBe(0.5);
  });

  it("set_clip_fade clamps to [0, clip.length]", async () => {
    const { clipId } = await waveClip();
    const length = (await findClip(clipId)).length;

    await exec("set_clip_fade", { clipId, fadeInSec: length + 999 });
    expect((await findClip(clipId)).fadeInSec).toBe(length);

    await exec("set_clip_fade", { clipId, fadeOutSec: -5 });
    expect((await findClip(clipId)).fadeOutSec).toBe(0);
  });

  it("set_clip_fade errors on an unknown clipId", async () => {
    const r = await exec("set_clip_fade", { clipId: "does-not-exist", fadeInSec: 0.5 });
    expect(r.ok).toBe(false);
  });

  it("set_clip_fade sets curveIn/curveOut as fadeInType/fadeOutType ints", async () => {
    const { clipId } = await waveClip();
    expect((await findClip(clipId)).fadeInType).toBe(1);   // linear default
    expect((await findClip(clipId)).fadeOutType).toBe(1);

    await exec("set_clip_fade", { clipId, curveIn: "convex" });
    expect((await findClip(clipId)).fadeInType).toBe(2);

    await exec("set_clip_fade", { clipId, curveOut: "sCurve" });
    expect((await findClip(clipId)).fadeOutType).toBe(4);
  });

  // clip-ops wave — reverse / auto-crossfade / normalize mock-bridge coverage.
  it("set_clip_reverse flips reversed and undo/redo round-trips", async () => {
    const { clipId } = await waveClip();
    expect((await findClip(clipId)).reversed).toBeFalsy();

    const r = await exec("set_clip_reverse", { clipId, reversed: true });
    expect(r.ok).toBe(true);
    expect((await findClip(clipId)).reversed).toBe(true);

    await exec("undo", {});
    expect((await findClip(clipId)).reversed).toBeFalsy();

    await exec("redo", {});
    expect((await findClip(clipId)).reversed).toBe(true);
  });

  it("set_clip_reverse errors on an unknown clipId", async () => {
    const r = await exec("set_clip_reverse", { clipId: "does-not-exist", reversed: true });
    expect(r.ok).toBe(false);
  });

  it("set_clip_crossfade flips autoCrossfade and undo/redo round-trips", async () => {
    const { clipId } = await waveClip();
    expect((await findClip(clipId)).autoCrossfade).toBeFalsy();

    const r = await exec("set_clip_crossfade", { clipId, enabled: true });
    expect(r.ok).toBe(true);
    expect((await findClip(clipId)).autoCrossfade).toBe(true);

    await exec("undo", {});
    expect((await findClip(clipId)).autoCrossfade).toBeFalsy();

    await exec("redo", {});
    expect((await findClip(clipId)).autoCrossfade).toBe(true);
  });

  it("set_clip_crossfade errors on an unknown clipId", async () => {
    const r = await exec("set_clip_crossfade", { clipId: "does-not-exist", enabled: true });
    expect(r.ok).toBe(false);
  });

  it("normalize_clip sets gainDb toward the target and undo restores the prior value", async () => {
    const { clipId } = await waveClip();

    const r = await exec("normalize_clip", { clipId, targetDb: 0 });
    expect(r.ok).toBe(true);
    const after = await findClip(clipId);
    expect(after.gainDb).toBeGreaterThan(0);   // mock assumes a -6 dBFS nominal peak

    await exec("undo", {});
    expect((await findClip(clipId)).gainDb ?? 0).toBe(0);

    await exec("redo", {});
    expect((await findClip(clipId)).gainDb).toBe(after.gainDb);
  });

  it("normalize_clip defaults targetDb to 0 when omitted", async () => {
    const { clipId } = await waveClip();
    const r = await exec("normalize_clip", { clipId });
    expect(r.ok).toBe(true);
    expect((r as CommandResult<{ gainDb: number }>).data?.gainDb).toBe(6);   // 0 - (-6)
  });

  it("normalize_clip rejects a MIDI clip", async () => {
    const { clipId } = await midiClip();
    const r = await exec("normalize_clip", { clipId, targetDb: 0 });
    expect(r.ok).toBe(false);
  });

  it("normalize_clip errors on an unknown clipId", async () => {
    const r = await exec("normalize_clip", { clipId: "does-not-exist" });
    expect(r.ok).toBe(false);
  });
});
