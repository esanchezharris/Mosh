import { afterEach, describe, expect, it, vi } from "vitest";

const realtimeMocks = vi.hoisted(() => ({
  connect: vi.fn(async () => undefined),
  mute: vi.fn(async () => undefined),
  close: vi.fn(),
  interrupt: vi.fn(),
  on: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock("@openai/agents/realtime", () => ({
  OpenAIRealtimeWebRTC: class {},
  RealtimeAgent: class {},
  RealtimeSession: class {
    connect = realtimeMocks.connect;
    mute = realtimeMocks.mute;
    close = realtimeMocks.close;
    interrupt = realtimeMocks.interrupt;
    on = realtimeMocks.on;
    sendMessage = realtimeMocks.sendMessage;
  },
  tool: (definition: unknown) => definition,
}));

import { createOpenAIRealtimeController } from "./openAIRealtime";

const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");

afterEach(() => {
  vi.clearAllMocks();
  if (originalMediaDevices) {
    Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
  } else {
    Reflect.deleteProperty(navigator, "mediaDevices");
  }
});

describe("OpenAI Realtime microphone transport", () => {
  it("uses the physical WebRTC microphone in the packaged and browser UI path", async () => {
    const track = { enabled: true, stop: vi.fn() };
    const stream = {
      getAudioTracks: () => [track],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => stream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    const controller = createOpenAIRealtimeController({
      getClientSecret: async () => "ek_test",
      runDirectSafe: async () => "done",
      draftReport: async () => "saved",
      delegateSupervisor: async () => "delegated",
      isRecording: () => false,
      onFailure: vi.fn(),
    });

    await controller.connect();

    expect(controller.inputMode).toBe("webrtc-microphone");
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(track.enabled).toBe(false);
    expect(realtimeMocks.connect).toHaveBeenCalledWith({ apiKey: "ek_test" });
    expect(realtimeMocks.mute).toHaveBeenLastCalledWith(true);
  });
});
