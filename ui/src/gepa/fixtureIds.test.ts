import { describe, it, expect } from "vitest";
import { EVAL_REAL_ID_TO_VAR, rewriteRealIds, fixtureIdGaps } from "./fixtureIds";

// The frozen evalA §A bug (2026-07): synth utterances were authored against the
// REAL engine's 1000-series logical ids, but rows replay on the MOCK (ids 17+/107+),
// so the referenced entities never exist. These tests pin the repair map + the
// build-time tripwire that would have caught it.

describe("rewriteRealIds", () => {
  it("rewrites every mapped real-engine id to its ${VAR} placeholder", () => {
    expect(rewriteRealIds("Turn 1012 into drums.")).toBe("Turn ${TKEYS} into drums.");
    expect(rewriteRealIds("Put a built-in drum kit on track 1010.")).toBe(
      "Put a built-in drum kit on track ${TKICK}.",
    );
    expect(rewriteRealIds("Reject the render on clip 1018.")).toBe(
      "Reject the render on clip ${CSUB}.",
    );
    expect(rewriteRealIds("Add a generative re-imagine layer to the Keys clip 1016.")).toBe(
      "Add a generative re-imagine layer to the Keys clip ${CKEYS}.",
    );
  });

  it("covers the full recovered real-engine map (1010/1012/1013/1014/1016/1018)", () => {
    expect(EVAL_REAL_ID_TO_VAR).toEqual({
      "1010": "TKICK",
      "1012": "TKEYS",
      "1013": "TSUB",
      "1014": "TLEAD",
      "1016": "CKEYS",
      "1018": "CSUB",
    });
  });

  it("leaves non-id numbers alone (names, notes, dB values)", () => {
    // "808 Bass" is a NAME the user wants — not an id reference.
    expect(rewriteRealIds("Could you rename 1013 to 808 Bass?")).toBe(
      "Could you rename ${TSUB} to 808 Bass?",
    );
    expect(rewriteRealIds("Map kick.wav to track 1010 on note 38.")).toBe(
      "Map kick.wav to track ${TKICK} on note 38.",
    );
    expect(rewriteRealIds("Make track 1013 a bit louder, like +2 dB.")).toBe(
      "Make track ${TSUB} a bit louder, like +2 dB.",
    );
  });

  it("respects word boundaries (no substring rewrites)", () => {
    expect(rewriteRealIds("id 11016 stays")).toBe("id 11016 stays");
    expect(rewriteRealIds("10161 stays")).toBe("10161 stays");
    expect(rewriteRealIds("clip 1016, please")).toBe("clip ${CKEYS}, please");
  });

  it("rewrites multiple ids in one utterance", () => {
    expect(rewriteRealIds("Move the clip 1016 from 1012 to 1013.")).toBe(
      "Move the clip ${CKEYS} from ${TKEYS} to ${TSUB}.",
    );
  });
});

describe("fixtureIdGaps", () => {
  // A miniature rendered-snapshot text: ids are QUOTED (both compactSnapshot and
  // raw JSON quote them), which is what the containment check keys on.
  const snapText = '"17" "Kick" clips:[] / "18" "Keys" clips:["107":midi@4s]';

  it("flags a 1000-series token that does not resolve in the snapshot", () => {
    expect(fixtureIdGaps("Mute track 1012.", snapText)).toEqual(["1012"]);
  });

  it("flags a leftover unresolved ${VAR} placeholder", () => {
    expect(fixtureIdGaps("Mute track ${TNOPE}.", snapText)).toEqual(["${TNOPE}"]);
  });

  it("passes a resolved utterance whose ids exist in the snapshot", () => {
    expect(fixtureIdGaps("Mute track 18, then split clip 107.", snapText)).toEqual([]);
  });

  it("ignores non-1000-series numbers (notes, dB, names like 808)", () => {
    expect(fixtureIdGaps("Rename 18 to 808 Bass, note 38, +2 dB.", snapText)).toEqual([]);
  });

  it("accepts a 1000-series token that IS a real id in the snapshot", () => {
    expect(fixtureIdGaps("Mute track 1012.", 'tracks: "1012" "Keys"')).toEqual([]);
  });
});
