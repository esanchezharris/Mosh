import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Inspector } from "./Inspector";
import { useStore } from "../../store";
import { useShell } from "../shellState";
import type { CommandResult, Snapshot, Track } from "../../types";

vi.mock("../../ui/Rack", () => ({ Rack: () => null }));
vi.mock("../../ui/GenDrawer", () => ({ GenDrawer: () => null }));
vi.mock("./LyricPanel", () => ({ LyricPanel: () => null }));
vi.mock("../../ui/dock/useFloatingWindow", () => ({
  useDrumWindow: { getState: () => ({ open: () => {} }) },
}));

const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
function step(input: HTMLInputElement, delta: number): void {
  nativeInputValueSetter.call(input, String(Number(input.value) + delta));
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function snapshot(): Snapshot {
  const track = {
    id: "t1", index: 0, name: "Keys", type: "audio", volumeDb: 0, pan: 0,
    mute: false, solo: false, clips: [], plugins: [],
  } as unknown as Track;
  return { schemaVersion: 1, session: {}, tracks: [track] } as unknown as Snapshot;
}

describe("v2 Inspector Mix snapshot-backed ranges", () => {
  let host: HTMLDivElement;
  let root: Root;
  const calls: { command: string; args?: Record<string, unknown> }[] = [];

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    calls.length = 0;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useStore.setState({
      snapshot: snapshot(),
      selectedTrackId: "t1",
      exec: vi.fn((command: string, args?: Record<string, unknown>): Promise<CommandResult> => {
        calls.push({ command, args });
        // Keep the snapshot round trip pending for the entire gesture.
        return new Promise<CommandResult>(() => {});
      }),
    });
    useShell.setState({ selectedClipId: null, inspectorTab: "mix" });
    await act(async () => {
      root.render(React.createElement(Inspector));
      await Promise.resolve();
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("keeps rapid native volume and pan steps cumulative on the selected track", () => {
    const volume = host.querySelector<HTMLInputElement>('[data-testid="v2-track-volume"]')!;
    const pan = host.querySelector<HTMLInputElement>('[data-testid="v2-track-pan"]')!;

    for (let i = 0; i < 3; i++) act(() => step(volume, -0.5));
    for (let i = 0; i < 3; i++) act(() => step(pan, -0.02));

    expect(calls.filter((call) => call.command === "set_track_volume").map((call) => call.args?.db))
      .toEqual([-0.5, -1, -1.5]);
    expect(calls.filter((call) => call.command === "set_track_pan").map((call) => call.args?.pan))
      .toEqual([-0.02, -0.04, -0.06]);
  });
});
