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

// CAP-CLP-017 — insert_time is delete_time_range's inverse, so it is proven against the
// same seeded mock arrangement: Drums [0,8], Bass [0,8] (MIDI), Keys [2,8], sections
// Intro 0..8 / Verse 8..24 / Hook 24..40 beats, one annotation at beat 24, 120 BPM.
//
// What this file can and cannot say: the mock reproduces the STRUCTURE (clips, automation
// points, tempo map, beat-anchored sections/annotations, loop range). It cannot say
// anything about the engine — in particular the un-sorted-clip-list hazard the native
// handler exists to dodge has no analogue in a JS array. That case is proven in
// `Mosh --selftest` against the real ClipTrack.
describe("insert_time via the mock bridge", () => {
  beforeEach(() => __resetMockForTests());

  it("rejects a non-positive duration and a negative start with the native error strings", async () => {
    expect((await exec("insert_time", { start: 4, duration: 0 })).error).toBe("duration must be greater than 0");
    expect((await exec("insert_time", { start: 4, duration: -1 })).error).toBe("duration must be greater than 0");
    expect((await exec("insert_time", { start: -1, duration: 2 })).error).toBe("start must be >= 0");
  });

  it("a rejected call mutates nothing", async () => {
    const before = JSON.stringify((await snap()).tracks);
    await exec("insert_time", { start: 4, duration: 0 });
    expect(JSON.stringify((await snap()).tracks)).toBe(before);
  });

  it("splits the straddling clip and moves everything after the point by EXACTLY the duration", async () => {
    // Keys is [2,8]; inserting 2s at 4 splits it into [2,4] + [4,6]->[6,10].
    const r = await exec("insert_time", { start: 4, duration: 2 });
    expect(r.ok).toBe(true);
    const keys = await clipsOf("Keys");
    expect(keys.map((c) => [c.start, c.start + c.length]).sort((a, b) => a[0] - b[0]))
      .toEqual([[2, 4], [6, 10]]);
    // …on EVERY track, not just the one.
    const drums = await clipsOf("Drums");
    expect(drums.map((c) => [c.start, c.start + c.length]).sort((a, b) => a[0] - b[0]))
      .toEqual([[0, 4], [6, 10]]);
  });

  it("a clip entirely before the point does not move at all", async () => {
    const tr = await exec<CommandResult>("create_track", { name: "Early" });
    const trackId = (tr.data as { trackId: string }).trackId;
    await exec("add_test_tone_clip", { trackId, start: 0, seconds: 1 });
    await exec("insert_time", { start: 4, duration: 2 });
    const clips = await clipsOf("Early");
    expect(clips.map((c) => [c.start, c.start + c.length])).toEqual([[0, 1]]);
  });

  it("holds an automation value FLAT across the inserted space instead of stretching the ramp", async () => {
    const tr = await exec<CommandResult>("create_track", { name: "Auto" });
    const trackId = (tr.data as { trackId: string }).trackId;
    await exec("load_builtin", { trackId, type: "compressor" });
    await exec("add_automation_point", { trackId, pluginIndex: 0, paramIndex: 0, time: 1, value: 0.2 });
    await exec("add_automation_point", { trackId, pluginIndex: 0, paramIndex: 0, time: 6, value: 0.8 });

    await exec("insert_time", { start: 5, duration: 2 });
    const s = await snap();
    const pts = s.tracks.find((t) => t.name === "Auto")!.plugins![0].params!
      .find((p) => p.index === 0)!.points!;
    expect(pts.map((p) => p.t)).toEqual([1, 5, 7, 8]);   // 1 held, 6 -> 8, holds at both edges
    expect(pts[1].v).toBeCloseTo(pts[2].v, 6);           // FLAT across [5,7]
    expect(pts[1].v).toBeCloseTo(0.68, 2);               // the value in force at the insertion point
  });

  it("moves tempo changes, beat-anchored sections/annotations and the loop region", async () => {
    await exec("insert_tempo_change", { time: 8, bpm: 140 });
    await exec("set_transport", { loop: true, loopStart: 6, loopEnd: 10 });
    // 120 BPM ⇒ 2 beats/s. Insert 2s at 4s = beat 8 ⇒ +4 beats after beat 8.
    const r = await exec<CommandResult>("insert_time", { start: 4, duration: 2 });
    expect(r.ok).toBe(true);
    const s = await snap();
    expect(s.session.tempoMap!.map((p) => p.time)).toEqual([0, 10]);
    const byName = Object.fromEntries(s.sections!.map((x) => [x.name, [x.startBeat, x.endBeat]]));
    expect(byName.Intro).toEqual([0, 8]);      // ends AT the point — entirely before, untouched
    expect(byName.Verse).toEqual([12, 28]);    // starts AT the point — moves WHOLE (same rule as a clip)
    expect(byName.Hook).toEqual([28, 44]);     // after — moves whole
    expect(s.annotations![0].beat).toBe(28);
    expect([s.transport.loopStart, s.transport.loopEnd]).toEqual([8, 12]);  // 6..10 is wholly after 4s
    expect((r.data as { loopShifted: boolean }).loopShifted).toBe(true);
  });

  it("a straddling loop region GROWS (its start holds, only its end moves)", async () => {
    await exec("set_transport", { loop: true, loopStart: 2, loopEnd: 10 });
    await exec("insert_time", { start: 4, duration: 2 });
    const s = await snap();
    expect([s.transport.loopStart, s.transport.loopEnd]).toEqual([2, 12]);
  });

  it("trackIds scopes the insert to those tracks and leaves the project-global structures alone", async () => {
    const s0 = await snap();
    const keysId = s0.tracks.find((t) => t.name === "Keys")!.id;
    await exec("set_transport", { loop: true, loopStart: 6, loopEnd: 10 });
    const r = await exec<CommandResult>("insert_time", { start: 4, duration: 2, trackIds: [keysId] });
    expect(r.ok).toBe(true);
    expect((r.data as { scoped: boolean }).scoped).toBe(true);

    expect((await clipsOf("Keys")).map((c) => [c.start, c.start + c.length]).sort((a, b) => a[0] - b[0]))
      .toEqual([[2, 4], [6, 10]]);
    expect((await clipsOf("Drums")).map((c) => [c.start, c.start + c.length]))
      .toEqual([[0, 8]]);                                     // unnamed track untouched
    const s = await snap();
    expect(s.sections!.map((x) => x.startBeat)).toEqual([0, 8, 24]);
    expect(s.annotations![0].beat).toBe(24);
    expect([s.transport.loopStart, s.transport.loopEnd]).toEqual([6, 10]);
  });

  it("undo restores the whole timeline in one step", async () => {
    await exec("insert_tempo_change", { time: 8, bpm: 140 });
    await exec("set_transport", { loop: true, loopStart: 6, loopEnd: 10 });
    const key = async () => {
      const s = await snap();
      return JSON.stringify([s.tracks.map((t) => t.clips), s.sections, s.annotations,
                             s.session.tempoMap, s.transport.loopStart, s.transport.loopEnd]);
    };
    const before = await key();
    await exec("insert_time", { start: 4, duration: 2 });
    expect(await key()).not.toBe(before);
    expect((await exec("undo")).ok).toBe(true);
    expect(await key()).toBe(before);
  });
});

describe("move_clip ripple via the mock bridge", () => {
  beforeEach(() => __resetMockForTests());

  async function threeClipTrack() {
    const tr = await exec<CommandResult>("create_track", { name: "MoveRipple" });
    const trackId = (tr.data as { trackId: string }).trackId;
    const a = await exec<CommandResult>("add_test_tone_clip", { trackId, start: 0, seconds: 1 });
    await exec("add_test_tone_clip", { trackId, start: 2, seconds: 1 });
    await exec("add_test_tone_clip", { trackId, start: 4, seconds: 1 });
    return { trackId, a: (a.data as { clipId: string }).clipId };
  }
  const startsOf = async () =>
    (await clipsOf("MoveRipple")).map((c) => c.start).sort((x, y) => x - y);

  it("a plain move leaves the neighbours where they are", async () => {
    const { a } = await threeClipTrack();
    await exec("move_clip", { clipId: a, start: 6 });
    expect(await startsOf()).toEqual([2, 4, 6]);
  });

  it("ripple:true carries the later same-track clips by exactly the move distance", async () => {
    const { a } = await threeClipTrack();
    const r = await exec("move_clip", { clipId: a, start: 3, ripple: true });
    expect(r.ok).toBe(true);
    expect(await startsOf()).toEqual([3, 5, 7]);
  });

  it("one undo reverts the move AND the shift", async () => {
    const { a } = await threeClipTrack();
    await exec("move_clip", { clipId: a, start: 3, ripple: true });
    expect((await exec("undo")).ok).toBe(true);
    expect(await startsOf()).toEqual([0, 2, 4]);
  });

  it("refuses ripple across a track change, with no side effect", async () => {
    const { a } = await threeClipTrack();
    const other = (await snap()).tracks.find((t) => t.name === "Drums")!.id;
    const before = await startsOf();
    const r = await exec("move_clip", { clipId: a, start: 8, trackId: other, ripple: true });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("ripple:true cannot be combined with a move to another track");
    expect(await startsOf()).toEqual(before);
  });

  it("allows ripple when the explicit trackId is the clip's OWN track", async () => {
    const { trackId, a } = await threeClipTrack();
    const r = await exec("move_clip", { clipId: a, start: 3, trackId, ripple: true });
    expect(r.ok).toBe(true);
    expect(await startsOf()).toEqual([3, 5, 7]);
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
