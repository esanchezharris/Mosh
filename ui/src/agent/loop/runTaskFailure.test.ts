import { describe, expect, it, vi } from "vitest";

const { brainChatMock, demoBrainAvailableMock } = vi.hoisted(() => ({
  brainChatMock: vi.fn(),
  demoBrainAvailableMock: vi.fn(),
}));
vi.mock("../../bridge", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../bridge")>(),
  archivePair: vi.fn(async () => {}),
  brainChat: brainChatMock,
  demoBrainAvailable: demoBrainAvailableMock,
}));

import { chatWithFallback } from "./runTask";

describe("loop brain failure posture", () => {
  it("propagates a production provider failure instead of substituting the demo loop", async () => {
    demoBrainAvailableMock.mockReturnValue(false);
    brainChatMock.mockRejectedValue(new Error("unavailable"));

    await expect(chatWithFallback([{ role: "user", content: "make a beat" }])).rejects.toThrow("brain unavailable");
  });
});
