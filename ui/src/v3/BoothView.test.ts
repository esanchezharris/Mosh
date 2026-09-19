import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoothView } from "./BoothView";
import { useV3 } from "./shellState";
import { useStore } from "../store";
import type { CommandResult, LoopContribution, LoopState, Snapshot, Track } from "../types";

const track = (id: string, name: string): Track =>
  ({ id, index: 0, name, type: "audio", volumeDb: 0, pan: 0, mute: false, solo: false, clips: [], plugins: [] }) as unknown as Track;

const part = (id: string, label: string, over: Partial<LoopContribution> = {}): LoopContribution =>
  ({ id, label, keeper: false, rejected: false, clipId: `c-${id}`, trackId: "11", ...over });

function loopState(over: Partial<LoopState> = {}): LoopState {
  return {
    engaged: true, phase: "idle", leadTrackId: "11", takesTrackId: "12",
    transport: { recording: false, playing: false, positionSec: 0 },
    listening: { qn: 8, bar: 3, entryQn: 8, leadQn: 4 },
    currentId: null, lastId: null, reviewId: null, auditionedId: null,
    contributions: [], phoneSeenMs: 0, blockReason: "",
    ...over,
  };
}

function snapshot(loop?: LoopState): Snapshot {
  return {
    schemaVersion: 1,
    session: { sampleRate: 48000, tempo: 120, length: 16 },
    tracks: [track("11", "Keys"), track("12", "Keys · Takes")],
    transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
    ...(loop ? { loop } : {}),
  } as unknown as Snapshot;
}

const PADS = ["v3-loop-record", "v3-loop-keep", "v3-loop-again", "v3-loop-hear", "v3-loop-play-all", "v3-loop-stop"];

describe("v3 Booth — the desktop recording pad", () => {
  let host: HTMLDivElement;
  let root: Root;
  const calls: { command: string; args?: Record<string, unknown> }[] = [];

  const render = (snap: Snapshot) => act(() => root.render(React.createElement(BoothView, { snapshot: snap })));
  const pad = (testId: string) => host.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    calls.length = 0;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useV3.setState({ posture: "booth", phoneOpen: false });
    useStore.setState({
      snapshot: snapshot(),
      selectedTrackId: "11",
      remoteStatus: null,
      peaks: {},
      ensurePeaks: vi.fn(),
      refresh: vi.fn(async () => {}),
      exec: vi.fn(async (command: string, args?: Record<string, unknown>): Promise<CommandResult> => {
        calls.push({ command, args });
        return { ok: true, command };
      }),
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useV3.setState({ posture: "studio" });
  });

  it("offers the selected track as Lead before the loop is engaged, and creates nothing on its own", async () => {
    render(snapshot());
    expect(host.querySelector('[data-testid="v3-booth"]')).not.toBeNull();
    expect(calls, "entering the Booth must not mutate the session").toEqual([]);
    for (const id of PADS) expect(pad(id), id).toBeNull();
    const setup = pad("v3-booth-setup");
    expect(setup).not.toBeNull();
    expect(setup!.textContent).toBe("Use Keys as Lead");
    await act(async () => { setup!.click(); });
    expect(calls).toEqual([{ command: "loop_setup", args: { trackId: "11" } }]);
  });

  it("renders the six pads with the policy's disabled states once engaged", () => {
    render(snapshot(loopState()));
    expect(pad("v3-booth-setup")).toBeNull();
    for (const id of PADS) expect(pad(id), id).not.toBeNull();
    // stopped, nothing recorded: record / play all / stop are live, the rest need a target
    expect(pad("v3-loop-record")!.disabled).toBe(false);
    expect(pad("v3-loop-play-all")!.disabled).toBe(false);
    expect(pad("v3-loop-stop")!.disabled).toBe(false);
    expect(pad("v3-loop-keep")!.disabled).toBe(true);
    expect(pad("v3-loop-again")!.disabled).toBe(true);
    expect(pad("v3-loop-hear")!.disabled).toBe(true);
    expect(pad("v3-loop-hear")!.textContent).toBe("Review Selected Take");

    render(snapshot(loopState({
      transport: { recording: true, playing: true, positionSec: 4 }, currentId: "p2",
      contributions: [part("p1", "Part 1")],
    })));
    expect(pad("v3-loop-record")!.disabled).toBe(true);
    expect(pad("v3-loop-keep")!.disabled).toBe(false);
    expect(pad("v3-loop-hear")!.disabled).toBe(false);
    expect(pad("v3-loop-hear")!.textContent).toBe("Review Current Recording");
    expect(pad("v3-loop-stop")!.disabled).toBe(false);
    expect(host.querySelector<HTMLButtonElement>('[data-testid="v3-loop-go"]')!.disabled).toBe(true);
  });

  it("disables everything the Mac cannot do, and says why", () => {
    render(snapshot(loopState({ blockReason: "No audio device — recording is unavailable on this Mac" })));
    for (const id of PADS) expect(pad(id)!.disabled, id).toBe(true);
    expect(host.textContent).toContain("No audio device");
  });

  it("Keep sends loop_keep with the target the readout names", async () => {
    render(snapshot(loopState({ lastId: "p1", contributions: [part("p1", "Part 1", { keeper: false })] })));
    expect(host.textContent).toContain("Target · Part 1 · preserved");
    await act(async () => { pad("v3-loop-keep")!.click(); });
    expect(calls).toEqual([{ command: "loop_keep", args: { targetId: "p1" } }]);
    expect(useStore.getState().refresh).toHaveBeenCalled();
  });

  it("shows the result's own detail — including a Keep that committed but did not roll again", async () => {
    useStore.setState({
      exec: vi.fn(async (command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        return { ok: true, command, data: { applied: true, restarted: false,
          detail: "Kept Part 1; recording did not restart: no audio device" } };
      }),
    });
    render(snapshot(loopState({ lastId: "p1", contributions: [part("p1", "Part 1")] })));
    expect(host.querySelector('[data-testid="v3-booth-note"]')).toBeNull();   // anti-vacuity baseline
    await act(async () => { pad("v3-loop-keep")!.click(); });
    const note = host.querySelector('[data-testid="v3-booth-note"]');
    expect(note!.getAttribute("role")).toBe("status");
    expect(note!.textContent).toBe("Kept Part 1; recording did not restart: no audio device");
  });

  it("lists the contributions, marks what happened to them, and selects on click", async () => {
    render(snapshot(loopState({
      lastId: "p2",
      contributions: [part("p1", "Part 1", { rejected: true }), part("p2", "Part 2", { keeper: true })],
    })));
    const parts = host.querySelectorAll<HTMLButtonElement>('[data-testid="v3-loop-part"]');
    expect(parts).toHaveLength(2);
    expect(parts[0]!.className).toContain("rejected");
    expect(parts[0]!.className).not.toContain("kept");
    expect(parts[1]!.className).toContain("kept");
    expect(parts[0]!.textContent).toContain("Part 1 · preserved redo");

    await act(async () => { parts[0]!.click(); });
    expect(host.textContent).toContain("Target · Part 1 · preserved redo");
    await act(async () => { pad("v3-loop-again")!.click(); });
    expect(calls).toEqual([{ command: "loop_again", args: { targetId: "p1" } }]);
  });

  it("locks the contribution list while a pass is recording", () => {
    render(snapshot(loopState({
      transport: { recording: true, playing: true, positionSec: 4 }, currentId: "p2",
      contributions: [part("p1", "Part 1")],
    })));
    expect(host.querySelector<HTMLButtonElement>('[data-testid="v3-loop-part"]')!.disabled).toBe(true);
  });

  it("opens the phone dialog and reads the listening cursor back", () => {
    render(snapshot(loopState()));
    expect(host.textContent).toContain("bar 3");
    expect(host.textContent).toContain("Entry 8 qn");
    expect(host.textContent).toContain("Lead 4 qn");
    act(() => pad("v3-booth-phone")!.click());
    expect(useV3.getState().phoneOpen).toBe(true);
  });

  it("no longer drives the old take lane", () => {
    render(snapshot(loopState({ contributions: [part("p1", "Part 1")] })));
    expect(host.querySelector('[data-testid="v3-takes"]')).toBeNull();
    expect(host.querySelector('[data-testid="v3-take"]')).toBeNull();
    expect(host.querySelector('[data-testid="v3-booth-record"]')).toBeNull();
    expect(calls.some((c) => c.command === "list_takes")).toBe(false);
  });
});
