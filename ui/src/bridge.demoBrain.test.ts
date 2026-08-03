import { beforeEach, describe, expect, it } from "vitest";
import { demoBrainAvailable } from "./bridge";

type JuceState = {
  initialisationData?: {
    __juce__functions?: string[];
  };
};

const juceState = (): JuceState => {
  const juceWindow = window as unknown as { __JUCE__?: JuceState };
  juceWindow.__JUCE__ ??= {};
  juceWindow.__JUCE__.initialisationData ??= {};
  return juceWindow.__JUCE__;
};

describe("demo brain surface boundary", () => {
  beforeEach(() => {
    juceState().initialisationData!.__juce__functions = [];
  });

  it("is available on the explicit browser test surface", () => {
    expect(demoBrainAvailable()).toBe(true);
  });

  it("is unavailable whenever real native functions are bound", () => {
    juceState().initialisationData!.__juce__functions = ["brain_chat"];
    expect(demoBrainAvailable()).toBe(false);
  });
});
