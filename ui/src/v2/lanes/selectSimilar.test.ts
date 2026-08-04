import { describe, expect, it } from "vitest";
import { selectSimilarIds, similarityKey } from "./selectSimilar";
import type { Snapshot } from "../../types";

const snap = (clips: { id: string; track: string; sourceFile?: string; name?: string }[]) => {
  const byTrack = new Map<string, { id: string; sourceFile?: string; name?: string }[]>();
  for (const c of clips) {
    if (!byTrack.has(c.track)) byTrack.set(c.track, []);
    byTrack.get(c.track)!.push({ id: c.id, sourceFile: c.sourceFile, name: c.name });
  }
  return {
    tracks: [...byTrack].map(([id, cs]) => ({ id, clips: cs })),
  } as unknown as Snapshot;
};

describe("selectSimilar", () => {
  it("keys on SOURCE, so a renamed copy of a loop is still similar", () => {
    const s = snap([
      { id: "a", track: "t1", sourceFile: "/loops/kick.wav", name: "Kick" },
      { id: "b", track: "t2", sourceFile: "/loops/kick.wav", name: "renamed by hand" },
      { id: "c", track: "t2", sourceFile: "/loops/snare.wav", name: "Kick" },
    ]);
    // b matches on source despite a different name; c does NOT match despite the same name.
    expect(selectSimilarIds(s, "a").sort()).toEqual(["a", "b"]);
  });

  it("falls back to name for MIDI clips, which have no source file", () => {
    const s = snap([
      { id: "m1", track: "t1", name: "Hook" },
      { id: "m2", track: "t2", name: "Hook" },
      { id: "m3", track: "t2", name: "Verse" },
    ]);
    expect(selectSimilarIds(s, "m1").sort()).toEqual(["m1", "m2"]);
  });

  it("spans tracks — copies of a loop live on different lanes", () => {
    const s = snap([
      { id: "a", track: "t1", sourceFile: "/x.wav" },
      { id: "b", track: "t2", sourceFile: "/x.wav" },
      { id: "c", track: "t3", sourceFile: "/x.wav" },
    ]);
    expect(selectSimilarIds(s, "b")).toHaveLength(3);
  });

  it("always includes the clip you asked about, even when nothing matches", () => {
    const s = snap([{ id: "lonely", track: "t1", sourceFile: "/only.wav" }]);
    expect(selectSimilarIds(s, "lonely")).toEqual(["lonely"]);
  });

  it("an unnamed, sourceless clip matches only itself — never everything", () => {
    // The dangerous failure: a null key matching other null keys would select every
    // untitled clip in the project from one right-click.
    const s = snap([
      { id: "x", track: "t1" },
      { id: "y", track: "t1" },
    ]);
    expect(selectSimilarIds(s, "x")).toEqual(["x"]);
  });

  it("returns [] for an unknown clip and for no snapshot", () => {
    expect(selectSimilarIds(snap([{ id: "a", track: "t1", name: "n" }]), "nope")).toEqual([]);
    expect(selectSimilarIds(null, "a")).toEqual([]);
  });

  it("similarityKey prefers source over name and ignores whitespace-only values", () => {
    expect(similarityKey({ sourceFile: "/a.wav", name: "n" })).toBe("src:/a.wav");
    expect(similarityKey({ sourceFile: "   ", name: "n" })).toBe("name:n");
    expect(similarityKey({ sourceFile: "  ", name: "  " })).toBeNull();
  });
});
