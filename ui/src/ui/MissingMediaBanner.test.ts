import { describe, it, expect } from "vitest";
import { missingMediaClips } from "./MissingMediaBanner";
import type { Snapshot } from "../types";

function snap(tracks: Snapshot["tracks"]): Snapshot {
  return { schemaVersion: 1, session: {}, tracks } as unknown as Snapshot;
}

function clip(over: Record<string, unknown>): Snapshot["tracks"][number]["clips"][number] {
  return { id: "c", name: "clip", type: "wave", start: 0, length: 1, offset: 0, hasRenderLayer: false, ...over } as unknown as Snapshot["tracks"][number]["clips"][number];
}

describe("G13 — missing-media banner selector", () => {
  it("returns nothing for a clean session (no snapshot, no clips, present sources)", () => {
    expect(missingMediaClips(null)).toEqual([]);
    expect(missingMediaClips(snap([]))).toEqual([]);
    expect(missingMediaClips(snap([
      { id: "t1", name: "Vox", type: "audio", clips: [clip({ id: "c1", name: "take" })] },
    ] as unknown as Snapshot["tracks"]))).toEqual([]);
  });

  it("flags every clip whose source file is missing, carrying its track + clip identity", () => {
    const out = missingMediaClips(snap([
      { id: "t1", name: "Vox", type: "audio", clips: [
        clip({ id: "c1", name: "verse", sourceMissing: true }),
        clip({ id: "c2", name: "present" }),
      ] },
      { id: "t2", name: "Gtr", type: "audio", clips: [
        clip({ id: "c3", name: "riff", sourceMissing: true }),
      ] },
    ] as unknown as Snapshot["tracks"]));
    expect(out).toEqual([
      { trackId: "t1", trackName: "Vox", clipId: "c1", clipName: "verse" },
      { trackId: "t2", trackName: "Gtr", clipId: "c3", clipName: "riff" },
    ]);
  });

  it("ignores hidden beneath-render clips (not user-managed)", () => {
    expect(missingMediaClips(snap([
      { id: "t1", name: "Vox", type: "audio", clips: [
        clip({ id: "h", name: "hidden render", sourceMissing: true, hidden: true }),
      ] },
    ] as unknown as Snapshot["tracks"]))).toEqual([]);
  });
});
