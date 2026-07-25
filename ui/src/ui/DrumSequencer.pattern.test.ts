// DRM-002 — the Pattern field.
//
// add_drum_pattern shipped agent-only: the backend, the twin parsers and their mirrored
// golden vectors were all complete, but nothing in the UI called it. A mouse-only user
// could only build a beat one cell at a time — and got one undo step per cell, where the
// command does the whole grid in one transaction.
//
// What matters here is the WIRING, not the parsing (drumPatternUtil.test.ts owns that):
// the field seeds from the live clip, validates with the same parser the backend uses,
// refuses to dispatch while invalid, and passes clipId so Apply is a per-lane EDIT rather
// than a wipe of the whole grid.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DrumSequencer } from "./DrumSequencer";
import { useStore } from "../store";
import { parseDrumPattern } from "./drumPatternUtil";
import type { Clip, Snapshot } from "../types";

vi.mock("../bridge", async () => {
  const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
  return { ...actual, onEvent: vi.fn(() => () => {}), pickFiles: vi.fn(), pickSaveFile: vi.fn() };
});

// kick on 1 and 3, snare on 2 — at 16 steps/bar, 120bpm 4/4 (stepBeats = 0.25).
const CLIP: Clip = {
  id: "c1", name: "beat", type: "drum", start: 0, length: 2, offset: 0, hasRenderLayer: false,
  notes: [
    { i: 0, pitch: 36, start: 0, length: 0.25, velocity: 100 },
    { i: 1, pitch: 38, start: 1, length: 0.25, velocity: 100 },
    { i: 2, pitch: 36, start: 2, length: 0.25, velocity: 100 },
  ],
} as unknown as Clip;

const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  session: {
    sampleRate: 48000, tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4,
    metronome: false, length: 16, editFile: "/tmp/d.mosh", key: { tonic: "A", mode: "minor" },
  },
  tracks: [{ id: "t1", index: 0, name: "Drums", type: "drum", volumeDb: 0, pan: 0, mute: false, solo: false, clips: [CLIP] }],
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
  master: { volumeDb: 0, pan: 0 },
} as unknown as Snapshot;

describe("DrumSequencer pattern field (DRM-002)", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;

  const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  const click = (id: string) => act(() => { q(id)!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  const type = (value: string) => {
    const el = q("dr-pattern-input") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
    act(() => { setter.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); });
  };

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    exec = vi.fn(async () => ({ ok: true }));
    useStore.setState({ snapshot: SNAPSHOT, exec });
    act(() => root.render(React.createElement(DrumSequencer, { clip: CLIP })));
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it("is closed until asked for (the grid stays the primary surface)", () => {
    expect(q("dr-pattern-panel")).toBeFalsy();
    expect(q("dr-pattern-toggle")).toBeTruthy();
  });

  it("seeds the field from the LIVE clip, not blank", () => {
    // A blank field would read as "type a pattern to REPLACE everything". Seeding it means
    // what you see is what's on the grid, so Apply is visibly an edit.
    click("dr-pattern-toggle");
    const el = q("dr-pattern-input") as HTMLTextAreaElement;
    expect(el.value).toContain("kick:");
    expect(el.value).toContain("snare:");
    const parsed = parseDrumPattern(el.value, 16);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.steps.length, "seeded text lost the clip's hits").toBe(3);
  });

  it("reports the parser's OWN error text and blocks Apply", () => {
    // The backend rejects with the identical string (twin parsers, mirrored goldens), so
    // a producer never gets two different explanations of the same mistake.
    click("dr-pattern-toggle");
    type("kick: x...; boguslane: x...");
    const status = q("dr-pattern-status")!;
    const expected = parseDrumPattern("kick: x...; boguslane: x...", 16);
    expect(expected.ok).toBe(false);
    if (!expected.ok) expect(status.textContent).toBe(expected.error);
    expect((q("dr-pattern-apply") as HTMLButtonElement).disabled).toBe(true);
  });

  it("does not dispatch anything while the pattern is invalid", () => {
    click("dr-pattern-toggle");
    type("kick: x...; boguslane: x...");
    click("dr-pattern-apply");
    expect(exec).not.toHaveBeenCalled();
  });

  it("Apply sends ONE add_drum_pattern carrying clipId (per-lane replace)", () => {
    // clipId is what makes this an edit: the backend clears only the lanes NAMED in the
    // text. Without it the command would create a new track instead.
    click("dr-pattern-toggle");
    type("hat: x.x.x.x.x.x.x.x.");
    click("dr-pattern-apply");
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith("add_drum_pattern", {
      clipId: "c1", pattern: "hat: x.x.x.x.x.x.x.x.", stepsPerBar: 16,
    });
  });

  it("never falls back to per-cell add_note (that is the whole point)", () => {
    click("dr-pattern-toggle");
    type("kick: x...x...x...x...");
    click("dr-pattern-apply");
    expect(exec.mock.calls.some((c) => c[0] === "add_note"), "laid the grid cell-by-cell").toBe(false);
  });

  it("a preset fills the field with something the parser accepts", () => {
    click("dr-pattern-toggle");
    click("dr-pattern-preset");
    const el = q("dr-pattern-input") as HTMLTextAreaElement;
    expect(parseDrumPattern(el.value, 16).ok, "a shipped preset does not parse").toBe(true);
  });

  it("closes after applying", async () => {
    click("dr-pattern-toggle");
    type("kick: x...x...x...x...");
    click("dr-pattern-apply");
    // applyPattern awaits exec before clearing the draft, so the close lands a microtask
    // later — the panel deliberately stays up until the command has actually gone out.
    await act(async () => { await Promise.resolve(); });
    expect(q("dr-pattern-panel")).toBeFalsy();
  });
});
