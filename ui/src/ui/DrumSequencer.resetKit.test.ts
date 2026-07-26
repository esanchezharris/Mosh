// UI-REACH — load_drum_kit. Its old UI_REACH_GAPS entry said this "wants a kit picker",
// which was wrong: there is exactly one bundled kit (mosh-kit), no list_drum_kits
// enumeration anywhere, and no kit name in the snapshot — a picker is not buildable
// today. What IS real: after a producer swaps individual pads via the "⋯" per-lane
// button (assign_sample), reloading the bundled default is a meaningful reset. "Reset
// kit" ships in the toolbar next to Clear/Pattern, gated on isDrumTrack (mirrors "Make
// drum track" being gated on !isDrumTrack — the two are mutually exclusive).
//
// Same render harness as the sibling DrumSequencer.pattern.test.ts.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DrumSequencer } from "./DrumSequencer";
import { useStore } from "../store";
import type { Clip, Snapshot } from "../types";

vi.mock("../bridge", async () => {
  const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
  return { ...actual, onEvent: vi.fn(() => () => {}), pickFiles: vi.fn(), pickSaveFile: vi.fn() };
});

const CLIP: Clip = {
  id: "c1", name: "beat", type: "drum", start: 0, length: 2, offset: 0, hasRenderLayer: false,
  notes: [{ i: 0, pitch: 36, start: 0, length: 0.25, velocity: 100 }],
} as unknown as Clip;

function snapshotWithTrack(type: "drum" | "audio"): Snapshot {
  return {
    schemaVersion: 1,
    session: {
      sampleRate: 48000, tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4,
      metronome: false, length: 16, editFile: "/tmp/d.mosh", key: { tonic: "A", mode: "minor" },
    },
    tracks: [{ id: "t1", index: 0, name: "Drums", type, volumeDb: 0, pan: 0, mute: false, solo: false, clips: [CLIP] }],
    transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
    master: { volumeDb: 0, pan: 0 },
  } as unknown as Snapshot;
}

describe("DrumSequencer — Reset kit (UI-REACH load_drum_kit)", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;

  const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

  function renderWith(type: "drum" | "audio") {
    exec = vi.fn(async () => ({ ok: true }));
    useStore.setState({ snapshot: snapshotWithTrack(type), exec });
    act(() => root.render(React.createElement(DrumSequencer, { clip: CLIP })));
  }

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it("shows Reset kit on a drum track but not on a plain audio track", () => {
    renderWith("drum");
    expect(q("dr-reset-kit")).toBeTruthy();

    renderWith("audio");
    expect(q("dr-reset-kit")).toBeFalsy();
    // The two controls are mutually exclusive: a non-drum track offers "make drum
    // track" instead, in the same toolbar slot.
    expect(q("make-drum-track")).toBeTruthy();
  });

  it("clicking Reset kit execs load_drum_kit for this track, and only after clicking", () => {
    renderWith("drum");
    expect(exec).not.toHaveBeenCalled();

    act(() => q("dr-reset-kit")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith("load_drum_kit", { trackId: "t1" });
  });
});
