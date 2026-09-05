// Unit pins for settings/shellVisibility.ts — the per-shell hiding rules.

import { describe, expect, it } from "vitest";
import { settingHiddenForShell } from "./shellVisibility";

describe("settingHiddenForShell", () => {
  it("classic hides nothing", () => {
    expect(settingHiddenForShell("classic", "Interaction", "keymap")).toBe(false);
    expect(settingHiddenForShell("classic", "Appearance", "skin")).toBe(false);
  });

  it("v2 hides the whole inert axes plus the skin", () => {
    for (const cat of ["Layout", "Interaction", "Feel", "Keys"])
      expect(settingHiddenForShell("v2", cat, "anything")).toBe(true);
    expect(settingHiddenForShell("v2", "Appearance", "skin")).toBe(true);
    expect(settingHiddenForShell("v2", "Plugins", "scanAU")).toBe(false);
  });

  it("live hides ONLY the classic visual skin — audio/keys/feel/layout stay reachable", () => {
    expect(settingHiddenForShell("live", "Appearance", "skin")).toBe(true);
    for (const [cat, id] of [["Keys", "key.crop_clip"], ["Feel", "feel"],
                             ["Layout", "liveDockHeight"], ["Interaction", "keymap"],
                             ["Plugins", "scanAU"], ["Privacy", "telemetryOptIn"]] as const)
      expect(settingHiddenForShell("live", cat, id)).toBe(false);
  });

  it("v3 hides skin, classic redesign, PT fades, and Live dock prefs", () => {
    expect(settingHiddenForShell("v3", "Appearance", "skin")).toBe(true);
    expect(settingHiddenForShell("v3", "Layout", "redesignShell")).toBe(true);
    expect(settingHiddenForShell("v3", "Pro Tools", "protoolsDefaultFadeLengthMs")).toBe(true);
    expect(settingHiddenForShell("v3", "Layout", "liveDockHeight")).toBe(true);
    expect(settingHiddenForShell("v3", "Layout", "uiShell")).toBe(false);
    expect(settingHiddenForShell("v3", "Appearance", "colorway")).toBe(false);
    expect(settingHiddenForShell("v3", "Moshi", "agentConfirmDestructive")).toBe(false);
  });
});
