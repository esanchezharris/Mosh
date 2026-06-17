import { describe, it, expect } from "vitest";
import { parseTranscript, buildMinerUser, videoIdFromUrl, isPlaylistUrl, selectVideoUrls } from "./youtube";

describe("parseTranscript — WebVTT/SRT captions → clean prose", () => {
  it("strips the header, cue timings, inline tags, and dedups rolling auto-captions", () => {
    const vtt = [
      "WEBVTT",
      "Kind: captions",
      "Language: en",
      "",
      "00:00:00.000 --> 00:00:02.000 align:start position:0%",
      "hey what's up <00:00:01.000><c> everybody</c>",
      "",
      "00:00:02.000 --> 00:00:05.000",
      "hey what's up everybody",          // rolling repeat of the previous cue
      "today we program the <c>kick</c>",
      "",
      "00:00:05.000 --> 00:00:07.000",
      "today we program the kick",        // rolling repeat
      "on the one and the three",
    ].join("\n");
    const out = parseTranscript(vtt);
    expect(out).not.toMatch(/WEBVTT|Kind:|Language:|-->/);
    expect(out).not.toMatch(/<[^>]+>/);
    expect(out.toLowerCase()).toContain("hey what's up everybody");
    expect(out.toLowerCase()).toContain("program the kick");
    expect(out.toLowerCase()).toContain("on the one and the three");
    expect(out.toLowerCase().match(/hey what's up everybody/g)?.length).toBe(1); // deduped
  });
  it("handles SRT-style numeric index lines + comma timestamps", () => {
    const srt = ["1", "00:00:00,000 --> 00:00:02,000", "first line", "", "2", "00:00:02,000 --> 00:00:04,000", "second line"].join("\n");
    const out = parseTranscript(srt);
    expect(out).toContain("first line");
    expect(out).toContain("second line");
    expect(out).not.toMatch(/-->/);
    expect(out).not.toMatch(/\b\d+\b\s+\d/); // no bare numeric index leaked
  });
  it("returns empty for a header-only caption file", () => {
    expect(parseTranscript("WEBVTT\n\n").trim()).toBe("");
  });
});

describe("buildMinerUser — transcript-grounded recipe-card extraction", () => {
  it("includes the title, the transcript, and the shared recipe-card rules", () => {
    const user = buildMinerUser("today we swing the hats for that boom bap feel", { title: "Boom Bap Drums", url: "https://x" });
    expect(user).toContain("Boom Bap Drums");
    expect(user).toContain("swing the hats");
    expect(user.toLowerCase()).toContain("transcript");
    expect(user).toContain('"kind":"swing"');   // shares the CheckSpec menu
    expect(user).toContain("Output EXACTLY");    // shares the strict output shape
  });
  it("instructs the model to return no cards when the transcript teaches nothing encodable", () => {
    const user = buildMinerUser("subscribe and hit the bell", { title: "t" });
    expect(user.toLowerCase()).toMatch(/do not invent|don't invent|\{"cards":\[\]\}/);
  });
  it("bounds an over-long transcript", () => {
    const huge = "word ".repeat(20000);
    const user = buildMinerUser(huge, { title: "t" });
    expect(user.length).toBeLessThan(huge.length);
  });
});

describe("videoIdFromUrl — extract a YouTube video id", () => {
  it("reads the v= param of a watch URL (even with a &list=)", () => {
    expect(videoIdFromUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(videoIdFromUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&index=4")).toBe("dQw4w9WgXcQ");
  });
  it("reads a youtu.be short URL and a /shorts/ URL", () => {
    expect(videoIdFromUrl("https://youtu.be/dQw4w9WgXcQ?si=abc")).toBe("dQw4w9WgXcQ");
    expect(videoIdFromUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });
  it("returns null for a playlist-only URL or junk", () => {
    expect(videoIdFromUrl("https://www.youtube.com/playlist?list=PL123")).toBeNull();
    expect(videoIdFromUrl("not a url")).toBeNull();
  });
});

describe("isPlaylistUrl — does this URL name a playlist to expand", () => {
  it("is true for a playlist page or a watch URL carrying a list=", () => {
    expect(isPlaylistUrl("https://www.youtube.com/playlist?list=PL123")).toBe(true);
    expect(isPlaylistUrl("https://www.youtube.com/watch?v=abc&list=PL123")).toBe(true);
  });
  it("is false for a bare video URL or junk", () => {
    expect(isPlaylistUrl("https://www.youtube.com/watch?v=abc")).toBe(false);
    expect(isPlaylistUrl("https://youtu.be/abc")).toBe(false);
    expect(isPlaylistUrl("nonsense")).toBe(false);
  });
});

describe("selectVideoUrls — canonicalize, dedup, skip already-mined, cap", () => {
  it("canonicalizes to a bare watch URL and dedups by video id", () => {
    const out = selectVideoUrls([
      "https://www.youtube.com/watch?v=AAA&list=PL1", // same id as below, different list
      "https://youtu.be/AAA",
      "https://www.youtube.com/watch?v=BBB",
    ]);
    expect(out).toEqual(["https://www.youtube.com/watch?v=AAA", "https://www.youtube.com/watch?v=BBB"]);
  });
  it("skips ids already mined (the cross-run seen set)", () => {
    const out = selectVideoUrls(["https://www.youtube.com/watch?v=AAA", "https://www.youtube.com/watch?v=BBB"], { seen: new Set(["AAA"]) });
    expect(out).toEqual(["https://www.youtube.com/watch?v=BBB"]);
  });
  it("caps the batch and drops non-video URLs", () => {
    const out = selectVideoUrls([
      "https://www.youtube.com/watch?v=AAA",
      "https://www.youtube.com/playlist?list=PL1", // no video id → dropped
      "https://www.youtube.com/watch?v=BBB",
      "https://www.youtube.com/watch?v=CCC",
    ], { cap: 2 });
    expect(out).toEqual(["https://www.youtube.com/watch?v=AAA", "https://www.youtube.com/watch?v=BBB"]);
  });
});
