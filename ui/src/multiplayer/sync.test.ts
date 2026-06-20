import { describe, it, expect } from "vitest";
import {
  deriveActiveTrackId,
  computeSyncActions,
  logicalIdOf,
  lockOwnerOfTrack,
  isTrackLockedByOther,
} from "./sync";
import type { Snapshot } from "../types";

function snap(): Snapshot {
  return {
    tracks: [
      { id: "t1", logicalId: "L1", index: 0, name: "A", type: "audio",
        clips: [{ id: "c1", name: "c1", type: "wave", start: 0, length: 1, offset: 0 } as never] },
      { id: "t2", logicalId: "L2", index: 1, name: "B", type: "audio",
        clips: [{ id: "c2", name: "c2", type: "wave", start: 0, length: 1, offset: 0 } as never] },
    ],
  } as unknown as Snapshot;
}

describe("deriveActiveTrackId (commit-on-move trigger)", () => {
  it("uses the track of the first selected clip", () => {
    expect(deriveActiveTrackId(["c2"], "t1", snap())).toBe("t2");
  });
  it("falls back to the selected track when nothing is selected", () => {
    expect(deriveActiveTrackId([], "t1", snap())).toBe("t1");
  });
  it("falls back to the selected track when the selected clip is unknown", () => {
    expect(deriveActiveTrackId(["ghost"], "t1", snap())).toBe("t1");
  });
  it("is null when there is no selection and no selected track", () => {
    expect(deriveActiveTrackId([], null, snap())).toBeNull();
  });
});

describe("computeSyncActions", () => {
  it("is a no-op when the active track is unchanged", () => {
    expect(computeSyncActions("t1", "t1")).toEqual({ release: null, claim: null });
  });
  it("releases the previous track and claims the next on a transition", () => {
    expect(computeSyncActions("t1", "t2")).toEqual({ release: "t1", claim: "t2" });
  });
  it("claims only when moving from nothing onto a track", () => {
    expect(computeSyncActions(null, "t2")).toEqual({ release: null, claim: "t2" });
  });
  it("releases only when moving off a track onto nothing", () => {
    expect(computeSyncActions("t1", null)).toEqual({ release: "t1", claim: null });
  });
});

describe("logicalIdOf", () => {
  it("resolves a track's logical id from the snapshot", () => {
    expect(logicalIdOf("t2", snap())).toBe("L2");
  });
  it("is null for an unknown track or missing snapshot", () => {
    expect(logicalIdOf("ghost", snap())).toBeNull();
    expect(logicalIdOf("t1", null)).toBeNull();
  });
});

describe("lock ownership", () => {
  const locks = { L1: "other", L2: "me" };
  it("reports the owner of a track's lock by logicalId", () => {
    expect(lockOwnerOfTrack({ logicalId: "L1" }, locks)).toBe("other");
    expect(lockOwnerOfTrack({ logicalId: "L9" }, locks)).toBeNull();
  });
  it("flags a track locked by another peer, not by us", () => {
    expect(isTrackLockedByOther({ logicalId: "L1" }, locks, "me")).toBe(true);
    expect(isTrackLockedByOther({ logicalId: "L2" }, locks, "me")).toBe(false); // ours
    expect(isTrackLockedByOther({ logicalId: "L9" }, locks, "me")).toBe(false); // free
  });
});
