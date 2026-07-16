import { describe, expect, it } from "vitest";
import { isEvalABoundCompatible, parseSplitTimeSeconds } from "./evalABoundFilter";

describe("evalA split-clip bound filter", () => {
  it("parses seconds from utterances", () => {
    expect(parseSplitTimeSeconds("Split the Keys clip at 5 seconds.")).toBe(5);
    expect(parseSplitTimeSeconds("split clip at 2.5s")).toBe(2.5);
    expect(parseSplitTimeSeconds("split it somewhere soon")).toBeNull();
  });

  it("rejects impossible Keys splits at the clip boundary or beyond", () => {
    expect(isEvalABoundCompatible("split_clip", "Split the Keys clip at 4 seconds.")).toBe(false);
    expect(isEvalABoundCompatible("split_clip", "Split the Keys clip at 12 seconds.")).toBe(false);
    expect(isEvalABoundCompatible("split_clip", "Split the Keys clip at 13 seconds.")).toBe(false);
  });

  it("keeps valid in-bounds splits and all non-split commands", () => {
    expect(isEvalABoundCompatible("split_clip", "Split the Keys clip at 5 seconds.")).toBe(true);
    expect(isEvalABoundCompatible("split_clip", "Split the Sub audio clip at 1 seconds.")).toBe(true);
    expect(isEvalABoundCompatible("set_tempo", "Set the tempo to 90 BPM.")).toBe(true);
  });
});
