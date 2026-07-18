import { describe, it, expect } from "vitest";
import { defaultSettings, type SettingValue } from "../settings/schema";
import { buildFeel, buildKeymap, gestureTableName } from "./config";
import { resolveKey } from "./keymap";
import { FEEL_DEFAULTS } from "./feel";
import { EditorAction as A } from "./actions";

// The glue between the settings store and the interaction layer. Pure builders take a
// getter (override ?? schema-default) and assemble the active feel / keymap / table.
const getterFrom = (over: Record<string, SettingValue> = {}) => {
  const defs = defaultSettings();
  return (id: string): SettingValue => (id in over ? over[id] : defs[id]);
};

describe("buildFeel", () => {
  it("returns the schema (Mosh) defaults when nothing is overridden", () => {
    expect(buildFeel(getterFrom())).toEqual(FEEL_DEFAULTS);
  });
  it("reflects feel overrides", () => {
    const f = buildFeel(getterFrom({ "feel.edgeGrabPx": 12, "feel.dragThreshold": 8 }));
    expect(f.edgeGrabPx).toBe(12);
    expect(f.dragThreshold).toBe(8);
    expect(f.snapStrength).toBe(FEEL_DEFAULTS.snapStrength); // untouched stays default
  });
});

describe("gestureTableName", () => {
  it("reads the selector; default is mosh", () => {
    expect(gestureTableName(getterFrom())).toBe("mosh");
    expect(gestureTableName(getterFrom({ gestureTable: "ableton" }))).toBe("ableton");
  });
});

describe("buildKeymap", () => {
  it("keeps Classic on the selected legacy keymap axis", () => {
    const km = buildKeymap(getterFrom({ uiShell: "classic", keymap: "ableton", workflowProfile: "fl" }));
    expect(resolveKey(km, { key: "e", metaKey: true })).toBe(A.SPLIT); // Ableton-only
  });

  it("uses the authoritative workflow profile keymap in v2", () => {
    const fl = buildKeymap(getterFrom({ uiShell: "v2", workflowProfile: "fl", keymap: "ableton" }));
    expect(resolveKey(fl, { key: "r", metaKey: true })).toBe(A.EXPORT_AUDIO);
    expect(resolveKey(fl, { key: "e", metaKey: true })).toBeNull();
  });

  it("a non-empty key.* override rebinds; empty inherits the preset", () => {
    const km = buildKeymap(getterFrom({ "key.play_pause": "Mod+P" }));
    expect(resolveKey(km, { key: "p", metaKey: true })).toBe(A.PLAY_PAUSE); // rebound
    expect(resolveKey(km, { key: " " })).toBeNull(); // old Space binding replaced
    expect(resolveKey(km, { key: "z", metaKey: true })).toBe(A.UNDO); // inherited
  });

  it("ignores a whitespace-only override", () => {
    const km = buildKeymap(getterFrom({ "key.play_pause": "   " }));
    expect(resolveKey(km, { key: " " })).toBe(A.PLAY_PAUSE); // still the preset Space
  });

  it("applies the active profile's persisted override over its scoped preset", () => {
    const km = buildKeymap(getterFrom({ workflowProfile: "fl", "key.export_audio": "Mod+P" }));
    expect(resolveKey(km, { key: "p", metaKey: true })).toBe(A.EXPORT_AUDIO);
    expect(resolveKey(km, { key: "r", metaKey: true })).toBeNull();
  });

  it.each(["key.split", "key.export_audio"])("keeps FL Mod+E reserved over the persisted %s override", (id) => {
    const stored: Record<string, SettingValue> = {
      uiShell: "v2",
      workflowProfile: "fl",
      [id]: "Mod+E",
    };
    const km = buildKeymap(getterFrom(stored));
    expect(resolveKey(km, { key: "e", metaKey: true }, "arrangement")).toBeNull();
    expect(resolveKey(km, { key: "e", metaKey: true }, "modal")).toBeNull();
    expect(stored[id]).toBe("Mod+E");
  });

  it("does not apply the FL reservation to Classic persisted bindings", () => {
    const km = buildKeymap(getterFrom({
      uiShell: "classic",
      keymap: "mosh",
      workflowProfile: "fl",
      "key.export_audio": "Mod+E",
    }));
    expect(resolveKey(km, { key: "e", metaKey: true }, "modal")).toBe(A.EXPORT_AUDIO);
  });
});
