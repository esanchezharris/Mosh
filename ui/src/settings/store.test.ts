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
    savePersisted(localStorage, { template: "fl", values: { theme: "light" }, keyOverrides: {} });
    expect(loadPersisted(localStorage)).toEqual({
      template: "fl",
      values: { theme: "light" },
      keyOverrides: {},
    });
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

describe("reset", () => {
  it("clears overrides AND persists the cleared state (survives reload)", () => {
    useSettings.getState().applyTemplate("ableton");
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
  it("applies skin/theme to the root data-attributes and scale to zoom", () => {
    // The skin axis only applies in the classic shell — the v2 shell (now the default)
    // pins data-skin=mosh (effects.ts). Opt into classic to exercise the skin effect.
    useSettings.getState().set("uiShell", "classic");
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
    localStorage.clear(); // establish the precondition: NO unified settings persisted
    localStorage.setItem("mosh.voiceOn", "0");
    useSettings.getState().hydrate();
    expect(useSettings.getState().get("voiceOn")).toBe(false);
  });
});
