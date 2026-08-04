// The editor's own keyboard layer + view features, through the REAL component.
// pianoRollView/pianoRollGrid pin the arithmetic; this pins that the keys are wired and
// scoped to the open roll rather than claimed app-wide.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PianoRoll } from "./PianoRoll";
import { useStore } from "../store";
import { useSettings } from "../settings/store";
import type { CommandResult, Snapshot, Track } from "../types";

vi.mock("../bridge", async () => {
  const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
  return { ...actual, onEvent: vi.fn(() => () => {}), pickFiles: vi.fn(), pickSaveFile: vi.fn() };
});

// Three notes on three pitches — enough that folding is observable.
const NOTES = [
  { i: 0, pitch: 60, start: 0, length: 1, velocity: 100 },
  { i: 1, pitch: 64, start: 1, length: 1, velocity: 100 },
  { i: 2, pitch: 67, start: 2, length: 1, velocity: 100 },
];

const TRACK = {
  id: "t1", index: 0, name: "Keys", volumeDb: 0, pan: 0, mute: false, solo: false,
  clips: [{ id: "c1", name: "c1", type: "midi", start: 0, length: 8, offset: 0, hasRenderLayer: false, notes: NOTES }],
} as unknown as Track;

const SNAPSHOT = {
  schemaVersion: 1,
  session: {
    sampleRate: 48000, tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4,
    metronome: false, length: 16, editFile: "/tmp/pr-view.tracktionedit",
    key: { tonic: "A", mode: "minor" },
  },
  tracks: [TRACK],
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
  master: { volumeDb: 0, pan: 0 },
} as unknown as Snapshot;

describe("piano-roll view features and editor keys", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;

  const mount = () => {
    useStore.setState({ snapshot: SNAPSHOT, editingClipId: "c1", snap: true, exec });
    act(() => root.render(React.createElement(PianoRoll)));
  };

  const rows = () => host.querySelectorAll(".pr-row").length;
  const key = (k: string, mods: Record<string, boolean> = {}) =>
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...mods })); });
  const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  const calls = (name: string) => exec.mock.calls.filter((c) => c[0] === name).map((c) => c[1]);

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    exec = vi.fn(async (command: string): Promise<CommandResult> => ({ ok: true, command }));
    useSettings.getState().set("scaleLock", false);
    useSettings.getState().set("notePreview", false);   // keep sequences to edit commands
    useSettings.getState().set("prGridDivision", "1/4");
    useSettings.getState().set("prGridAdaptive", false);
    useSettings.getState().set("prGridTriplet", false);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useSettings.getState().set("notePreview", true);
    useStore.setState({ editingClipId: null, snapshot: null });
    vi.restoreAllMocks();
  });

  it("renders the FULL MIDI range, so notes outside the old 36..96 window are reachable", () => {
    mount();
    expect(rows()).toBe(128);
  });

  it("F folds to the pitches actually in use", () => {
    mount();
    key("f");
    expect(rows()).toBe(3);
    key("f");
    expect(rows()).toBe(128);
  });

  it("G folds to the scale but keeps every pitch that has a note", () => {
    mount();
    key("g");
    // A minor has 7 classes; every one of the three notes (60 C, 64 E, 67 G) is in key,
    // so folding must not lose any of them.
    expect(rows()).toBeLessThan(128);
    expect(rows()).toBeGreaterThan(0);
    expect(host.querySelectorAll(".pr-note").length).toBe(3);
  });

  it("K shades the key without constraining what you draw", () => {
    mount();
    expect(host.querySelectorAll(".pr-row.off-key").length).toBe(0);
    key("k");
    expect(host.querySelectorAll(".pr-row.off-key").length).toBeGreaterThan(0);
    // …and scale LOCK is still off: highlighting is a view preference, not an input aid.
    expect(useSettings.getState().get("scaleLock")).toBe(false);
  });

  it("T toggles the triplet grid, and it persists in settings", () => {
    mount();
    key("t");
    expect(useSettings.getState().get("prGridTriplet")).toBe(true);
  });

  it("Cmd+1..4 pick a grid division and turn adaptive off", () => {
    mount();
    // Coarse → fine, so the digit reads as "how many subdivisions in".
    for (const [digit, expected] of [["1", "1/4"], ["2", "1/8"], ["3", "1/16"], ["4", "1/32"]]) {
      useSettings.getState().set("prGridAdaptive", true);
      key(digit, { metaKey: true });
      expect(useSettings.getState().get("prGridDivision")).toBe(expected);
      // Picking an explicit division must also leave adaptive mode, or the choice would
      // be silently overridden by the zoom.
      expect(useSettings.getState().get("prGridAdaptive")).toBe(false);
    }
  });

  it("Cmd+A selects all, Cmd+Shift+A inverts", () => {
    mount();
    key("a", { metaKey: true });
    expect(host.querySelectorAll(".pr-note.sel").length).toBe(3);
    key("a", { metaKey: true, shiftKey: true });
    expect(host.querySelectorAll(".pr-note.sel").length).toBe(0);
  });

  it("arrow keys transpose the selection, Shift by an octave", async () => {
    mount();
    key("a", { metaKey: true });
    exec.mockClear();
    key("ArrowUp");
    await flush();
    expect((calls("set_note")[0] as { edits: { pitch: number }[] }).edits.map((e) => e.pitch)).toEqual([61, 65, 68]);
    exec.mockClear();
    key("ArrowUp", { shiftKey: true });
    await flush();
    expect((calls("set_note")[0] as { edits: { pitch: number }[] }).edits.map((e) => e.pitch)).toEqual([72, 76, 79]);
  });

  it("Cmd+arrow changes velocity instead of pitch", async () => {
    mount();
    key("a", { metaKey: true });
    exec.mockClear();
    key("ArrowUp", { metaKey: true });
    await flush();
    expect((calls("set_note")[0] as { edits: { velocity: number }[] }).edits.map((e) => e.velocity)).toEqual([110, 110, 110]);
  });

  it("0 deactivates the selection, and again reactivates it", async () => {
    mount();
    key("a", { metaKey: true });
    exec.mockClear();
    key("0");
    await flush();
    expect((calls("set_note")[0] as { edits: { mute: boolean }[] }).edits.every((e) => e.mute)).toBe(true);
  });

  it("Cmd+D duplicates the selection after itself", async () => {
    mount();
    key("a", { metaKey: true });
    exec.mockClear();
    key("d", { metaKey: true });
    await flush();
    const args = calls("add_note")[0] as { notes: { start: number }[] };
    // The selection spans beats 0..3, so the copy starts at 3.
    expect(args.notes.map((n) => n.start)).toEqual([3, 4, 5]);
  });

  it("Cmd+U quantizes to the grid shown in the editor, not the arrangement's", async () => {
    mount();
    key("u", { metaKey: true });
    await flush();
    expect((calls("quantize_notes")[0] as { division: number }).division).toBeCloseTo(1, 6);
  });

  it("editor keys do NOTHING once the roll is closed", async () => {
    mount();
    act(() => { useStore.setState({ editingClipId: null }); });
    exec.mockClear();
    key("f"); key("a", { metaKey: true }); key("ArrowUp");
    await flush();
    // Scoped to the surface, not claimed app-wide — otherwise F would swallow a letter
    // everywhere in the app.
    expect(exec.mock.calls).toEqual([]);
  });
});
