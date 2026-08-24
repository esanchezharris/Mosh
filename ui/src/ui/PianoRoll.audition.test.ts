// Audition through the REAL component. notePreview.test.ts pins the throttling and the
// note-off bookkeeping; this pins that the piano roll actually CALLS it at the right
// moments — a missing call site is invisible to a pure-module test.
//
// Preview OFF must send literally nothing. That is the assertion that keeps the feature
// honest: a producer who turns it off has asked for silence, not for quieter noise.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PianoRoll } from "./PianoRoll";
import { useStore } from "../store";
import { useSettings } from "../settings/store";
import { useLive } from "../live/liveState";
import type { CommandResult, Snapshot, Track } from "../types";

vi.mock("../bridge", async () => {
  const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
  return { ...actual, onEvent: vi.fn(() => () => {}), pickFiles: vi.fn(), pickSaveFile: vi.fn() };
});

const ROW_H = 15;

const TRACK = {
  id: "t1", index: 0, name: "Keys", volumeDb: 0, pan: 0, mute: false, solo: false,
  clips: [{
    id: "c1", name: "c1", type: "midi", start: 0, length: 8, offset: 0, hasRenderLayer: false,
    notes: [{ i: 0, pitch: 60, start: 0, length: 1, velocity: 100 }],
  }],
} as unknown as Track;

const SNAPSHOT = {
  schemaVersion: 1,
  session: {
    sampleRate: 48000, tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4,
    metronome: false, length: 16, editFile: "/tmp/pr-aud.tracktionedit",
    key: { tonic: "A", mode: "minor" },
  },
  tracks: [TRACK],
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
  master: { volumeDb: 0, pan: 0 },
} as unknown as Snapshot;

describe("piano-roll note audition", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;

  const mount = () => {
    useStore.setState({ snapshot: SNAPSHOT, editingClipId: "c1", snap: true, snapDivision: "1/4", exec });
    act(() => root.render(React.createElement(PianoRoll, { docked: true })));
  };

  const auditions = () =>
    exec.mock.calls.filter((c) => c[0] === "audition_note").map((c) => c[1] as Record<string, unknown>);

  const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    exec = vi.fn(async (command: string): Promise<CommandResult> => ({ ok: true, command }));
    useSettings.getState().set("notePreview", true);
    useSettings.getState().set("scaleLock", false);
    useLive.setState({ drawMode: false });
  });

  afterEach(async () => {
    act(() => root.unmount());
    host.remove();
    useSettings.getState().set("notePreview", true);
    useStore.setState({ editingClipId: null, snapshot: null });
    vi.restoreAllMocks();
  });

  it("clicking a key in the gutter plays that pitch", async () => {
    mount();
    const key = host.querySelector('[data-testid="pr-key"][data-pitch="72"]');
    expect(key).toBeTruthy();
    act(() => { key!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 })); });
    await flush();
    expect(auditions()).toEqual([{ trackId: "t1", pitch: 72, velocity: 100, action: "blip" }]);
  });

  it("drawing a note plays it", async () => {
    useLive.setState({ drawMode: true });
    mount();
    const grid = host.querySelector(".pr-grid")!;
    act(() => {
      grid.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 2, clientX: 100, clientY: 100 }));
      grid.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 2, clientX: 100, clientY: 100 }));
    });
    await flush();
    expect(auditions()).toHaveLength(1);
    expect(auditions()[0].action).toBe("blip");
  });

  it("offers explicit one-step repair for legacy same-pitch overlaps", async () => {
    mount();
    const repair = host.querySelector('[data-testid="pr-resolve-overlaps"]');
    expect(repair).toBeTruthy();
    act(() => { (repair as HTMLButtonElement).click(); });
    await flush();
    expect(exec).toHaveBeenCalledWith("resolve_note_overlaps", { clipId: "c1" });
  });

  it("dragging a note to a new pitch sounds it, and RELEASES it on pointerup", async () => {
    // The release is the half that matters: without it every drag leaves a note hanging
    // until the engine's TTL sweep cuts it off seconds later.
    mount();
    const note = host.querySelector(".pr-note")!;
    act(() => {
      note.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 3, clientX: 10, clientY: 200 }));
      note.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 3, clientX: 10, clientY: 200 - 3 * ROW_H, buttons: 1 }));
      note.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 3, clientX: 10, clientY: 200 - 3 * ROW_H }));
    });
    await flush();
    const a = auditions();
    expect(a.some((x) => x.action === "on" && x.pitch === 63)).toBe(true);
    expect(a.some((x) => x.action === "off")).toBe(true);
  });

  it("an abandoned drag (pointercancel) still releases the note", async () => {
    mount();
    const note = host.querySelector(".pr-note")!;
    act(() => {
      note.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 4, clientX: 10, clientY: 200 }));
      note.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 4, clientX: 10, clientY: 200 - 2 * ROW_H, buttons: 1 }));
      host.querySelector(".pr-grid")!.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 4 }));
    });
    await flush();
    expect(auditions().some((x) => x.action === "off")).toBe(true);
  });

  it("sends NOTHING when Preview is off", async () => {
    useSettings.getState().set("notePreview", false);
    useLive.setState({ drawMode: true });
    mount();
    const key = host.querySelector('[data-testid="pr-key"][data-pitch="72"]');
    act(() => { key!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 5 })); });
    const grid = host.querySelector(".pr-grid")!;
    act(() => {
      grid.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 6, clientX: 100, clientY: 100 }));
      grid.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 6, clientX: 100, clientY: 100 }));
    });
    await flush();
    expect(auditions()).toEqual([]);
    // ...but the EDIT still happens. Preview governs sound, never whether work lands.
    expect(exec.mock.calls.some((c) => c[0] === "add_note")).toBe(true);
  });

  it("does not create on a draw-off single click, but creates on double-click", async () => {
    mount();
    const grid = host.querySelector(".pr-grid")!;
    act(() => {
      grid.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 8, clientX: 100, clientY: 100 }));
      grid.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 8, clientX: 100, clientY: 100 }));
    });
    await flush();
    expect(exec.mock.calls.some((c) => c[0] === "add_note")).toBe(false);

    act(() => {
      grid.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 100, clientY: 100 }));
    });
    await flush();
    expect(exec.mock.calls.some((c) => c[0] === "add_note")).toBe(true);
  });

  it("shift-clicking a gutter key selects that pitch instead of playing it", async () => {
    mount();
    const key = host.querySelector('[data-testid="pr-key"][data-pitch="60"]');
    act(() => { key!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 7, shiftKey: true })); });
    await flush();
    expect(host.querySelectorAll(".pr-note.sel").length).toBe(1);
    expect(auditions()).toEqual([]);
  });
});
