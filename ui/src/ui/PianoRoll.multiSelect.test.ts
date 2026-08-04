// Multi-note editing through the REAL component. pianoRollEdit/pianoRollSelection pin the
// arithmetic and the set algebra; this pins that the component actually WIRES them — the
// class of bug pure modules structurally cannot catch, and the reason PianoRoll.scaleLock
// .test.ts exists in the same shape.
//
// The specific regression guarded here: onNoteDown used to do
// `setSelectedNotes(new Set([n.i]))` unconditionally, so grabbing any note threw the
// selection away and dragged exactly one note. That single line is what made "select
// several notes and move them together" impossible.

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

const ROW_H = 15, BEAT_PX = 42;

// Three notes an even beat apart, on the grid, at distinct pitches.
const NOTES = [
  { i: 0, pitch: 60, start: 0, length: 1, velocity: 100 },
  { i: 1, pitch: 62, start: 1, length: 1, velocity: 100 },
  { i: 2, pitch: 64, start: 2, length: 1, velocity: 100 },
];

const TRACK = {
  id: "t1", index: 0, name: "Keys", volumeDb: 0, pan: 0, mute: false, solo: false,
  clips: [{ id: "c1", name: "c1", type: "midi", start: 0, length: 8, offset: 0, hasRenderLayer: false, notes: NOTES }],
} as unknown as Track;

const SNAPSHOT = {
  schemaVersion: 1,
  session: {
    sampleRate: 48000, tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4,
    metronome: false, length: 16, editFile: "/tmp/pr-multi.tracktionedit",
    key: { tonic: "A", mode: "minor" },
  },
  tracks: [TRACK],
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
  master: { volumeDb: 0, pan: 0 },
} as unknown as Snapshot;

describe("piano-roll multi-note editing", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;

  const mount = () => {
    useStore.setState({ snapshot: SNAPSHOT, editingClipId: "c1", snap: true, snapDivision: "1/4", exec });
    act(() => root.render(React.createElement(PianoRoll)));
  };

  const noteEls = () => [...host.querySelectorAll(".pr-note")];
  // EDIT commands only. Audition is a separate concern that interleaves freely with these
  // (selecting a note sounds it), and it has its own spec — mixing the two here would make
  // every sequence assertion depend on the Preview setting.
  const names = () => exec.mock.calls.map((c) => c[0] as string).filter((n) => n !== "audition_note");
  const setNoteArgs = () =>
    exec.mock.calls.filter((c) => c[0] === "set_note").map((c) => c[1] as Record<string, number>);
  /** Args of the first call to `command` — never index into mock.calls directly, since
   *  audition_note interleaves with the edits. */
  const argsOf = (command: string) =>
    exec.mock.calls.find((c) => c[0] === command)?.[1] as Record<string, unknown> | undefined;

  const click = (el: Element, shiftKey = false) => {
    act(() => {
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: 5, clientY: 5, shiftKey }));
      el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 5, clientY: 5, shiftKey }));
    });
  };

  /**
   * A multi-note commit is a CHAIN of awaited commands (batch_begin → N × set_note →
   * batch_end), so the microtask queue has to drain before the full sequence is visible.
   * Without this you observe only `["batch_begin"]` and would conclude the batching is
   * broken when it is merely in flight.
   */
  const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

  /** Drag `el` by (dxPx, semitones-down). altAtDown latches an Option copy-drag. */
  const drag = async (el: Element, dxPx: number, semitones: number, altAtDown = false) => {
    const x0 = 10, y0 = 200;
    const x1 = x0 + dxPx, y1 = y0 + semitones * ROW_H;
    act(() => {
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 2, clientX: x0, clientY: y0, altKey: altAtDown }));
      el.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 2, clientX: x1, clientY: y1, buttons: 1 }));
      el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 2, clientX: x1, clientY: y1 }));
    });
    await flush();
  };

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    exec = vi.fn(async (command: string): Promise<CommandResult> => ({ ok: true, command }));
    useSettings.getState().set("scaleLock", false);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState({ editingClipId: null, snapshot: null });
    vi.restoreAllMocks();
  });

  it("shift-click builds a selection without starting a drag", () => {
    mount();
    const els = noteEls();
    click(els[0]);
    click(els[1], true);
    expect(host.querySelectorAll(".pr-note.sel").length).toBe(2);
    expect(names()).toEqual([]); // selection is view state — no command
  });

  it("dragging a SELECTED note moves the whole selection, as one undo step", async () => {
    mount();
    const els = noteEls();
    click(els[0]);
    click(els[1], true);
    click(els[2], true);
    exec.mockClear();

    await drag(noteEls()[0], BEAT_PX, 0);

    // ONE command carrying every note — which is also the only safe shape, since moving a
    // note re-sorts the engine's list and would invalidate any later index.
    expect(names()).toEqual(["set_note"]);
    const edits = argsOf("set_note")!.edits as { noteIndex: number; start: number }[];
    // Each note moved by ONE beat from its own start — the selection keeps its shape
    // instead of collapsing onto the note that was grabbed.
    expect(edits.map((e) => e.start)).toEqual([1, 2, 3]);
    expect(edits.map((e) => e.noteIndex)).toEqual([0, 1, 2]);
  });

  it("dragging an UNSELECTED note replaces the selection and moves only that note", async () => {
    mount();
    const els = noteEls();
    click(els[0]);
    exec.mockClear();

    await drag(noteEls()[2], BEAT_PX, 0);

    expect(names()).toEqual(["set_note"]);           // single note ⇒ no batch
    expect(setNoteArgs()[0].noteIndex).toBe(2);
  });

  it("transposing a multi-note selection moves every note by the same interval", async () => {
    mount();
    const els = noteEls();
    click(els[0]);
    click(els[1], true);
    exec.mockClear();

    await drag(noteEls()[0], 0, 2); // straight down two semitones

    const edits = argsOf("set_note")!.edits as { pitch: number; start: number }[];
    expect(edits.map((e) => e.pitch)).toEqual([58, 60]);
    // A purely vertical drag must not rewrite any start (the axis invariant, at N).
    expect(edits.map((e) => e.start)).toEqual([0, 1]);
  });

  it("Option-drag COPIES the selection instead of moving it", async () => {
    mount();
    const els = noteEls();
    click(els[0]);
    click(els[1], true);
    exec.mockClear();

    await drag(noteEls()[0], BEAT_PX, 0, /* altAtDown */ true);

    // One add_note carrying both copies, and — critically — no set_note: the originals
    // must be left exactly where they were.
    expect(names()).toEqual(["add_note"]);
    const args = argsOf("add_note") as { notes?: { start: number }[] };
    expect(args.notes?.map((n) => n.start)).toEqual([1, 2]);
  });

  it("Delete removes the whole selection in descending index order", async () => {
    mount();
    const els = noteEls();
    click(els[0]);
    click(els[2], true);
    exec.mockClear();

    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true })); });
    await flush();

    expect(names()).toEqual(["batch_begin", "remove_note", "remove_note", "batch_end"]);
    const idx = exec.mock.calls.filter((c) => c[0] === "remove_note").map((c) => (c[1] as { noteIndex: number }).noteIndex);
    expect(idx).toEqual([2, 0]); // descending — remove_note reindexes
  });
});
