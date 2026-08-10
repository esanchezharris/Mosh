import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { defaultSettings, type SettingValue } from "../settings/schema";
import { buildFeel, buildKeymap, gestureTableName, effectiveInteractionSetting, liveKeymap, liveGestureTable } from "./config";
import { useSettings } from "../settings/store";
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
  it("uses the selected preset", () => {
    const km = buildKeymap(getterFrom({ keymap: "ableton" }));
    expect(resolveKey(km, { key: "e", metaKey: true })).toBe(A.SPLIT); // Ableton-only
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
});

// DAW shell interaction bundles are resolved only when the corresponding selector
// has no persisted override. An explicit user choice always wins.
describe("effectiveInteractionSetting — DAW shell defaults", () => {
  const backup = { ...useSettings.getState() };
  beforeEach(() => {
    useSettings.setState({ template: null, values: {}, keyOverrides: {} });
  });
  afterAll(() => {
    useSettings.setState(backup, true);
  });

  it("fresh Pro Tools shell + no overrides → the Pro Tools bundle", () => {
    expect(effectiveInteractionSetting("keymap")).toBe("protools");
    expect(effectiveInteractionSetting("gestureTable")).toBe("protools");
    // …and the resolution reaches the ACTIVE bundle, not just the getter
    expect(resolveKey(liveKeymap(), { key: " ", metaKey: true })).toBe(A.RECORD);
    expect(liveGestureTable().some((r) => r.region === "clip.header")).toBe(true);
  });

  it("live shell + explicit 'mosh' keymap → mosh wins (an explicit choice, even the default value)", () => {
    useSettings.setState({ values: { uiShell: "live", keymap: "mosh" } });
    expect(effectiveInteractionSetting("keymap")).toBe("mosh");
    expect(resolveKey(liveKeymap(), { key: "e", metaKey: true })).toBeNull();
    // gestureTable is independently unset → still ableton
    expect(effectiveInteractionSetting("gestureTable")).toBe("ableton");
  });

  it("live shell + a non-default explicit bundle → the user's bundle wins", () => {
    useSettings.setState({ values: { uiShell: "live", keymap: "fl", gestureTable: "fl" } });
    expect(effectiveInteractionSetting("keymap")).toBe("fl");
    expect(effectiveInteractionSetting("gestureTable")).toBe("fl");
  });

  it("other shells + unset → the schema default (mosh), unchanged", () => {
    useSettings.setState({ values: { uiShell: "v2" } });
    expect(effectiveInteractionSetting("keymap")).toBe("mosh");
    expect(effectiveInteractionSetting("gestureTable")).toBe("mosh");
    useSettings.setState({ values: { uiShell: "classic" } });
    expect(effectiveInteractionSetting("keymap")).toBe("mosh");
  });

  it("non-interaction ids pass straight through", () => {
    expect(effectiveInteractionSetting("feel.dragThreshold")).toBe(FEEL_DEFAULTS.dragThreshold);
    expect(effectiveInteractionSetting("uiShell")).toBe("protools"); // the schema default itself
  });

  it("Pro Tools shell + unset interaction selectors → Pro Tools bundle", () => {
    useSettings.setState({ values: { uiShell: "protools" } });

    expect(effectiveInteractionSetting("keymap")).toBe("protools");
    expect(effectiveInteractionSetting("gestureTable")).toBe("protools");
  });

  it("Pro Tools shell + explicit interaction selectors → the user's bundle wins", () => {
    useSettings.setState({
      values: { uiShell: "protools", keymap: "ableton", gestureTable: "fl" },
    });

    expect(effectiveInteractionSetting("keymap")).toBe("ableton");
    expect(effectiveInteractionSetting("gestureTable")).toBe("fl");
  });
});
