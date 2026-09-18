import { afterEach, describe, expect, it } from "vitest";
import { useSettings } from "../settings/store";
import { activeShell, isModernShell, isV2Active } from "./shellFlag";

// isModernShell = v2 | v3 (own composer dock, data-skin=mosh). isV2Active stays v2-only.
describe("isModernShell", () => {
  afterEach(() => useSettings.getState().set("uiShell", "protools"));

  it("is true for v2 and v3 and false for every other shell", () => {
    for (const [shell, modern] of [["v2", true], ["v3", true], ["protools", false], ["live", false], ["classic", false]] as const) {
      useSettings.getState().set("uiShell", shell);
      expect(activeShell()).toBe(shell);
      expect(isModernShell()).toBe(modern);
      expect(isModernShell(shell)).toBe(modern);
    }
  });

  it("does not widen isV2Active (the video gate keeps its v2-only meaning)", () => {
    useSettings.getState().set("uiShell", "v3");
    expect(isModernShell()).toBe(true);
    expect(isV2Active()).toBe(false);
  });
});
