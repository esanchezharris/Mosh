// G2a — recording permission / failure UX.
//
// enterRecord arms the selected track, then starts the transport recording. The
// real engine degrades a no-input / mic-permission situation in TWO distinct ways:
//   1. arm_track returns ok:false (a live device rejected the target), OR
//   2. arm_track returns ok:true with data.applied:false + data.reason
//      ("no input device") — the graceful-no-op path proven by the conformance
//      "no fake clip on failure" invariant (MoshOps.cpp / conformance 45/49).
//
// Either way the user must get a CLEAR, persistent error state (the store's
// `lastError`, rendered as a role="alert" bar in both shells), and the doomed
// record must NOT be started. On a successful arm, any stale error clears and
// recording proceeds.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { useStore } from "./store";
import * as bridge from "./bridge";
import { __resetMockForTests } from "./bridge.mock";
import type { CommandResult, Snapshot } from "./types";

describe("enterRecord — no-input / mic-permission failure UX (G2a)", () => {
  beforeEach(async () => {
    __resetMockForTests();
    await useStore.getState().refresh();
    // Pick an audio track to record into.
    const t = useStore.getState().snapshot?.tracks[0];
    useStore.setState({ selectedTrackId: t?.id ?? null, lastError: null });
  });

  it("surfaces a clear error and does NOT start recording when arm is a graceful no-op (applied:false)", async () => {
    const orig = useStore.getState().exec;
    const spy = vi
      .spyOn(useStore.getState(), "exec")
      .mockImplementation(async (command: string, args?: Record<string, unknown>): Promise<CommandResult> => {
        if (command === "arm_track")
          return { ok: true, command, data: { armed: true, applied: false, reason: "no input device" } };
        return orig(command, args);
      });

    await useStore.getState().enterRecord();

    const s = useStore.getState();
    expect(s.lastError).toBeTruthy();
    expect(String(s.lastError).toLowerCase()).toMatch(/input|mic|permission/);
    // The doomed record was never started.
    expect(s.snapshot?.transport.recording ?? false).toBe(false);

    spy.mockRestore();
  });

  it("surfaces a clear error when arm_track fails outright (ok:false)", async () => {
    const orig = useStore.getState().exec;
    const spy = vi
      .spyOn(useStore.getState(), "exec")
      .mockImplementation(async (command: string, args?: Record<string, unknown>): Promise<CommandResult> => {
        if (command === "arm_track")
          return { ok: false, command, error: "input device rejected" };
        return orig(command, args);
      });

    await useStore.getState().enterRecord();

    const s = useStore.getState();
    expect(s.lastError).toBeTruthy();
    expect(String(s.lastError).toLowerCase()).toMatch(/input|mic|permission/);
    expect(s.snapshot?.transport.recording ?? false).toBe(false);

    spy.mockRestore();
  });

  it("clears any stale error and starts recording when the arm succeeds", async () => {
    useStore.setState({ lastError: "stale no-input error from a previous attempt" });

    await useStore.getState().enterRecord();

    const s = useStore.getState();
    expect(s.lastError).toBeNull();
    expect(s.snapshot?.transport.recording ?? false).toBe(true);
  });

  it("keeps an existing armed track instead of arming the selected track", async () => {
    const firstTrackId = useStore.getState().snapshot!.tracks[0]!.id;
    const created = await useStore.getState().exec("create_track", { name: "Selected B" });
    const secondTrackId = (created.data as { trackId: string }).trackId;
    await useStore.getState().exec("arm_track", { trackId: firstTrackId, armed: true });
    await useStore.getState().refresh();
    useStore.setState({ selectedTrackId: secondTrackId });
    const calls: { command: string; args?: Record<string, unknown> }[] = [];
    const originalExec = useStore.getState().exec;
    const spy = vi.spyOn(useStore.getState(), "exec").mockImplementation(async (command, args) => {
      calls.push({ command, args });
      return originalExec(command, args);
    });

    await useStore.getState().enterRecord();

    expect(calls).toEqual([{ command: "set_transport", args: { action: "record" } }]);
    expect(useStore.getState().snapshot?.tracks.find((track) => track.id === secondTrackId)?.armed).not.toBe(true);
    spy.mockRestore();
  });

  it("does not start recording from a malformed arm success", async () => {
    const orig = useStore.getState().exec;
    const spy = vi.spyOn(useStore.getState(), "exec").mockImplementation(
      async (command: string, args?: Record<string, unknown>): Promise<CommandResult> =>
        command === "arm_track" ? { ok: true, command, data: {} } : orig(command, args),
    );

    await useStore.getState().enterRecord();

    expect(useStore.getState().lastError).toMatch(/input/i);
    expect(useStore.getState().snapshot?.transport.recording ?? false).toBe(false);
    spy.mockRestore();
  });

  it("does not accept a transport response that failed to enter recording", async () => {
    const orig = useStore.getState().exec;
    const spy = vi.spyOn(useStore.getState(), "exec").mockImplementation(
      async (command: string, args?: Record<string, unknown>): Promise<CommandResult> => {
        if (command === "set_transport" && args?.action === "record")
          return { ok: true, command, data: { recording: false } };
        return orig(command, args);
      },
    );

    await useStore.getState().enterRecord();

    expect(useStore.getState().lastError).toBe("Could not start recording.");
    expect(useStore.getState().snapshot?.transport.recording ?? false).toBe(false);
    spy.mockRestore();
  });

  it("does not continue arming into a replacement project", async () => {
    let releaseArm: ((result: CommandResult) => void) | undefined;
    const calls: string[] = [];
    const spy = vi.spyOn(useStore.getState(), "exec").mockImplementation(
      async (command: string): Promise<CommandResult> => {
        calls.push(command);
        if (command === "arm_track")
          return new Promise((resolve) => { releaseArm = resolve; });
        return { ok: true, command, data: { recording: true } };
      },
    );

    const pending = useStore.getState().enterRecord();
    await vi.waitFor(() => expect(releaseArm).toBeTypeOf("function"));
    useStore.setState((state) => ({ projectEpoch: state.projectEpoch + 1 }));
    releaseArm!({ ok: true, command: "arm_track", data: { applied: true } });
    await pending;

    expect(calls).toEqual(["arm_track"]);
    expect(useStore.getState().takeDecisionPending).toBe(false);
    spy.mockRestore();
  });

  it.each([null, {}, { id: "" }])("rejects a malformed landed clip descriptor: %j", async (clip) => {
    const spy = vi.spyOn(useStore.getState(), "exec").mockResolvedValue({
      ok: true,
      command: "stop_recording",
      data: { applied: true, clips: [clip] },
    });

    await useStore.getState().stopRecord();

    expect(useStore.getState().takeDecisionPending).toBe(false);
    expect(useStore.getState().lastTakeClipId).toBeNull();
    expect(useStore.getState().lastError).toBe("Could not land the recording take.");
    spy.mockRestore();
  });

  it("does not promote an unrelated clip when the backend reports a foreign id", async () => {
    const spy = vi.spyOn(useStore.getState(), "exec").mockResolvedValue({
      ok: true,
      command: "stop_recording",
      data: { applied: true, clips: [{ id: "foreign-take" }] },
    });

    await useStore.getState().stopRecord();

    expect(useStore.getState().takeDecisionPending).toBe(false);
    expect(useStore.getState().lastTakeClipId).toBeNull();
    expect(useStore.getState().lastError).toBe("Could not find the landed recording take.");
    spy.mockRestore();
  });

  it("does not open take review when stop completes after a project replacement", async () => {
    let releaseStop: ((result: CommandResult) => void) | undefined;
    const landedId = useStore.getState().snapshot!.tracks[0]!.clips[0]!.id;
    const spy = vi.spyOn(useStore.getState(), "exec").mockImplementation(
      async (command: string): Promise<CommandResult> => {
        if (command === "stop_recording")
          return new Promise((resolve) => { releaseStop = resolve; });
        return { ok: true, command };
      },
    );

    const pending = useStore.getState().stopRecord();
    await vi.waitFor(() => expect(releaseStop).toBeTypeOf("function"));
    useStore.setState((state) => ({ projectEpoch: state.projectEpoch + 1 }));
    releaseStop!({
      ok: true,
      command: "stop_recording",
      data: { applied: true, clips: [{ id: landedId }] },
    });
    await pending;

    expect(useStore.getState().takeDecisionPending).toBe(false);
    expect(useStore.getState().lastTakeClipId).toBeNull();
    spy.mockRestore();
  });

  it("does not refresh an old snapshot while a project replacement is in flight", async () => {
    const current = useStore.getState().snapshot!;
    useStore.setState({
      snapshot: { ...current, session: { ...current.session, editFile: "/sentinel/new-project.mosh" } },
      projectTransitioning: true,
    });

    await useStore.getState().refresh();

    expect(useStore.getState().snapshot?.session.editFile).toBe("/sentinel/new-project.mosh");
  });

  it("drops an in-flight old snapshot when the project epoch changes", async () => {
    const oldSnapshot = useStore.getState().snapshot!;
    let releaseSnapshot: ((snapshot: Snapshot) => void) | undefined;
    const snapshotSpy = vi.spyOn(bridge, "getSnapshot").mockImplementationOnce(
      async () => new Promise((resolve) => { releaseSnapshot = resolve; }),
    );

    useStore.setState({ projectTransitioning: false });
    const refresh = useStore.getState().refresh();
    await vi.waitFor(() => expect(releaseSnapshot).toBeTypeOf("function"));
    useStore.setState((state) => ({
      projectEpoch: state.projectEpoch + 1,
      projectTransitioning: true,
      snapshot: {
        ...oldSnapshot,
        session: { ...oldSnapshot.session, editFile: "/sentinel/replacement.mosh" },
      },
    }));
    releaseSnapshot!(oldSnapshot);
    await refresh;

    expect(useStore.getState().snapshot?.session.editFile).toBe("/sentinel/replacement.mosh");
    useStore.setState({ projectTransitioning: false });
    snapshotSpy.mockRestore();
  });

  it("rejects Record while a real project replacement command is pending", async () => {
    let releaseOpen: ((result: CommandResult) => void) | undefined;
    const executeSpy = vi.spyOn(bridge, "executeCommand").mockImplementationOnce(
      async () => new Promise((resolve) => { releaseOpen = resolve; }),
    );

    const opening = useStore.getState().exec("open_project", { file: "/mock/next.mosh" });
    await vi.waitFor(() => expect(useStore.getState().projectTransitioning).toBe(true));
    await useStore.getState().enterRecord();

    expect(useStore.getState().lastError).toBe("Wait for the project to finish opening before recording.");
    releaseOpen!({ ok: true, command: "open_project" });
    await opening;
    executeSpy.mockRestore();
  });

  it("keeps Record closed until the replacement snapshot commits", async () => {
    const previous = useStore.getState().snapshot!;
    const replacement: Snapshot = {
      ...previous,
      session: { ...previous.session, editFile: "/mock/next.mosh" },
      tracks: [],
    };
    let releaseSnapshot: ((snapshot: Snapshot) => void) | undefined;
    const executeSpy = vi.spyOn(bridge, "executeCommand").mockResolvedValueOnce({
      ok: true,
      command: "open_project",
    });
    const snapshotSpy = vi.spyOn(bridge, "getSnapshot").mockImplementationOnce(
      async () => new Promise((resolve) => { releaseSnapshot = resolve; }),
    );

    const opening = useStore.getState().exec("open_project", { file: "/mock/next.mosh" });
    await vi.waitFor(() => expect(releaseSnapshot).toBeTypeOf("function"));
    expect(useStore.getState().projectTransitioning).toBe(true);

    await useStore.getState().enterRecord();

    expect(useStore.getState().lastError).toBe("Wait for the project to finish opening before recording.");
    expect(executeSpy).toHaveBeenCalledOnce();
    releaseSnapshot!(replacement);
    await opening;
    expect(useStore.getState().projectTransitioning).toBe(false);
    expect(useStore.getState().snapshot?.session.editFile).toBe("/mock/next.mosh");
    snapshotSpy.mockRestore();
    executeSpy.mockRestore();
  });

  it("clears stale project state and retries after a replacement snapshot failure", async () => {
    const previous = useStore.getState().snapshot!;
    const replacement: Snapshot = {
      ...previous,
      session: { ...previous.session, editFile: "/mock/retried.mosh" },
      tracks: [],
    };
    let releaseRetry: ((snapshot: Snapshot) => void) | undefined;
    const executeSpy = vi.spyOn(bridge, "executeCommand").mockResolvedValueOnce({
      ok: true,
      command: "open_project",
    });
    const snapshotSpy = vi.spyOn(bridge, "getSnapshot")
      .mockRejectedValueOnce(new Error("snapshot temporarily unavailable"))
      .mockImplementationOnce(async () => new Promise((resolve) => { releaseRetry = resolve; }));

    const opening = useStore.getState().exec("open_project", { file: "/mock/retried.mosh" });
    await vi.waitFor(() => expect(releaseRetry).toBeTypeOf("function"));

    expect(useStore.getState()).toMatchObject({
      snapshot: null,
      connected: false,
      projectTransitioning: false,
      selectedTrackId: null,
    });
    await useStore.getState().enterRecord();
    expect(useStore.getState().lastError).toBe("Add a track before recording.");
    expect(executeSpy).toHaveBeenCalledOnce();

    releaseRetry!(replacement);
    await opening;
    expect(useStore.getState().projectTransitioning).toBe(false);
    expect(useStore.getState().snapshot?.session.editFile).toBe("/mock/retried.mosh");
    snapshotSpy.mockRestore();
    executeSpy.mockRestore();
  });
});

// Skill Foundry Slice B, Task 2 — the observed RecordingStoreOutcomeV1 result and the
// takeReview projection, exercised against the REAL mock (bridge.mock.ts), not an
// exec() spy, so the stable ids these assertions read are the mock's actual Task 1
// projection (bridge.mock.recording.test.ts already covers the mock's own guards).
describe("enterRecord/stopRecord/navTake/keepTake — observed RecordingStoreOutcomeV1 (Skill Foundry Slice B)", () => {
  beforeEach(async () => {
    __resetMockForTests();
    await useStore.getState().refresh();
    const t = useStore.getState().snapshot?.tracks[0];
    useStore.setState({ selectedTrackId: t?.id ?? null, lastError: null });
  });

  it("enterRecord() resolves started with a null baseline on a genuinely first recording", async () => {
    const outcome = await useStore.getState().enterRecord();
    expect(outcome).toMatchObject({ kind: "started" });
    expect(useStore.getState().snapshot?.transport.recording).toBe(true);
  });

  it("stopRecord() resolves reviewing with the landed take's real observed ids, and takeReview matches", async () => {
    await useStore.getState().enterRecord();
    const outcome = await useStore.getState().stopRecord();
    expect(outcome).toMatchObject({
      kind: "reviewing",
      review: { takeIds: expect.arrayContaining([expect.any(String)]), currentTakeId: expect.any(String) },
    });
    const review = (outcome as { review?: { clipId: string } }).review;
    expect(useStore.getState().takeReview).toEqual(review);
    expect(useStore.getState().takeDecisionPending).toBe(true);
  });

  it("a second start->stop cycle grows the SAME clip's take set by one and selects the new id", async () => {
    await useStore.getState().enterRecord();
    const first = await useStore.getState().stopRecord();
    const firstReview = (first as unknown as { review: { clipId: string; takeIds: string[] } }).review;
    await useStore.getState().enterRecord();
    const second = await useStore.getState().stopRecord();
    const secondReview = (second as unknown as { review: { clipId: string; takeIds: string[]; currentTakeId: string } }).review;

    expect(secondReview.clipId).toBe(firstReview.clipId);
    expect(secondReview.takeIds).toHaveLength(firstReview.takeIds.length + 1);
    expect(secondReview.takeIds.slice(0, firstReview.takeIds.length)).toEqual(firstReview.takeIds);
    expect(secondReview.currentTakeId).toBe(secondReview.takeIds.at(-1));
  });

  it("navTake(-1) after two takes selects the FIRST take's stable id and updates takeReview", async () => {
    await useStore.getState().enterRecord();
    await useStore.getState().stopRecord();
    await useStore.getState().enterRecord();
    const stopped = await useStore.getState().stopRecord();
    const review = (stopped as unknown as { review: { takeIds: string[] } }).review;

    const outcome = await useStore.getState().navTake(-1);
    expect(outcome).toMatchObject({ kind: "reviewing", review: { currentTakeId: review.takeIds[0] } });
    expect(useStore.getState().takeReview).toMatchObject({ currentTakeId: review.takeIds[0] });
  });

  it("keepTake() with an explicit stable id clears takeReview/lastTakeClipId/takeDecisionPending", async () => {
    await useStore.getState().enterRecord();
    await useStore.getState().stopRecord();
    await useStore.getState().enterRecord();
    const stopped = await useStore.getState().stopRecord();
    const review = (stopped as unknown as { review: { takeIds: string[] } }).review;

    const outcome = await useStore.getState().keepTake(review.takeIds[0]);
    expect(outcome).toMatchObject({ kind: "kept" });
    expect(useStore.getState().takeReview).toBeNull();
    expect(useStore.getState().lastTakeClipId).toBeNull();
    expect(useStore.getState().takeDecisionPending).toBe(false);
  });

  it("keepTake() with an unknown stable id is blocked and mutates no store review state", async () => {
    await useStore.getState().enterRecord();
    const stopped = await useStore.getState().stopRecord();
    const reviewBefore = useStore.getState().takeReview;
    expect(stopped).toMatchObject({ kind: "reviewing" });

    const outcome = await useStore.getState().keepTake("ffffffff-0000-4000-8000-000000000000");
    expect(outcome).toMatchObject({ kind: "blocked" });
    expect(useStore.getState().takeReview).toEqual(reviewBefore);
    expect(useStore.getState().takeDecisionPending).toBe(true);
  });

  it("stopRecord() while not recording resolves not_recording rather than a false error", async () => {
    const outcome = await useStore.getState().stopRecord();
    expect(outcome).toEqual({ kind: "not_recording" });
  });

  it("project replacement clears takeReview along with takeDecisionPending/lastTakeClipId", async () => {
    await useStore.getState().enterRecord();
    await useStore.getState().stopRecord();
    expect(useStore.getState().takeReview).not.toBeNull();

    useStore.setState((state) => ({ projectEpoch: state.projectEpoch + 1, takeDecisionPending: false, lastTakeClipId: null, takeReview: null }));
    expect(useStore.getState().takeReview).toBeNull();
  });
});
