// G6 — Tempo / time-signature / metronome GUI controls in the v2 top bar.
// Pure command-surface assertions: editing the BPM field execs set_tempo, editing
// the time-signature fields execs set_time_signature, and toggling the metronome
// button execs set_metronome. No backend concepts leak in — everything is store.exec.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TopBar } from "./TopBar";
import { useStore } from "../store";
import type { CommandResult, Snapshot } from "../types";

// The app/session tool cluster pulls in bridge side effects we don't care about
// here; stub it to keep the test focused on the transport meta controls.
vi.mock("../ui/TopbarTools", () => ({
  TrainingTool: () => null,
  CommandLogTool: () => null,
  RemoteTool: () => null,
  MultiplayerTool: () => null,
  HelpTool: () => null,
}));

function makeSnapshot(over?: Partial<Snapshot["session"]>): Snapshot {
  return {
    schemaVersion: 1,
    session: {
      sampleRate: 48000,
      tempo: 120,
      timeSigNumerator: 4,
      timeSigDenominator: 4,
      metronome: false,
      key: { tonic: "C", mode: "major" },
      length: 16,
      editFile: "/mock/song.mosh",
      ...over,
    },
    tracks: [],
  } as unknown as Snapshot;
}

describe("v2 TopBar tempo / time-sig / metronome controls", () => {
  let host: HTMLDivElement;
  let root: Root;
  const execCalls: { command: string; args?: Record<string, unknown> }[] = [];

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    execCalls.length = 0;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useStore.setState({
      exec: vi.fn(async (command: string, args?: Record<string, unknown>): Promise<CommandResult> => {
        execCalls.push({ command, args });
        return { ok: true, command };
      }),
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  function render(snap: Snapshot) {
    act(() => {
      root.render(React.createElement(TopBar, { snapshot: snap }));
    });
  }

  it("editing the BPM field execs set_tempo with the new bpm", () => {
    render(makeSnapshot());
    const bpm = host.querySelector<HTMLInputElement>('input[aria-label="Tempo"]');
    expect(bpm).not.toBeNull();
    act(() => {
      bpm!.value = "140";
      bpm!.dispatchEvent(new Event("focusout", { bubbles: true }));
    });
    const call = execCalls.find((c) => c.command === "set_tempo");
    expect(call).toBeTruthy();
    expect(call!.args).toMatchObject({ bpm: 140 });
  });

  it("editing the time-signature numerator execs set_time_signature", () => {
    render(makeSnapshot());
    const num = host.querySelector<HTMLInputElement>('input[aria-label="Time signature numerator"]');
    const den = host.querySelector<HTMLInputElement>('input[aria-label="Time signature denominator"]');
    expect(num).not.toBeNull();
    expect(den).not.toBeNull();
    act(() => {
      num!.value = "3";
      num!.dispatchEvent(new Event("focusout", { bubbles: true }));
    });
    const call = execCalls.find((c) => c.command === "set_time_signature");
    expect(call).toBeTruthy();
    expect(call!.args).toMatchObject({ numerator: 3, denominator: 4 });
  });

  it("editing the time-signature denominator execs set_time_signature", () => {
    render(makeSnapshot());
    const den = host.querySelector<HTMLInputElement>('input[aria-label="Time signature denominator"]');
    expect(den).not.toBeNull();
    act(() => {
      den!.value = "8";
      den!.dispatchEvent(new Event("focusout", { bubbles: true }));
    });
    const call = execCalls.find((c) => c.command === "set_time_signature");
    expect(call).toBeTruthy();
    expect(call!.args).toMatchObject({ numerator: 4, denominator: 8 });
  });

  it("clicking the metronome toggle execs set_metronome with the flipped state", () => {
    render(makeSnapshot({ metronome: false }));
    const met = host.querySelector<HTMLButtonElement>('button[aria-label="Metronome"]');
    expect(met).not.toBeNull();
    expect(met!.getAttribute("aria-pressed")).toBe("false");
    act(() => {
      met!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const call = execCalls.find((c) => c.command === "set_metronome");
    expect(call).toBeTruthy();
    expect(call!.args).toMatchObject({ enabled: true });
  });

  it("reflects an enabled metronome from the snapshot (aria-pressed)", () => {
    render(makeSnapshot({ metronome: true }));
    const met = host.querySelector<HTMLButtonElement>('button[aria-label="Metronome"]');
    expect(met).not.toBeNull();
    expect(met!.getAttribute("aria-pressed")).toBe("true");
  });
});
