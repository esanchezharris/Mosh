// The stem-export pre-flight rule.
//
// This count is shown to the producer BEFORE they commit to an export that blocks the app
// with no cancel, so it has to agree with what actually lands on disk. These pin it against
// cmdExportStems's real selection rule (MoshOps.cpp ~:10035) — including the two places a
// friendlier-looking rule would be wrong.

import { describe, expect, it } from "vitest";
import { stemBaseName, stemCount, stemTracks } from "./exportStems";
import type { Track } from "./types";

const t = (over: Partial<Track>): Track => ({
  id: "t", index: 0, name: "T", type: "audio", volumeDb: 0, pan: 0,
  mute: false, solo: false, clips: [], plugins: [],
  ...over,
} as unknown as Track);

const withClip = (over: Partial<Track> = {}) => t({ clips: [{ id: "c" }], ...over } as Partial<Track>);

describe("stem export pre-flight", () => {
  it("counts tracks that hold clips, and skips the ones that don't", () => {
    const tracks = [withClip({ id: "a" }), t({ id: "b" }), withClip({ id: "c" })];
    expect(stemCount(tracks, false)).toBe(2);
  });

  it("includeEmpty takes the silent ones too", () => {
    const tracks = [withClip({ id: "a" }), t({ id: "b" }), withClip({ id: "c" })];
    expect(stemCount(tracks, true)).toBe(3);
  });

  it("never counts a group track — a folder is not an audio track and yields no stem", () => {
    const tracks = [withClip({ id: "a" }), withClip({ id: "g", isGroup: true })];
    expect(stemCount(tracks, false)).toBe(1);
    expect(stemCount(tracks, true), "includeEmpty must not resurrect a group track").toBe(1);
  });

  it("does NOT special-case return/bus tracks — native doesn't either", () => {
    // The tempting filter. Native applies no isReturn check: a return simply holds no clips,
    // so it drops out of the default pass on its own. Under includeEmpty it genuinely does
    // get a silent stem, and a count that hid that would under-report the real output.
    const tracks = [withClip({ id: "a" }), t({ id: "r", isReturn: true })];
    expect(stemCount(tracks, false)).toBe(1);
    expect(stemCount(tracks, true), "silently dropped a return that native would export").toBe(2);
  });

  it("keeps track order so indices line up with the files on disk", () => {
    const tracks = [t({ id: "empty" }), withClip({ id: "kept" })];
    expect(stemTracks(tracks, false).map((x) => x.id)).toEqual(["kept"]);
  });

  it("names a stem with a zero-padded index and a filesystem-safe track name", () => {
    expect(stemBaseName(3, "Lead Vocal")).toBe("03-Lead Vocal");
    expect(stemBaseName(12, "Drums")).toBe("12-Drums");
    // createLegalFileName's job: a track named after a path would otherwise escape the folder.
    expect(stemBaseName(0, "hi/hat*?")).toBe("00-hihat");
    expect(stemBaseName(1, "///")).toBe("01-unnamed");
  });
});
