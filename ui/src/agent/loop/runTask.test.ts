// The full app-side loop integration, hermetic: runLoopTask → chatWithFallback
// (the explicit Vitest dev surface permits the deterministic loopBrainMock) → the
// loop FSM → the TASK-scoped executor → the dev mock backend. One ask becomes a
// real two-step task, the store view fills in, and ONE undo reverts everything.

import { describe, it, expect, beforeEach } from "vitest";
import {
  compactMelodyCommand,
  compactMelodySpec,
  runLoopTask,
  agenticLoopEnabled,
  loopAllowedFor,
  agenticLoopOn,
} from "./runTask";
import { useTaskStore } from "./taskStore";
import { useStore } from "../../store";
import { __resetMockForTests } from "../../bridge.mock";
import type { Snapshot } from "../../types";

function snap(): Snapshot {
  const s = useStore.getState().snapshot;
  if (!s) throw new Error("no snapshot");
  return s;
}

const noopUi = { say: () => {}, utter: () => {} };

describe("runLoopTask — composer ask → multi-step task → one undo unit", () => {
  beforeEach(async () => {
    __resetMockForTests();
    // Start EMPTY: the dev seed already carries a "Drums" track, which would
    // make every drum assertion below vacuously true against the seed.
    await useStore.getState().exec("new_project", {});
    await useStore.getState().refresh();
    useTaskStore.setState({ current: null, last: null, history: [], drawerOpen: false, signal: null });
  });

  it("the lofi script runs two steps against the real mock and lands done", async () => {
    const utters: string[] = [];
    const run = await runLoopTask("build me a lofi sketch", { say: () => {}, utter: (i) => utters.push(i) });

    expect(run.outcome).toBe("done");
    expect(run.stepCount).toBe(2);
    expect(snap().session.tempo).toBe(80);                                  // step 1
    const drums = snap().tracks.find((t) => t.name === "Drums");
    expect(drums, "add_drum_pattern created its Drums track").toBeTruthy(); // step 2
    if (!drums) throw new Error("add_drum_pattern did not create its Drums track");
    const firstClip = drums.clips[0];
    if (!firstClip) throw new Error("add_drum_pattern did not create a clip");
    expect((firstClip.notes ?? []).length).toBeGreaterThanOrEqual(8);

    // beats only: ACK_WORKING at start, DONE at the end — no per-step spam
    expect(utters[0]).toBe("ACK_WORKING");
    expect(utters[utters.length - 1]).toBe("DONE");

    // the store view is renderable history now
    const st = useTaskStore.getState();
    expect(st.current).toBeNull();
    expect(st.last?.outcome).toBe("done");
    expect(st.last?.steps).toHaveLength(2);
    expect(st.last?.plan.map((p) => p.goal)).toEqual(["set a lazy tempo", "lay dusty drums"]);
    expect(st.history).toHaveLength(1);

    // ONE undo reverts the WHOLE task (tempo AND the drum track)
    const u = await useStore.getState().exec("undo");
    expect(u.ok).toBe(true);
    await useStore.getState().refresh();
    expect(snap().session.tempo).toBe(120);
    expect(snap().tracks.some((t) => t.name === "Drums")).toBe(false);
  });

  it("an unrecognized ask parks as need_user with zero session mutation", async () => {
    const before = JSON.stringify(snap());
    const run = await runLoopTask("do the thing", noopUi);

    expect(run.outcome).toBe("need_user");
    expect(run.deferred).toBe(true);
    expect(useTaskStore.getState().last?.outcome).toBe("need_user");
    await useStore.getState().refresh();
    expect(JSON.stringify(snap())).toBe(before);
  });

  it("runs the exact in-key melody ask through the compact local-model contract", async () => {
    const track = await useStore.getState().exec("create_track", { name: "Keys", type: "midi" });
    const trackId = (track.data as { trackId: string }).trackId;
    const clip = await useStore.getState().exec("add_midi_clip", { trackId, start: 0, length: 8 });
    const clipId = (clip.data as { clipId: string }).clipId;
    await useStore.getState().exec("set_key", { tonic: "A", mode: "minor" });
    await useStore.getState().refresh();

    const run = await runLoopTask("give the keys a little melody idea, nothing fancy, keep it in key", noopUi);

    expect(run.outcome).toBe("done");
    expect(run.stepCount).toBe(1);
    const keys = snap().tracks.find((candidate) => candidate.id === trackId)!;
    expect(keys.clips.find((candidate) => candidate.id === clipId)?.notes).toHaveLength(8);
    expect(useTaskStore.getState().last?.steps[0]?.commands[0]?.args).toMatchObject({ clipId });

    await useStore.getState().exec("undo");
    await useStore.getState().refresh();
    expect(snap().tracks.find((candidate) => candidate.id === trackId)!
      .clips.find((candidate) => candidate.id === clipId)?.notes ?? []).toHaveLength(0);
  });

  it("accepts only a varied, in-scale pitch sequence from the compact contract", async () => {
    const track = await useStore.getState().exec("create_track", { name: "Keys", type: "midi" });
    const trackId = (track.data as { trackId: string }).trackId;
    const clip = await useStore.getState().exec("add_midi_clip", { trackId, start: 0, length: 8 });
    const clipId = (clip.data as { clipId: string }).clipId;
    await useStore.getState().exec("set_key", { tonic: "A", mode: "minor" });
    await useStore.getState().refresh();
    const spec = compactMelodySpec("give the keys a melody, keep it in key", snap())!;

    expect(spec.clipId).toBe(clipId);
    expect(spec.prompt.length).toBeLessThan(300);
    expect(compactMelodyCommand('{"p":[60,62,64,65,64,62,60,57]}', spec)?.args).toMatchObject({ clipId });
    expect(compactMelodyCommand('{"p":[60,61,64,65,64,62,60,57]}', spec)).toBeNull();
    expect(compactMelodyCommand('{"p":[60,60,60,60,60,60,60,60]}', spec)).toBeNull();
  });

  it("leaves compound melody requests to the full agent loop", async () => {
    const track = await useStore.getState().exec("create_track", { name: "Keys", type: "midi" });
    const trackId = (track.data as { trackId: string }).trackId;
    await useStore.getState().exec("add_midi_clip", { trackId, start: 0, length: 8 });
    await useStore.getState().exec("set_key", { tonic: "A", mode: "minor" });
    await useStore.getState().refresh();

    for (const ask of [
      "give Keys a melody, keep it in key, and make it faster",
      "give Keys a melody, keep it in key; make it faster",
      "give Keys a melody, keep it in key, after that make it faster",
      "give Keys a melody, keep it in key, next make it faster",
      "give Keys a melody, keep it in key, finally make it faster",
    ]) expect(compactMelodySpec(ask, snap())).toBeNull();
  });

  it("agenticLoopOn stays off without the developer build flag", () => {
    expect(agenticLoopOn()).toBe(false);
  });

  it("the explicit build flag enables the loop in a packaged build", () => {
    expect(agenticLoopEnabled("1")).toBe(true);
    expect(agenticLoopEnabled(undefined)).toBe(false);
    expect(loopAllowedFor("1", false)).toBe(true);
    expect(loopAllowedFor("1", true)).toBe(false);
  });
});
