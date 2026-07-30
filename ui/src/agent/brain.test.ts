import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Snapshot } from "../types";

// Mock ONLY the network boundary (bridge.brainChat). Best-of-n is gated OFF by default
// (settings `bestOfNServing` !== true), so escalateCandidates/archivePair aren't reached.
const { brainChatMock, demoBrainAvailableMock } = vi.hoisted(() => ({
  brainChatMock: vi.fn(),
  demoBrainAvailableMock: vi.fn(),
}));
vi.mock("../bridge", () => ({
  brainChat: brainChatMock,
  demoBrainAvailable: demoBrainAvailableMock,
  escalateCandidates: vi.fn(async () => null),
  archivePair: vi.fn(async () => {}),
}));

import { createBrain } from "./brain";

const snap: Snapshot = {
  schemaVersion: 1,
  session: { sampleRate: 48000, tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4, metronome: false, key: { tonic: "C", mode: "major" }, length: 16, editFile: "" },
  tracks: [
    { id: "17", index: 0, name: "Drums", type: "audio", volumeDb: 0, mute: false, solo: false,
      clips: [{ id: "101", name: "beat", type: "midi", start: 0, length: 4, offset: 0, hasRenderLayer: false }] },
  ],
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
  master: { volumeDb: 0, pan: 0 },
};

const systemOfLastCall = (): string => {
  const calls = brainChatMock.mock.calls;
  const messages = calls[calls.length - 1][0] as { role: string; content: string }[];
  return messages[0].content;
};

describe("createBrain injects producer knowledge for the user's turn", () => {
  beforeEach(() => {
    brainChatMock.mockReset();
    brainChatMock.mockResolvedValue({ content: '{"intent":"ACK_GOT_IT"}' });
    demoBrainAvailableMock.mockReset();
    demoBrainAvailableMock.mockReturnValue(false);
  });

  it("adds the relevant knowledge card to the system prompt", async () => {
    const brain = createBrain(() => snap);
    await brain.send("why does the beat start strong then thin out?");
    const sys = systemOfLastCall();
    expect(sys).toContain("Producer knowledge");
    expect(sys.toLowerCase()).toContain("first ~1 second");
  });

  it("adds no knowledge block for a request no card is about", async () => {
    const brain = createBrain(() => snap);
    // Not a production request at all — stays a true zero-overlap probe as the
    // producer-knowledge store grows (see knowledge.test.ts for the rationale).
    await brain.send("what's a good movie to watch this weekend");
    expect(systemOfLastCall()).not.toContain("Producer knowledge");
  });
});

describe("createBrain failure posture", () => {
  beforeEach(() => {
    brainChatMock.mockReset();
    demoBrainAvailableMock.mockReset();
  });

  it("returns an explicit unavailable reply when the production brain fails", async () => {
    demoBrainAvailableMock.mockReturnValue(false);
    brainChatMock.mockRejectedValue(new Error("unavailable"));

    const reply = await createBrain(() => snap).send("set the tempo to 120");

    expect(reply).toEqual({ intent: "UHOH", say: "brain unavailable", commands: [] });
  });

  it("uses the demo brain only when the existing demo surface is enabled", async () => {
    demoBrainAvailableMock.mockReturnValue(true);
    brainChatMock.mockRejectedValue(new Error("unavailable"));

    const reply = await createBrain(() => snap).send("click please");

    expect(reply.commands).toEqual([{ command: "set_metronome", args: { enabled: true } }]);
  });
});
