// Opt-in crash reporting + telemetry toggle (src/telemetry/, see
// docs/telemetry/PRIVACY.md and the "telemetryOptIn" descriptor in schema.ts).
// Pins: (1) the schema default is OFF; (2) toggling it through the settings store
// persists AND notifies the native bridge exactly once with the new value, on an
// explicit set(), on reset(), and on a fresh hydrate(); (3) a corrupted persisted
// value degrades safely back to OFF (the store's existing coerceSetting contract).
//
// setTelemetryOptIn() itself is native-only (see bridge.ts — a no-op outside the
// real JUCE WebView), so it is mocked here purely to observe CALLS; nothing in
// this file touches a filesystem or a network endpoint.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../bridge", async () => {
  const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
  return { ...actual, setTelemetryOptIn: vi.fn() };
});

import { setTelemetryOptIn } from "../bridge";
import { useSettings, loadPersisted, STORAGE_KEY } from "./store";
import { defaultSettings, settingDef } from "./schema";

beforeEach(() => {
  localStorage.clear();
  useSettings.getState().reset();
  // reset() itself fires one setTelemetryOptIn(false) call via applySettingEffects
  // — clear it AFTER so every test starts observing a pristine call history.
  vi.mocked(setTelemetryOptIn).mockClear();
});

afterEach(() => {
  vi.mocked(setTelemetryOptIn).mockClear();
});

describe("telemetryOptIn setting", () => {
  it("defaults to false", () => {
    expect(settingDef("telemetryOptIn")?.default).toBe(false);
    expect(defaultSettings().telemetryOptIn).toBe(false);
    expect(useSettings.getState().get("telemetryOptIn")).toBe(false);
  });

  it("is a UI-local app-scoped boolean, grouped under Privacy", () => {
    const def = settingDef("telemetryOptIn")!;
    expect(def.type).toBe("bool");
    expect(def.scope).toBe("app");
    expect(def.category).toBe("Privacy");
  });

  it("a fresh hydrate with nothing persisted notifies native with false", () => {
    useSettings.getState().hydrate();
    expect(setTelemetryOptIn).toHaveBeenCalledTimes(1);
    expect(setTelemetryOptIn).toHaveBeenCalledWith(false);
  });

  it("turning it on persists the override and notifies native with true", () => {
    useSettings.getState().set("telemetryOptIn", true);

    expect(useSettings.getState().get("telemetryOptIn")).toBe(true);
    expect(setTelemetryOptIn).toHaveBeenCalledTimes(1);
    expect(setTelemetryOptIn).toHaveBeenCalledWith(true);

    // Persisted for real (not just held in memory) — the exact contract set()
    // gives every other setting (mirrors uiShell/theme).
    const persisted = loadPersisted(localStorage);
    expect(persisted.values.telemetryOptIn).toBe(true);
  });

  it("survives a reload: hydrate reads the persisted true back and re-notifies native", () => {
    useSettings.getState().set("telemetryOptIn", true);
    vi.mocked(setTelemetryOptIn).mockClear();

    // Simulate a reload: blow away in-memory state, re-hydrate from localStorage.
    useSettings.setState({ template: null, values: {} });
    useSettings.getState().hydrate();

    expect(useSettings.getState().get("telemetryOptIn")).toBe(true);
    expect(setTelemetryOptIn).toHaveBeenCalledWith(true);
  });

  it("turning it back off persists false and notifies native with false", () => {
    useSettings.getState().set("telemetryOptIn", true);
    vi.mocked(setTelemetryOptIn).mockClear();

    useSettings.getState().set("telemetryOptIn", false);

    expect(useSettings.getState().get("telemetryOptIn")).toBe(false);
    expect(setTelemetryOptIn).toHaveBeenCalledTimes(1);
    expect(setTelemetryOptIn).toHaveBeenCalledWith(false);
    expect(loadPersisted(localStorage).values.telemetryOptIn).toBe(false);
  });

  it("reset() restores the default (false) and notifies native", () => {
    useSettings.getState().set("telemetryOptIn", true);
    vi.mocked(setTelemetryOptIn).mockClear();

    useSettings.getState().reset();

    expect(useSettings.getState().get("telemetryOptIn")).toBe(false);
    expect(setTelemetryOptIn).toHaveBeenCalledWith(false);
  });

  it("a corrupted persisted value degrades safely back to the schema default (false)", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        template: null,
        values: { telemetryOptIn: "yes please" }, // not a boolean
        keyOverrides: {},
      }),
    );

    useSettings.getState().hydrate();

    expect(useSettings.getState().get("telemetryOptIn")).toBe(false);
    expect(setTelemetryOptIn).toHaveBeenCalledWith(false);
  });
});
