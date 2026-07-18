import { describe, it, expect } from "vitest";
import { defaultSettings, type SettingValue } from "../settings/schema";
import { applyReservedKeyCombos, buildFeel, buildKeymap, gestureTableName } from "./config";
import { getKeymap, resolveKey } from "./keymap";
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
  it("consumes arbitrary reserved combo metadata", () => {
    const reserved = applyReservedKeyCombos(getKeymap("mosh"), ["Space", "Mod+O"]);
    expect(resolveKey(reserved, { key: " " })).toBeNull();
    expect(resolveKey(reserved, { key: "o", metaKey: true })).toBeNull();
    expect(resolveKey(reserved, { key: "z", metaKey: true })).toBe(A.UNDO);
  });

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

  it.each([
    ["key.split", A.SPLIT],
    ["key.export_audio", A.EXPORT_AUDIO],
  ])("reserves FL Mod+E in v2 but keeps the persisted %s binding available in Classic", (id, classicAction) => {
    const stored: Record<string, SettingValue> = {
      uiShell: "v2",
      workflowProfile: "fl",
      [id]: "Mod+E",
    };
    const km = buildKeymap(getterFrom(stored));
    expect(resolveKey(km, { key: "e", metaKey: true }, "arrangement")).toBeNull();
    expect(resolveKey(km, { key: "e", metaKey: true }, "modal")).toBeNull();
    stored.uiShell = "classic";
    stored.keymap = "fl";
    const classic = buildKeymap(getterFrom(stored));
    expect(resolveKey(classic, { key: "e", metaKey: true }, "modal")).toBe(classicAction);
  });
});
