import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import type { CommandResult, Snapshot } from "../types";
import { useShell } from "../v2/shellState";
import { ProToolsPunchControls } from "./ProToolsPunchControls";
import { useProTools } from "./proToolsState";

const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  session: {
    sampleRate: 48_000,
    tempo: 120,
    timeSigNumerator: 4,
    timeSigDenominator: 4,
    countInBars: 0,
    editFile: "/tmp/punch.mosh",
    key: { tonic: "C", mode: "major" },
    project: {
      sampleRate: 48_000,
      bitDepth: 24,
      timeBase: "barsBeats",
      countInBars: 0,
      recordOptions: {
        overdub: true,
        replaceExisting: false,
        quantize: 0,
        quantizeLabel: "(none)",
        punchInOut: false,
        retrospectiveSeconds: 10,
      },
    },
  },
  tracks: [],
  transport: {
    playing: false,
    recording: false,
    position: 0,
    looping: false,
    loopStart: 0,
    loopEnd: 0,
  },
};

describe("Pro Tools Punch controls", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;
  const originalState = useStore.getState();

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    exec = vi.fn(async (command: string): Promise<CommandResult> => ({ ok: true, command }));
    useStore.setState({
      snapshot: SNAPSHOT,
      transport: SNAPSHOT.transport,
      projectEpoch: 4,
      lastError: null,
      exec,
    });
    useShell.setState({ timeRange: null, timeRangeDragging: false });
    useProTools.getState().resetForProject(useProTools.getState().projectEpoch + 1);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState({
      snapshot: originalState.snapshot,
      transport: originalState.transport,
      projectEpoch: originalState.projectEpoch,
      lastError: originalState.lastError,
      exec: originalState.exec,
    });
    useShell.setState({ timeRange: null, timeRangeDragging: false });
  });

  const render = (snapshot: Snapshot = SNAPSHOT) => act(() => {
    root.render(React.createElement(
      React.StrictMode,
      null,
      React.createElement(ProToolsPunchControls, { snapshot }),
    ));
  });

  it("turns an Edit selection into a non-looping punch range before enabling Punch", async () => {
    useShell.setState({ timeRange: { start: 2, end: 6 } });
    render();

    const punch = host.querySelector<HTMLButtonElement>("[data-testid=pt-punch-toggle]");
    if (!punch) throw new Error("Punch control is missing");

    // When Punch is enabled.
    await act(async () => punch.click());

    // Then its engine range follows Timeline playback, not the Edit target.
    expect(exec.mock.calls).toEqual([
      ["set_transport", { loop: false, loopStart: 2, loopEnd: 6 }],
      ["set_record_options", { punchInOut: true }],
    ]);
  });

  it("uses the independent Timeline span for Punch while selections are unlinked", async () => {
    // Given different Edit and Timeline ranges.
    useShell.setState({ timeRange: { start: 2, end: 6 } });
    useProTools.getState().setTimelineEditLinked(false, useShell.getState().timeRange);
    useProTools.getState().setTimelineSelection({ start: 8, end: 10 });
    render();

    const punch = host.querySelector<HTMLButtonElement>("[data-testid=pt-punch-toggle]");
    if (!punch) throw new Error("Punch control is missing");

    // When Punch is enabled.
    await act(async () => punch.click());

    // Then its engine range follows Timeline playback, not the Edit target.
    expect(exec.mock.calls).toEqual([
      ["set_transport", { loop: false, loopStart: 8, loopEnd: 10 }],
      ["set_record_options", { punchInOut: true }],
    ]);
  });

  it("uses a stored punch range, refuses a missing range, and surfaces command failure", async () => {
    const withRange = {
      ...SNAPSHOT,
      transport: { ...SNAPSHOT.transport, looping: true, loopStart: 3, loopEnd: 5 },
    };
    useStore.setState({ transport: withRange.transport });
    render(withRange);
    const punch = host.querySelector<HTMLButtonElement>("[data-testid=pt-punch-toggle]")!;
    await act(async () => punch.click());
    expect(exec.mock.calls[0]).toEqual([
      "set_transport",
      { loop: false, loopStart: 3, loopEnd: 5 },
    ]);

    exec.mockClear();
    act(() => useStore.setState({ transport: SNAPSHOT.transport, lastError: null }));
    render();
    const missingRangePunch = host.querySelector<HTMLButtonElement>("[data-testid=pt-punch-toggle]")!;
    await act(async () => missingRangePunch.click());
    expect(exec).not.toHaveBeenCalled();
    expect(useStore.getState().lastError).toMatch(/Timeline selection or stored range/i);

    act(() => useShell.setState({ timeRange: { start: 4, end: 7 } }));
    exec.mockImplementationOnce(async () => ({
      ok: false,
      command: "set_transport",
      error: "range refused",
    }));
    const failingPunch = host.querySelector<HTMLButtonElement>("[data-testid=pt-punch-toggle]")!;
    await act(async () => failingPunch.click());
    expect(exec).toHaveBeenCalledTimes(1);
    expect(useStore.getState().lastError).toBe("range refused");
  });

  it("sets the engine pre-roll preference and exposes the selected range readout", async () => {
    useShell.setState({ timeRange: { start: 2, end: 6 } });
    render();

    const preRoll = host.querySelector<HTMLSelectElement>("[data-testid=pt-preroll-select]");
    if (!preRoll) throw new Error("Pre-roll control is missing");
    await act(async () => {
      preRoll.value = "1";
      preRoll.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(exec).toHaveBeenCalledWith("set_count_in", { bars: 1 });
    expect(host.querySelector("[data-testid=pt-punch-range-readout]")?.textContent)
      .toMatch(/2\.000.*6\.000/);
  });

  it("does not finish enabling Punch after the project changes", async () => {
    useShell.setState({ timeRange: { start: 2, end: 6 } });
    let release: ((result: CommandResult) => void) | undefined;
    exec.mockImplementationOnce(() => new Promise<CommandResult>((resolve) => { release = resolve; }));
    render();

    const punch = host.querySelector<HTMLButtonElement>("[data-testid=pt-punch-toggle]")!;
    await act(async () => {
      punch.click();
      await Promise.resolve();
    });
    act(() => useStore.setState({ projectEpoch: 5 }));
    await act(async () => release?.({ ok: true, command: "set_transport" }));

    expect(exec).toHaveBeenCalledTimes(1);
  });
});
