import { describe, it, expect, beforeEach } from "vitest";
import { useSettings, loadPersisted, savePersisted, STORAGE_KEY } from "./store";
import { defaultSettings } from "./schema";

// The settings store is the canonical, schema-driven, localStorage-backed home for
// every UI-local setting. These tests pin the three behaviours the goal calls out:
// schema→defaults, a localStorage persistence round-trip, and template application
// with a per-setting override layered on top (template + diffs). Plus the DOM-effect
// contract (skin/theme/scale apply to <html>) and corrupted-storage resilience.

beforeEach(() => {
  localStorage.clear();
  useSettings.getState().reset();
});

describe("defaults from schema", () => {
  it("returns each setting's schema default when nothing is persisted", () => {
    const s = useSettings.getState();
    const defs = defaultSettings();
    for (const id of Object.keys(defs)) expect(s.get(id)).toEqual(defs[id]);
    expect(s.get("skin")).toBe("mosh");
    expect(s.get("theme")).toBe("dark");
    expect(s.get("uiScale")).toBe(1);
    expect(s.get("voiceOn")).toBe(true);
  });
});

describe("set + localStorage persistence round-trip", () => {
  it("persists an override and reads it back after a fresh hydrate", () => {
    useSettings.getState().set("theme", "light");
    useSettings.getState().set("uiScale", 1.2);

    // Simulate a reload: blow away in-memory state, re-hydrate from localStorage.
    useSettings.setState({ template: null, values: {} });
    useSettings.getState().hydrate();

    expect(useSettings.getState().get("theme")).toBe("light");
    expect(useSettings.getState().get("uiScale")).toBe(1.2);
    // untouched settings stay at their defaults
    expect(useSettings.getState().get("skin")).toBe("mosh");
  });

  it("coerces on the way in so an out-of-range value never persists raw", () => {
    useSettings.getState().set("uiScale", 99);
    expect(useSettings.getState().get("uiScale")).toBe(1.4);
    const { values } = loadPersisted(localStorage);
    expect(values.uiScale).toBe(1.4);
  });

  it("savePersisted/loadPersisted are an exact round-trip", () => {
    savePersisted(localStorage, { template: "fl", values: { theme: "light" } });
    expect(loadPersisted(localStorage)).toEqual({ template: "fl", values: { theme: "light" } });
  });
});

describe("template application + per-setting override", () => {
  it("applyTemplate sets all of the template's values", () => {
    useSettings.getState().applyTemplate("ableton");
    const s = useSettings.getState();
    expect(s.template).toBe("ableton");
    expect(s.get("skin")).toBe("ableton");
    expect(s.get("theme")).toBe("light");
  });

  it("a per-setting override layers on top of the template (template + diffs)", () => {
    useSettings.getState().applyTemplate("ableton"); // skin=ableton, theme=light
    useSettings.getState().set("theme", "dark"); // override just the theme

    const s = useSettings.getState();
    expect(s.get("theme")).toBe("dark"); // the diff wins
    expect(s.get("skin")).toBe("ableton"); // rest of the template stays
    expect(s.template).toBe("ableton"); // still based on the template

    // and the diff survives a reload
    useSettings.setState({ template: null, values: {} });
    useSettings.getState().hydrate();
    expect(useSettings.getState().get("theme")).toBe("dark");
    expect(useSettings.getState().get("skin")).toBe("ableton");
  });
});

describe("DOM effects", () => {
  it("applies skin/theme to the root data-attributes and scale to zoom", () => {
    useSettings.getState().applyTemplate("fl");
    const root = document.documentElement;
    expect(root.getAttribute("data-skin")).toBe("fl");
    expect(root.getAttribute("data-theme")).toBe("dark");

    useSettings.getState().set("skin", "ableton");
    expect(root.getAttribute("data-skin")).toBe("ableton");

    useSettings.getState().set("uiScale", 1.3);
    expect((root.style as CSSStyleDeclaration & { zoom?: string }).zoom).toBe("1.3");
  });
});

describe("resilience", () => {
  it("falls back to defaults when localStorage holds garbage", () => {
    localStorage.setItem(STORAGE_KEY, "{not json");
    useSettings.getState().hydrate();
    expect(useSettings.getState().get("theme")).toBe("dark");
  });

  it("drops unknown ids and out-of-range values found in storage", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 1, values: { bogus: 7, uiScale: 99 } }),
    );
    useSettings.getState().hydrate();
    expect(useSettings.getState().get("uiScale")).toBe(1.4);
    expect(useSettings.getState().values.bogus).toBeUndefined();
  });

  it("migrates the legacy mosh.voiceOn key when no unified settings exist", () => {
    localStorage.setItem("mosh.voiceOn", "0");
    useSettings.getState().hydrate();
    expect(useSettings.getState().get("voiceOn")).toBe(false);
  });
});
