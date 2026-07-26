// UI-REACH (sketch_beatbox) — the store's sketch_status reducer. Mirrors
// store.scanProgress.test.ts's idiom: the dev mock's own sketch_beatbox path already
// exercises this end-to-end (sketch.test.ts), but an "error" state — the install-gated,
// no-graceful-degradation 503 from a real Mac without the sketch venv — is not something
// the mock ever produces on its own, so it's published directly via __mockEmitForTests,
// the same idiom store.lifecycle.test.ts/store.scanProgress.test.ts use for backend-only
// event shapes.
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { useStore } from "./store";
import { __resetMockForTests, __mockEmitForTests } from "./bridge.mock";

describe("sketch_status reducer (UI-REACH sketch_beatbox)", () => {
  beforeAll(() => { useStore.getState().init(); }); // wires the reducer to the mock's event bus
  beforeEach(() => {
    __resetMockForTests();
    useStore.setState({ sketchingBeatbox: {}, lastError: null });
  });

  it("a working event marks the source FILE PATH (not a clipId) as in flight", () => {
    __mockEmitForTests("sketch_status", { file: "/tmp/boombap.wav", state: "working", bpm: 90, bars: 1 });
    expect(useStore.getState().sketchingBeatbox).toEqual({ "/tmp/boombap.wav": true });
    expect(useStore.getState().lastError).toBeNull();
  });

  it("a done event clears the in-flight flag for that path and leaves others untouched", () => {
    __mockEmitForTests("sketch_status", { file: "/tmp/a.wav", state: "working" });
    __mockEmitForTests("sketch_status", { file: "/tmp/b.wav", state: "working" });
    __mockEmitForTests("sketch_status", { file: "/tmp/a.wav", state: "done", hitCount: 8 });
    expect(useStore.getState().sketchingBeatbox).toEqual({ "/tmp/b.wav": true });
  });

  it("an error event clears the in-flight flag AND surfaces the exact backend message — " +
     "install-gated with no graceful degradation, so the raw 503 text must reach the user, " +
     "not a swallowed or generic failure", () => {
    __mockEmitForTests("sketch_status", { file: "/tmp/boombap.wav", state: "working" });
    __mockEmitForTests("sketch_status", {
      file: "/tmp/boombap.wav", state: "error",
      error: "sketch_unavailable (run service/sketch/setup-sketch.sh)",
    });
    expect(useStore.getState().sketchingBeatbox).toEqual({});
    expect(useStore.getState().lastError).toBe("sketch_unavailable (run service/sketch/setup-sketch.sh)");
  });

  it("an error with no message falls back to a plain, honest default", () => {
    __mockEmitForTests("sketch_status", { file: "/tmp/x.wav", state: "error" });
    expect(useStore.getState().lastError).toBe("could not sketch a beat from that take");
  });
});
