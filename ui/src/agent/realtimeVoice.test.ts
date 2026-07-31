import { describe, expect, it, vi } from "vitest";
import { PushToTalkController, realtimeFallbackFor } from "./realtimeVoice";

function setup() {
  const track = { enabled: true, stop: vi.fn() };
  const stream = { getAudioTracks: () => [track] } as unknown as MediaStream;
  const session = {
    connect: vi.fn(async () => undefined),
    mute: vi.fn(async () => undefined),
    close: vi.fn(),
    interrupt: vi.fn(),
  };
  const audio = { volume: 1 } as HTMLAudioElement;
  const controller = new PushToTalkController({
    getClientSecret: vi.fn(async () => "ek_test"),
    getMediaStream: vi.fn(async () => stream),
    createSession: vi.fn(() => session),
    audioElement: audio,
  });
  return { controller, session, track, audio };
}

describe("Realtime push-to-talk privacy lifecycle", () => {
  it("connects with history audio disabled and leaves both track and session muted", async () => {
    const { controller, session, track } = setup();
    await controller.connect();
    expect(track.enabled).toBe(false);
    expect(session.mute).toHaveBeenLastCalledWith(true);
    expect(controller.sessionOptions).toMatchObject({ historyStoreAudio: false });
  });

  it("disables the acquired track before waiting for a deferred client secret", async () => {
    let releaseSecret!: (value: string) => void;
    const secret = new Promise<string>((resolve) => { releaseSecret = resolve; });
    const track = { enabled: true, stop: vi.fn() };
    const stream = { getAudioTracks: () => [track] } as unknown as MediaStream;
    const session = { connect: vi.fn(async () => undefined), mute: vi.fn(), close: vi.fn(), interrupt: vi.fn() };
    const controller = new PushToTalkController({
      getClientSecret: () => secret,
      getMediaStream: vi.fn(async () => stream),
      createSession: vi.fn(() => session),
      audioElement: { volume: 1 } as HTMLAudioElement,
    });

    const connecting = controller.connect();
    await Promise.resolve();
    expect(track.enabled).toBe(false);
    expect(session.connect).not.toHaveBeenCalled();
    releaseSecret("ek_test");
    await connecting;
  });

  it("enables audio only while physically held and disables it on release, cancel, error, and dispose", async () => {
    const { controller, session, track } = setup();
    await controller.connect();
    await controller.press({ recording: false });
    expect(track.enabled).toBe(true);
    expect(session.mute).toHaveBeenLastCalledWith(false);

    for (const stop of [
      () => controller.release(),
      async () => { await controller.press({ recording: false }); await controller.cancel(); },
      async () => { await controller.press({ recording: false }); await controller.fail(); },
    ]) {
      await stop();
      expect(track.enabled).toBe(false);
      expect(session.mute).toHaveBeenLastCalledWith(true);
    }
    await controller.dispose();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(track.enabled).toBe(false);
  });

  it("refuses voice during recording without stopping the take or opening the mic", async () => {
    const { controller, session, track } = setup();
    await controller.connect();
    await expect(controller.press({ recording: true })).resolves.toEqual({
      ok: false,
      reason: "Stop recording before talking to Moshi.",
    });
    expect(track.enabled).toBe(false);
    expect(session.mute).not.toHaveBeenCalledWith(false);
  });

  it("ducks only Realtime output during playback", async () => {
    const { controller, audio } = setup();
    await controller.connect();
    controller.setPlaybackActive(true);
    expect(audio.volume).toBe(0.3);
    controller.setPlaybackActive(false);
    expect(audio.volume).toBe(1);
  });
});

describe("Realtime failure fallback", () => {
  it("allows only deterministic safe commands and report drafting through Apple speech", () => {
    expect(realtimeFallbackFor("play")).toEqual({ kind: "apple-speech", allowed: true });
    expect(realtimeFallbackFor("log this as a bug")).toEqual({ kind: "apple-speech", allowed: true });
    expect(realtimeFallbackFor("rebuild the chorus around my vocal")).toEqual({
      kind: "text-only",
      allowed: false,
      message: "Realtime unavailable — type complex requests.",
    });
  });
});
