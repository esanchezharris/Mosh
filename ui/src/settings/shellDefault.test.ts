import { afterEach, describe, expect, it } from "vitest";
import { defaultSettings } from "./schema";
import { savePersisted, useSettings } from "./store";
import { resolveShell } from "../v2/shellQuery";

// The flip (V3 parity brief §6) changes FRESH installs only. Anyone who chose a shell keeps it.
describe("uiShell default flip", () => {
  afterEach(() => { localStorage.clear(); useSettings.setState({ template: null, values: {} }); });

  it("a fresh install resolves to v3", () => {
    expect(defaultSettings().uiShell).toBe("v3");
    expect(resolveShell(defaultSettings().uiShell)).toBe("v3");
  });

  it("every persisted explicit choice survives hydration unchanged (anti-vacuity: protools no longer equals the default)", () => {
    for (const shell of ["protools", "live", "v2", "classic"] as const) {
      savePersisted(localStorage, { template: null, values: { uiShell: shell }, keyOverrides: {} });
      useSettings.setState({ template: null, values: {} });
      useSettings.getState().hydrate();
      expect(useSettings.getState().get("uiShell"), shell).toBe(shell);
      expect(useSettings.getState().get("uiShell")).not.toBe("v3");   // the default did not overwrite the choice
    }
  });
});
