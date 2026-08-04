// The audition layer's job is to send as FEW commands as possible while still sounding
// right, and to never leave a note hanging. Both are asserted on exact command counts —
// "it roughly throttles" is not a property you can regress against.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createNotePreview, CMD_AUDITION_NOTE, CMD_ALL_NOTES_OFF } from "./notePreview";

type Call = { command: string; args: Record<string, unknown> };

const harness = (enabled = true) => {
  const calls: Call[] = [];
  let clock = 0;
  const p = createNotePreview();
  p.configure({
    exec: async (command, args = {}) => { calls.push({ command, args }); },
    enabled: () => enabled,
    now: () => clock,
  });
  return {
    p, calls,
    advance: (ms: number) => { clock += ms; },
    notes: () => calls.filter((c) => c.command === CMD_AUDITION_NOTE).map((c) => c.args),
    ons: () => calls.filter((c) => c.args.action === "on").map((c) => c.args.pitch),
    offs: () => calls.filter((c) => c.args.action === "off").map((c) => c.args.pitch),
  };
};

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("notePreview — throttling", () => {
  it("holding the SAME pitch twice sends exactly one note-on", () => {
    const h = harness();
    h.p.hold("v", "t1", 60);
    h.p.hold("v", "t1", 60);
    h.p.hold("v", "t1", 60);
    expect(h.ons()).toEqual([60]);
  });

  it("a fast sweep across many pitches collapses to a few notes, ending on the SETTLED pitch", () => {
    // A drag up an octave in one frame. Without the gate this is 12 round trips; without
    // the trailing edge, the note left sounding is whichever arrived first, not the one
    // the producer stopped on.
    const h = harness();
    for (let p = 60; p <= 72; p++) h.p.hold("v", "t1", p);
    vi.runAllTimers();
    const ons = h.ons();
    expect(ons.length).toBeLessThanOrEqual(3);
    expect(ons[ons.length - 1]).toBe(72);
  });

  it("retriggers freely once the gate window has passed", () => {
    const h = harness();
    h.p.hold("v", "t1", 60);
    h.advance(100);
    h.p.hold("v", "t1", 62);
    expect(h.ons()).toEqual([60, 62]);
    expect(h.offs()).toEqual([60]);   // the previous pitch is released, not left hanging
  });
});

describe("notePreview — note-off correctness", () => {
  it("release sends note-off for the HELD pitch, and clears the voice", () => {
    const h = harness();
    h.p.hold("v", "t1", 64);
    h.p.release("v");
    expect(h.offs()).toEqual([64]);
    expect(h.p.outstanding()).toBe(0);
  });

  it("switching track mid-gesture releases the note on the OLD track first", () => {
    // Otherwise the old track keeps sounding with nothing left holding a reference to it.
    const h = harness();
    h.p.hold("v", "t1", 60);
    h.advance(100);
    h.p.hold("v", "t2", 60);
    const off = h.calls.find((c) => c.args.action === "off");
    expect(off?.args.trackId).toBe("t1");
    expect(h.ons()).toEqual([60, 60]);
  });

  it("releaseAll panics and leaves nothing outstanding", () => {
    const h = harness();
    h.p.hold("a", "t1", 60);
    h.p.hold("b", "t1", 64);
    h.p.releaseAll();
    expect(h.p.outstanding()).toBe(0);
    expect(h.calls.some((c) => c.command === CMD_ALL_NOTES_OFF)).toBe(true);
  });

  it("a pending retrigger does not fire after the voice is released", () => {
    // The gate's trailing-edge timer outlives the gesture unless it is cancelled — which
    // would sound a note nobody is holding, with no matching note-off ever coming.
    const h = harness();
    h.p.hold("v", "t1", 60);
    h.p.hold("v", "t1", 61);   // queued behind the gate
    h.p.release("v");
    vi.runAllTimers();
    expect(h.ons()).toEqual([60]);
    expect(h.p.outstanding()).toBe(0);
  });
});

describe("notePreview — the Preview switch", () => {
  it("sends NOTHING at all when preview is off", () => {
    const h = harness(false);
    h.p.tap("t1", 60);
    h.p.hold("v", "t1", 62);
    vi.runAllTimers();
    expect(h.calls).toEqual([]);
  });

  it("tap fires a self-releasing blip — no note-off needed from us", () => {
    const h = harness();
    h.p.tap("t1", 60, 88);
    expect(h.notes()).toEqual([{ trackId: "t1", pitch: 60, velocity: 88, action: "blip" }]);
    expect(h.p.outstanding()).toBe(0);
  });
});
