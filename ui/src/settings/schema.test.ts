import { describe, it, expect } from "vitest";
import { SETTINGS, defaultSettings, coerceSetting, settingsByCategory } from "./schema";

// The schema is the single source of truth for app settings. These tests pin the
// authoring invariants (every descriptor well-formed, defaults valid against their
// own constraints) plus the coercion contract the store relies on to sanitise both
// user input and anything read back from localStorage.

describe("settings schema", () => {
  it("every descriptor is well-formed", () => {
    expect(SETTINGS.length).toBeGreaterThan(0);
    for (const d of SETTINGS) {
      expect(d.id).toBeTruthy();
      expect(d.type).toBeTruthy();
      expect(d.scope).toBeTruthy();
      expect(d.category).toBeTruthy();
      expect(d.label).toBeTruthy();
      expect(d.default).not.toBeUndefined();
    }
  });

  it("has no duplicate ids", () => {
    const ids = SETTINGS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every enum descriptor carries non-empty options and a default in-set", () => {
    for (const d of SETTINGS.filter((s) => s.type === "enum")) {
      const opts = d.constraints?.options ?? [];
      expect(opts.length).toBeGreaterThan(0);
      expect(opts.some((o) => o.value === d.default)).toBe(true);
    }
  });

  it("every default is already valid against its own constraints", () => {
    for (const d of SETTINGS) {
      expect(coerceSetting(d.id, d.default)).toEqual(d.default);
    }
  });
});

describe("defaultSettings", () => {
  it("returns the schema default for every id", () => {
    const defs = defaultSettings();
    expect(Object.keys(defs).sort()).toEqual(SETTINGS.map((d) => d.id).sort());
    for (const d of SETTINGS) expect(defs[d.id]).toEqual(d.default);
  });

  it("uses Pro Tools for fresh settings", () => {
    expect(defaultSettings().uiShell).toBe("protools");
  });

  it("defines the Pro Tools no-dialog fade defaults", () => {
    const defaults = defaultSettings();
    expect(defaults.protoolsDefaultFadeLengthMs).toBe(10);
    expect(defaults.protoolsDefaultFadeCurveIn).toBe("linear");
    expect(defaults.protoolsDefaultFadeCurveOut).toBe("linear");
  });
});

describe("settingsByCategory", () => {
  it("groups settings, categories in first-appearance order", () => {
    const groups = settingsByCategory();
    // AUD-SCAN — "Plugins" is last by design: it is maintenance (opt-in AU scanning),
    // not a preference, so it sits at the bottom of the settings panel.
    expect(groups.map((g) => g.category)).toEqual([
      "Appearance", "Moshi", "Layout", "Pro Tools", "Privacy", "Interaction", "Feel", "Keys", "Plugins",
    ]);
  });

  it("keeps settings within a group in schema order", () => {
    const groups = settingsByCategory();
    const appearance = groups.find((g) => g.category === "Appearance");
    if (!appearance) throw new Error("Appearance settings group is missing");
    expect(appearance.settings.map((s) => s.id)).toEqual(["skin", "theme", "uiScale", "colorway"]);
    const moshi = groups.find((g) => g.category === "Moshi");
    if (!moshi) throw new Error("Moshi settings group is missing");
    expect(moshi.settings.map((s) => s.id)).toEqual(["voiceOn", "voiceVol", "agentMemory", "agentConfirmDestructive", "produceLane"]);
  });

  it("covers every setting exactly once", () => {
    const count = settingsByCategory().reduce((n, g) => n + g.settings.length, 0);
    expect(count).toBe(SETTINGS.length);
  });
});

describe("coerceSetting", () => {
  it("clamps a number to its constraint range", () => {
    expect(coerceSetting("uiScale", 5)).toBe(1.4);
    expect(coerceSetting("uiScale", 0.1)).toBe(0.8);
  });

  it("snaps a number to its step", () => {
    // uiScale step 0.1 around the 0.8..1.4 range
    expect(coerceSetting("uiScale", 1.04)).toBeCloseTo(1.0, 5);
    expect(coerceSetting("uiScale", 1.16)).toBeCloseTo(1.2, 5);
  });

  it("falls back to the default for a non-finite number", () => {
    expect(coerceSetting("uiScale", Number.NaN)).toBe(1);
    expect(coerceSetting("uiScale", Number.POSITIVE_INFINITY)).toBe(1);
  });

  it("rejects an out-of-set enum value, returning the default", () => {
    expect(coerceSetting("theme", "chartreuse")).toBe("light");
    expect(coerceSetting("skin", "cubase")).toBe("mosh");
  });

  it("passes a valid enum value through unchanged", () => {
    expect(coerceSetting("theme", "light")).toBe("light");
    expect(coerceSetting("skin", "ableton")).toBe("ableton");
  });

  it("accepts the Pro Tools / Logic enum values across the DAW selectors", () => {
    for (const id of ["skin", "layout", "gestureTable", "keymap"]) {
      expect(coerceSetting(id, "protools")).toBe("protools");
      expect(coerceSetting(id, "logic")).toBe("logic");
    }
  });

  it("coerces a boolean, falling back to default on garbage", () => {
    expect(coerceSetting("voiceOn", false)).toBe(false);
    expect(coerceSetting("voiceOn", true)).toBe(true);
    // a non-boolean from corrupted storage falls back to the default
    expect(coerceSetting("voiceOn", "yes")).toBe(true);
  });

  it("returns the default for an unknown id", () => {
    expect(coerceSetting("does-not-exist", 42)).toBe(42);
  });

  it("bounds and validates remembered Pro Tools fade settings", () => {
    expect(coerceSetting("protoolsDefaultFadeLengthMs", -1)).toBe(0);
    expect(coerceSetting("protoolsDefaultFadeLengthMs", 60_001)).toBe(60_000);
    expect(coerceSetting("protoolsDefaultFadeCurveIn", "sCurve")).toBe("sCurve");
    expect(coerceSetting("protoolsDefaultFadeCurveOut", "not-a-curve")).toBe("linear");
  });
});
