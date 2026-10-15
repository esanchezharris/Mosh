import { describe, expect, it } from "vitest";
import type { Track } from "../types";
import { defaultChainTargets, looksLikeSpeakers } from "./vocalSetup";

const track = (id: string, over: Partial<Track> = {}): Track =>
  ({ id, index: 0, name: id, type: "audio", volumeDb: 0, pan: 0, mute: false, solo: false, clips: [], plugins: [], ...over }) as unknown as Track;
const effect = { index: 1, name: "EQ", type: "eq", enabled: true, external: false, isInstrument: false, params: [] };

describe("looksLikeSpeakers", () => {
  it.each(["MacBook Pro Speakers", "MacBook Air Speakers", "iMac Speakers", "Built-in Output", "Studio Display Speakers"])(
    "treats %s as a loudspeaker", (name) => expect(looksLikeSpeakers(name)).toBe(true));
  it.each(["External Headphones", "AirPods Pro", "Scarlett 2i2 USB", "BlackHole 2ch", "", null, undefined])(
    "does not flag %s", (name) => expect(looksLikeSpeakers(name)).toBe(false));
});

describe("defaultChainTargets", () => {
  it("puts the chain on both Lead and Takes when both are empty", () => {
    expect(defaultChainTargets([track("L"), track("T")], "L", "T").map((t) => t.id)).toEqual(["L", "T"]);
  });
  it("leaves a Lead that already has effects -- and its Takes -- alone", () => {
    expect(defaultChainTargets([track("L", { plugins: [effect] as Track["plugins"] }), track("T")], "L", "T")).toEqual([]);
  });
  it("skips a Takes lane that already has effects but still fills the Lead", () => {
    expect(defaultChainTargets([track("L"), track("T", { plugins: [effect] as Track["plugins"] })], "L", "T").map((t) => t.id))
      .toEqual(["L"]);
  });
  it("never targets a track a preset cannot apply to, or a missing one", () => {
    expect(defaultChainTargets([track("L", { frozen: true }), track("T")], "L", "T").map((t) => t.id)).toEqual(["T"]);
    expect(defaultChainTargets([track("T")], "L", "T")).toEqual([]);
  });
});
