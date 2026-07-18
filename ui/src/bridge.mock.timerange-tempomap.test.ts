import { describe, it, expect, beforeEach } from "vitest";
import { mockExecute, mockSnapshot, __resetMockForTests } from "./bridge.mock";
import type { CommandResult, Snapshot } from "./types";

// Phase-A catalog closure — mock-bridge parity for the newly agent-callable
// commands: delete_time_range (all-tracks range delete + opt-in ripple),
// insert_tempo_change / remove_tempo_change (the SES-001 tempo map), and the
// opt-in ripple flag on trim_clip. Error strings mirror the native handlers
// (MoshOps.cpp) so bench error-rate scoring is substrate-consistent.

const exec = <T = CommandResult>(command: string, args: Record<string, unknown> = {}) =>
  mockExecute<T>({ command, args });

const snap = () => mockSnapshot<Snapshot>();

async function clipsOf(trackName: string) {
  const s = await snap();
  return s.tracks.find((t) => t.name === trackName)!.clips;
}

describe("tempo map — insert_tempo_change / remove_tempo_change via the mock bridge", () => {
  beforeEach(() => __resetMockForTests());

  it("a fresh snapshot carries session.tempoMap with the base point", async () => {
    const s = await snap();
    expect(s.session.tempoMap).toEqual([{ time: 0, bpm: 120, curve: 1 }]);
  });

  it("insert_tempo_change appends a time-sorted point; undo/redo round-trips", async () => {
    const r = await exec("insert_tempo_change", { time: 8, bpm: 140 });
    expect(r.ok).toBe(true);
    let s = await snap();
    expect(s.session.tempoMap).toEqual([
      { time: 0, bpm: 120, curve: 1 },
      { time: 8, bpm: 140, curve: 1 },
    ]);

    // Inserting earlier in time lands in sorted position, not at the end.
    await exec("insert_tempo_change", { time: 4, bpm: 100, curve: 0 });
    s = await snap();
    expect(s.session.tempoMap!.map((p) => p.time)).toEqual([0, 4, 8]);
    expect(s.session.tempoMap![1]).toEqual({ time: 4, bpm: 100, curve: 0 });

    const u = await exec("undo");
    expect(u.ok).toBe(true);
    s = await snap();
    expect(s.session.tempoMap!.map((p) => p.time)).toEqual([0, 8]);

    const rd = await exec("redo");
    expect(rd.ok).toBe(true);
    s = await snap();
    expect(s.session.tempoMap!.map((p) => p.time)).toEqual([0, 4, 8]);
  });

  it("insert_tempo_change validates bpm and time with the native error strings", async () => {
    const badBpm = await exec("insert_tempo_change", { time: 8, bpm: 5 });
    expect(badBpm.ok).toBe(false);
    expect(badBpm.error).toBe("bpm must be 20..999");

    const noTime = await exec("insert_tempo_change", { bpm: 140 });
    expect(noTime.ok).toBe(false);
    expect(noTime.error).toBe("missing/negative 'time'");
  });

  it("set_tempo keeps the base tempo-map point in sync (point 0 IS the base tempo)", async () => {
    await exec("set_tempo", { bpm: 95 });
    const s = await snap();
    expect(s.session.tempo).toBe(95);
    expect(s.session.tempoMap![0]).toEqual({ time: 0, bpm: 95, curve: 1 });
  });

  it("remove_tempo_change refuses the base point and removes a real one", async () => {
    const base = await exec("remove_tempo_change", { index: 0 });
    expect(base.ok).toBe(false);
    expect(base.error).toBe("index must be 1..numTempos-1");

    await exec("insert_tempo_change", { time: 8, bpm: 140 });
    const r = await exec("remove_tempo_change", { index: 1 });
    expect(r.ok).toBe(true);
    const s = await snap();
    expect(s.session.tempoMap).toEqual([{ time: 0, bpm: 120, curve: 1 }]);
  });
});

describe("delete_time_range via the mock bridge", () => {
  beforeEach(() => __resetMockForTests());

  it("rejects start >= end with the native error string", async () => {
    const r = await exec("delete_time_range", { start: 8, end: 8 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("start must be less than end");
  });

  it("clears the span across ALL tracks, splitting straddling clips at the bounds", async () => {
    // Seed: Drums [0,8], Bass [0,8], Keys [2,8]. Delete [3,5].
    const r = await exec("delete_time_range", { start: 3, end: 5 });
    expect(r.ok).toBe(true);

    for (const name of ["Drums", "Bass", "Keys"]) {
      const clips = await clipsOf(name);
      for (const c of clips) {
        const overlaps = c.start < 5 && c.start + c.length > 3;
        expect(overlaps, `${name} clip [${c.start}, ${c.start + c.length}] overlaps the deleted range`).toBe(false);
      }
    }
    // Straddling clips keep both outside pieces.
    const drums = await clipsOf("Drums");
    expect(drums.map((c) => [c.start, c.start + c.length]).sort((a, b) => a[0] - b[0]))
      .toEqual([[0, 3], [5, 8]]);
    const keys = await clipsOf("Keys");
    expect(keys.map((c) => [c.start, c.start + c.length]).sort((a, b) => a[0] - b[0]))
      .toEqual([[2, 3], [5, 8]]);
  });

  it("a wave clip's right piece advances its source offset by the removed span position", async () => {
    await exec("delete_time_range", { start: 3, end: 5 });
    const keys = await clipsOf("Keys"); // wave clip, originally [2,8] offset 0
    const right = keys.find((c) => c.start === 5)!;
    expect(right.offset).toBe(3); // source continues from 3s into the file (5 - clipStart 2)
  });

  it("ripple:true closes the gap — downstream clips slide left by the range length", async () => {
    const r = await exec("delete_time_range", { start: 3, end: 5, ripple: true });
    expect(r.ok).toBe(true);
    const drums = await clipsOf("Drums");
    expect(drums.map((c) => [c.start, c.start + c.length]).sort((a, b) => a[0] - b[0]))
      .toEqual([[0, 3], [3, 6]]); // right piece [5,8] slid left by 2
  });

  it("undo restores every split/removed clip in one step", async () => {
    const before = JSON.stringify((await snap()).tracks.map((t) => t.clips));
    await exec("delete_time_range", { start: 3, end: 5, ripple: true });
    const u = await exec("undo");
    expect(u.ok).toBe(true);
    const after = JSON.stringify((await snap()).tracks.map((t) => t.clips));
    expect(after).toBe(before);
  });
});

describe("trim_clip ripple via the mock bridge", () => {
  beforeEach(() => __resetMockForTests());

  async function twoClipTrack() {
    const tr = await exec<CommandResult>("create_track", { name: "Ripple" });
    const trackId = (tr.data as { trackId: string }).trackId;
    const c1 = await exec<CommandResult>("add_test_tone_clip", { trackId, start: 0, seconds: 4 });
    const c2 = await exec<CommandResult>("add_test_tone_clip", { trackId, start: 4, seconds: 2 });
    return {
      trackId,
      c1: (c1.data as { clipId: string }).clipId,
      c2: (c2.data as { clipId: string }).clipId,
    };
  }

  it("ripple:true pulls the same-track neighbor by the end delta", async () => {
    const { c1, c2 } = await twoClipTrack();
    const r = await exec("trim_clip", { clipId: c1, start: 0, length: 2, ripple: true });
    expect(r.ok).toBe(true);
    const s = await snap();
    const clips = s.tracks.find((t) => t.name === "Ripple")!.clips;
    expect(clips.find((c) => c.id === c2)!.start).toBe(2); // followed the end left by 2s
  });

  it("without ripple the neighbor stays put (default path unchanged)", async () => {
    const { c1, c2 } = await twoClipTrack();
    await exec("trim_clip", { clipId: c1, start: 0, length: 2 });
    const s = await snap();
    const clips = s.tracks.find((t) => t.name === "Ripple")!.clips;
    expect(clips.find((c) => c.id === c2)!.start).toBe(4);
  });
});
