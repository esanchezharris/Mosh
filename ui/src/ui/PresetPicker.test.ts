import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetMockForTests } from "../bridge.mock";
import { useStore } from "../store";
import type { Plugin } from "../types";
import { PresetPicker, presetKeyFor } from "./PresetPicker";

const plugin = (over: Partial<Plugin>): Plugin => ({
  index: 0, name: "4OSC", type: "4osc", enabled: true, external: false, builtin: true, isInstrument: true, params: [], ...over,
} as Plugin);

describe("presetKeyFor", () => {
  it("names the two loadable banks and nothing else", () => {
    expect(presetKeyFor(plugin({}))).toBe("4osc");
    expect(presetKeyFor(plugin({ builtin: false, name: "Vital", type: "vst3" }))).toBe("vital");
    expect(presetKeyFor(plugin({ type: "sampler", name: "Sampler" }))).toBeNull();
    expect(presetKeyFor(plugin({ builtin: false, name: "Serum 2", type: "vst3" }))).toBeNull();
  });
});

describe("PresetPicker against the mock backend", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    __resetMockForTests();
    await useStore.getState().refresh();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

  const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

  it("renders the 4OSC bank and nothing for the sampler (anti-vacuity: both branches)", async () => {
    const trackId = useStore.getState().snapshot!.tracks[0].id;
    await act(async () => root.render(React.createElement(PresetPicker, { plugin: plugin({}), trackId })));
    await flush();
    const select = host.querySelector('[data-testid="preset-pick"]') as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    expect(select!.querySelectorAll("option").length).toBe(6);   // placeholder + the 5 bundled 4osc presets
    await act(async () => root.render(React.createElement(PresetPicker, { plugin: plugin({ type: "sampler", name: "Sampler" }), trackId })));
    await flush();
    expect(host.querySelector('[data-testid="preset-pick"]')).toBeNull();
  });

  it("reports onLoaded only for a load the engine ACCEPTED", async () => {
    const { exec, refresh } = useStore.getState();
    const made = await exec("create_track", { name: "Synth" }) as { data?: { trackId?: string } };
    await exec("add_midi_clip", { trackId: made.data!.trackId });  // an instrument-less track gets the default 4OSC
    await refresh();
    const tracks = useStore.getState().snapshot!.tracks;
    const withSynth = tracks.find((t) => (t.plugins ?? []).some((p) => p.isInstrument && p.builtin));
    const bare = tracks.find((t) => !(t.plugins ?? []).some((p) => p.isInstrument));
    expect(withSynth).toBeTruthy();                                // both branches exist (anti-vacuity)
    expect(bare).toBeTruthy();
    const onLoaded = vi.fn();
    const pick = async (trackId: string) => {
      await act(async () => root.render(React.createElement(PresetPicker, { plugin: plugin({}), trackId, onLoaded })));
      await flush();
      const select = host.querySelector('[data-testid="preset-pick"]') as HTMLSelectElement;
      await act(async () => {
        select.value = "/presets/4osc/mosh-bass.json";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await flush();
    };
    await pick(bare!.id);                                           // the engine refuses: no instrument
    expect(onLoaded).not.toHaveBeenCalled();
    await pick(withSynth!.id);
    expect(onLoaded).toHaveBeenCalledTimes(1);
    expect(onLoaded).toHaveBeenCalledWith({ name: "mosh-bass", file: "/presets/4osc/mosh-bass.json" });
  });
});
