import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../store";
import { __resetMockForTests } from "../bridge.mock";
import { useTaskStore, type TaskView } from "../agent/loop/taskStore";
import { dropChords, dropDrumBeat } from "./beats";
import type { CommandResult } from "../types";

// Review fix 2: a double click on + Drum beat or + Chords must not run the drop twice. The
// buttons stay enabled while their own promise runs, so without a guard a double click landed
// two Drums tracks (two undo steps), or a second + Chords collided with the first click's own
// open batch and blamed Moshi for it.

const st = () => useStore.getState();
type Call = { command: string; args?: Record<string, unknown> };
const count = (calls: Call[], command: string) => calls.filter((c) => c.command === command).length;
const liveTask = (): TaskView => ({ ask: "build a beat", phase: "stepping", plan: [], steps: [], startedAt: Date.now() });

describe("one drop at a time", () => {
  const originalExec = useStore.getState().exec;
  let calls: Call[];
  let override: ((c: string, a?: Record<string, unknown>) => CommandResult | null) | null;

  beforeEach(async () => {
    __resetMockForTests();
    useStore.setState({ exec: originalExec, lastError: null });
    useTaskStore.setState({ current: null, signal: null });
    await st().refresh();
    calls = [];
    override = null;
    const real = st().exec;
    useStore.setState({
      exec: (async (command: string, args?: Record<string, unknown>, ...rest: unknown[]) => {
        calls.push({ command, args });
        const forced = override?.(command, args);
        if (forced) return forced;
        return (real as (...a: unknown[]) => Promise<CommandResult>)(command, args, ...rest);
      }) as typeof real,
    });
  });
  afterEach(() => {
    useStore.setState({ exec: originalExec });
    useTaskStore.setState({ current: null, signal: null });
  });

  it("two rapid + Drum beat clicks land exactly ONE add_drum_pattern and one new track", async () => {
    const before = st().snapshot!.tracks.length;
    const [a, b] = await Promise.all([dropDrumBeat(), dropDrumBeat()]);
    expect(count(calls, "add_drum_pattern")).toBe(1);
    expect([a, b].filter((r) => r !== null)).toHaveLength(1);
    await st().refresh();
    expect(st().snapshot!.tracks.length).toBe(before + 1);
    // the guard clears once the drop settles: the next click works (anti-stuck)
    expect(await dropDrumBeat()).not.toBeNull();
    expect(count(calls, "add_drum_pattern")).toBe(2);
  });

  it("two rapid + Chords clicks land exactly ONE create_track, and never blame Moshi", async () => {
    const before = st().snapshot!.tracks.length;
    const [a, b] = await Promise.all([dropChords(), dropChords()]);
    expect(count(calls, "create_track")).toBe(1);
    expect(count(calls, "batch_begin")).toBe(1);
    expect([a, b].filter((r) => r !== null)).toHaveLength(1);
    expect(st().lastError ?? "").not.toMatch(/Moshi/);
    await st().refresh();
    expect(st().snapshot!.tracks.length).toBe(before + 1);
  });

  it("+ Drum beat then + Chords before the beat settles: only the first runs", async () => {
    const [beat, chords] = await Promise.all([dropDrumBeat(), dropChords()]);
    expect(beat).not.toBeNull();
    expect(chords).toBeNull();
    expect(count(calls, "add_drum_pattern")).toBe(1);
    expect(count(calls, "create_track")).toBe(0);
  });

  it("a drop that throws clears the guard", async () => {
    override = (c) => { if (c === "add_drum_pattern") throw new Error("bridge dropped"); return null; };
    await expect(dropDrumBeat()).rejects.toThrow("bridge dropped");
    override = null;
    expect(await dropDrumBeat()).not.toBeNull();
  });

  it("a batch collision blames Moshi only while a Moshi task is live", async () => {
    // someone else's open batch, no Moshi task: the message must not name Moshi
    expect((await st().exec("batch_begin", { name: "other" })).ok).toBe(true);
    expect(useTaskStore.getState().current).toBeNull();
    expect(await dropChords()).toBeNull();
    expect(st().lastError).toBeTruthy();
    expect(st().lastError).not.toMatch(/Moshi/);
    // the same collision while a Moshi task IS live says so
    useTaskStore.setState({ current: liveTask(), signal: { aborted: false } });
    expect(await dropChords()).toBeNull();
    expect(st().lastError).toMatch(/Moshi is still working/);
    await st().exec("batch_end", {});
    expect(count(calls, "create_track")).toBe(0);
  });
});
