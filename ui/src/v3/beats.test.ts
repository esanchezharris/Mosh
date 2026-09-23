import { beforeEach, describe, expect, it } from "vitest";
import { parseDrumPattern } from "../ui/drumPatternUtil";
import { useStore } from "../store";
import { __resetMockForTests } from "../bridge.mock";
import { barPosToSec, barSeconds, meterFrom, tempoMapFrom } from "../time";
import { DEFAULT_DRUM_BEAT, dropDrumBeat } from "./beats";

const ONE_BAR_HITS = (() => {
  const parsed = parseDrumPattern(DEFAULT_DRUM_BEAT, 16, 0, 100);
  return parsed.ok ? parsed.steps.length : -1;
})();

const st = () => useStore.getState();
const clipOf = (trackId: string, clipId: string) =>
  st().snapshot!.tracks.find((t) => t.id === trackId)!.clips.find((c) => c.id === clipId)!;

describe("V3 default beat", () => {
  it("parses as one bar of three lanes with hits on every lane (anti-vacuity: the grammar is real)", () => {
    const parsed = parseDrumPattern(DEFAULT_DRUM_BEAT, 16, 0, 100);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.bars).toBe(1);
    expect(parsed.lanePitches.length).toBe(3);
    expect(parsed.steps.length).toBeGreaterThan(8);
    expect(ONE_BAR_HITS).toBe(parsed.steps.length);
  });

  describe("dropDrumBeat against the mock backend", () => {
    beforeEach(async () => { __resetMockForTests(); await st().refresh(); });

    it("adds one drum track with a FOUR-bar clip, selects it WITHOUT opening the editor; one undo removes both", async () => {
      const before = st().snapshot!;
      const dropped = await dropDrumBeat();
      expect(dropped).not.toBeNull();
      const after = st().snapshot!;
      expect(after.tracks.length).toBe(before.tracks.length + 1);
      const track = after.tracks.find((t) => t.id === dropped!.trackId)!;
      expect(track.type).toBe("drum");
      const clip = track.clips.find((c) => c.id === dropped!.clipId)!;
      // 4 bars: the length is four bars at the session meter and the one-bar pattern is tiled x4.
      expect(clip.length).toBeCloseTo(4 * barSeconds(meterFrom(after.session)), 6);
      expect(clip.notes?.length).toBe(4 * ONE_BAR_HITS);
      expect(st().selectedTrackId).toBe(track.id);
      expect([...st().selection]).toEqual([clip.id]);
      // No modal: the Drum Machine editor stays closed so Loop and Play are reachable at once.
      expect(st().editingClipId).toBeNull();
      await st().exec("undo");
      await st().refresh();
      expect(st().snapshot!.tracks.length).toBe(before.tracks.length);
    });

    it("lands on the bar at/before the playhead in a session that already has clips", async () => {
      const map = tempoMapFrom(st().snapshot!.session);
      expect(st().snapshot!.tracks.some((t) => t.clips.length > 0)).toBe(true);   // not empty (anti-vacuity)
      await st().exec("set_transport", { position: barPosToSec(map, 1.35) });
      await st().refresh();
      const dropped = await dropDrumBeat();
      expect(dropped).not.toBeNull();
      expect(clipOf(dropped!.trackId, dropped!.clipId).start).toBeCloseTo(barPosToSec(map, 1), 9);
      // a playhead a hair under a barline (float noise) still counts as that bar
      await st().exec("set_transport", { position: barPosToSec(map, 3) - 1e-9 });
      await st().refresh();
      const again = await dropDrumBeat();
      expect(clipOf(again!.trackId, again!.clipId).start).toBeCloseTo(barPosToSec(map, 3), 9);
    });

    it("an EMPTY session drops at bar 1 whatever the playhead, and the loop region becomes the clip (looping stays off)", async () => {
      await st().exec("new_project", {});
      await st().refresh();
      expect(st().snapshot!.tracks.length).toBe(0);
      await st().exec("set_transport", { position: 5.3 });
      await st().refresh();
      expect(st().transport.position).toBeCloseTo(5.3, 9);   // the playhead really is past bar 1 (anti-vacuity)
      expect(st().transport.loopEnd - st().transport.loopStart).toBeLessThanOrEqual(1e-6);  // no region yet
      const dropped = await dropDrumBeat();
      expect(dropped).not.toBeNull();
      const clip = clipOf(dropped!.trackId, dropped!.clipId);
      expect(clip.start).toBe(0);
      await st().refresh();
      const t = st().transport;
      expect(t.loopStart).toBeCloseTo(clip.start, 9);
      expect(t.loopEnd).toBeCloseTo(clip.start + clip.length, 9);
      expect(t.looping).toBe(false);                    // the region only: the demo presses Loop
    });

    it("keeps an existing loop region (and its looping state) untouched", async () => {
      await st().exec("set_transport", { loop: true, loopStart: 2, loopEnd: 6 });
      const dropped = await dropDrumBeat();
      expect(dropped).not.toBeNull();
      await st().refresh();
      const t = st().transport;
      expect([t.looping, t.loopStart, t.loopEnd]).toEqual([true, 2, 6]);
    });

    // fixCheck A1: with Loop ON the beat belongs IN the loop. The bar under a playhead that has
    // been cycling the loop is arbitrary, so a beat dropped there lands partly or wholly outside
    // the loop and the loop plays silence where it should play the new part.
    it("with Loop ON, drops at the loop start and spans the loop — a mid-loop playhead does not move it", async () => {
      const map = tempoMapFrom(st().snapshot!.session);
      const meter = meterFrom(st().snapshot!.session);
      await st().exec("set_transport", { loop: true, loopStart: barPosToSec(map, 2), loopEnd: barPosToSec(map, 4) });
      await st().exec("set_transport", { position: barPosToSec(map, 3.4) });
      await st().refresh();
      expect(st().transport.looping).toBe(true);                                   // anti-vacuity: Loop is on
      expect(st().transport.position).toBeCloseTo(barPosToSec(map, 3.4), 9);     // and the playhead is mid-loop
      expect(st().snapshot!.tracks.some((t) => t.clips.length > 0)).toBe(true);  // not the empty-session rule
      const dropped = await dropDrumBeat();
      expect(dropped).not.toBeNull();
      const clip = clipOf(dropped!.trackId, dropped!.clipId);
      expect(clip.start).toBeCloseTo(barPosToSec(map, 2), 9);
      expect(clip.length).toBeCloseTo(2 * barSeconds(meter), 6);
      expect(clip.notes?.length).toBe(2 * ONE_BAR_HITS);
    });

    it("with Loop ON over more than 16 bars the beat caps at 16 (the engine's limit); Loop OFF keeps the playhead rule", async () => {
      const map = tempoMapFrom(st().snapshot!.session);
      const meter = meterFrom(st().snapshot!.session);
      await st().exec("set_transport", { loop: true, loopStart: 0, loopEnd: barPosToSec(map, 20) });
      await st().refresh();
      const long = await dropDrumBeat();
      expect(long).not.toBeNull();
      const clip = clipOf(long!.trackId, long!.clipId);
      expect(clip.start).toBe(0);
      expect(clip.length).toBeCloseTo(16 * barSeconds(meter), 6);
      // the same region with Loop OFF: back to four bars at the bar under the playhead
      await st().exec("set_transport", { loop: false, loopStart: 0, loopEnd: barPosToSec(map, 20) });
      await st().exec("set_transport", { position: barPosToSec(map, 5.5) });
      await st().refresh();
      expect(st().transport.looping).toBe(false);
      const off = await dropDrumBeat();
      const offClip = clipOf(off!.trackId, off!.clipId);
      expect(offClip.start).toBeCloseTo(barPosToSec(map, 5), 9);
      expect(offClip.length).toBeCloseTo(4 * barSeconds(meter), 6);
    });
  });
});
