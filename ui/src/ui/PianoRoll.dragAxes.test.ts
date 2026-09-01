// Piano-roll drag AXIS INDEPENDENCE — the time half of the guard PR #427 opened.
//
// #427 fixed the pitch half: sliding a note sideways must not re-pitch it. This
// pins the mirror image — dragging a note purely VERTICALLY (to change its pitch)
// must not quantize its START TIME. A deliberately off-grid note (a pushed hit, a
// swung 16th) is the producer's timing decision; nudging its pitch is not a request
// to straighten it.
//
// The rule both halves share: an axis you did not move is never rewritten.
//
// These need snap ON (with snap off, snapBeat is the identity and the bug is
// invisible) and a note that actually sits off the grid.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PianoRoll, pianoRollNoteGripWidth, pianoRollNoteHitAtX } from "./PianoRoll";
import { useStore } from "../store";
import { useSettings } from "../settings/store";
import { useLive } from "../live/liveState";
import { FEEL_DEFAULTS } from "../interaction/feel";
import type { CommandResult, Snapshot, Track } from "../types";

const setEditorCursor = vi.hoisted(() => vi.fn());

vi.mock("../bridge", async () => {
  const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
  return {
    ...actual,
    onEvent: vi.fn(() => () => {}),
    pickFiles: vi.fn(),
    pickSaveFile: vi.fn(),
    setEditorCursor,
  };
});

const ROW_H = 15, BEAT_PX = 42;

// The fixture note is deliberately OFF the grid on BOTH time axes: at 120bpm 4/4
// with a 1/4 snap the step is exactly 1 beat, so a start of 1.3 and a length of
// 0.75 are both things the grid would straighten if the guard is missing.
const OFF_GRID_START = 1.3, OFF_GRID_LENGTH = 0.75;

const TRACK: Track = {
  id: "t1", index: 0, name: "Keys", volumeDb: 0, pan: 0, mute: false, solo: false,
  clips: [{
    id: "c1", name: "c1", type: "midi", start: 0, length: 4, offset: 0, hasRenderLayer: false,
    notes: [{ i: 0, pitch: 60, start: OFF_GRID_START, length: OFF_GRID_LENGTH, velocity: 100 }],
  }],
} as unknown as Track;

const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  session: {
    sampleRate: 48000, tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4,
    metronome: false, length: 16, editFile: "/tmp/pr-axes.tracktionedit",
    key: { tonic: "A", mode: "minor" },
  },
  tracks: [TRACK],
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
  master: { volumeDb: 0, pan: 0 },
} as unknown as Snapshot;

describe("piano-roll drag axis independence", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;

  const mount = (adaptive = false, noteLength = OFF_GRID_LENGTH) => {
    // snap ON — this is the whole point: snapBeat must have teeth for the guard to matter.
    // The editor keeps its OWN grid now — the arrangement's snapDivision no longer reaches
    // it — so pin the division here. Adaptive off, or the step would follow the zoom.
    useSettings.getState().set("prGridDivision", "1/4");
    useSettings.getState().set("prGridAdaptive", adaptive);
    useSettings.getState().set("prGridTriplet", false);
    const snapshot: Snapshot = {
      ...SNAPSHOT,
      tracks: SNAPSHOT.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => ({
          ...clip,
          notes: (clip.notes ?? []).map((note) => ({ ...note, length: noteLength })),
        })),
      })),
    };
    useStore.setState({ snapshot, editingClipId: "c1", snap: true, exec });
    act(() => root.render(React.createElement(PianoRoll, { docked: true })));
  };

  const selectNote = () => {
    const editor = host.querySelector<HTMLElement>('[data-testid="piano-roll"]');
    if (!editor) throw new Error("piano-roll editor did not render");
    editor.focus();
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "a", bubbles: true, metaKey: true,
    })));
    exec.mockClear();
  };

  const pressEditorKey = (key: string, options: KeyboardEventInit = {}) => {
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...options })));
    return exec.mock.calls.find((call) => call[0] === "set_note")?.[1] as
      | { start?: number; pitch?: number; length?: number }
      | undefined;
  };

  /**
   * Drag by `dxPx` horizontally and `semitones` downward, from whichever handle
   * `selector` names — the note body ("move") or its resize grip ("resize").
   * Returns the committed `set_note` args, or undefined if nothing was committed.
   */
  const drag = (selector: string, dxPx: number, semitones: number, altKey = false) => {
    const handle = host.querySelector(selector);
    if (!handle) throw new Error(`piano-roll ${selector} did not render`);
    const x0 = 10, x1 = x0 + dxPx;
    const y0 = 200, y1 = y0 + semitones * ROW_H; // +y is downward = lower pitch
    act(() => {
      handle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 3, clientX: x0, clientY: y0 }));
      handle.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 3, clientX: x1, clientY: y1, buttons: 1, altKey }));
      handle.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 3, clientX: x1, clientY: y1 }));
    });
    const call = exec.mock.calls.find((c) => c[0] === "set_note");
    return call ? (call[1] as { start?: number; pitch?: number; length?: number }) : undefined;
  };

  const dragNote = (dxPx: number, semitones: number, altKey = false) => drag(".pr-note", dxPx, semitones, altKey);
  const dragGrip = (dxPx: number, semitones: number, altKey = false) => drag(".pr-note-grip-end", dxPx, semitones, altKey);
  const dragStartGrip = (dxPx: number, altKey = false) => drag(".pr-note-grip-start", dxPx, 0, altKey);

  const clickGrid = (beat: number, altKey = false) => {
    const grid = host.querySelector(".pr-grid");
    if (!grid) throw new Error("piano-roll grid did not render");
    const x = beat * BEAT_PX, y = 200;
    act(() => {
      grid.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 11, clientX: x, clientY: y, altKey }));
      grid.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 11, clientX: x, clientY: y, altKey }));
    });
    return exec.mock.calls.find((c) => c[0] === "add_note")?.[1] as { start?: number } | undefined;
  };

  /**
   * Drag out to `viaPx` and then back to `endPx` before releasing — the "I changed
   * my mind, put it back" gesture. The guard must not leave the far-out preview
   * standing, or letting go at the origin would commit the trip that was undone.
   */
  const dragOutAndBack = (selector: string, viaPx: number, endPx: number) => {
    const handle = host.querySelector(selector);
    if (!handle) throw new Error(`piano-roll ${selector} did not render`);
    const x0 = 10, y = 200;
    const at = (type: string, x: number, extra: Record<string, unknown> = {}) =>
      handle.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 5, clientX: x, clientY: y, ...extra }));
    act(() => {
      at("pointerdown", x0);
      at("pointermove", x0 + viaPx, { buttons: 1 });
      at("pointermove", x0 + endPx, { buttons: 1 });
      at("pointerup", x0 + endPx);
    });
    return exec.mock.calls.find((c) => c[0] === "set_note")?.[1] as
      | { start?: number; length?: number }
      | undefined;
  };

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    exec = vi.fn(async (command: string): Promise<CommandResult> => ({ ok: true, command }));
    useSettings.getState().set("scaleLock", false);
    useLive.setState({ drawMode: true });
    setEditorCursor.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useSettings.getState().set("scaleLock", false);
    useLive.setState({ drawMode: false });
    useStore.setState({ editingClipId: null, snapshot: null });
    vi.restoreAllMocks();
  });

  it("a purely VERTICAL drag re-pitches the note without quantizing its off-grid start", () => {
    mount();
    const sent = dragNote(0, 4); // straight down 4 semitones, zero horizontal travel
    expect(sent?.pitch).toBe(56);
    expect(sent?.start).toBe(OFF_GRID_START);
  });

  it("a sub-threshold horizontal wobble during a vertical drag does not quantize either", () => {
    // A real hand never travels exactly 0px sideways. Anything at or under the
    // drag threshold is tremor, not a request to move the note in time.
    expect(FEEL_DEFAULTS.dragThreshold).toBeGreaterThan(0);
    mount();
    const sent = dragNote(FEEL_DEFAULTS.dragThreshold, 4);
    expect(sent?.pitch).toBe(56);
    expect(sent?.start).toBe(OFF_GRID_START);
  });

  it("still snaps the start once the drag really crosses the time axis", () => {
    mount();
    // A full beat to the right: 1.3 + 1.0 = 2.3, which the 1-beat grid rounds to 2.
    expect(dragNote(BEAT_PX, 0)?.start).toBe(2);
  });

  it("Shift+Right lengthens the selected note by one grid step without moving its start", () => {
    mount(false, 2);
    selectNote();

    const sent = pressEditorKey("ArrowRight", { shiftKey: true });

    expect(sent?.length).toBe(3);
    expect(sent?.start).toBeUndefined();
  });

  it("Shift+Left shortens the selected note by one grid step without moving its start", () => {
    mount(false, 2);
    selectNote();

    const sent = pressEditorKey("ArrowLeft", { shiftKey: true });

    expect(sent?.length).toBe(1);
    expect(sent?.start).toBeUndefined();
  });

  it("Shift+Up and Shift+Down transpose selected notes by octaves", () => {
    mount(false, 2);
    selectNote();
    expect(pressEditorKey("ArrowUp", { shiftKey: true })?.pitch).toBe(72);

    exec.mockClear();
    expect(pressEditorKey("ArrowDown", { shiftKey: true })?.pitch).toBe(48);
  });

  it("Option-drag moves a note off-grid without disabling snap", () => {
    mount();
    expect(dragNote(BEAT_PX, 0, true)?.start).toBeCloseTo(OFF_GRID_START + 1, 6);
    expect(useStore.getState().snap).toBe(true);
  });

  it("Option-drag resizes a note off-grid", () => {
    mount();
    expect(dragGrip(BEAT_PX, 0, true)?.length).toBeCloseTo(OFF_GRID_LENGTH + 1, 6);
  });

  it("resizes from the left edge while keeping the note end fixed", () => {
    mount();
    const sent = dragStartGrip(-BEAT_PX / 2, true);
    expect(sent?.start).toBeCloseTo(OFF_GRID_START - 0.5, 6);
    expect(sent?.length).toBeCloseTo(OFF_GRID_LENGTH + 0.5, 6);
  });

  it("renders a hit target and resize cursor on both note edges", () => {
    mount();
    const start = host.querySelector<HTMLElement>(".pr-note-grip-start");
    const end = host.querySelector<HTMLElement>(".pr-note-grip-end");
    expect(start?.getAttribute("aria-label")).toMatch(/^Resize start/);
    expect(end?.getAttribute("aria-label")).toMatch(/^Resize end/);
    expect(start?.classList.contains("pr-note-grip")).toBe(true);
    expect(end?.classList.contains("pr-note-grip")).toBe(true);
    expect(start?.style.width).toBe("10px");
    expect(end?.style.width).toBe("10px");
  });

  it("advertises note-body and resize-edge gestures before pointer-down", () => {
    mount();
    const grid = host.querySelector<HTMLElement>(".pr-grid");
    const note = host.querySelector<HTMLElement>(".pr-note");
    const start = host.querySelector<HTMLElement>(".pr-note-grip-start");
    const end = host.querySelector<HTMLElement>(".pr-note-grip-end");
    if (!grid || !note || !start || !end) throw new Error("piano-roll cursor targets did not render");

    act(() => note.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerId: 31 })));
    expect(grid.style.cursor).toBe("grab");
    expect(setEditorCursor).toHaveBeenLastCalledWith("open-hand");

    act(() => start.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerId: 31 })));
    expect(grid.style.cursor).toBe("ew-resize");
    expect(setEditorCursor).toHaveBeenLastCalledWith("resize-left-right");

    act(() => end.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerId: 31 })));
    expect(grid.style.cursor).toBe("ew-resize");
    expect(setEditorCursor).toHaveBeenLastCalledWith("resize-left-right");

    act(() => grid.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 31 })));
    expect(grid.style.cursor).toBe("crosshair");
    expect(setEditorCursor).toHaveBeenLastCalledWith("crosshair");

    act(() => note.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, pointerId: 31, clientX: 20, clientY: 200,
    })));
    expect(grid.style.cursor).toBe("grabbing");
    expect(setEditorCursor).toHaveBeenLastCalledWith("closed-hand");

    act(() => note.dispatchEvent(new PointerEvent("pointerup", {
      bubbles: true, pointerId: 31, clientX: 20, clientY: 200,
    })));
    expect(grid.style.cursor).toBe("grab");
    expect(setEditorCursor).toHaveBeenLastCalledWith("open-hand");
  });

  it("resolves each note pixel through one stable body-or-edge hit target", () => {
    expect(pianoRollNoteGripWidth(62)).toBe(10);
    expect(pianoRollNoteHitAtX(62, 10)).toBe("resize-start");
    expect(pianoRollNoteHitAtX(62, 10.01)).toBe("move");
    expect(pianoRollNoteHitAtX(62, 51.99)).toBe("move");
    expect(pianoRollNoteHitAtX(62, 52)).toBe("resize-end");
    expect(pianoRollNoteHitAtX(6, 1)).toBe("resize-start");
    expect(pianoRollNoteHitAtX(6, 3)).toBe("move");
    expect(pianoRollNoteHitAtX(6, 5)).toBe("resize-end");
  });

  it("keeps a dragged note attached to a stationary pointer while the editor scrolls", () => {
    mount();
    const note = host.querySelector<HTMLElement>(".pr-note");
    const scroller = host.querySelector<HTMLElement>(".pr-scroll");
    if (!note || !scroller) throw new Error("piano-roll note or scroller did not render");

    scroller.scrollTop = 90;
    act(() => scroller.dispatchEvent(new Event("scroll", { bubbles: true })));
    const topAtDown = Number.parseFloat(note.style.top);

    act(() => note.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, pointerId: 21, clientX: 20, clientY: 200,
    })));
    scroller.scrollTop += 2 * ROW_H;
    act(() => scroller.dispatchEvent(new Event("scroll", { bubbles: true })));

    const preview = host.querySelector<HTMLElement>(".pr-note");
    expect(Number.parseFloat(preview?.style.top ?? "NaN") - topAtDown).toBe(2 * ROW_H);
  });

  it("keeps an end resize attached to a stationary pointer while the editor scrolls horizontally", () => {
    mount();
    const grip = host.querySelector<HTMLElement>(".pr-note-grip-end");
    const note = host.querySelector<HTMLElement>(".pr-note");
    const scroller = host.querySelector<HTMLElement>(".pr-scroll");
    if (!grip || !note || !scroller) throw new Error("piano-roll resize grip or scroller did not render");

    const widthAtDown = Number.parseFloat(note.style.width);
    act(() => grip.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, pointerId: 22, clientX: 20, clientY: 200,
    })));
    scroller.scrollLeft = BEAT_PX;
    act(() => scroller.dispatchEvent(new Event("scroll", { bubbles: true })));

    const preview = host.querySelector<HTMLElement>(".pr-note");
    expect(Number.parseFloat(preview?.style.width ?? "NaN")).toBeGreaterThan(widthAtDown);
  });

  it("renders every active adaptive snap subdivision", () => {
    mount(true);
    const halfBeat = [...host.querySelectorAll<HTMLElement>('.pr-gl[data-grid-kind="subdivision"]')]
      .find((line) => line.dataset.gridBeat === "0.5");
    expect(halfBeat?.style.left).toBe(`${BEAT_PX / 2}px`);
  });

  it("snaps a drawn note normally but Option-click can place it off-grid", () => {
    mount();
    expect(clickGrid(1.3)?.start).toBe(1);
    exec.mockClear();
    expect(clickGrid(1.3, true)?.start).toBeCloseTo(1.3, 6);
  });

  it("a drawn note starts at the grid line AT OR BELOW the click, never ahead of it", () => {
    // The "half a beat off the grid" bug: entry used round-to-nearest, so a click
    // at beat 1.6 on the 1-beat grid drew the note at beat 2 — up to half a step
    // from the pointer, and AHEAD of it. Entry floors, like every reference DAW's
    // pencil; round stays only on the drag paths (see the tests above).
    mount();
    expect(clickGrid(1.6)?.start).toBe(1);
    exec.mockClear();
    expect(clickGrid(1.9)?.start).toBe(1);
    exec.mockClear();
    expect(clickGrid(2.0)?.start).toBe(2);
  });

  it("a vertical wiggle on the resize grip does not quantize an off-grid length", () => {
    mount();
    expect(dragGrip(0, 3)).toBeUndefined();
  });

  it("dragging the resize grip out and back to the start commits nothing", () => {
    mount();
    // Skipping the preview while inside the deadzone is not enough: the far-out
    // one must be cleared, or releasing at the origin commits the abandoned trip.
    expect(dragOutAndBack(".pr-note-grip-end", 3 * BEAT_PX, 0)).toBeUndefined();
  });

  it("dragging a note out and back commits nothing", () => {
    mount();
    // Same abandoned gesture as the resize case above, and now the same answer: neither
    // axis ended up moved, so nothing is sent at all.
    //
    // This assertion used to expect a set_note carrying the note's ORIGINAL start — the
    // move path wrote the unchanged values back, while the resize path (one test up)
    // committed nothing. That asymmetry was an artifact of two code paths, not a decision:
    // both gestures abandon the same way. Committing nothing is the stronger guarantee for
    // the property this file is about — an untouched axis cannot be rewritten by a command
    // that was never sent — and it saves a pointless undo step, JSONL line, snapshot
    // invalidation and UI refresh per abandoned drag.
    expect(dragOutAndBack(".pr-note", 3 * BEAT_PX, 0)).toBeUndefined();
  });
});
