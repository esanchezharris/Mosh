import { describe, it, expect, beforeEach } from "vitest";
import { useSettings, loadPersisted, savePersisted, STORAGE_KEY } from "./store";
import { defaultSettings } from "./schema";

// The settings store is the canonical, schema-driven, localStorage-backed home for
// every UI-local setting. These tests pin the three behaviours the goal calls out:
// schema→defaults and a localStorage persistence round-trip. Plus the DOM-effect
// contract (theme/scale apply to <html>, data-skin is pinned) and corrupted-storage
// resilience.

beforeEach(() => {
  localStorage.clear();
  useSettings.getState().reset();
});

describe("defaults from schema", () => {
  it("returns each setting's schema default when nothing is persisted", () => {
    const s = useSettings.getState();
    const defs = defaultSettings();
    for (const id of Object.keys(defs)) expect(s.get(id)).toEqual(defs[id]);
    expect(s.get("theme")).toBe("light"); // v2 default: warm cream + dark panels
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
    expect(useSettings.getState().get("voiceOn")).toBe(true);
  });

  it("coerces on the way in so an out-of-range value never persists raw", () => {
    useSettings.getState().set("uiScale", 99);
    expect(useSettings.getState().get("uiScale")).toBe(1.4);
    const { values } = loadPersisted(localStorage);
    expect(values.uiScale).toBe(1.4);
  });

  it("savePersisted/loadPersisted are an exact round-trip", () => {
    savePersisted(localStorage, { template: "fl", values: { theme: "light" }, keyOverrides: {} });
    expect(loadPersisted(localStorage)).toEqual({
      template: "fl",
      values: { theme: "light" },
      keyOverrides: {},
    });
  });

  it("drops a stored old-shell choice on load, so an install on Pro Tools/Live/v2/classic opens V3", () => {
    // Shell retirement (docs/SHELL-RETIREMENT-PLAN-2026-11-17.md §6.4): the move is silent.
    for (const old of ["protools", "live", "v2", "classic"]) {
      savePersisted(localStorage, {
        template: "protools",
        values: { uiShell: old, redesignShell: false, skin: "protools", liveDockHeight: 300, theme: "dark" },
        keyOverrides: {},
      });
      const { values } = loadPersisted(localStorage);
      expect(values, old).toEqual({ theme: "dark" });   // the other preferences survive
      useSettings.setState({ template: null, values: {} });
      useSettings.getState().hydrate();
      expect(useSettings.getState().get("uiShell"), old).toBeUndefined();
      expect(document.documentElement.getAttribute("data-skin"), old).toBe("mosh");
    }
  });

});

describe("reset", () => {
  it("clears overrides AND persists the cleared state (survives reload)", () => {
    useSettings.getState().set("uiScale", 1.3);
    useSettings.getState().reset();

    expect(useSettings.getState().get("uiScale")).toBe(1); // back to default
    expect(useSettings.getState().template).toBeNull();
    // and a reload must NOT resurrect the old overrides
    useSettings.setState({ template: "zzz", values: { uiScale: 1.3 } });
    useSettings.getState().hydrate();
    expect(useSettings.getState().get("uiScale")).toBe(1);
    expect(useSettings.getState().template).toBeNull();
  });
});

describe("per-template (per-keymap) rebind persistence (AL-002)", () => {
  it("scopes a key.* rebind to the active keymap — it doesn't bleed into another", () => {
    // On the Ableton keymap, rebind Undo.
    useSettings.getState().set("keymap", "ableton");
    useSettings.getState().set("key.undo", "Mod+P");
    expect(useSettings.getState().get("key.undo")).toBe("Mod+P");

    // Switch to the Mosh keymap — the Ableton rebind must NOT carry over.
    useSettings.getState().set("keymap", "mosh");
    expect(useSettings.getState().get("key.undo")).toBe("");

    // Switch back to Ableton — its own rebind returns.
    useSettings.getState().set("keymap", "ableton");
    expect(useSettings.getState().get("key.undo")).toBe("Mod+P");
  });

  it("round-trips per-keymap rebinds across a reload", () => {
    useSettings.getState().set("keymap", "ableton");
    useSettings.getState().set("key.undo", "Mod+P");
    useSettings.getState().set("keymap", "fl");
    useSettings.getState().set("key.undo", "Mod+J");

    // Simulate a reload: blow away in-memory state, re-hydrate from localStorage.
    useSettings.setState({ template: null, values: {}, keyOverrides: {} });
    useSettings.getState().hydrate();

    useSettings.getState().set("keymap", "ableton");
    expect(useSettings.getState().get("key.undo")).toBe("Mod+P");
    useSettings.getState().set("keymap", "fl");
    expect(useSettings.getState().get("key.undo")).toBe("Mod+J");
    // a keymap that was never rebound still inherits the preset
    useSettings.getState().set("keymap", "mosh");
    expect(useSettings.getState().get("key.undo")).toBe("");
  });

  it("clearing a rebind to '' removes the per-keymap entry (back to inherit)", () => {
    useSettings.getState().set("keymap", "ableton");
    useSettings.getState().set("key.undo", "Mod+P");
    useSettings.getState().set("key.undo", ""); // the SettingsPanel right-click clear

    expect(useSettings.getState().get("key.undo")).toBe("");
    // and the entry is gone from the persisted per-keymap map (no empty-string shadow)
    const { keyOverrides } = loadPersisted(localStorage);
    expect(keyOverrides.ableton?.["key.undo"]).toBeUndefined();
  });

  it("reset clears per-keymap rebinds and they don't survive reload", () => {
    useSettings.getState().set("keymap", "ableton");
    useSettings.getState().set("key.undo", "Mod+P");
    useSettings.getState().reset();

    expect(useSettings.getState().get("key.undo")).toBe("");
    useSettings.getState().hydrate();
    useSettings.getState().set("keymap", "ableton");
    expect(useSettings.getState().get("key.undo")).toBe("");
  });

  it("savePersisted/loadPersisted round-trip keyOverrides exactly", () => {
    savePersisted(localStorage, {
      template: "ableton",
      values: { keymap: "ableton" },
      keyOverrides: { ableton: { "key.undo": "Mod+P" } },
    });
    expect(loadPersisted(localStorage)).toEqual({
      template: "ableton",
      values: { keymap: "ableton" },
      keyOverrides: { ableton: { "key.undo": "Mod+P" } },
    });
  });

  it("falls back to a legacy global key.* override (v1 blobs had no keyOverrides)", () => {
    // A v1-shaped blob: a global key override lives in `values`, no keyOverrides field.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 1, template: null, values: { "key.undo": "Mod+P" } }),
    );
    useSettings.getState().hydrate();
    // still resolves via the global fallback so no rebind is silently lost
    expect(useSettings.getState().get("key.undo")).toBe("Mod+P");
  });
});

describe("DOM effects", () => {
  it("pins data-skin, applies theme to the root data-attributes and scale to zoom", () => {
    useSettings.getState().set("theme", "dark");
    const root = document.documentElement;
    expect(root.getAttribute("data-skin")).toBe("mosh");
    expect(root.getAttribute("data-theme")).toBe("dark");

    useSettings.getState().set("uiScale", 1.3);
    expect((root.style as CSSStyleDeclaration & { zoom?: string }).zoom).toBe("1.3");
  });
});

describe("resilience", () => {
  it("falls back to defaults when localStorage holds garbage", () => {
    localStorage.setItem(STORAGE_KEY, "{not json");
    useSettings.getState().hydrate();
    expect(useSettings.getState().get("theme")).toBe("light");
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
    localStorage.clear(); // establish the precondition: NO unified settings persisted
    localStorage.setItem("mosh.voiceOn", "0");
    useSettings.getState().hydrate();
    expect(useSettings.getState().get("voiceOn")).toBe(false);
  });
});
