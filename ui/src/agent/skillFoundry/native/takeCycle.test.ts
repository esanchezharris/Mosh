// Skill Foundry Slice B, Task 2 — the native `capture-review-choose-take` handler.

import { describe, expect, it, vi } from "vitest";
import type { Snapshot, Track } from "../../../types";
import type {
  NativeSkillPayloadV1,
  RecordingLifecycleResultV1,
  StudioSkillEnvironmentV1,
} from "../contracts";
import { resolveRecordTargetV1, takeCycleV1 } from "./takeCycle";

const PAYLOAD: NativeSkillPayloadV1 = {
  schemaVersion: 1,
  id: "capture-review-choose-take",
  version: "1.0.0",
  implementation: "native",
  handlerKey: "takeCycleV1",
  title: "Capture, review, and choose a take",
  description: "Start/stop a recording, audition, retry, and keep a take.",
  intents: { positiveExamples: ["record a take"], negativeExamples: [], tags: ["recording"] },
  slots: [],
  execution: { mode: "lifecycle", confirmation: "never" },
  responses: { completed: "Done.", needsChoice: "Which one?", blocked: "Can't do that." },
  provenance: [],
  legacyAliases: [],
  compatibility: {
    minMoshVersion: "0.1.0", commandCatalogSha256: "x", predicateCatalogVersion: 1,
    resolverCatalogVersion: 1, nativeSourceSha256: "y",
  },
};

function track(overrides: Partial<Track> & { id: string }): Track {
  return { name: overrides.id, clips: [], ...overrides } as Track;
}

function baseSnapshot(tracks: Track[], overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    schemaVersion: 1,
    session: { sampleRate: 48000, tempo: 120, key: { root: "C", scale: "major" }, editFile: "x" },
    transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
    tracks,
    ...overrides,
  } as unknown as Snapshot;
}

type FakeRecordingCalls = { start: number; stop: number; audition: (-1 | 1)[]; keep: number };

function fakeEnvironment(opts: {
  snapshot: Snapshot | (() => Snapshot) | (() => Promise<Snapshot>);
  selectedTrackId?: string | null;
  recordingResults?: Partial<{
    start: RecordingLifecycleResultV1;
    stop: RecordingLifecycleResultV1;
    audition: RecordingLifecycleResultV1;
    keep: RecordingLifecycleResultV1;
  }>;
}): { environment: StudioSkillEnvironmentV1; calls: FakeRecordingCalls } {
  const calls: FakeRecordingCalls = { start: 0, stop: 0, audition: [], keep: 0 };
  const resolveSnapshot = async (): Promise<Snapshot> =>
    typeof opts.snapshot === "function" ? (opts.snapshot as () => Snapshot | Promise<Snapshot>)() : opts.snapshot;

  const ok = (state: string): RecordingLifecycleResultV1 => ({ ok: true, state, say: state, changes: null });

  const environment: StudioSkillEnvironmentV1 = {
    context: () => ({ projectEpoch: 1, selectedTrackId: opts.selectedTrackId ?? null, tracks: [] }),
    snapshot: resolveSnapshot,
    exec: vi.fn(async () => { throw new Error("takeCycleV1 must never call exec() directly"); }),
    readSourceStatus: async () => ({ schemaVersion: 1, ok: true, statusIndex: null, diagnostics: [] }),
    runBatch: vi.fn(async () => { throw new Error("takeCycleV1 must never call runBatch() directly"); }),
    refresh: async () => {},
    recording: {
      start: async () => { calls.start += 1; return opts.recordingResults?.start ?? ok("recording"); },
      stop: async () => { calls.stop += 1; return opts.recordingResults?.stop ?? ok("reviewing"); },
      audition: async (delta) => { calls.audition.push(delta); return opts.recordingResults?.audition ?? ok("reviewing"); },
      keep: async () => { calls.keep += 1; return opts.recordingResults?.keep ?? ok("kept"); },
    },
  };
  return { environment, calls };
}

describe("resolveRecordTargetV1", () => {
  it("resolves the sole armed, input-capable track", () => {
    const snap = baseSnapshot([track({ id: "t1", armed: true, hasInput: true }), track({ id: "t2" })]);
    expect(resolveRecordTargetV1(snap, null)).toEqual({ kind: "resolved", trackId: "t1" });
  });

  it("reports ambiguous_target for two armed, input-capable tracks", () => {
    const snap = baseSnapshot([
      track({ id: "t1", armed: true, hasInput: true }),
      track({ id: "t2", armed: true, hasInput: true }),
    ]);
    expect(resolveRecordTargetV1(snap, null)).toEqual({ kind: "ambiguous_target" });
  });

  it("falls back to the selected track only when it is input-capable", () => {
    const snap = baseSnapshot([track({ id: "t1", hasInput: true }), track({ id: "t2" })]);
    expect(resolveRecordTargetV1(snap, "t1")).toEqual({ kind: "resolved", trackId: "t1" });
    expect(resolveRecordTargetV1(snap, "t2")).toEqual({ kind: "missing_target" });
  });

  it("never falls back to the first audio/first project track", () => {
    const snap = baseSnapshot([track({ id: "t1" }), track({ id: "t2" })]); // neither armed nor selected/hasInput
    expect(resolveRecordTargetV1(snap, null)).toEqual({ kind: "missing_target" });
  });

  it("reports observation_failed for a malformed snapshot", () => {
    const snap = { session: {} } as unknown as Snapshot;
    expect(resolveRecordTargetV1(snap, null)).toEqual({
      kind: "observation_failed", reason: "malformed snapshot: tracks is not an array",
    });
  });

  it("ignores an armed track with hasInput !== true", () => {
    const snap = baseSnapshot([track({ id: "t1", armed: true, hasInput: false })]);
    expect(resolveRecordTargetV1(snap, null)).toEqual({ kind: "missing_target" });
  });
});

describe("takeCycleV1 — start", () => {
  it("resolves the target then calls recording.start(), completing on success", async () => {
    const snap = baseSnapshot([track({ id: "t1", armed: true, hasInput: true })]);
    const { environment, calls } = fakeEnvironment({ snapshot: snap });
    const outcome = await takeCycleV1({ payload: PAYLOAD, environment, utterance: "record", slots: { action: "start" } });
    expect(outcome).toMatchObject({ kind: "completed", changes: null });
    expect(calls.start).toBe(1);
  });

  it("blocks with ambiguous_target and calls recording.start() ZERO times", async () => {
    const snap = baseSnapshot([
      track({ id: "t1", armed: true, hasInput: true }),
      track({ id: "t2", armed: true, hasInput: true }),
    ]);
    const { environment, calls } = fakeEnvironment({ snapshot: snap });
    const outcome = await takeCycleV1({ payload: PAYLOAD, environment, utterance: "record", slots: { action: "start" } });
    expect(outcome).toMatchObject({ kind: "blocked", code: "ambiguous_target" });
    expect(calls.start).toBe(0);
  });

  it("blocks with missing_target and calls recording.start() ZERO times", async () => {
    const snap = baseSnapshot([track({ id: "t1" })]);
    const { environment, calls } = fakeEnvironment({ snapshot: snap });
    const outcome = await takeCycleV1({ payload: PAYLOAD, environment, utterance: "record", slots: { action: "start" } });
    expect(outcome).toMatchObject({ kind: "blocked", code: "missing_target" });
    expect(calls.start).toBe(0);
  });

  it("blocks with observation_failed on a snapshot() rejection, zero recording calls", async () => {
    const { environment, calls } = fakeEnvironment({
      snapshot: async () => { throw new Error("bridge down"); },
    });
    const outcome = await takeCycleV1({ payload: PAYLOAD, environment, utterance: "record", slots: { action: "start" } });
    expect(outcome).toMatchObject({ kind: "blocked", code: "observation_failed" });
    expect(calls.start).toBe(0);
  });

  it("propagates a recording.start() failure as blocked with its own reason code", async () => {
    const snap = baseSnapshot([track({ id: "t1", armed: true, hasInput: true })]);
    const { environment } = fakeEnvironment({
      snapshot: snap,
      recordingResults: { start: { ok: false, code: "observation_failed", say: "no usable input" } },
    });
    const outcome = await takeCycleV1({ payload: PAYLOAD, environment, utterance: "record", slots: { action: "start" } });
    expect(outcome).toMatchObject({ kind: "blocked", code: "observation_failed", say: "no usable input" });
  });
});

describe("takeCycleV1 — again", () => {
  it("requires stopped transport and non-recording controller BEFORE calling start", async () => {
    const stillSnap = baseSnapshot([track({ id: "t1", armed: true, hasInput: true })]);
    const { environment, calls } = fakeEnvironment({ snapshot: stillSnap });
    const outcome = await takeCycleV1({ payload: PAYLOAD, environment, utterance: "again", slots: { action: "again" } });
    expect(outcome).toMatchObject({ kind: "completed" });
    expect(calls.start).toBe(1);
  });

  it("blocks without calling start when transport.recording is still true", async () => {
    const snap = baseSnapshot([track({ id: "t1", armed: true, hasInput: true })], {
      transport: { playing: false, recording: true, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
    });
    const { environment, calls } = fakeEnvironment({ snapshot: snap });
    const outcome = await takeCycleV1({ payload: PAYLOAD, environment, utterance: "again", slots: { action: "again" } });
    expect(outcome).toMatchObject({ kind: "blocked", code: "stale_context" });
    expect(calls.start).toBe(0);
  });

  it("blocks without calling start when transport.playing is still true", async () => {
    const snap = baseSnapshot([track({ id: "t1", armed: true, hasInput: true })], {
      transport: { playing: true, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
    });
    const { environment, calls } = fakeEnvironment({ snapshot: snap });
    const outcome = await takeCycleV1({ payload: PAYLOAD, environment, utterance: "again", slots: { action: "again" } });
    expect(outcome).toMatchObject({ kind: "blocked", code: "stale_context" });
    expect(calls.start).toBe(0);
  });

  it("blocks without calling start when controller.record is still 'recording'", async () => {
    const snap = baseSnapshot([track({ id: "t1", armed: true, hasInput: true })], {
      controller: { mode: "capture", record: "recording", take: { exists: false }, agent: "idle" },
    });
    const { environment, calls } = fakeEnvironment({ snapshot: snap });
    const outcome = await takeCycleV1({ payload: PAYLOAD, environment, utterance: "again", slots: { action: "again" } });
    expect(outcome).toMatchObject({ kind: "blocked", code: "stale_context" });
    expect(calls.start).toBe(0);
  });
});

describe("takeCycleV1 — stop/audition/keep delegate to the recording environment only", () => {
  it("stop calls recording.stop() exactly once and never exec/runBatch", async () => {
    const { environment, calls } = fakeEnvironment({ snapshot: baseSnapshot([]) });
    const outcome = await takeCycleV1({ payload: PAYLOAD, environment, utterance: "stop", slots: { action: "stop" } });
    expect(outcome).toMatchObject({ kind: "completed" });
    expect(calls.stop).toBe(1);
    expect(environment.exec).not.toHaveBeenCalled();
    expect(environment.runBatch).not.toHaveBeenCalled();
  });

  it("audition_next/audition_previous pass the correct signed delta", async () => {
    const { environment, calls } = fakeEnvironment({ snapshot: baseSnapshot([]) });
    await takeCycleV1({ payload: PAYLOAD, environment, utterance: "next take", slots: { action: "audition_next" } });
    await takeCycleV1({ payload: PAYLOAD, environment, utterance: "previous take", slots: { action: "audition_previous" } });
    expect(calls.audition).toEqual([1, -1]);
  });

  it("keep calls recording.keep() exactly once", async () => {
    const { environment, calls } = fakeEnvironment({ snapshot: baseSnapshot([]) });
    const outcome = await takeCycleV1({ payload: PAYLOAD, environment, utterance: "keep it", slots: { action: "keep" } });
    expect(outcome).toMatchObject({ kind: "completed" });
    expect(calls.keep).toBe(1);
  });

  it("every lifecycle outcome carries changes:null (never claims atomic rollback)", async () => {
    const { environment } = fakeEnvironment({ snapshot: baseSnapshot([]) });
    const outcome = await takeCycleV1({ payload: PAYLOAD, environment, utterance: "keep it", slots: { action: "keep" } });
    expect(outcome).toMatchObject({ changes: null });
  });
});

describe("takeCycleV1 — malformed action slot", () => {
  it("blocks missing_slot when the action slot is absent", async () => {
    const { environment } = fakeEnvironment({ snapshot: baseSnapshot([]) });
    const outcome = await takeCycleV1({ payload: PAYLOAD, environment, utterance: "", slots: {} });
    expect(outcome).toMatchObject({ kind: "blocked", code: "missing_slot" });
  });

  it("blocks invalid_slot for an unrecognized action string", async () => {
    const { environment } = fakeEnvironment({ snapshot: baseSnapshot([]) });
    const outcome = await takeCycleV1({ payload: PAYLOAD, environment, utterance: "", slots: { action: "delete_everything" } });
    expect(outcome).toMatchObject({ kind: "blocked", code: "invalid_slot" });
  });
});
