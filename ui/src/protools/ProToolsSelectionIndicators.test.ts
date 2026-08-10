import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import type { CommandResult, Snapshot } from "../types";
import { useShell } from "../v2/shellState";
import { ProToolsSelectionIndicators } from "./ProToolsSelectionIndicators";
import { useProTools } from "./proToolsState";

const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  session: {
    sampleRate: 48_000,
    tempo: 120,
    timeSigNumerator: 4,
    timeSigDenominator: 4,
    editFile: "/tmp/protools-selection-indicators.mosh",
    key: { tonic: "C", mode: "major" },
  },
  tracks: [],
  transport: {
    playing: false,
    recording: false,
    position: 1,
    looping: false,
    loopStart: 0,
    loopEnd: 0,
  },
};

const inputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;

function enter(input: HTMLInputElement, value: string): void {
  if (!inputValueSetter) throw new Error("Native input value setter is unavailable");
  inputValueSetter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("Pro Tools Edit Selection indicators", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;
  let projectEpoch = 70;
  const originalState = useStore.getState();

  beforeEach(() => {
    projectEpoch += 1;
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    exec = vi.fn(async (command: string): Promise<CommandResult> => ({ ok: true, command }));
    useStore.setState({
      snapshot: SNAPSHOT,
      transport: SNAPSHOT.transport,
      projectEpoch,
      exec,
    });
    useProTools.getState().resetForProject(projectEpoch);
    useShell.setState({ timeRange: { start: 2, end: 6 }, timeRangeDragging: false });
    act(() => root.render(React.createElement(ProToolsSelectionIndicators, { snapshot: SNAPSHOT })));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState({
      snapshot: originalState.snapshot,
      transport: originalState.transport,
      projectEpoch: originalState.projectEpoch,
      exec: originalState.exec,
    });
    useShell.setState({ timeRange: null, timeRangeDragging: false });
  });

  const field = (name: "Start" | "End" | "Length"): HTMLInputElement => {
    const control = host.querySelector<HTMLInputElement>(`[aria-label="Edit Selection ${name}"]`);
    if (!control) throw new Error(`${name} selection indicator is missing`);
    return control;
  };

  const key = (input: HTMLInputElement, value: string, code = "") => act(() =>
    input.dispatchEvent(new KeyboardEvent("keydown", {
      key: value,
      code,
      bubbles: true,
      cancelable: true,
    })));

  it("shows Start, End, and duration in the default Main Time Scale", () => {
    expect(field("Start").value).toBe("2.1.1");
    expect(field("End").value).toBe("4.1.1");
    expect(field("Length").value).toBe("2.0.0");
    expect(host.querySelector<HTMLSelectElement>("[aria-label='Main time scale']")?.value)
      .toBe("barsBeats");
  });

  it("cycles Start to End with Slash and commits the typed range with Enter", () => {
    const start = field("Start");
    const end = field("End");
    act(() => { start.focus(); enter(start, "3.1.1"); });
    key(start, "/", "Slash");
    expect(document.activeElement).toBe(end);
    act(() => enter(end, "5.1.1"));
    key(end, "Enter");

    expect(useShell.getState().timeRange).toEqual({ start: 4, end: 8 });
    expect(exec).not.toHaveBeenCalled();
  });

  it("sets End from a precise Length while retaining Start", () => {
    const length = field("Length");
    act(() => { length.focus(); enter(length, "1.0.0"); });
    key(length, "Enter");

    expect(useShell.getState().timeRange).toEqual({ start: 2, end: 4 });
    expect(field("End").value).toBe("3.1.1");
  });

  it("changes only Edit selection while Timeline is unlinked", () => {
    act(() => {
      useProTools.getState().setTimelineEditLinked(false, useShell.getState().timeRange);
      useProTools.getState().setTimelineSelection({ start: 10, end: 12 });
    });
    const end = field("End");
    act(() => { end.focus(); enter(end, "5.1.1"); });
    key(end, "Enter");

    expect(useShell.getState().timeRange).toEqual({ start: 2, end: 8 });
    expect(useProTools.getState().timelineSelection).toEqual({ start: 10, end: 12 });
  });

  it("keeps the prior range and reports a reversed entry", () => {
    const end = field("End");
    act(() => { end.focus(); enter(end, "1.1.1"); });
    key(end, "Enter");

    expect(useShell.getState().timeRange).toEqual({ start: 2, end: 6 });
    expect(host.querySelector("[role=alert]")?.textContent).toMatch(/after Start/i);
    expect(end.getAttribute("aria-invalid")).toBe("true");
  });

  it("discards a focused draft on Escape or project replacement", () => {
    const start = field("Start");
    act(() => { start.focus(); enter(start, "5.1.1"); });
    key(start, "Escape");
    expect(start.value).toBe("2.1.1");

    act(() => {
      start.focus();
      enter(start, "6.1.1");
      useShell.setState({ timeRange: { start: 1, end: 3 } });
      useStore.setState({ projectEpoch: projectEpoch + 1 });
    });
    expect(start.value).toBe("1.3.1");
    expect(document.activeElement).not.toBe(start);
    expect(exec).not.toHaveBeenCalled();
  });
});
