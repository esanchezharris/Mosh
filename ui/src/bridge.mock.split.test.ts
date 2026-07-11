import { describe, it, expect, beforeEach } from "vitest";
import { mockExecute, mockSnapshot, __resetMockForTests } from "./bridge.mock";
import type { CommandResult, Snapshot } from "./types";

// P1 split-point normalization (r4 gate-miss fix plan): offset clips must accept
// BOTH absolute times strictly inside the clip and clip-relative times that resolve
// inside as start + t; exact edges and truly-outside values error loudly.

const exec = <T = CommandResult>(command: string, args: Record<string, unknown>) =>
  mockExecute<T>({ command, args });

async function offsetClip(): Promise<{ clipId: string; start: number; length: number }> {
  const s = await mockSnapshot<Snapshot>();
  const track = s.tracks.find((t) => t.clips.some((c) => c.type === "wave"))!;
  const clip = track.clips.find((c) => c.type === "wave")!;
  // Move it off zero so relative and absolute diverge (the eval fixtures' shape).
  await exec("move_clip", { clipId: clip.id, start: 4 });
  await exec("trim_clip", { clipId: clip.id, length: 8 });
  return { clipId: clip.id, start: 4, length: 8 };
}

async function clipCount(): Promise<number> {
  const s = await mockSnapshot<Snapshot>();
  return s.tracks.flatMap((t) => t.clips).length;
}

describe("split_clip point normalization", () => {
  beforeEach(() => __resetMockForTests());

  it("accepts an absolute time strictly inside an offset clip", async () => {
    const { clipId } = await offsetClip();
    const before = await clipCount();
    const r = await exec("split_clip", { clipId, time: 8 }); // inside [4, 12]
    expect(r.ok).toBe(true);
    expect(await clipCount()).toBe(before + 1);
  });

  it("resolves a clip-relative time (start + t) when absolute lands outside", async () => {
    const { clipId } = await offsetClip();
    const before = await clipCount();
    const r = await exec("split_clip", { clipId, time: 2 }); // 2 ∉ [4,12]; 4+2=6 ∈ (4,12)
    expect(r.ok).toBe(true);
    expect(await clipCount()).toBe(before + 1);
  });

  it("the exact clip start resolves clip-relatively when that lands inside", async () => {
    // time=4 on [4,12] is the ambiguous case by construction: absolute 4 is the edge,
    // but relative start+4=8 is a legal interior point — normalization prefers a
    // successful split over an edge rejection.
    const { clipId } = await offsetClip();
    const before = await clipCount();
    const r = await exec("split_clip", { clipId, time: 4 });
    expect(r.ok).toBe(true);
    expect(await clipCount()).toBe(before + 1);
  });

  it("rejects the exact clip end (relative candidate lands outside too)", async () => {
    const { clipId } = await offsetClip();
    const r = await exec("split_clip", { clipId, time: 12 }); // relative 16 > end
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("split point outside clip");
  });

  it("rejects truly-outside values with the resolved point in the error", async () => {
    const { clipId } = await offsetClip();
    const r = await exec("split_clip", { clipId, time: 99 });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("99");
  });
});

describe("add_midi_clip length fidelity", () => {
  beforeEach(() => __resetMockForTests());

  // The backend honors `length` in seconds (MoshOps cmdAddMidiClip:
  // insertMIDIClip({start, start+length})). The mock hardcoding length=4 made the
  // evalA split_clip fixtures ({start:4,length:8} → intended [4,12]) reject the
  // model's correct absolute split at 8 — a mock-fidelity bug, not a model miss.
  it("honors the length argument so an inside split at 8 on [4,12] succeeds", async () => {
    const s = await mockSnapshot<Snapshot>();
    const add = await exec("add_midi_clip", { trackId: s.tracks[0].id, start: 4, length: 8 });
    expect(add.ok).toBe(true);
    const clipId = (add.data as { clipId: string }).clipId;
    const r = await exec("split_clip", { clipId, time: 8 });
    expect(r.ok).toBe(true);
  });
});
