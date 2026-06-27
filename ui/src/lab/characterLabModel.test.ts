import { describe, it, expect, vi } from "vitest";
import {
  FAMILY_NAMES_FALLBACK,
  familyNameAt,
  applyDrive,
  applyMorph,
  applySeed,
  DRIVE_SLIDERS,
  TOGGLES,
  type MoshiApiLike,
} from "./characterLabModel";

// A spy api standing in for moshi.js — the lab only ever touches these five methods,
// so the descriptors' wiring is fully exercisable with no WebGL context.
function mockApi() {
  return {
    set: vi.fn(),
    setPersonality: vi.fn(),
    setStyle: vi.fn(),
    setQuality: vi.fn(),
    setAnatomy: vi.fn(),
  } satisfies MoshiApiLike;
}

describe("familyNameAt — mirrors moshi.js float→family mapping", () => {
  const N = FAMILY_NAMES_FALLBACK; // 9 families in canonical order

  it("maps the dial to the right family at hand-computed points", () => {
    expect(familyNameAt(0, N)).toBe("TAR");        // 0   → idx 0
    expect(familyNameAt(0.11, N)).toBe("TAR");     // .99 → idx 0
    expect(familyNameAt(0.12, N)).toBe("DISCO");   // 1.08→ idx 1
    expect(familyNameAt(0.5, N)).toBe("SILK");     // 4.5 → idx 4
    expect(familyNameAt(0.95, N)).toBe("PORCELAIN"); // 8.55 → idx 8
  });

  it("wraps at and past the ends exactly like the component", () => {
    expect(familyNameAt(1, N)).toBe("TAR");        // 1 wraps to 0
    expect(familyNameAt(-0.05, N)).toBe("PORCELAIN"); // negative wraps up
    expect(familyNameAt(2.5, N)).toBe("SILK");     // multiples wrap
  });

  it("never returns undefined for any in-range dial", () => {
    for (let v = 0; v < 1; v += 0.013) expect(N).toContain(familyNameAt(v, N));
  });
});

describe("control descriptors call the right API", () => {
  it("each drive slider sets its own scalar", () => {
    const api = mockApi();
    for (const s of DRIVE_SLIDERS) {
      applyDrive(api, s.key, 0.42);
      expect(api.set).toHaveBeenCalledWith(s.key, 0.42);
    }
    expect(api.set).toHaveBeenCalledTimes(DRIVE_SLIDERS.length);
  });

  it("MORPH drives setPersonality with the raw dial (crossfade, no snap)", () => {
    const api = mockApi();
    applyMorph(api, 0.37);
    expect(api.setPersonality).toHaveBeenCalledWith(0.37);
  });

  it("SEED re-resolves within the family the MORPH dial selects", () => {
    const api = mockApi();
    applySeed(api, 0.5, 0.8); // dial 0.5 → SILK
    expect(api.setPersonality).toHaveBeenCalledWith("SILK", 0.8);
  });

  it("each toggle calls its dedicated setter with the chosen option", () => {
    const api = mockApi();
    const byKey = Object.fromEntries(TOGGLES.map((t) => [t.key, t]));
    byKey.style.apply(api, "baked");
    byKey.quality.apply(api, "ps1");
    byKey.anatomy.apply(api, "C");
    expect(api.setStyle).toHaveBeenCalledWith("baked");
    expect(api.setQuality).toHaveBeenCalledWith("ps1");
    expect(api.setAnatomy).toHaveBeenCalledWith("C");
  });

  it("exposes non-empty option lists for every toggle", () => {
    for (const t of TOGGLES) expect(t.options().length).toBeGreaterThan(0);
  });
});
