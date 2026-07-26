// G7 — mock-bridge parity for export_stems.
//
// The mock is what vitest and Playwright actually run against, so a mock that is merely
// plausible makes every test written on top of it vacuous. This one had drifted from the
// native handler in two ways that both produced a green suite and a wrong app:
//
//   • it filtered `t.type === "audio"`, silently dropping DRUM tracks. Native has no type
//     filter — trackType is a ValueTree property, and a drum track is the same te::AudioTrack
//     underneath — so a beat simply never got a stem here while it did in the real app;
//   • it returned `files: string[]` where native returns `stems: [{trackId, name, index,
//     file, bytes}]`, so UI code reading data.stems saw undefined under test and worked live.
//
// These pin both, plus the index rule that is easy to "tidy" into a bug.

import { describe, it, expect, beforeEach } from "vitest";
import { mockExecute, mockSnapshot, __resetMockForTests } from "./bridge.mock";
import type { CommandResult, Snapshot } from "./types";

type Stem = { trackId: string; name: string; index: number; file: string; bytes: number };
type StemsData = { dir: string; format: string; count: number; stems: Stem[] };

const exec = <T = CommandResult>(command: string, args: Record<string, unknown> = {}) =>
  mockExecute<T>({ command, args });
const snap = () => mockSnapshot<Snapshot>();

const stems = async (args: Record<string, unknown> = {}) => {
  const r = await exec("export_stems", args);
  expect(r.ok, `export_stems failed: ${(r as { error?: string }).error}`).toBe(true);
  return r.data as unknown as StemsData;
};

describe("export_stems — mock parity", () => {
  beforeEach(() => __resetMockForTests());

  it("exports EVERY track that holds clips, drum tracks included", async () => {
    // The seed is Drums (type "drum") + Bass + Keys. The old `type === "audio"` filter
    // reported 2 here and dropped the beat — the exact failure this pins.
    const d = await stems();
    expect(d.count).toBe(3);
    expect(d.stems.map((s) => s.name)).toEqual(["Drums", "Bass", "Keys"]);
  });

  it("returns the native envelope shape, not a bare filename list", async () => {
    const d = await stems();
    expect(Array.isArray(d.stems)).toBe(true);
    expect((d as unknown as { files?: unknown }).files, "still returning the old files[] shape").toBeUndefined();
    const first = d.stems[0];
    expect(Object.keys(first).sort()).toEqual(["bytes", "file", "index", "logicalId", "name", "trackId"]);
    expect(first.trackId).toBeTruthy();
    expect(first.file).toContain(d.dir);
    expect(first.file.endsWith(".wav")).toBe(true);
  });

  it("names files with a zero-padded index, matching stemFileBaseName", async () => {
    const d = await stems();
    expect(d.stems[0].file.split("/").pop()).toBe("00-Drums.wav");
    expect(d.stems[2].file.split("/").pop()).toBe("02-Keys.wav");
  });

  it("skips an empty track and LEAVES A GAP in the indices", async () => {
    // Native assigns myIndex before the empty-skip (`const int myIndex = index++;` precedes
    // the `continue`), so emptying the middle track yields 00 and 02 — not 00 and 01. The
    // index is what keeps two same-named tracks from colliding, so it must track position.
    const s = await snap();
    const bass = s.tracks.find((t) => t.name === "Bass")!;
    await exec("remove_clip", { clipId: bass.clips[0].id });

    const d = await stems();
    expect(d.count).toBe(2);
    expect(d.stems.map((x) => x.name)).toEqual(["Drums", "Keys"]);
    expect(d.stems.map((x) => x.index), "renumbered instead of preserving track position").toEqual([0, 2]);
  });

  it("includeEmpty takes the silent track back, with no gap", async () => {
    const s = await snap();
    const bass = s.tracks.find((t) => t.name === "Bass")!;
    await exec("remove_clip", { clipId: bass.clips[0].id });

    const d = await stems({ includeEmpty: true });
    expect(d.count).toBe(3);
    expect(d.stems.map((x) => x.index)).toEqual([0, 1, 2]);
  });

  it("errors like native when nothing is renderable", async () => {
    const s = await snap();
    for (const t of s.tracks) for (const c of t.clips ?? []) await exec("remove_clip", { clipId: c.id });
    const r = await exec("export_stems");
    expect(r.ok).toBe(false);
    expect((r as { error?: string }).error).toBe("no renderable tracks (all empty or hidden)");
  });

  it("honours the requested format in both the envelope and the filenames", async () => {
    const d = await stems({ format: "flac" });
    expect(d.format).toBe("flac");
    expect(d.stems.every((x) => x.file.endsWith(".flac"))).toBe(true);
  });
});
