import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TopBar } from "./TopBar";
import { useStore } from "../store";
import { __resetMockForTests, mockSnapshot } from "../bridge.mock";
import type { CommandResult, Snapshot } from "../types";

// The app/session tool cluster pulls in bridge side effects we don't care about
// here; stub it to keep the test focused on the transport controls (mirrors
// topbarTransport.test.ts).
vi.mock("../ui/TopbarTools", () => ({
  TrainingTool: () => null,
  CommandLogTool: () => null,
  RemoteTool: () => null,
  MultiplayerTool: () => null,
  HelpTool: () => null,
}));

describe("v2 TopBar Record button — arms the selected track before recording (CONF-RECORD-ARM)", () => {
  let host: HTMLDivElement;
  let root: Root;
  let execCalls: { command: string; args?: Record<string, unknown> }[];
  let settledExecCount: number;
  let settleWaiters: { target: number; resolve: () => void }[];
  let nextExecResult: CommandResult | null;
  let nextExecError: Error | null;

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    __resetMockForTests();
    await act(async () => {
      await useStore.getState().refresh();
    });
    execCalls = [];
    settledExecCount = 0;
    settleWaiters = [];
    nextExecResult = null;
    nextExecError = null;
    const orig = useStore.getState().exec;
    vi.spyOn(useStore.getState(), "exec").mockImplementation(
      async (command: string, args?: Record<string, unknown>): Promise<CommandResult> => {
        execCalls.push({ command, args });
        try {
          if (nextExecError) {
            const error = nextExecError;
            nextExecError = null;
            throw error;
          }
          const result = nextExecResult ?? await orig(command, args);
          nextExecResult = null;
          return result;
        } finally {
          settledExecCount += 1;
          const ready = settleWaiters.filter((waiter) => waiter.target <= settledExecCount);
          settleWaiters = settleWaiters.filter((waiter) => waiter.target > settledExecCount);
          ready.forEach((waiter) => waiter.resolve());
        }
      },
    );
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  function render(snap: Snapshot) {
    act(() => {
      root.render(React.createElement(TopBar, { snapshot: snap }));
    });
  }

  function waitForSettledExecs(target: number): Promise<void> {
    if (settledExecCount >= target) return Promise.resolve();
    return new Promise((resolve) => settleWaiters.push({ target, resolve }));
  }

  async function clickRecord(expectedExecs = 1) {
    const btn = host.querySelector<HTMLButtonElement>('[data-testid="v2-record"]')!;
    const settledTarget = settledExecCount + expectedExecs;
    act(() => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitForSettledExecs(settledTarget);
  }

  async function clickTransport(selector: string, expectedExecs = 1) {
    const btn = host.querySelector<HTMLButtonElement>(selector)!;
    const settledTarget = settledExecCount + expectedExecs;
    act(() => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitForSettledExecs(settledTarget);
  }

  it("arms the selected track then starts recording, when no track is armed yet", async () => {
    const snap = useStore.getState().snapshot!;
    const trackId = snap.tracks[0]?.id;
    expect(trackId).toBeTruthy();
    expect(useStore.getState().selectedTrackId).toBe(trackId); // auto-selected by refresh()
    expect(snap.tracks.every((t) => !t.armed)).toBe(true);

    render(snap);
    const btn = host.querySelector<HTMLButtonElement>('[data-testid="v2-record"]')!;
    expect(btn.getAttribute("data-armed")).toBe("false");

    await clickRecord(2);

    expect(execCalls.map((c) => c.command)).toEqual(["arm_track", "set_transport"]);
    expect(execCalls[0].args).toMatchObject({ trackId, armed: true });
    expect(execCalls[1].args).toMatchObject({ action: "record" });

    // Verify against the mock backend's own state, not just the dispatched args.
    const after = await mockSnapshot<Snapshot>();
    expect(after.tracks.find((t) => t.id === trackId)?.armed).toBe(true);
    expect(after.transport.recording).toBe(true);
  });

  it("does not re-arm a track when one is already armed — just starts recording", async () => {
    const snap0 = useStore.getState().snapshot!;
    const trackId = snap0.tracks[0]?.id!;
    await useStore.getState().exec("arm_track", { trackId, armed: true });
    await act(async () => {
      await useStore.getState().refresh();
    });
    execCalls = []; // the setup arm above isn't part of what we're asserting

    const armedSnap = useStore.getState().snapshot!;
    expect(armedSnap.tracks.find((t) => t.id === trackId)?.armed).toBe(true);

    render(armedSnap);
    const btn = host.querySelector<HTMLButtonElement>('[data-testid="v2-record"]')!;
    expect(btn.getAttribute("data-armed")).toBe("true");

    await clickRecord();

    expect(execCalls.map((c) => c.command)).toEqual(["set_transport"]);
    expect(execCalls[0].args).toMatchObject({ action: "record" });

    const after = await mockSnapshot<Snapshot>();
    expect(after.transport.recording).toBe(true);
  });

  it("clicking Record again while recording lands the take through stop_recording", async () => {
    const snap = useStore.getState().snapshot!;
    render(snap);
    await clickRecord(2); // arm + start
    execCalls = [];

    // Sync the store (transport + the now-armed track list) off the mock, mirroring
    // how snapshot_invalidated/transport events keep the real app current, then
    // re-render with that fresh snapshot before the second click.
    await act(async () => {
      await useStore.getState().refresh();
    });
    expect(useStore.getState().transport.recording).toBe(true);
    render(useStore.getState().snapshot!);

    const clipsBefore = useStore.getState().snapshot!.tracks.flatMap((track) => track.clips).length;
    await clickRecord();

    expect(execCalls.map((c) => c.command)).toEqual(["stop_recording"]);

    await act(async () => {
      await useStore.getState().refresh();
    });
    expect(useStore.getState().transport.recording).toBe(false);
    expect(useStore.getState().snapshot!.tracks.flatMap((track) => track.clips)).toHaveLength(clipsBefore + 1);
  });

  it("the visible Stop button lands the active take before returning to project start", async () => {
    const snap = useStore.getState().snapshot!;
    render(snap);
    await clickRecord(2);

    await act(async () => {
      await useStore.getState().exec("set_transport", { position: 6 });
      await useStore.getState().refresh();
    });
    render(useStore.getState().snapshot!);
    execCalls = [];
    const clipsBefore = useStore.getState().snapshot!.tracks.flatMap((track) => track.clips).length;

    await clickTransport('[data-testid="v2-stop"]', 2);

    expect(execCalls).toEqual([
      { command: "stop_recording", args: undefined },
      { command: "set_transport", args: { position: 0 } },
    ]);

    await act(async () => {
      await useStore.getState().refresh();
    });
    expect(useStore.getState().transport).toMatchObject({ recording: false, position: 0 });
    expect(useStore.getState().snapshot!.tracks.flatMap((track) => track.clips)).toHaveLength(clipsBefore + 1);
  });

  it("the visible Stop button keeps the ordinary non-recording stop-and-return behavior", async () => {
    await useStore.getState().exec("set_transport", { position: 6 });
    await act(async () => {
      await useStore.getState().refresh();
    });
    render(useStore.getState().snapshot!);
    execCalls = [];

    await clickTransport('[data-testid="v2-stop"]');

    expect(execCalls).toEqual([
      { command: "set_transport", args: { action: "stop", position: 0 } },
    ]);
    await act(async () => {
      await useStore.getState().refresh();
    });
    expect(useStore.getState().transport).toMatchObject({ recording: false, position: 0 });
  });

  it("To start lands the active take before returning to project start", async () => {
    render(useStore.getState().snapshot!);
    await clickRecord(2);
    await act(async () => {
      await useStore.getState().exec("set_transport", { position: 6 });
      await useStore.getState().refresh();
    });
    render(useStore.getState().snapshot!);
    execCalls = [];
    const clipsBefore = useStore.getState().snapshot!.tracks.flatMap((track) => track.clips).length;

    await clickTransport('[aria-label="To start"]', 2);

    expect(execCalls).toEqual([
      { command: "stop_recording", args: undefined },
      { command: "set_transport", args: { position: 0 } },
    ]);
    await act(async () => {
      await useStore.getState().refresh();
    });
    expect(useStore.getState().transport).toMatchObject({ recording: false, position: 0 });
    expect(useStore.getState().snapshot!.tracks.flatMap((track) => track.clips)).toHaveLength(clipsBefore + 1);
  });

  it("To start keeps the ordinary non-recording jump-to-start behavior", async () => {
    await useStore.getState().exec("set_transport", { position: 6 });
    await act(async () => {
      await useStore.getState().refresh();
    });
    render(useStore.getState().snapshot!);
    execCalls = [];

    await clickTransport('[aria-label="To start"]');

    expect(execCalls).toEqual([
      { command: "set_transport", args: { action: "stop", position: 0 } },
    ]);
    await act(async () => {
      await useStore.getState().refresh();
    });
    expect(useStore.getState().transport).toMatchObject({ recording: false, position: 0 });
  });

  it("serializes a rapid Record then Stop before recording telemetry arrives", async () => {
    const snap0 = useStore.getState().snapshot!;
    const trackId = snap0.tracks[0]?.id!;
    await useStore.getState().exec("arm_track", { trackId, armed: true });
    await act(async () => {
      await useStore.getState().refresh();
    });
    render(useStore.getState().snapshot!);
    execCalls = [];
    const clipsBefore = useStore.getState().snapshot!.tracks
      .find((track) => track.id === trackId)?.clips.length ?? 0;

    const settledTarget = settledExecCount + 3;
    const record = host.querySelector<HTMLButtonElement>('[data-testid="v2-record"]')!;
    const stop = host.querySelector<HTMLButtonElement>('[data-testid="v2-stop"]')!;
    act(() => {
      record.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      stop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitForSettledExecs(settledTarget);

    expect(execCalls).toEqual([
      { command: "set_transport", args: { action: "record" } },
      { command: "stop_recording", args: undefined },
      { command: "set_transport", args: { position: 0 } },
    ]);
    const after = await mockSnapshot<Snapshot>();
    expect(after.transport).toMatchObject({ recording: false, position: 0 });
    expect(after.tracks.find((track) => track.id === trackId)?.clips).toHaveLength(clipsBefore + 1);
  });

  it("serializes a rapid Record then Play before recording telemetry arrives", async () => {
    const snap0 = useStore.getState().snapshot!;
    const trackId = snap0.tracks[0]?.id!;
    await useStore.getState().exec("arm_track", { trackId, armed: true });
    await act(async () => {
      await useStore.getState().refresh();
    });
    render(useStore.getState().snapshot!);
    execCalls = [];

    const settledTarget = settledExecCount + 2;
    const record = host.querySelector<HTMLButtonElement>('[data-testid="v2-record"]')!;
    const play = host.querySelector<HTMLButtonElement>('[data-testid="v2-play"]')!;
    act(() => {
      record.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      play.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitForSettledExecs(settledTarget);

    expect(execCalls).toEqual([
      { command: "set_transport", args: { action: "record" } },
      { command: "stop_recording", args: undefined },
    ]);
    const after = await mockSnapshot<Snapshot>();
    expect(after.transport).toMatchObject({ playing: false, recording: false });
  });

  it("keeps Stop on the generic path when record returns recording false", async () => {
    const snap0 = useStore.getState().snapshot!;
    const trackId = snap0.tracks[0]?.id!;
    await useStore.getState().exec("arm_track", { trackId, armed: true });
    await act(async () => {
      await useStore.getState().refresh();
    });
    render(useStore.getState().snapshot!);
    execCalls = [];
    nextExecResult = {
      ok: true,
      command: "set_transport",
      data: { playing: false, recording: false, position: 0 },
    };

    await clickRecord();
    await clickTransport('[data-testid="v2-stop"]');

    expect(execCalls).toEqual([
      { command: "set_transport", args: { action: "record" } },
      { command: "set_transport", args: { action: "stop", position: 0 } },
    ]);
  });

  it("continues with the next queued transport action after a bridge rejection", async () => {
    const snap0 = useStore.getState().snapshot!;
    const trackId = snap0.tracks[0]?.id!;
    await useStore.getState().exec("arm_track", { trackId, armed: true });
    await act(async () => {
      await useStore.getState().refresh();
    });
    render(useStore.getState().snapshot!);
    execCalls = [];
    nextExecError = new Error("bridge rejected record");

    const settledTarget = settledExecCount + 2;
    const record = host.querySelector<HTMLButtonElement>('[data-testid="v2-record"]')!;
    const stop = host.querySelector<HTMLButtonElement>('[data-testid="v2-stop"]')!;
    act(() => {
      record.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      stop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitForSettledExecs(settledTarget);

    expect(execCalls).toEqual([
      { command: "set_transport", args: { action: "record" } },
      { command: "set_transport", args: { action: "stop", position: 0 } },
    ]);
  });
});
