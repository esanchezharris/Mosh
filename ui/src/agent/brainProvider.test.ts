// The wiring proof for the in-app brain picker: the `brainProvider` setting has to
// reach bridge.brainChat's SECOND argument, because that argument is the only thing
// that makes BrainProxy::resolve pick a seat other than the environment default.
//
// The load-bearing case is the DEFAULT one. "" must send `undefined`, not the empty
// string: an empty string is falsy on the native side today, but relying on that would
// make the picker's off-state depend on a coincidence rather than on sending nothing.
// So the first test pins "no pick ⇒ no provider argument" — that is what keeps this
// additive for every install that never touches the picker.
//
// Own file (not brain.test.ts) for the same reason brainMemory.test.ts is: driving
// useSettings reaches applySettingEffects, which needs setTelemetryOptIn on the mock.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Snapshot } from "../types";

const { brainChatMock } = vi.hoisted(() => ({ brainChatMock: vi.fn() }));
vi.mock("../bridge", () => ({
  brainChat: brainChatMock,
  executeCommand: vi.fn(async () => ({})),
  escalateCandidates: vi.fn(async () => null),
  archivePair: vi.fn(async () => {}),
  setTelemetryOptIn: vi.fn(async () => {}),
}));

import { createBrain } from "./brain";
import { useSettings } from "../settings/store";

const snap: Snapshot = {
  schemaVersion: 1,
  session: { sampleRate: 48000, tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4, metronome: false, key: { tonic: "C", mode: "major" }, length: 16, editFile: "" },
  tracks: [],
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
  master: { volumeDb: 0, pan: 0 },
};

/** The `provider` argument of the last brainChat call (arg index 1). */
const providerOfLastCall = (): unknown => {
  const calls = brainChatMock.mock.calls;
  return calls[calls.length - 1][1];
};

describe("the brainProvider setting selects the seat brainChat asks", () => {
  beforeEach(() => {
    brainChatMock.mockReset();
    brainChatMock.mockResolvedValue({ content: '{"intent":"ACK_GOT_IT"}' });
    useSettings.getState().set("brainProvider", "");
  });

  it("sends NO provider when nothing is picked (the pre-picker behaviour)", async () => {
    const brain = createBrain(() => snap);
    await brain.send("add a track");
    expect(providerOfLastCall()).toBeUndefined();
  });

  it("forwards an explicit pick", async () => {
    useSettings.getState().set("brainProvider", "xai");
    const brain = createBrain(() => snap);
    await brain.send("add a track");
    expect(providerOfLastCall()).toBe("xai");
  });

  it("forwards the local seat too — the whole point of the MLX entry", async () => {
    useSettings.getState().set("brainProvider", "local");
    const brain = createBrain(() => snap);
    await brain.send("add a track");
    expect(providerOfLastCall()).toBe("local");
  });

  it("re-reads the setting per turn, so switching mid-session takes effect", async () => {
    const brain = createBrain(() => snap);
    await brain.send("add a track");
    expect(providerOfLastCall()).toBeUndefined();
    useSettings.getState().set("brainProvider", "openai");
    await brain.send("add another");
    expect(providerOfLastCall()).toBe("openai");
  });
});
