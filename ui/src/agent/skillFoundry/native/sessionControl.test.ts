// Skill Foundry Slice B, Task 3 — deterministic, non-toggle session control.

import { describe, expect, it, vi } from "vitest";
import type { CommandResult, Snapshot } from "../../../types";
import type { RecordingLifecycleResultV1, StudioSkillEnvironmentV1 } from "../contracts";
import { matchSessionControlActionV1, runSessionControlV1 } from "./sessionControl";

function snap(overrides: Partial<{ playing: boolean; recording: boolean; position: number; dirty: boolean }> = {}): Snapshot {
  return {
    schemaVersion: 1,
    session: { sampleRate: 48000, tempo: 120, key: { root: "C", scale: "major" }, editFile: "/mock/x.mosh", dirty: overrides.dirty ?? false },
    transport: {
      playing: overrides.playing ?? false,
      recording: overrides.recording ?? false,
      position: overrides.position ?? 0,
      looping: false, loopStart: 0, loopEnd: 0,
    },
    tracks: [],
  } as unknown as Snapshot;
}

type FakeEnvOpts = {
  snapshots: Snapshot[];   // consumed in order; last one repeats
  execResult?: (command: string, args: Record<string, unknown>) => CommandResult;
  recordingStop?: RecordingLifecycleResultV1;
};

function fakeEnvironment(opts: FakeEnvOpts): { environment: StudioSkillEnvironmentV1; execCalls: { command: string; args: Record<string, unknown> }[] } {
  const execCalls: { command: string; args: Record<string, unknown> }[] = [];
  let snapshotIndex = 0;
  const nextSnapshot = (): Snapshot => {
    const value = opts.snapshots[Math.min(snapshotIndex, opts.snapshots.length - 1)]!;
    snapshotIndex += 1;
    return value;
  };
  const environment: StudioSkillEnvironmentV1 = {
    context: () => ({ projectEpoch: 1, selectedTrackId: null, tracks: [] }),
    snapshot: async () => nextSnapshot(),
    exec: vi.fn(async (command: string, args: Record<string, unknown>): Promise<CommandResult> => {
      execCalls.push({ command, args });
      if (opts.execResult) return opts.execResult(command, args);
      return { ok: true, command, data: {} };
    }),
    readSourceStatus: async () => ({ schemaVersion: 1, ok: true, statusIndex: null, diagnostics: [] }),
    runBatch: vi.fn(async () => { throw new Error("sessionControlV1 must never call runBatch()"); }),
    refresh: async () => { nextSnapshot(); },
    recording: {
      start: async () => { throw new Error("not used"); },
      stop: async () => opts.recordingStop ?? { ok: true, state: "reviewing", say: "Stopped — reviewing the take.", changes: null },
      audition: async () => { throw new Error("not used"); },
      keep: async () => { throw new Error("not used"); },
    },
  };
  return { environment, execCalls };
}

describe("matchSessionControlActionV1", () => {
  it("matches canonical and held-out phrases per action", () => {
    expect(matchSessionControlActionV1("play")).toBe("play");
    expect(matchSessionControlActionV1("hit play")).toBe("play");
    expect(matchSessionControlActionV1("stop")).toBe("stop");
    expect(matchSessionControlActionV1("pause playback")).toBe("stop");
    expect(matchSessionControlActionV1("back to the start")).toBe("from_start");
    expect(matchSessionControlActionV1("rewind")).toBe("from_start");
    expect(matchSessionControlActionV1("save")).toBe("save");
    expect(matchSessionControlActionV1("save the project")).toBe("save");
    expect(matchSessionControlActionV1("undo")).toBe("undo");
    expect(matchSessionControlActionV1("undo that")).toBe("undo");
    expect(matchSessionControlActionV1("redo")).toBe("redo");
    expect(matchSessionControlActionV1("redo the last undo")).toBe("redo");
  });

  it("does not match an unrelated or partial phrase (anchored, not substring)", () => {
    expect(matchSessionControlActionV1("play the drums louder")).toBeNull();
    expect(matchSessionControlActionV1("")).toBeNull();
    expect(matchSessionControlActionV1("undo everything I've ever done")).toBeNull();
  });
});

describe("runSessionControlV1 — play", () => {
  it("completes with zero exec calls when already playing", async () => {
    const { environment, execCalls } = fakeEnvironment({ snapshots: [snap({ playing: true })] });
    const outcome = await runSessionControlV1("play", environment);
    expect(outcome).toMatchObject({ kind: "completed" });
    expect(execCalls).toHaveLength(0);
  });

  it("issues set_transport play when stopped", async () => {
    const { environment, execCalls } = fakeEnvironment({ snapshots: [snap({ playing: false })] });
    const outcome = await runSessionControlV1("play", environment);
    expect(outcome).toMatchObject({ kind: "completed" });
    expect(execCalls).toEqual([{ command: "set_transport", args: { action: "play" } }]);
  });

  it("blocks on command failure", async () => {
    const { environment } = fakeEnvironment({
      snapshots: [snap({ playing: false })],
      execResult: () => ({ ok: false, command: "set_transport", error: "no playback context" }),
    });
    const outcome = await runSessionControlV1("play", environment);
    expect(outcome).toMatchObject({ kind: "blocked", code: "command_failed" });
  });
});

describe("runSessionControlV1 — stop", () => {
  it("completes with zero exec calls when already stopped", async () => {
    const { environment, execCalls } = fakeEnvironment({ snapshots: [snap({ playing: false, recording: false })] });
    const outcome = await runSessionControlV1("stop", environment);
    expect(outcome).toMatchObject({ kind: "completed" });
    expect(execCalls).toHaveLength(0);
  });

  it("issues set_transport stop when playing (not recording)", async () => {
    const { environment, execCalls } = fakeEnvironment({ snapshots: [snap({ playing: true })] });
    const outcome = await runSessionControlV1("stop", environment);
    expect(outcome).toMatchObject({ kind: "completed" });
    expect(execCalls).toEqual([{ command: "set_transport", args: { action: "stop" } }]);
  });

  it("while recording, calls recording.stop() instead of a bare transport stop", async () => {
    const { environment, execCalls } = fakeEnvironment({
      snapshots: [snap({ recording: true, playing: true })],
      recordingStop: { ok: true, state: "reviewing", say: "Stopped.", changes: null },
    });
    const outcome = await runSessionControlV1("stop", environment);
    expect(outcome).toMatchObject({ kind: "completed", say: "Stopped." });
    expect(execCalls).toHaveLength(0); // the mutation went through recording.stop(), not exec
  });

  it("propagates a recording.stop() failure as blocked", async () => {
    const { environment } = fakeEnvironment({
      snapshots: [snap({ recording: true, playing: true })],
      recordingStop: { ok: false, code: "observation_failed", say: "could not land the take" },
    });
    const outcome = await runSessionControlV1("stop", environment);
    expect(outcome).toMatchObject({ kind: "blocked", code: "observation_failed", say: "could not land the take" });
  });
});

describe("runSessionControlV1 — from_start", () => {
  it("completes with zero exec calls when already at position 0", async () => {
    const { environment, execCalls } = fakeEnvironment({ snapshots: [snap({ position: 0 })] });
    const outcome = await runSessionControlV1("back to the start", environment);
    expect(outcome).toMatchObject({ kind: "completed" });
    expect(execCalls).toHaveLength(0);
  });

  it("issues set_transport to_start when not at position 0", async () => {
    const { environment, execCalls } = fakeEnvironment({ snapshots: [snap({ position: 12.5 })] });
    const outcome = await runSessionControlV1("rewind", environment);
    expect(outcome).toMatchObject({ kind: "completed" });
    expect(execCalls).toEqual([{ command: "set_transport", args: { action: "to_start" } }]);
  });
});

describe("runSessionControlV1 — save", () => {
  it("completes only after refresh observes dirty:false", async () => {
    const { environment } = fakeEnvironment({
      snapshots: [snap({ dirty: false })], // consumed by the post-save snapshot() read
    });
    const outcome = await runSessionControlV1("save", environment);
    expect(outcome).toMatchObject({ kind: "completed" });
  });

  it("blocks when the post-save observation still shows dirty:true", async () => {
    const { environment } = fakeEnvironment({
      snapshots: [snap({ dirty: true })],
    });
    const outcome = await runSessionControlV1("save", environment);
    expect(outcome).toMatchObject({ kind: "blocked", code: "command_failed" });
  });

  it("blocks on save command failure without checking dirty at all", async () => {
    const { environment } = fakeEnvironment({
      snapshots: [snap({ dirty: true })],
      execResult: () => ({ ok: false, command: "save", error: "no project file" }),
    });
    const outcome = await runSessionControlV1("save", environment);
    expect(outcome).toMatchObject({ kind: "blocked", code: "command_failed", say: "no project file" });
  });
});

describe("runSessionControlV1 — undo/redo", () => {
  it("undo completes only when the engine reports undone:true", async () => {
    const { environment } = fakeEnvironment({
      snapshots: [snap()],
      execResult: (command) => ({ ok: true, command, data: { undone: true } }),
    });
    const outcome = await runSessionControlV1("undo", environment);
    expect(outcome).toMatchObject({ kind: "completed" });
  });

  it("undo blocks when the engine reports undone:false (nothing to undo)", async () => {
    const { environment } = fakeEnvironment({
      snapshots: [snap()],
      execResult: (command) => ({ ok: true, command, data: { undone: false } }),
    });
    const outcome = await runSessionControlV1("undo", environment);
    expect(outcome).toMatchObject({ kind: "blocked", code: "command_failed" });
  });

  it("redo completes only when the engine reports redone:true", async () => {
    const { environment } = fakeEnvironment({
      snapshots: [snap()],
      execResult: (command) => ({ ok: true, command, data: { redone: true } }),
    });
    const outcome = await runSessionControlV1("redo", environment);
    expect(outcome).toMatchObject({ kind: "completed" });
  });

  it("undo issues exactly one exec call (runs alone)", async () => {
    const { environment, execCalls } = fakeEnvironment({
      snapshots: [snap()],
      execResult: (command) => ({ ok: true, command, data: { undone: true } }),
    });
    await runSessionControlV1("undo", environment);
    expect(execCalls).toEqual([{ command: "undo", args: {} }]);
  });
});

describe("runSessionControlV1 — no match", () => {
  it("returns null (not an outcome) for an unrecognized utterance", async () => {
    const { environment } = fakeEnvironment({ snapshots: [snap()] });
    const outcome = await runSessionControlV1("mix this professionally", environment);
    expect(outcome).toBeNull();
  });

  it("every completed/blocked outcome carries changes:null or omits changes (no atomicity claim)", async () => {
    const { environment } = fakeEnvironment({ snapshots: [snap({ playing: true })] });
    const outcome = await runSessionControlV1("play", environment);
    expect(outcome).toMatchObject({ changes: null });
  });
});
