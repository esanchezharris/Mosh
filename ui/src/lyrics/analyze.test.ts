import { describe, it, expect } from "vitest";
import { __resetMockForTests, mockExecute, mockSnapshot } from "../bridge.mock";
import type { CommandResult, Snapshot, LyricLine } from "../types";

// L1 — analyze_lyrics lands precise per-line phonology (the flow-visualizer feed) as a
// transient `analysis` blob on each line → snapshot. Exercised through the mock seam (the
// same command/snapshot contract the native engine exposes); the real precise path is the
// phonology service (golden: service/lyrics/analyze_test.py).

async function trackWithSheet(): Promise<string> {
  __resetMockForTests();
  const created = await mockExecute<CommandResult<{ trackId: string }>>({ command: "create_track", args: { name: "Vox" } });
  const trackId = created.data?.trackId ?? "";
  await mockExecute<CommandResult>({ command: "create_lyric_sheet", args: { trackId } });
  return trackId;
}

async function lyricLines(trackId: string): Promise<LyricLine[]> {
  const snap = await mockSnapshot<Snapshot>();
  return snap.tracks.find((t) => t.id === trackId)?.lyricSheet?.lines ?? [];
}

describe("analyze_lyrics (mock seam)", () => {
  it("lands a precise analysis blob on every line", async () => {
    const trackId = await trackWithSheet();
    // line 0: a finalized hook ending on the group-A anchor; line 1: a gapped seed.
    await mockExecute<CommandResult>({ command: "set_lyric_line", args: { trackId, lineIndex: 0, text: "lighting up the flame", rhymeGroup: "A", syllableTarget: 5 } });
    await mockExecute<CommandResult>({ command: "set_lyric_line", args: { trackId, lineIndex: 1, seedText: "rising up the ___", rhymeGroup: "A", syllableTarget: 5 } });

    const res = await mockExecute<CommandResult<{ status: string; lineCount: number }>>({ command: "analyze_lyrics", args: { trackId } });
    expect(res.ok).toBe(true);
    expect(res.data?.lineCount).toBe(2);

    const lines = await lyricLines(trackId);
    expect(lines).toHaveLength(2);
    for (const l of lines) {
      expect(l.analysis).toBeTruthy();
      expect(typeof l.analysis!.syllables).toBe("number");
      expect(l.analysis!.target).toBe(5);
      expect(l.analysis!.words.length).toBeGreaterThan(0);
      // a per-word stress contour string is the visualizer's dot row
      expect(l.analysis!.stress.length).toBe(l.analysis!.words.reduce((s, w) => s + w.syllables, 0));
    }
  });

  it("marks the group's fixed end as the anchor + flags a gapped seed incomplete", async () => {
    const trackId = await trackWithSheet();
    await mockExecute<CommandResult>({ command: "set_lyric_line", args: { trackId, lineIndex: 0, text: "lighting up the flame", rhymeGroup: "A" } });
    await mockExecute<CommandResult>({ command: "set_lyric_line", args: { trackId, lineIndex: 1, seedText: "rising up the ___", rhymeGroup: "A" } });
    await mockExecute<CommandResult>({ command: "analyze_lyrics", args: { trackId } });

    const [anchorLine, gappedLine] = await lyricLines(trackId);
    expect(anchorLine.analysis!.rhymeGrade).toBe("anchor"); // its end IS the group anchor
    expect(anchorLine.analysis!.complete).toBe(true);
    expect(gappedLine.analysis!.analyzed).toBe("seed");
    expect(gappedLine.analysis!.hasGap).toBe(true);
    expect(gappedLine.analysis!.complete).toBe(false); // gaps remain
  });

  it("errors cleanly when the track has no lyric sheet", async () => {
    __resetMockForTests();
    const created = await mockExecute<CommandResult<{ trackId: string }>>({ command: "create_track", args: { name: "NoSheet" } });
    const res = await mockExecute<CommandResult>({ command: "analyze_lyrics", args: { trackId: created.data?.trackId } });
    expect(res.ok).toBe(false);
  });
});
