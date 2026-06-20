import { describe, it, expect, vi } from "vitest";
import { createHandsFree } from "./handsFree";
import type { VoiceCallbacks, VoiceInput } from "./voiceInput";
import type { FastAction, Mode } from "./fastPath";

// A controllable fake continuous voice source: it captures the callbacks the
// controller wires, so a test can push `final` transcripts at will and observe
// the start/abort lifecycle — no real Web Speech / native backend, no timers.
function harness(opts: { mode?: Mode; busy?: boolean } = {}) {
  let cb: VoiceCallbacks = {};
  let aborted = true; // not started until engage()
  let now = 1000;
  let busy = opts.busy ?? false;
  let mode: Mode = opts.mode ?? "idle";
  const dispatched: FastAction[] = [];
  const setListening = vi.fn();
  const source: VoiceInput = {
    start: () => { aborted = false; cb.onStart?.(); },
    stop: () => { cb.onStop?.(); },
    abort: () => { aborted = true; },
    get listening() { return !aborted; },
  };
  const makeSource = vi.fn((c: VoiceCallbacks): VoiceInput => { cb = c; return source; });
  const dispatch = vi.fn(async (a: FastAction) => { dispatched.push(a); });
  const hf = createHandsFree({
    getCtx: () => ({ mode, tempo: 120, timeSigNum: 4 }),
    isBusy: () => busy,
    setBusy: (b: boolean) => { busy = b; },
    dispatch,
    makeSource,
    setListening,
    now: () => now,
  });
  return {
    hf, dispatched, makeSource, setListening, dispatch,
    pushFinal: (t: string): Promise<void> => Promise.resolve(cb.onFinal?.(t) as unknown as void),
    advance: (ms: number) => { now += ms; },
    forceBusy: (b: boolean) => { busy = b; },
    setMode: (m: Mode) => { mode = m; },
    isStarted: () => !aborted,
  };
}

describe("createHandsFree", () => {
  it("dispatches the matched FastAction for a known command phrase", async () => {
    const h = harness();
    h.hf.engage();
    await h.pushFinal("play it");
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]).toMatchObject({ kind: "commands" });
  });

  it("drops unknown speech — no dispatch (it never reaches the brain)", async () => {
    const h = harness();
    h.hf.engage();
    await h.pushFinal("make the bass warmer and add some reverb");
    expect(h.dispatched).toHaveLength(0);
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it("resolves commands against the LIVE performer mode (barge-in 'stop')", async () => {
    const h = harness({ mode: "recording" });
    h.hf.engage();
    await h.pushFinal("stop");
    expect(h.dispatched[0]).toMatchObject({ kind: "stopRecord" });
  });

  it("dedupes a repeated final inside the debounce window", async () => {
    const h = harness();
    h.hf.engage();
    await h.pushFinal("undo that");
    await h.pushFinal("undo that"); // same text, same instant → collapsed
    expect(h.dispatched).toHaveLength(1);
    h.advance(800); // past the window → a real second utterance
    await h.pushFinal("undo that");
    expect(h.dispatched).toHaveLength(2);
  });

  it("drops a final while the agent is busy", async () => {
    const h = harness({ busy: true });
    h.hf.engage();
    await h.pushFinal("play it");
    expect(h.dispatched).toHaveLength(0);
  });

  it("ignores finals before engage and after disengage; releases the mic on disengage", async () => {
    const h = harness();
    await h.pushFinal("play it"); // before engage — no source yet
    expect(h.dispatched).toHaveLength(0);
    h.hf.engage();
    h.hf.disengage();
    await h.pushFinal("play it"); // after disengage — controller ignores
    expect(h.dispatched).toHaveLength(0);
    expect(h.isStarted()).toBe(false);
  });

  it("engage builds + starts one source (idempotent); disengage aborts it", () => {
    const h = harness();
    h.hf.engage();
    h.hf.engage();
    expect(h.makeSource).toHaveBeenCalledTimes(1);
    expect(h.isStarted()).toBe(true);
    expect(h.setListening).toHaveBeenCalledWith(true);
    h.hf.disengage();
    expect(h.isStarted()).toBe(false);
    expect(h.setListening).toHaveBeenLastCalledWith(false);
  });
});
