// Behavioral test for the Sketch Phase-0 flow (beatbox WAV → drum MoshOps) against
// the dev mock — the same command contract the native cmdSketchBeatbox drives. No
// service / no librosa: the mock simulates the async path (working → done + a new
// drum track carrying kick/snare/hat notes on the grid).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mockExecute, mockOnEvent, mockSnapshot, __resetMockForTests } from "./bridge.mock";
import type { Snapshot } from "./types";

type Ev = { type: string; payload: Record<string, unknown> };
type Res = { ok: boolean; data?: { status?: string; trackId?: string; midiClipId?: string; noteCount?: number }; error?: string };

describe("sketch_beatbox (beatbox → drum MoshOps)", () => {
  beforeEach(() => { __resetMockForTests(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("emits working, then lands a new drum track with kick/snare/hat notes on done", async () => {
    const snap = await mockSnapshot<Snapshot>();
    const tracksBefore = snap.tracks.length;

    const events: Ev[] = [];
    const off = mockOnEvent("mosh_event", (e) => events.push(e as Ev));

    const res = await mockExecute<Res>({ command: "sketch_beatbox", args: { file: "/tmp/boombap.wav", bpm: 90, bars: 1 } });
    expect(res.ok).toBe(true);
    expect(res.data?.status).toBe("started");
    expect(events.some((e) => e.type === "sketch_status" && e.payload.state === "working")).toBe(true);

    await vi.advanceTimersByTimeAsync(500); // past the simulated transduction

    expect(events.some((e) => e.type === "sketch_status" && e.payload.state === "done")).toBe(true);
    const after = await mockSnapshot<Snapshot>();
    expect(after.tracks.length).toBe(tracksBefore + 1);

    const drum = after.tracks[after.tracks.length - 1];
    const clip = drum.clips.find((c) => c.type === "midi");
    expect(clip, "a MIDI clip should land on the new drum track").toBeTruthy();
    const pitches = new Set((clip!.notes ?? []).map((n) => n.pitch));
    expect(pitches.has(36), "has a kick (GM 36)").toBe(true);
    expect(pitches.has(38), "has a snare (GM 38)").toBe(true);
    expect(pitches.has(42), "has a closed hat (GM 42)").toBe(true);
    expect(clip!.start).toBe(0); // loop boxed from 0
    off();
  });

  it("sets the project tempo to the supplied BPM and sizes the loop clip to the native formula", async () => {
    await mockExecute<Res>({ command: "sketch_beatbox", args: { file: "/tmp/trap.wav", bpm: 140, bars: 1 } });
    await vi.advanceTimersByTimeAsync(500);
    const after = await mockSnapshot<Snapshot>();
    expect(after.session.tempo).toBe(140);
    // Loop length must match the native cmdSketchBeatbox: bars*4 beats * 60/bpm, no floor.
    const clip = after.tracks[after.tracks.length - 1].clips.find((c) => c.type === "midi")!;
    expect(clip.length).toBeCloseTo((1 * 4 * 60) / 140, 5); // 1 bar @ 140 BPM = 1.714s (not floored to 2)
  });

  it("rejects a missing file", async () => {
    const res = await mockExecute<Res>({ command: "sketch_beatbox", args: { bpm: 90 } as Record<string, unknown> });
    expect(res.ok).toBe(false);
  });
});
