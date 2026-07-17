// G6 — Tempo / time-signature / metronome GUI controls in the classic top bar.
// Pure command-surface assertions: BPM and time-signature are editable fields and a
// metronome toggle, each going through store.exec (set_tempo / set_time_signature /
// set_metronome). No backend concepts leak in.
// G2b — a count-in selector alongside them, going through set_count_in.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Topbar } from "./Topbar";
import { useStore } from "../store";
import type { CommandResult, Snapshot } from "../types";

// Heavy app/session tool cluster + presence pull in bridge side effects; stub them
// so the test stays focused on the transport meta controls.
vi.mock("./TopbarTools", () => ({
  TopbarTools: () => null,
}));
vi.mock("./PresenceCluster", () => ({
  PresenceCluster: () => null,
}));
vi.mock("./Meter", () => ({
  MasterMeter: () => null,
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

describe("classic Topbar tempo / time-sig / metronome controls", () => {
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
      root.render(React.createElement(Topbar, { snapshot: snap }));
    });
  }

  it("editing the BPM field execs set_tempo with the new bpm", () => {
    render(makeSnapshot());
    const bpm = host.querySelector<HTMLInputElement>('input[aria-label="Tempo"]');
    expect(bpm).not.toBeNull();
    act(() => {
      bpm!.value = "90";
      bpm!.dispatchEvent(new Event("focusout", { bubbles: true }));
    });
    const call = execCalls.find((c) => c.command === "set_tempo");
    expect(call).toBeTruthy();
    expect(call!.args).toMatchObject({ bpm: 90 });
  });

  it("editing the time-signature execs set_time_signature", () => {
    render(makeSnapshot());
    const num = host.querySelector<HTMLInputElement>('input[aria-label="Time signature numerator"]');
    const den = host.querySelector<HTMLInputElement>('input[aria-label="Time signature denominator"]');
    expect(num).not.toBeNull();
    expect(den).not.toBeNull();
    act(() => {
      num!.value = "6";
      num!.dispatchEvent(new Event("focusout", { bubbles: true }));
    });
    let call = execCalls.find((c) => c.command === "set_time_signature");
    expect(call).toBeTruthy();
    expect(call!.args).toMatchObject({ numerator: 6, denominator: 4 });

    execCalls.length = 0;
    act(() => {
      den!.value = "8";
      den!.dispatchEvent(new Event("focusout", { bubbles: true }));
    });
    call = execCalls.find((c) => c.command === "set_time_signature");
    expect(call).toBeTruthy();
    expect(call!.args).toMatchObject({ denominator: 8 });
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

  it("defaults the count-in selector to Off (0) when the snapshot omits it", () => {
    render(makeSnapshot());
    const ci = host.querySelector<HTMLSelectElement>('select[aria-label="Count-in"]');
    expect(ci).not.toBeNull();
    expect(ci!.value).toBe("0");
  });

  it("reflects a non-zero count-in from the snapshot", () => {
    render(makeSnapshot({ countInBars: 2 }));
    const ci = host.querySelector<HTMLSelectElement>('select[aria-label="Count-in"]');
    expect(ci).not.toBeNull();
    expect(ci!.value).toBe("2");
  });

  it("changing the count-in selector execs set_count_in with the chosen bars", () => {
    render(makeSnapshot({ countInBars: 0 }));
    const ci = host.querySelector<HTMLSelectElement>('select[aria-label="Count-in"]');
    expect(ci).not.toBeNull();
    act(() => {
      ci!.value = "1";
      ci!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const call = execCalls.find((c) => c.command === "set_count_in");
    expect(call).toBeTruthy();
    expect(call!.args).toMatchObject({ bars: 1 });
  });
});
