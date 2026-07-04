import { describe, expect, it } from "vitest";
import { extractSessionNames, mentionsRealEntity, negativeRow, parseNegativePairs, validAsk } from "./negatives";

const SNAP = {
  tracks: [
    { id: "t1", name: "Drums", clips: [{ id: "c1", name: "Loop A" }] },
    { id: "t2", name: "Piano", clips: [] },
  ],
  sections: [{ id: "s1", name: "Verse" }],
  tempo: 120,
};

describe("extractSessionNames", () => {
  it("collects nested entity names, lowercased and sorted", () => {
    expect(extractSessionNames(SNAP)).toEqual(["drums", "loop a", "piano", "verse"]);
  });
  it("ignores short and non-string names", () => {
    expect(extractSessionNames({ tracks: [{ name: "ab" }, { name: 7 }] })).toEqual([]);
  });
});

describe("mentionsRealEntity", () => {
  const names = extractSessionNames(SNAP);
  it("rejects requests naming a real entity (any case)", () => {
    expect(mentionsRealEntity("mute the DRUMS track", names)).toBe(true);
    expect(mentionsRealEntity("rename Verse to Chorus", names)).toBe(true);
  });
  it("passes requests referencing absent entities", () => {
    expect(mentionsRealEntity("mute the Guitar track", names)).toBe(false);
  });
  it("over-rejects on substring (safe direction)", () => {
    // "pianoforte" contains "piano" — losing a candidate is fine; a false HUH row is not.
    expect(mentionsRealEntity("boost the pianoforte stem", names)).toBe(true);
  });
});

describe("validAsk", () => {
  it("accepts 1–12 words", () => {
    expect(validAsk("which track did you mean?")).toBe(true);
    expect(validAsk("one two three four five six seven eight nine ten eleven twelve")).toBe(true);
  });
  it("rejects empty, non-string, and >12 words", () => {
    expect(validAsk("")).toBe(false);
    expect(validAsk(undefined)).toBe(false);
    expect(validAsk("one two three four five six seven eight nine ten eleven twelve thirteen")).toBe(false);
  });
});

describe("parseNegativePairs", () => {
  it("parses fenced JSON and keeps only well-formed pairs", () => {
    const content = '```json\n{"pairs":[' +
      '{"absent":"mute the Guitar track","ask":"which track did you mean?","grounded":"mute the Piano track"},' +
      '{"absent":"","ask":"hm?"},' +
      '{"absent":"solo the Horns","ask":"I do not see a Horns track here, can you point me at the right one please today"},' +
      '{"absent":"pan the Strings left","ask":"which track?"}' +
      "]}\n```";
    expect(parseNegativePairs(content)).toEqual([
      { absent: "mute the Guitar track", ask: "which track did you mean?", grounded: "mute the Piano track" },
      { absent: "pan the Strings left", ask: "which track?" },
    ]);
  });
  it("returns [] on garbage", () => {
    expect(parseNegativePairs("not json")).toEqual([]);
    expect(parseNegativePairs('{"nope":1}')).toEqual([]);
  });
});

describe("negativeRow", () => {
  it("pins the exact HUH gold convention", () => {
    const row = negativeRow("SYS", "mute the Guitar track", "which track did you mean?");
    expect(row.messages).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "mute the Guitar track" },
      { role: "assistant", content: '{"intent":"HUH","say":"which track did you mean?"}' },
    ]);
  });
});
