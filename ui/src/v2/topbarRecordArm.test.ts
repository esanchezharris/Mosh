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

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    __resetMockForTests();
    await act(async () => {
      await useStore.getState().refresh();
    });
    execCalls = [];
    const orig = useStore.getState().exec;
    vi.spyOn(useStore.getState(), "exec").mockImplementation(
      async (command: string, args?: Record<string, unknown>): Promise<CommandResult> => {
        execCalls.push({ command, args });
        return orig(command, args);
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

  async function clickRecord() {
    const btn = host.querySelector<HTMLButtonElement>('[data-testid="v2-record"]')!;
    await act(async () => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      // Flush the handler's sequential `await exec(...)` chain (arm_track, then
      // set_transport) — a macrotask boundary drains the whole microtask queue.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  async function clickTransport(selector: string) {
    const btn = host.querySelector<HTMLButtonElement>(selector)!;
    await act(async () => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
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

    await clickRecord();

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
    await clickRecord(); // arm + start
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
    await clickRecord();

    await act(async () => {
      await useStore.getState().exec("set_transport", { position: 6 });
      await useStore.getState().refresh();
    });
    render(useStore.getState().snapshot!);
    execCalls = [];
    const clipsBefore = useStore.getState().snapshot!.tracks.flatMap((track) => track.clips).length;

    await clickTransport('[data-testid="v2-stop"]');

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
    await clickRecord();
    await act(async () => {
      await useStore.getState().exec("set_transport", { position: 6 });
      await useStore.getState().refresh();
    });
    render(useStore.getState().snapshot!);
    execCalls = [];
    const clipsBefore = useStore.getState().snapshot!.tracks.flatMap((track) => track.clips).length;

    await clickTransport('[aria-label="To start"]');

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
});
