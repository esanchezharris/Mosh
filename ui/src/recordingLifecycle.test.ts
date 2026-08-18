// Skill Foundry Slice B, Task 2 — observed recording-lifecycle state.

import { describe, expect, it } from "vitest";
import {
  createRecordingLifecycleEnvironmentV1,
  landedRecordingClipIds,
  observeRecordingLane,
  type RecordingLaneObservationV1,
  type RecordingStoreOutcomeV1,
} from "./recordingLifecycle";
import type { CommandResult, Snapshot } from "./types";

function snapshotWithClip(overrides: Partial<{
  takeIds: string[] | undefined;
  currentTakeId: string | undefined;
}> = {}): Snapshot {
  return {
    tracks: [
      {
        id: "trk1",
        clips: [
          {
            id: "clip1",
            name: "take",
            type: "wave",
            start: 0,
            length: 1,
            offset: 0,
            hasRenderLayer: false,
            takeIds: "takeIds" in overrides ? overrides.takeIds : ["t1", "t2"],
            currentTakeId: "currentTakeId" in overrides ? overrides.currentTakeId : "t2",
          },
        ],
      },
    ],
  } as unknown as Snapshot;
}

describe("landedRecordingClipIds", () => {
  it("returns null for a non-stop_recording result", () => {
    expect(landedRecordingClipIds({ ok: true, command: "set_transport", data: {} })).toBeNull();
  });

  it("returns the landed ids on a well-formed applied result", () => {
    const result: CommandResult = {
      ok: true, command: "stop_recording",
      data: { applied: true, clips: [{ id: "c1" }, { id: "c2" }] },
    };
    expect(landedRecordingClipIds(result)).toEqual(["c1", "c2"]);
  });
});

describe("observeRecordingLane", () => {
  it("observes a well-formed clip's takeIds/currentTakeId", () => {
    const observation = observeRecordingLane(snapshotWithClip(), "clip1");
    expect(observation).toEqual<RecordingLaneObservationV1>({
      clipId: "clip1", trackId: "trk1", takeIds: ["t1", "t2"], currentTakeId: "t2",
    });
  });

  it("returns null for an unknown clip id", () => {
    expect(observeRecordingLane(snapshotWithClip(), "no-such-clip")).toBeNull();
  });

  it("returns null when takeIds is missing or empty", () => {
    expect(observeRecordingLane(snapshotWithClip({ takeIds: undefined }), "clip1")).toBeNull();
    expect(observeRecordingLane(snapshotWithClip({ takeIds: [] }), "clip1")).toBeNull();
  });

  it("returns null when any takeIds entry is empty (not yet backfilled)", () => {
    expect(observeRecordingLane(snapshotWithClip({ takeIds: ["t1", ""] }), "clip1")).toBeNull();
  });

  it("returns null when currentTakeId is missing, empty, or not among takeIds", () => {
    expect(observeRecordingLane(snapshotWithClip({ currentTakeId: undefined }), "clip1")).toBeNull();
    expect(observeRecordingLane(snapshotWithClip({ currentTakeId: "" }), "clip1")).toBeNull();
    expect(observeRecordingLane(snapshotWithClip({ currentTakeId: "not-in-set" }), "clip1")).toBeNull();
  });
});

describe("createRecordingLifecycleEnvironmentV1", () => {
  function deps(overrides: Partial<{
    enterRecord: (bar?: number) => Promise<RecordingStoreOutcomeV1>;
    stopRecord: () => Promise<RecordingStoreOutcomeV1>;
    navTake: (delta: -1 | 1) => Promise<RecordingStoreOutcomeV1>;
    keepTake: (takeId?: string) => Promise<RecordingStoreOutcomeV1>;
  }> = {}) {
    return {
      enterRecord: overrides.enterRecord ?? (async () => ({ kind: "started", baseline: null })),
      stopRecord: overrides.stopRecord ?? (async () => ({ kind: "not_recording" })),
      navTake: overrides.navTake ?? (async () => ({ kind: "not_recording" })),
      keepTake: overrides.keepTake ?? (async () => ({ kind: "not_recording" })),
    };
  }

  it("start() maps a started outcome to ok:true state:recording", async () => {
    const env = createRecordingLifecycleEnvironmentV1(deps());
    await expect(env.start()).resolves.toMatchObject({ ok: true, state: "recording" });
  });

  it("stop() maps a reviewing outcome to ok:true state:reviewing", async () => {
    const review: RecordingLaneObservationV1 = { clipId: "c1", trackId: "t1", takeIds: ["a"], currentTakeId: "a" };
    const env = createRecordingLifecycleEnvironmentV1(deps({ stopRecord: async () => ({ kind: "reviewing", review }) }));
    await expect(env.stop()).resolves.toMatchObject({ ok: true, state: "reviewing" });
  });

  it("maps a blocked outcome to ok:false with a reason code and the exact reason as say", async () => {
    const env = createRecordingLifecycleEnvironmentV1(deps({
      enterRecord: async () => ({ kind: "blocked", reason: "no eligible target" }),
    }));
    await expect(env.start()).resolves.toEqual({ ok: false, code: "missing_target", say: "no eligible target" });
  });

  it("maps a recording_failed outcome to ok:false observation_failed", async () => {
    const env = createRecordingLifecycleEnvironmentV1(deps({
      enterRecord: async () => ({ kind: "recording_failed", reason: "device rejected" }),
    }));
    await expect(env.start()).resolves.toEqual({ ok: false, code: "observation_failed", say: "device rejected" });
  });

  it("audition()/keep() route to navTake/keepTake respectively", async () => {
    let navCalledWith: number | undefined;
    let keepCalled = false;
    const env = createRecordingLifecycleEnvironmentV1(deps({
      navTake: async (delta) => { navCalledWith = delta; return { kind: "not_recording" }; },
      keepTake: async () => { keepCalled = true; return { kind: "kept", review: null }; },
    }));
    await env.audition(-1);
    expect(navCalledWith).toBe(-1);
    const keepResult = await env.keep();
    expect(keepCalled).toBe(true);
    expect(keepResult).toMatchObject({ ok: true, state: "kept" });
  });
});
