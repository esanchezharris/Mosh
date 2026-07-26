// The piano roll was the last overlay still handling Escape with its own private
// window listener. AL-001 introduced a shared LIFO Escape stack precisely so that with
// two overlays open a single Escape closes only the TOP one — and every other overlay
// adopted it, several of them citing this file as the pattern they mirror. The
// migration never actually reached this file, so the backlog item read `done` while
// the component it names kept the old behaviour: with a popover open over the piano
// roll, one Escape closed both.
//
// The stack listens in CAPTURE phase and stopPropagation()s, so this also pins that the
// bubble-phase Delete/Backspace handler is unaffected by the migration.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PianoRoll } from "./PianoRoll";
import { useStore } from "../store";
import { pushEscapeHandler, escapeStackDepth } from "../hooks/escapeStack";
import type { Snapshot, Track } from "../types";

vi.mock("../bridge", async () => {
  const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
  return { ...actual, onEvent: vi.fn(() => () => {}), pickFiles: vi.fn(), pickSaveFile: vi.fn() };
});

const TRACK: Track = {
  id: "t1", index: 0, name: "Keys", volumeDb: 0, pan: 0, mute: false, solo: false,
  clips: [{
    id: "c1", name: "c1", type: "midi", start: 0, length: 4, offset: 0, hasRenderLayer: false,
    notes: [{ i: 0, pitch: 60, start: 0, length: 1, velocity: 100 }],
  }],
} as unknown as Track;

const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  session: {
    sampleRate: 48000, tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4,
    metronome: false, length: 16, editFile: "/tmp/pr-escape.tracktionedit",
    key: { tonic: "A", mode: "minor" },
  },
  tracks: [TRACK],
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
  master: { volumeDb: 0, pan: 0 },
} as unknown as Snapshot;

describe("piano roll Escape goes through the shared stack", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;
  let closePianoRoll: ReturnType<typeof vi.fn>;

  const pressEscape = () => {
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
  };

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    exec = vi.fn(async () => ({ ok: true }));
    closePianoRoll = vi.fn();
    useStore.setState({ snapshot: SNAPSHOT, editingClipId: "c1", snap: false, exec, closePianoRoll });
    act(() => root.render(React.createElement(PianoRoll)));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState({ editingClipId: null });
  });

  // ── What actually discriminates fixed from broken ────────────────────────────
  // NOTE, because it nearly produced a vacuous suite: in this jsdom, a CAPTURE
  // listener on `window` runs before a same-node bubble listener and its
  // stopPropagation() suppresses it — contrary to the DOM spec's AT_TARGET rule.
  // So "press Escape and assert the piano roll did not close" PASSES against the
  // old private-listener code too: the stack's capture handler simply swallows it.
  // Dispatch-based assertions therefore cannot tell the two implementations apart.
  // STACK PARTICIPATION (depth) is the honest discriminator, so that is what the
  // assertions below key on. Verified: each of these reds against HEAD.

  it("pushes exactly one handler onto the shared stack while open", () => {
    // Reds on the private-listener implementation: depth stays 0.
    expect(escapeStackDepth()).toBe(1);
  });

  it("stacks BENEATH a later overlay rather than listening independently", () => {
    // Depth 2 is the proof both overlays are in one ordered stack. The old code
    // reached depth 1 (only the other overlay), while the roll listened separately —
    // which is exactly how one Escape used to close both.
    const dispose = pushEscapeHandler(vi.fn());
    expect(escapeStackDepth(), "piano roll is not participating in the stack").toBe(2);
    dispose();
    expect(escapeStackDepth()).toBe(1);
  });

  it("routes Escape to the topmost overlay, leaving the roll open", () => {
    // Given participation (pinned above), this pins the ordering contract end to end.
    const above = vi.fn();
    const dispose = pushEscapeHandler(above);
    pressEscape();
    expect(above).toHaveBeenCalledTimes(1);
    expect(closePianoRoll, "piano roll closed underneath the top overlay").not.toHaveBeenCalled();
    dispose();
  });

  it("closes on Escape once it is topmost again", () => {
    const dispose = pushEscapeHandler(vi.fn());
    dispose();
    pressEscape();
    expect(closePianoRoll).toHaveBeenCalledTimes(1);
  });

  it("pops its handler off the stack on unmount", () => {
    expect(escapeStackDepth(), "nothing was pushed, so popping proves nothing").toBe(1);
    act(() => root.unmount());
    expect(escapeStackDepth()).toBe(0);
    // re-render so afterEach's unmount is a no-op rather than a double-unmount
    root = createRoot(host);
  });

  it("still deletes selected notes on Delete (the bubble-phase handler survives)", () => {
    const note = host.querySelector(".pr-note");
    expect(note, "no note rendered").toBeTruthy();
    act(() => {
      note!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: 10, clientY: 200 }));
      note!.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 10, clientY: 200 }));
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }));
    });
    expect(exec).toHaveBeenCalledWith("remove_note", expect.objectContaining({ clipId: "c1", noteIndex: 0 }));
  });
});
