// Behavioral test for the audio→MIDI (Basic Pitch) flow against the dev mock —
// the same contract the UI's right-click "Convert to MIDI" drives. No service / no
// model: the mock simulates the async path (working → done + a new MIDI track).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mockExecute, mockOnEvent, mockSnapshot, __resetMockForTests } from "./bridge.mock";
import type { Snapshot } from "./types";

type Ev = { type: string; payload: Record<string, unknown> };
type Res = { ok: boolean; data?: { status?: string }; error?: string };

describe("transcribe_clip (audio→MIDI)", () => {
  beforeEach(() => { __resetMockForTests(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("emits working, then lands a new MIDI track with notes on done", async () => {
    const snap = await mockSnapshot<Snapshot>();
    const wave = snap.tracks.flatMap((t) => t.clips).find((c) => c.type === "wave");
    expect(wave, "seed should contain a wave clip").toBeTruthy();

    const events: Ev[] = [];
    const off = mockOnEvent("mosh_event", (e) => events.push(e as Ev));
    const tracksBefore = snap.tracks.length;

    const res = await mockExecute<Res>({ command: "transcribe_clip", args: { clipId: wave!.id, mode: "mono" } });
    expect(res.ok).toBe(true);
    expect(res.data?.status).toBe("started");
    expect(events.some((e) => e.type === "transcribe_status" && e.payload.state === "working")).toBe(true);

    await vi.advanceTimersByTimeAsync(500); // past the simulated inference

    expect(events.some((e) => e.type === "transcribe_status" && e.payload.state === "done")).toBe(true);
    const after = await mockSnapshot<Snapshot>();
    expect(after.tracks.length).toBe(tracksBefore + 1);
    const midi = after.tracks[after.tracks.length - 1].clips.find((c) => c.type === "midi");
    expect(midi).toBeTruthy();
    expect((midi!.notes ?? []).length).toBeGreaterThan(0);
    expect(midi!.start).toBe(wave!.start); // time-aligned under the source audio
    off();
  });

  it("poly mode also lands a MIDI track (different preset)", async () => {
    const snap = await mockSnapshot<Snapshot>();
    const wave = snap.tracks.flatMap((t) => t.clips).find((c) => c.type === "wave")!;
    const res = await mockExecute<Res>({ command: "transcribe_clip", args: { clipId: wave.id, mode: "poly" } });
    expect(res.ok).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    const after = await mockSnapshot<Snapshot>();
    expect(after.tracks.some((t) => t.clips.some((c) => c.type === "midi" && (c.notes ?? []).length > 0))).toBe(true);
  });

  it("rejects a non-wave (MIDI) clip", async () => {
    const made = await mockExecute<{ ok: boolean; data?: { clipId?: string } }>(
      { command: "add_midi_clip", args: {} },
    );
    expect(made.ok).toBe(true);
    const res = await mockExecute<Res>({ command: "transcribe_clip", args: { clipId: made.data!.clipId, mode: "mono" } });
    expect(res.ok).toBe(false);
  });
});
