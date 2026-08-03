// Scale-lock wiring guard (reality-model invariant 88).
//
// musicalKey.test.ts proves the pitch math; this proves the PIANO ROLL actually
// applies it — that the snapped pitch is what reaches the `add_note`/`set_note`
// command, that existing notes are never rewritten, and that the whole feature
// is inert when the toggle is off. The pure-module tests cannot catch a missing
// call site; this is the class of bug that only a real render surfaces.

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

// The roll spans the FULL MIDI range now (it used to stop at 96), so the same screen Y is
// a different pitch. The helper below already derives Y from a target pitch, so this one
// constant is the whole update.
const ROW_H = 15, BEAT_PX = 42, HIGH = 127;
/** clientY that lands the pointer on a given pitch row (pitchAt inverts this). */
const yForPitch = (pitch: number) => (HIGH - pitch) * ROW_H + 1;

const TRACK: Track = {
  id: "t1", index: 0, name: "Keys", volumeDb: 0, pan: 0, mute: false, solo: false,
  clips: [{
    id: "c1", name: "c1", type: "midi", start: 0, length: 4, offset: 0, hasRenderLayer: false,
    // One deliberately OUT-OF-KEY existing note (D#4 = pc 3, not in A minor).
    notes: [{ i: 0, pitch: 63, start: 0, length: 1, velocity: 100 }],
  }],
} as unknown as Track;

function snapshotFor(key: { tonic: string; mode: string }): Snapshot {
  return {
    schemaVersion: 1,
    session: {
      sampleRate: 48000, tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4,
      metronome: false, length: 16, editFile: "/tmp/pr-scale.tracktionedit", key,
    },
    tracks: [TRACK],
    transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
    master: { volumeDb: 0, pan: 0 },
  } as unknown as Snapshot;
}

describe("piano-roll scale lock", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;

  const mount = (key = { tonic: "A", mode: "minor" }) => {
    useStore.setState({ snapshot: snapshotFor(key), editingClipId: "c1", snap: false, snapDivision: "1/4", exec });
    act(() => root.render(React.createElement(PianoRoll)));
  };

  /** A click with no movement — the piano roll's "add a note here" gesture. */
  const clickGrid = (clientX: number, clientY: number) => {
    const grid = host.querySelector(".pr-grid");
    if (!grid) throw new Error("piano-roll grid did not render");
    act(() => {
      grid.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX, clientY }));
      grid.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX, clientY }));
    });
  };

  const addedPitch = () => {
    const call = exec.mock.calls.find((c) => c[0] === "add_note");
    return call ? (call[1] as { pitch: number }).pitch : undefined;
  };

  /** Drag the fixture note by `semitones` down and `beats` sideways, and commit it. */
  const dragNote = (semitones: number, beats = 0) => {
    const note = host.querySelector(".pr-note");
    if (!note) throw new Error("piano-roll note did not render");
    const x0 = 10, x1 = x0 + beats * BEAT_PX;
    const y0 = 200, y1 = y0 + semitones * ROW_H; // +y is downward = lower pitch
    act(() => {
      note.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 2, clientX: x0, clientY: y0 }));
      note.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 2, clientX: x1, clientY: y1, buttons: 1 }));
      note.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 2, clientX: x1, clientY: y1 }));
    });
    const call = exec.mock.calls.find((c) => c[0] === "set_note");
    return call ? (call[1] as { pitch?: number }) : undefined;
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
    useSettings.getState().set("scaleLock", false);
    useStore.setState({ editingClipId: null, snapshot: null });
    vi.restoreAllMocks();
  });

  it("is OFF by default — the drawn pitch is exactly the row that was clicked", () => {
    expect(useSettings.getState().get("scaleLock")).toBe(false);
    mount();
    clickGrid(BEAT_PX, yForPitch(61)); // C#4 — out of A minor
    expect(addedPitch()).toBe(61);
  });

  it("snaps a drawn note to the song key when ON", () => {
    useSettings.getState().set("scaleLock", true);
    mount();
    clickGrid(BEAT_PX, yForPitch(61)); // C#4 → nearest A-minor tone downward = C4
    expect(addedPitch()).toBe(60);
  });

  it("leaves an in-key row alone when ON", () => {
    useSettings.getState().set("scaleLock", true);
    mount();
    clickGrid(BEAT_PX, yForPitch(64)); // E4 is in A minor
    expect(addedPitch()).toBe(64);
  });

  it("follows the song key, not a hardcoded scale", () => {
    useSettings.getState().set("scaleLock", true);
    mount({ tonic: "C#", mode: "major" }); // pcs 1,3,5,6,8,10,0 — C#4 (61) is IN key here
    clickGrid(BEAT_PX, yForPitch(61));
    expect(addedPitch()).toBe(61);
  });

  it("is a no-op in a chromatic key", () => {
    useSettings.getState().set("scaleLock", true);
    mount({ tonic: "A", mode: "chromatic" });
    clickGrid(BEAT_PX, yForPitch(61));
    expect(addedPitch()).toBe(61);
  });

  it("snaps a DRAGGED note too, not just a drawn one", () => {
    useSettings.getState().set("scaleLock", true);
    mount();
    // The fixture note is D#4 (63); dragging down 2 semitones targets C#4 (61),
    // which is out of A minor and must land on C4 (60).
    expect(dragNote(2)?.pitch).toBe(60);
  });

  it("does not snap a dragged note when OFF", () => {
    mount();
    expect(dragNote(2)?.pitch).toBe(61);
  });

  it("a purely HORIZONTAL nudge never re-pitches an off-key note — invariant 88", () => {
    useSettings.getState().set("scaleLock", true);
    mount();
    // The fixture note is an off-key D#4 (63). Sliding it sideways in time is
    // not a request to re-pitch it, so its pitch must survive the move even
    // though it does not belong to the locked key.
    expect(dragNote(0, 2)?.pitch).toBe(63);
  });

  it("a horizontal nudge on an IN-key note is likewise left alone", () => {
    useSettings.getState().set("scaleLock", true);
    mount({ tonic: "D#", mode: "major" }); // 63 is the tonic here — in key
    expect(dragNote(0, 2)?.pitch).toBe(63);
  });

  it("NEVER rewrites existing notes — invariant 88", () => {
    useSettings.getState().set("scaleLock", true);
    mount(); // the fixture clip holds an out-of-key D#4 that must survive untouched
    clickGrid(BEAT_PX, yForPitch(61));
    expect(exec.mock.calls.some((c) => c[0] === "set_note")).toBe(false);
    expect(exec.mock.calls.some((c) => c[0] === "quantize_notes")).toBe(false);
    const snap = useStore.getState().snapshot;
    expect(snap?.tracks[0].clips[0].notes?.[0].pitch).toBe(63);
  });

  it("shades out-of-key rows and marks the root only while ON", () => {
    mount();
    expect(host.querySelectorAll(".pr-row.off-key")).toHaveLength(0);
    expect(host.querySelectorAll(".pr-row.root")).toHaveLength(0);

    act(() => { useSettings.getState().set("scaleLock", true); });
    // The roll now draws the FULL range, 0..127 (it used to stop at 36..96, which silently
    // hid any note outside that). Counting rows for pitch class c: floor((127 - c)/12) + 1.
    // A minor's five out-of-key classes are A#(10) C#(1) D#(3) F#(6) G#(8) →
    // 10 + 11 + 11 + 11 + 10 = 53.
    expect(host.querySelectorAll(".pr-row.off-key")).toHaveLength(53);
    // The root is A (class 9): floor((127-9)/12) + 1 = 10.
    expect(host.querySelectorAll(".pr-row.root")).toHaveLength(10);
    // And the range itself is reachable — the old bug was that these rows did not exist.
    expect(host.querySelectorAll(".pr-row")).toHaveLength(128);
  });

  it("exposes a toggle that reports its state and names the key", () => {
    mount({ tonic: "F#", mode: "minor" });
    const btn = host.querySelector('[data-testid="pr-scale-lock"]');
    expect(btn).toBeTruthy();
    expect(btn?.getAttribute("aria-pressed")).toBe("false");
    expect(btn?.textContent).toContain("F# minor");

    act(() => { (btn as HTMLElement).click(); });
    expect(useSettings.getState().get("scaleLock")).toBe(true);
    expect(host.querySelector('[data-testid="pr-scale-lock"]')?.getAttribute("aria-pressed")).toBe("true");
  });
});
