import { describe, it, expect, vi, afterEach } from "vitest";
import { createContinuousVoiceInput } from "./voiceInput";

// A minimal fake Web Speech recognizer. Each `new` is recorded so a test can assert
// the auto-restart (a fresh instance armed after onend while engaged). The result
// shape matches what voiceInput's onresult handler reads: results[i][0].transcript +
// results[i].isFinal.
class FakeSR {
  continuous = false;
  interimResults = false;
  lang = "";
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: { error?: string }) => void) | null = null;
  onend: (() => void) | null = null;
  onstart: (() => void) | null = null;
  started = false;
  static instances: FakeSR[] = [];
  constructor() { FakeSR.instances.push(this); }
  start() { this.started = true; this.onstart?.(); }
  stop() { this.started = false; this.onend?.(); }   // real SR fires onend after stop()
  abort() { this.started = false; this.onend?.(); }
  emitFinal(text: string) {
    this.onresult?.({ resultIndex: 0, results: { length: 1, 0: { isFinal: true, length: 1, 0: { transcript: text } } } });
  }
  emitInterim(text: string) {
    this.onresult?.({ resultIndex: 0, results: { length: 1, 0: { isFinal: false, length: 1, 0: { transcript: text } } } });
  }
  emitError(code: string) { this.onerror?.({ error: code }); }
  end() { this.onend?.(); }
}

function installFake(): typeof FakeSR {
  FakeSR.instances = [];
  (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = FakeSR;
  return FakeSR;
}

afterEach(() => {
  delete (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
  delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
});

describe("createContinuousVoiceInput (web path)", () => {
  it("emits onFinal PER finalized segment (not just at the end)", () => {
    installFake();
    const onFinal = vi.fn();
    const v = createContinuousVoiceInput({ onFinal })!;
    v.start();
    const r = FakeSR.instances[0];
    r.emitFinal("undo that");
    r.emitFinal("play it");
    expect(onFinal).toHaveBeenNthCalledWith(1, "undo that");
    expect(onFinal).toHaveBeenNthCalledWith(2, "play it");
  });

  it("streams interim text without finalizing", () => {
    installFake();
    const onInterim = vi.fn();
    const onFinal = vi.fn();
    const v = createContinuousVoiceInput({ onInterim, onFinal })!;
    v.start();
    FakeSR.instances[0].emitInterim("put me");
    expect(onInterim).toHaveBeenCalledWith("put me");
    expect(onFinal).not.toHaveBeenCalled();
  });

  it("AUTO-RESTARTS on onend while engaged (the mic stays hot)", () => {
    installFake();
    const onStart = vi.fn();
    const v = createContinuousVoiceInput({ onStart })!;
    v.start();
    expect(FakeSR.instances).toHaveLength(1);
    expect(onStart).toHaveBeenCalledTimes(1);
    FakeSR.instances[0].end();          // Chromium self-stops after silence
    expect(FakeSR.instances).toHaveLength(2); // re-armed
    expect(v.listening).toBe(true);
    expect(onStart).toHaveBeenCalledTimes(1); // onStart fires once, not per re-arm
  });

  it("stop() ends listening and does NOT re-arm", () => {
    installFake();
    const onStop = vi.fn();
    const v = createContinuousVoiceInput({ onStop })!;
    v.start();
    v.stop();
    expect(v.listening).toBe(false);
    expect(onStop).toHaveBeenCalled();
    const n = FakeSR.instances.length;
    FakeSR.instances[FakeSR.instances.length - 1].end();
    expect(FakeSR.instances).toHaveLength(n); // no new instance after stop
  });

  it("a fatal error (not-allowed) stops listening and does NOT hot-loop", () => {
    installFake();
    const onError = vi.fn();
    const v = createContinuousVoiceInput({ onError })!;
    v.start();
    FakeSR.instances[0].emitError("not-allowed");
    FakeSR.instances[0].end();
    expect(onError).toHaveBeenCalledWith("not-allowed");
    expect(v.listening).toBe(false);
    expect(FakeSR.instances).toHaveLength(1); // did not re-arm
  });

  it("returns null when no speech backend exists", () => {
    // no fake installed, and not a native WebView
    expect(createContinuousVoiceInput({})).toBeNull();
  });
});
