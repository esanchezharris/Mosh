import { describe, it, expect } from "vitest";
import { parseTranscript, buildMinerUser } from "./youtube";

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
