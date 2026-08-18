import { describe, expect, it } from "vitest";
import { matchExplicitBalanceUtteranceV1, matchTakeCycleActionV1 } from "./matchers";

describe("matchTakeCycleActionV1", () => {
  it("matches each of the six actions plus a held-out phrasing", () => {
    expect(matchTakeCycleActionV1("record a take")).toBe("start");
    expect(matchTakeCycleActionV1("stop")).toBe("stop");
    expect(matchTakeCycleActionV1("try that again")).toBe("again");
    expect(matchTakeCycleActionV1("next take")).toBe("audition_next");
    expect(matchTakeCycleActionV1("previous take")).toBe("audition_previous");
    expect(matchTakeCycleActionV1("keep it")).toBe("keep");
    expect(matchTakeCycleActionV1("hit record")).toBe("start");
  });

  it("returns null for an unrelated utterance", () => {
    expect(matchTakeCycleActionV1("mute the drums")).toBeNull();
  });
});

describe("matchExplicitBalanceUtteranceV1", () => {
  it("parses an explicit level with a named track", () => {
    expect(matchExplicitBalanceUtteranceV1("set Drums to -6 dB")).toEqual({ action: "set_level", trackName: "Drums", db: -6 });
  });

  it("parses an explicit level with a pronoun target as the selected track (no name)", () => {
    expect(matchExplicitBalanceUtteranceV1("set it to -6 dB")).toEqual({ action: "set_level", db: -6 });
  });

  it("parses mute/unmute/solo with and without a named target", () => {
    expect(matchExplicitBalanceUtteranceV1("mute the vocals")).toEqual({ action: "mute", trackName: "the vocals" });
    expect(matchExplicitBalanceUtteranceV1("mute it")).toEqual({ action: "mute" });
    expect(matchExplicitBalanceUtteranceV1("unmute it")).toEqual({ action: "unmute" });
    expect(matchExplicitBalanceUtteranceV1("solo the bass")).toEqual({ action: "solo", trackName: "the bass" });
  });

  it("returns null for a vague taste request", () => {
    expect(matchExplicitBalanceUtteranceV1("mix this professionally")).toBeNull();
    expect(matchExplicitBalanceUtteranceV1("make it sound better")).toBeNull();
  });
});
