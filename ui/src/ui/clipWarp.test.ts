// Unit tests for the audio-warp / time-stretch UI helper (G9). The pure core that
// builds the set_clip_warp command args + maps snapshot stretchMode → label, so the
// React menu stays a thin caller. Backend (set_clip_warp, snapshot autoTempo/stretchMode)
// already exists — this is the UI-side logic only.
import { describe, it, expect } from "vitest";
import {
  WARP_MODES,
  DEFAULT_WARP_MODE,
  clipIsWarpable,
  warpToggleArgs,
  warpModeArgs,
  warpModeLabel,
} from "./clipWarp";
import type { Clip } from "../types";

const wave = (over: Partial<Clip> = {}): Clip => ({
  id: "c1", name: "chords", type: "wave", start: 0, length: 4, offset: 0, hasRenderLayer: false, ...over,
});
const midi = (over: Partial<Clip> = {}): Clip => ({
  id: "m1", name: "loop", type: "midi", start: 0, length: 4, offset: 0, hasRenderLayer: false, ...over,
});

describe("WARP_MODES", () => {
  it("offers at least an engine-default and the vendored soundtouch mode", () => {
    expect(WARP_MODES.length).toBeGreaterThanOrEqual(2);
    // each entry is { id, label } with a non-empty human label
    for (const m of WARP_MODES) {
      expect(typeof m.id).toBe("string");
      expect(m.label.length).toBeGreaterThan(0);
    }
    const ids = WARP_MODES.map((m) => m.id);
    expect(ids).toContain(DEFAULT_WARP_MODE); // "" — engine default
    expect(ids.some((id) => id.toLowerCase().includes("soundtouch"))).toBe(true);
  });

  it("has unique mode ids", () => {
    const ids = WARP_MODES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("clipIsWarpable", () => {
  it("is true only for wave clips", () => {
    expect(clipIsWarpable(wave())).toBe(true);
    expect(clipIsWarpable(midi())).toBe(false);
    expect(clipIsWarpable({ ...wave(), type: "clip" } as Clip)).toBe(false);
  });
});

describe("warpToggleArgs", () => {
  it("turns warp ON (with default mode) when the clip is currently off", () => {
    const args = warpToggleArgs(wave({ autoTempo: false }));
    expect(args.clipId).toBe("c1");
    expect(args.autoTempo).toBe(true);
    // enabling carries a mode key (default = engine default, "")
    expect(args.mode).toBe(DEFAULT_WARP_MODE);
  });

  it("treats a clip with no autoTempo field as OFF → enables", () => {
    const args = warpToggleArgs(wave());
    expect(args.autoTempo).toBe(true);
  });

  it("turns warp OFF when the clip is currently on, and omits mode", () => {
    const args = warpToggleArgs(wave({ autoTempo: true, stretchMode: "soundtouch" }));
    expect(args.autoTempo).toBe(false);
    expect("mode" in args).toBe(false); // disabling needs no stretch mode
  });

  it("enabling with an explicit mode forwards that mode", () => {
    const args = warpToggleArgs(wave({ autoTempo: false }), "soundtouch");
    expect(args.autoTempo).toBe(true);
    expect(args.mode).toBe("soundtouch");
  });
});

describe("warpModeArgs", () => {
  it("sets warp ON with the given mode (used by the mode <select>)", () => {
    const args = warpModeArgs(wave({ autoTempo: true }), "soundtouch");
    expect(args).toEqual({ clipId: "c1", autoTempo: true, mode: "soundtouch" });
  });
});

describe("warpModeArgs id", () => {
  it("uses the clip's own id", () => {
    const args = warpModeArgs(wave({ id: "abc", autoTempo: true }), "");
    expect(args.clipId).toBe("abc");
    expect(args.autoTempo).toBe(true);
    expect(args.mode).toBe("");
  });
});

describe("warpModeLabel", () => {
  it("maps a known stretchMode string to its UI label", () => {
    const st = WARP_MODES.find((m) => m.id.toLowerCase().includes("soundtouch"))!;
    expect(warpModeLabel(st.id)).toBe(st.label);
  });

  it("falls back to the engine-default label for an empty/unknown mode", () => {
    const def = WARP_MODES.find((m) => m.id === DEFAULT_WARP_MODE)!;
    expect(warpModeLabel(undefined)).toBe(def.label);
    expect(warpModeLabel("")).toBe(def.label);
    // an unknown engine mode name still resolves to *something* (the raw name), never throws
    expect(typeof warpModeLabel("elastiquePro")).toBe("string");
  });
});
