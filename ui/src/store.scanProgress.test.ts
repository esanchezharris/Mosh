// FIT-003 — plugin-scan progress event reducer. The dev mock's rescan_plugins
// always completes synchronously (no dev-mock AU sweep to sample), so the live
// running-count sample the REAL async backend streams is exercised here by
// publishing a synthetic 'plugin_scan_progress' event directly (via
// __mockEmitForTests), the same idiom store.lifecycle.test.ts uses for other
// backend-only event shapes the mock can't itself produce.
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { useStore } from "./store";
import { __resetMockForTests, __mockEmitForTests } from "./bridge.mock";

describe("plugin_scan_progress reducer (FIT-003)", () => {
  beforeAll(() => { useStore.getState().init(); }); // wires the reducer to the mock's event bus
  beforeEach(() => {
    __resetMockForTests();
    useStore.setState({ scanProgress: null, lastError: null });
  });

  it("a running-count sample sets scanProgress with count + elapsedMs", () => {
    __mockEmitForTests("plugin_scan_progress", { format: "au", done: false, count: 7, elapsedMs: 900 });
    expect(useStore.getState().scanProgress).toEqual({ format: "au", done: false, count: 7, elapsedMs: 900 });
  });

  it("a later sample with a higher count overwrites the earlier one", () => {
    __mockEmitForTests("plugin_scan_progress", { format: "au", done: false, count: 7, elapsedMs: 900 });
    __mockEmitForTests("plugin_scan_progress", { format: "au", done: false, count: 12, elapsedMs: 1800 });
    expect(useStore.getState().scanProgress).toEqual({ format: "au", done: false, count: 12, elapsedMs: 1800 });
  });

  it("the terminal done:true event clears scanProgress and refreshes the catalog", async () => {
    __mockEmitForTests("plugin_scan_progress", { format: "au", done: false, count: 7, elapsedMs: 900 });
    expect(useStore.getState().scanProgress).not.toBeNull();

    __mockEmitForTests("plugin_scan_progress", { format: "au", done: true, count: 12, elapsedMs: 2000 });
    expect(useStore.getState().scanProgress).toBeNull();

    // refreshPluginList() is fire-and-forget (void) inside the reducer; give its
    // microtask a tick, then confirm the catalog was actually re-pulled.
    await new Promise((r) => setTimeout(r, 0));
    expect(useStore.getState().availablePlugins.length).toBeGreaterThan(0);
  });

  it("an older {format,done}-only payload (no count/elapsedMs) still works — additive/backward-compatible", () => {
    __mockEmitForTests("plugin_scan_progress", { format: "vst3", done: false });
    expect(useStore.getState().scanProgress).toEqual({ format: "vst3", done: false, count: undefined, elapsedMs: undefined });
  });

  it("surfaces newly quarantined plug-ins when an async scan completes", async () => {
    __mockEmitForTests("plugin_scan_progress", {
      format: "vst3",
      done: true,
      count: 41,
      elapsedMs: 25_500,
      quarantined: ["WaveShell1-VST3 16.7.vst3"],
    });

    expect(useStore.getState().scanProgress).toBeNull();
    expect(useStore.getState().lastError).toBe(
      "VST3 scan quarantined WaveShell1-VST3 16.7.vst3 because it stopped responding.",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
