// Unit pins for settings/shellVisibility.ts.

import { describe, expect, it } from "vitest";
import { settingHidden } from "./shellVisibility";

describe("settingHidden", () => {
  it("hides only the settings that have their own control elsewhere", () => {
    expect(settingHidden("Layout", "startOnLaunch")).toBe(true);
    expect(settingHidden("Appearance", "colorway")).toBe(false);
    expect(settingHidden("Moshi", "agentConfirmDestructive")).toBe(false);
    expect(settingHidden("Interaction", "keymap")).toBe(false);
  });
});
