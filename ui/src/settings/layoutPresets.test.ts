import { describe, it, expect, vi } from "vitest";
import { LAYOUT_PRESETS, applyLayoutArrangement } from "./layoutPresets";
import type { Snapshot } from "../types";

const snap = (tracks: unknown[]): Snapshot => ({ tracks } as unknown as Snapshot);
const deps = (snapshot: Snapshot | null = null) => ({
  applyDock: vi.fn(),
  openDrumWindow: vi.fn(),
  closeDrumWindow: vi.fn(),
  snapshot,
});

describe("LAYOUT_PRESETS", () => {
  it("ships exactly the three v1 templates", () => {
    expect(Object.keys(LAYOUT_PRESETS).sort()).toEqual(["ableton", "fl", "mosh"]);
  });
  it("mosh tucks the browser; ableton/fl open it (the per-DAW IA difference)", () => {
    expect(LAYOUT_PRESETS.mosh.left).toEqual({ collapsed: true });
    expect(LAYOUT_PRESETS.ableton.left?.collapsed).toBe(false);
    expect(LAYOUT_PRESETS.fl.left?.collapsed).toBe(false);
  });
});

describe("applyLayoutArrangement", () => {
  it("ableton: opens the browser, closes any drum window", () => {
    const d = deps();
    applyLayoutArrangement("ableton", d);
    expect(d.applyDock).toHaveBeenCalledWith({ left: { collapsed: false, size: 260 } });
    expect(d.closeDrumWindow).toHaveBeenCalled();
    expect(d.openDrumWindow).not.toHaveBeenCalled();
  });

  it("mosh: collapses the browser, closes any drum window", () => {
    const d = deps();
    applyLayoutArrangement("mosh", d);
    expect(d.applyDock).toHaveBeenCalledWith({ left: { collapsed: true } });
    expect(d.closeDrumWindow).toHaveBeenCalled();
  });

  it("fl: opens the floating window for the first drum track's MIDI clip", () => {
    const d = deps(snap([{ type: "audio", clips: [] }, { type: "drum", clips: [{ id: "m1", type: "midi" }] }]));
    applyLayoutArrangement("fl", d);
    expect(d.openDrumWindow).toHaveBeenCalledWith("m1");
    expect(d.closeDrumWindow).not.toHaveBeenCalled();
  });

  it("fl: with no drum clip, opens nothing (no float over a non-drum project)", () => {
    const d = deps(snap([{ type: "audio", clips: [{ id: "w1", type: "wave" }] }]));
    applyLayoutArrangement("fl", d);
    expect(d.openDrumWindow).not.toHaveBeenCalled();
  });

  it("an unknown layout falls back to mosh (minimal)", () => {
    const d = deps();
    applyLayoutArrangement("protools", d);
    expect(d.applyDock).toHaveBeenCalledWith({ left: { collapsed: true } });
    expect(d.closeDrumWindow).toHaveBeenCalled();
  });
});
