import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mockExecute, mockSnapshot, __resetMockForTests } from "./bridge.mock";
import type { CommandResult, Snapshot } from "./types";

const withoutBrowserWindow = async (run: () => Promise<void>) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { value: undefined, configurable: true });
  try {
    await run();
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
};

const waveClipId = async () => {
  const s = await mockSnapshot<Snapshot>();
  const wave = s.tracks.flatMap((t) => t.clips).find((c) => c.type === "wave");
  expect(wave).toBeTruthy();
  return wave!.id;
};

describe("mock MoshOps runtime replay", () => {
  beforeEach(() => { __resetMockForTests(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("finishes skeleton extraction without a browser window global", async () => {
    await withoutBrowserWindow(async () => {
      const clipId = await waveClipId();
      const res = await mockExecute<CommandResult>({ command: "build_skeleton_from_clip", args: { clipId } });
      expect(res.ok).toBe(true);

      await vi.advanceTimersByTimeAsync(500);

      const after = await mockSnapshot<Snapshot>();
      const track = after.tracks.find((t) => t.clips.some((c) => c.id === clipId));
      expect(track?.lyricSheet?.lines.map((l) => l.status)).toEqual(["skeleton", "skeleton", "seed"]);
    });
  });

  it("finishes beatbox sketching without a browser window global", async () => {
    await withoutBrowserWindow(async () => {
      const before = await mockSnapshot<Snapshot>();
      const res = await mockExecute<CommandResult>({ command: "sketch_beatbox", args: { file: "/tmp/boombap.wav", bpm: 92, bars: 1 } });
      expect(res.ok).toBe(true);

      await vi.advanceTimersByTimeAsync(500);

      const after = await mockSnapshot<Snapshot>();
      expect(after.tracks.length).toBe(before.tracks.length + 1);
      expect(after.tracks[after.tracks.length - 1].type).toBe("drum");
    });
  });
});
