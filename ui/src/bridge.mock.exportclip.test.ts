// IMP-001 — mock-bridge parity for export_clip_consolidated.
//
// The contract the UI (and Re-Imagine's Import Take on the other side) relies on: the
// file ALWAYS starts at edit time zero, the clip's position is reported as where the
// audio begins inside the file, and frames = endSeconds × sampleRate. A mock that
// returned the clip's own start as startSeconds would make the whole "lands at bar 1"
// promise untestable here while being wrong live.

import { describe, it, expect, beforeEach } from "vitest";
import { mockExecute, mockSnapshot, __resetMockForTests } from "./bridge.mock";
import type { CommandResult, Snapshot } from "./types";

type ClipExport = {
  file: string; clipId: string; startSeconds: number; clipStartSeconds: number;
  endSeconds: number; sampleRate: number; bitDepth: number; frames: number;
};

const exec = <T = CommandResult>(command: string, args: Record<string, unknown> = {}) =>
  mockExecute<T>({ command, args });
const snap = () => mockSnapshot<Snapshot>();

const firstClip = async () => {
  const s = await snap();
  const t = s.tracks.find((tr) => tr.clips.length > 0)!;
  return t.clips[0];
};

describe("export_clip_consolidated — mock parity", () => {
  beforeEach(() => __resetMockForTests());

  it("starts at edit time zero and embeds the clip position as leading silence", async () => {
    const clip = await firstClip();
    const r = await exec("export_clip_consolidated", { clipId: clip.id, sampleRate: 48000 });
    expect(r.ok, (r as { error?: string }).error).toBe(true);
    const d = r.data as unknown as ClipExport;
    expect(d.startSeconds).toBe(0);
    expect(d.clipStartSeconds).toBeCloseTo(clip.start, 6);
    expect(d.endSeconds).toBeCloseTo(clip.start + clip.length, 6);
    expect(d.frames).toBe(Math.round(d.endSeconds * 48000));
    expect(d.sampleRate).toBe(48000);
    expect(d.bitDepth).toBe(24);
    expect(d.file.endsWith(".wav")).toBe(true);
  });

  it("adds an optional tail and refuses junk", async () => {
    const clip = await firstClip();
    const withTail = await exec("export_clip_consolidated", { clipId: clip.id, tailSeconds: 2 });
    expect(withTail.ok).toBe(true);
    expect((withTail.data as unknown as ClipExport).endSeconds).toBeCloseTo(clip.start + clip.length + 2, 6);

    const unknown = await exec("export_clip_consolidated", { clipId: "nope" });
    expect(unknown.ok).toBe(false);

    const badDepth = await exec("export_clip_consolidated", { clipId: clip.id, bitDepth: 12 });
    expect(badDepth.ok).toBe(false);
  });
});
