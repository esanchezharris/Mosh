// CONF-RECORD-ARM — the v2 topbar Record button used to toggle
// set_transport{action:"record"} with nothing armed, so a mouse-only user (no
// keyboard/agent arm step) recorded silence. It now arms the selected track via
// arm_track first, whenever no track is armed yet, then starts/stops recording via
// set_transport. These specs run against the REAL dev-mock backend (bridge.mock) —
// the same one store.exec routes through outside the JUCE WebView — so they prove
// the actual arm_track + set_transport round-trip, not just a stubbed exec.

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

  it("clicking again while recording just stops it — no re-arm attempt", async () => {
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

    await clickRecord(); // should just stop — nothing left to arm

    expect(execCalls.map((c) => c.command)).toEqual(["set_transport"]);
    expect(execCalls[0].args).toMatchObject({ action: "record" });

    await act(async () => {
      await useStore.getState().refresh();
    });
    expect(useStore.getState().transport.recording).toBe(false);
  });
});
