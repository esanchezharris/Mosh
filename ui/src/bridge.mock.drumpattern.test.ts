// add_drum_pattern (DRM-002) — behavioural mock parity. The mock must mirror the
// native handler exactly (#286 lesson: honor ALL args + error cases); these tests
// are the tripwire for a forgotten mock case too — the mock's `default:` returns
// ok() for unknown commands, so a missing case would otherwise pass silently.
import { describe, it, expect, beforeEach } from "vitest";
import { mockExecute, mockSnapshot, __resetMockForTests } from "./bridge.mock";
import type { CommandResult, Snapshot, Track } from "./types";

const exec = <T = CommandResult>(command: string, args: Record<string, unknown> = {}) =>
  mockExecute<T>({ command, args });

const snap = () => mockSnapshot<Snapshot>();

const TRAP = "kick: x...x...x...x...; snare: ....x.......x...; hat: x.x.x.x.x.x.x.x.";

async function trackById(id: string): Promise<Track> {
  const s = await snap();
  const t = s.tracks.find((x) => x.id === id);
  if (!t) throw new Error(`no track ${id}`);
  return t;
}

async function notesOf(clipId: string) {
  const s = await snap();
  for (const t of s.tracks)
    for (const c of t.clips) if (c.id === clipId) return c.notes ?? [];
  throw new Error(`no clip ${clipId}`);
}

const countPitch = (notes: Array<{ pitch: number }>, pitch: number) =>
  notes.filter((n) => n.pitch === pitch).length;

describe("add_drum_pattern (mock parity)", () => {
  beforeEach(() => __resetMockForTests());

  it("no trackId → creates a Drums drum track with the kit and lays the grid", async () => {
    const before = (await snap()).tracks.length;
    const r = await exec("add_drum_pattern", { pattern: TRAP });
    expect(r.ok).toBe(true);
    const data = r.data as { clipId: string; trackId: string; noteCount: number; steps: number; bars: number };
    expect(data.noteCount).toBe(14);
    expect(data.steps).toBe(16);
    expect(data.bars).toBe(1);

    const s = await snap();
    expect(s.tracks.length).toBe(before + 1);
    const t = await trackById(data.trackId);
    expect(t.name).toBe("Drums");
    expect(t.type).toBe("drum");
    expect(t.isInstrument).toBe(true);

    const clip = t.clips.find((c) => c.id === data.clipId)!;
    expect(clip.start).toBe(0);
    expect(clip.length).toBe(2); // 1 bar at 120 BPM 4/4
    const notes = clip.notes ?? [];
    expect(notes.length).toBe(14);
    // step 4 = beat 1.0 at 16 steps/bar in 4/4; one step long; velocity 100
    expect(notes.some((n) => n.pitch === 38 && n.start === 1 && n.length === 0.25 && n.velocity === 100)).toBe(true);
    expect(notes.some((n) => n.pitch === 36 && n.start === 0)).toBe(true);
  });

  it("'X' accents land at velocity 127", async () => {
    const r = await exec("add_drum_pattern", { pattern: { kick: "X...x..." }, stepsPerBar: 8 });
    const notes = await notesOf((r.data as { clipId: string }).clipId);
    expect(notes.find((n) => n.start === 0)!.velocity).toBe(127);
    expect(notes.find((n) => n.start === 2)!.velocity).toBe(100);
  });

  it("start defaults to 0 even after moving the transport (native parity)", async () => {
    await exec("set_transport", { position: 8 });
    const r = await exec("add_drum_pattern", { pattern: { kick: "x..." } });
    const data = r.data as { clipId: string; trackId: string };
    const t = await trackById(data.trackId);
    expect(t.clips.find((c) => c.id === data.clipId)!.start).toBe(0);
  });

  it("honors start (seconds) for the new clip", async () => {
    const r = await exec("add_drum_pattern", { pattern: { kick: "x..." }, start: 4 });
    const data = r.data as { clipId: string; trackId: string };
    const t = await trackById(data.trackId);
    expect(t.clips.find((c) => c.id === data.clipId)!.start).toBe(4);
  });

  it("multi-bar patterns size the clip to bars × barSeconds", async () => {
    const r = await exec("add_drum_pattern", {
      pattern: { kick: "x...x...x...x...x...x...x...x..." }, // 32 chars → 2 bars
    });
    const data = r.data as { clipId: string; trackId: string; bars: number; noteCount: number };
    expect(data.bars).toBe(2);
    expect(data.noteCount).toBe(8);
    const t = await trackById(data.trackId);
    expect(t.clips.find((c) => c.id === data.clipId)!.length).toBe(4); // 2 bars at 120 BPM 4/4
  });

  it("instrument-less audio track → flips to drum type and loads the kit", async () => {
    const c = await exec("create_track", { name: "Beat", type: "audio" });
    const trackId = (c.data as { trackId: string }).trackId;
    const r = await exec("add_drum_pattern", { trackId, pattern: { kick: "x..." } });
    expect(r.ok).toBe(true);
    const t = await trackById(trackId);
    expect(t.type).toBe("drum");
    expect(t.isInstrument).toBe(true);
  });

  it("a track that already has an instrument is left untouched (melodic-808 safe)", async () => {
    const c = await exec("create_track", { name: "808", type: "audio" });
    const trackId = (c.data as { trackId: string }).trackId;
    await exec("assign_sample", { trackId, note: 36, file: "/x/808.wav", mode: "melodic" });
    const before = await trackById(trackId);
    const pluginsBefore = (before.plugins ?? []).map((p) => p.type);

    const r = await exec("add_drum_pattern", { trackId, pattern: { "36": "x..." } });
    expect(r.ok).toBe(true);
    const t = await trackById(trackId);
    expect(t.type).toBe("audio"); // NOT flipped
    expect((t.plugins ?? []).map((p) => p.type)).toEqual(pluginsBefore); // NOT clobbered
  });

  it("a track holding wave audio errors (a sampler would silence it)", async () => {
    const s = await snap();
    const wave = s.tracks.find((t) => t.clips.some((c) => c.type === "wave"))!;
    const r = await exec("add_drum_pattern", { trackId: wave.id, pattern: { kick: "x..." } });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("wave");
  });

  it("unknown trackId errors", async () => {
    const r = await exec("add_drum_pattern", { trackId: "nope", pattern: { kick: "x..." } });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("no track");
  });

  it("clipId → per-lane replace: named lanes re-lay, other pitches survive", async () => {
    const first = await exec("add_drum_pattern", { pattern: TRAP });
    const clipId = (first.data as { clipId: string }).clipId;
    await exec("add_note", { clipId, pitch: 45, start: 0.5, length: 0.25, velocity: 100 }); // low tom

    const r = await exec("add_drum_pattern", { clipId, pattern: { kick: "x.x.x.x.x.x.x.x." } });
    expect(r.ok).toBe(true);
    const notes = await notesOf(clipId);
    expect(countPitch(notes, 36)).toBe(8); // kick replaced 4 → 8
    expect(countPitch(notes, 38)).toBe(2); // snare untouched
    expect(countPitch(notes, 42)).toBe(8); // hat untouched
    expect(countPitch(notes, 45)).toBe(1); // tom untouched
  });

  it("an all-rest lane clears just that lane", async () => {
    const first = await exec("add_drum_pattern", { pattern: TRAP });
    const clipId = (first.data as { clipId: string }).clipId;
    const r = await exec("add_drum_pattern", { clipId, pattern: { snare: "................" } });
    expect(r.ok).toBe(true);
    const notes = await notesOf(clipId);
    expect(countPitch(notes, 38)).toBe(0);
    expect(countPitch(notes, 36)).toBe(4);
    expect(countPitch(notes, 42)).toBe(8);
  });

  it("clipId of a wave clip errors", async () => {
    const s = await snap();
    const wave = s.tracks.flatMap((t) => t.clips).find((c) => c.type === "wave")!;
    const r = await exec("add_drum_pattern", { clipId: wave.id, pattern: { kick: "x..." } });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("no midi clip");
  });

  it("tiling: short lanes repeat across the pattern", async () => {
    const r = await exec("add_drum_pattern", { pattern: { hat: "x." } });
    expect((r.data as { noteCount: number }).noteCount).toBe(8);
  });

  it("parser errors surface as command errors", async () => {
    expect((await exec("add_drum_pattern", { pattern: { kick: "x..q" } })).ok).toBe(false);
    expect(String((await exec("add_drum_pattern", { pattern: { cowbell: "x..." } })).error)).toContain("cowbell");
    expect((await exec("add_drum_pattern", {})).ok).toBe(false);
    expect((await exec("add_drum_pattern", { pattern: { kick: "x..." }, stepsPerBar: 0 })).ok).toBe(false);
    expect((await exec("add_drum_pattern", { pattern: { kick: "x..." }, bars: 20 })).ok).toBe(false);
    expect((await exec("add_drum_pattern", { pattern: { kick: "x..." }, velocity: 0 })).ok).toBe(false);
  });

  it("undo after the create path removes the track, clip and kit in one step", async () => {
    const before = (await snap()).tracks.length;
    await exec("add_drum_pattern", { pattern: TRAP });
    expect((await snap()).tracks.length).toBe(before + 1);
    await exec("undo");
    expect((await snap()).tracks.length).toBe(before);
  });

  it("undo after a clipId replace restores the pre-replace notes exactly", async () => {
    const first = await exec("add_drum_pattern", { pattern: TRAP });
    const clipId = (first.data as { clipId: string }).clipId;
    const before = await notesOf(clipId);

    await exec("add_drum_pattern", { clipId, pattern: { kick: "x.x.x.x.x.x.x.x." } });
    expect(countPitch(await notesOf(clipId), 36)).toBe(8);

    await exec("undo");
    const after = await notesOf(clipId);
    expect(countPitch(after, 36)).toBe(4);
    expect(after.length).toBe(before.length);
  });
});
