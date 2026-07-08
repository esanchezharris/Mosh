import { describe, it, expect } from "vitest";
import { isTrackPatch, applyTrackPatch } from "./snapshotPatch";
import type { Snapshot, Track } from "./types";

const track = (id: string, vol: number): Track => ({ id, name: id, clips: [], volume: vol } as unknown as Track);

function snap(...tracks: Track[]): Snapshot {
  return { schemaVersion: 1, session: {}, tracks } as unknown as Snapshot;
}

describe("scoped snapshot invalidation", () => {
  it("isTrackPatch recognizes a scoped payload and rejects others", () => {
    expect(isTrackPatch({ scope: "track", trackId: "t1", track: track("t1", 0) })).toBe(true);
    expect(isTrackPatch(undefined)).toBe(false);
    expect(isTrackPatch({ scope: "track", trackId: "t1" })).toBe(false);      // no track var
    expect(isTrackPatch({ trackId: "t1", track: track("t1", 0) })).toBe(false); // no scope
  });

  it("applyTrackPatch replaces exactly the matching track, preserving order + others", () => {
    const before = snap(track("a", 0), track("b", 0), track("c", 0));
    const patched = applyTrackPatch(before, { scope: "track", trackId: "b", track: track("b", -6) });
    expect(patched).not.toBeNull();
    expect(patched!.tracks.map((t) => t.id)).toEqual(["a", "b", "c"]);          // order preserved
    expect((patched!.tracks[1] as Track & { volume: number }).volume).toBe(-6); // b updated
    expect(patched!.tracks[0]).toBe(before.tracks[0]);                          // a untouched (same ref)
    expect(patched).not.toBe(before);                                          // new snapshot object
  });

  it("returns null when the patched track id isn't present (caller does a full refresh)", () => {
    const before = snap(track("a", 0));
    expect(applyTrackPatch(before, { scope: "track", trackId: "ghost", track: track("ghost", 0) })).toBeNull();
  });
});
