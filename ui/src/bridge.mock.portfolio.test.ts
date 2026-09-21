// ?mockSeed=portfolio — the Song A showcase session (mock/portfolioSeed.ts) and the real
// stem peaks behind its wave clips (mock/fixturePeaks.ts). The default 3-track seed must
// stay the boot session for every other lane (the smoke asserts 3 tracks).
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandResult, Snapshot } from "./types";
import { PORTFOLIO_BARS, PORTFOLIO_BAR_SEC, barSpan, barStartSec, drumPattern, bassLine, portfolioSeed, portfolioTracks } from "./mock/portfolioSeed";
import { fixturePeaks, fixturePeaksForClip, fixtureStemOf } from "./mock/fixturePeaks";
import { isDrumClip } from "./ui/clipRenderers";

const rows = (s: Snapshot) => s.tracks.filter((t) => !t.isReturn);
const amp = (p: [number, number][]) => p.map(([lo, hi]) => Math.max(-lo, hi));

describe("portfolio seed — the Song A session", () => {
  it("lays out seven rows, two return buses with sends, chains, and sections covering the song", async () => {
    const { mockSnapshot } = await import("./bridge.mock");
    const base = await mockSnapshot<Snapshot>();
    const s = portfolioSeed(base);
    expect(rows(s).map((t) => t.name)).toEqual(["Beat", "Drums", "808", "Lead", "Double", "Backgrounds", "Ref"]);
    expect(s.buses?.map((b) => b.name)).toEqual(["Reverb", "Delay"]);
    for (const b of s.buses!) expect(s.tracks.find((t) => t.id === b.trackId)?.returnBus).toBe(b.bus);
    const lead = rows(s)[3];
    expect(lead.sends?.map((x) => [x.bus, x.db])).toEqual([[0, -12], [1, -18]]);
    expect(lead.plugins?.map((p) => p.name)).toEqual(["Mosh AutoTune", "Compressor", "4-Band EQ"]);
    expect(lead.plugins![1].params.slice(0, 4).map((p) => p.name)).toEqual(["Threshold", "Ratio", "Attack", "Release"]);   // the engine's names, not Drive/Tone
    const eight = rows(s)[2];
    expect(eight.isInstrument).toBe(true);
    expect(eight.plugins![0]).toMatchObject({ name: "4OSC", builtin: true, isInstrument: true });
    expect(eight.plugins![0].params).toHaveLength(8);
    expect(rows(s)[6].mute).toBe(true);
    expect(s.session.tempo).toBe(145);
    expect(s.session.editFile).toBe("/mock/greg.mosh");
    // Sections tile the whole song without gaps, in order.
    const secs = s.sections!;
    expect(secs[0].startBeat).toBe(0);
    for (let i = 1; i < secs.length; i++) expect(secs[i].startBeat).toBe(secs[i - 1].endBeat);
    expect(secs[secs.length - 1].endBeat).toBe(PORTFOLIO_BARS * 4);
    expect(s.session.length!).toBeCloseTo(PORTFOLIO_BARS * PORTFOLIO_BAR_SEC, 1);
    // The default seed did not change.
    expect(base.tracks).toHaveLength(3);
  });

  it("cuts every wave clip inside its stem and keeps clips on a track from overlapping", () => {
    for (const t of portfolioTracks()) {
      const sorted = [...t.clips].sort((a, b) => a.start - b.start);
      for (let i = 0; i < sorted.length; i++) {
        const c = sorted[i];
        if (c.type === "wave") {
          expect(fixtureStemOf(c.sourceFile)).not.toBeNull();
          expect(c.offset + c.length).toBeLessThanOrEqual(c.sourceLength! + 1e-6);
        }
        if (i > 0) expect(c.start).toBeGreaterThanOrEqual(sorted[i - 1].start + sorted[i - 1].length - 1e-9);
      }
    }
    expect(barStartSec(1)).toBe(0);
    expect(barSpan(4, 24)).toEqual({ start: 3 * PORTFOLIO_BAR_SEC, length: 21 * PORTFOLIO_BAR_SEC });
  });

  it("renders Drums as a drum grid and 808 as note blocks (the two MIDI renderers)", () => {
    expect(isDrumClip(drumPattern(4))).toBe(true);
    expect(isDrumClip(bassLine(4))).toBe(false);
    expect(drumPattern(21).every((n) => n.start < 21 * 4)).toBe(true);
    expect(bassLine(21).every((n) => n.start < 21 * 4)).toBe(true);
  });

  it("draws REAL stem peaks: silence where the vocal is silent, signal where it sings", () => {
    const silent = fixturePeaks("lead", barStartSec(54), 3 * PORTFOLIO_BAR_SEC, 8);   // the lead's last bars are empty
    expect(amp(silent).every((a) => a < 0.01)).toBe(true);
    const hook = fixturePeaks("lead", barStartSec(12), 8 * PORTFOLIO_BAR_SEC, 32);
    expect(amp(hook).filter((a) => a > 0.1).length).toBeGreaterThan(24);
    const whole = fixturePeaks("rough", 0, 92.69, 1);                                // one bucket = the global extremes
    expect(Math.max(-whole[0][0], whole[0][1])).toBeCloseTo(1, 2);
    const lead = portfolioTracks()[3];
    expect(fixturePeaksForClip(lead.clips[1], 16)).toHaveLength(16);
    expect(fixturePeaksForClip({ ...lead.clips[1], sourceFile: "/mock/chords.wav" }, 16)).toBeNull();
  });

  describe("URL switch", () => {
    afterEach(() => { vi.resetModules(); window.history.replaceState({}, "", "/"); });
    it("?mockSeed=portfolio boots the showcase and get_clip_peaks serves fixture peaks", async () => {
      vi.resetModules();
      window.history.replaceState({}, "", "/?mockSeed=portfolio");
      const m = await import("./bridge.mock");
      const s = await m.mockSnapshot<Snapshot>();
      expect(rows(s)).toHaveLength(7);
      const ref = rows(s)[6].clips[0];
      const r = await m.mockExecute<CommandResult<{ peaks: [number, number][] }>>({ command: "get_clip_peaks", args: { clipId: ref.id, buckets: 56 } });
      expect(r.ok).toBe(true);
      const a = amp(r.data!.peaks);
      expect(a[0]).toBeLessThan(a[10] * 0.6);    // the intro is quieter than the drop — a synthetic sine has no such structure
      expect(a[25]).toBeLessThan(a[30] * 0.7);   // …and so is the break at bars 25–27 (per-bar RMS from song_a_peaks.py)
    });
  });
});
