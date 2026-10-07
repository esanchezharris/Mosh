import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MixInspector, acceptsTrackPreset, inspectorHasForbiddenTabs, pluginDropIndex, trackPresetLabel } from "./MixInspector";
import { useStore } from "../store";
import type { CommandResult, Plugin, Snapshot, Track } from "../types";
import { PANELS } from "./panels/registry";
import type { PanelDef, PanelProps, SummaryContext } from "./panels/types";

vi.mock("../ui/GenDrawer", () => ({ GenDrawer: () => React.createElement("div", { "data-testid": "v3-gen" }, "gen") }));

function snapshot(): Snapshot {
  const plugin = {
    index: 0, name: "Serum", type: "VST3", enabled: true, external: true, isInstrument: true, params: [],
  } as Plugin;
  const track = {
    id: "t1", index: 0, name: "Keys", type: "audio", volumeDb: 0, pan: 0,
    mute: false, solo: false, clips: [], plugins: [plugin],
  } as unknown as Track;
  return { schemaVersion: 1, session: { sampleRate: 48000, tempo: 120, length: 16 }, tracks: [track] } as unknown as Snapshot;
}

describe("v3 Mix inspector", () => {
  let host: HTMLDivElement;
  let root: Root;
  const calls: { command: string; args?: Record<string, unknown> }[] = [];

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    calls.length = 0;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useStore.setState({
      snapshot: snapshot(),
      selectedTrackId: "t1",
      waveInputs: null,
      midiInputs: null,
      trackOutputs: null,
      exec: vi.fn(async (command: string, args?: Record<string, unknown>): Promise<CommandResult> => {
        calls.push({ command, args });
        return { ok: true, command };
      }),
      loadRouting: vi.fn(async () => {}),
      loadMidiInputs: vi.fn(async () => {}),
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("draws its sliders as the knob-less V3 range (.rng with the fill published as --pct)", () => {
    act(() => root.render(React.createElement(MixInspector, { snapshot: snapshot() })));
    const vol = host.querySelector<HTMLInputElement>('input[aria-label="Vol"]')!;
    expect(vol.type).toBe("range");
    expect(vol.classList.contains("rng")).toBe(true);
    expect(vol.style.getPropertyValue("--pct")).toBe("90.91%");      // 0 dB inside −60..6
    const pan = host.querySelector<HTMLInputElement>('input[aria-label="Pan"]')!;
    expect(pan.style.getPropertyValue("--pct")).toBe("50.00%");      // centre
    expect(host.querySelectorAll('input[type="range"]:not(.rng)')).toHaveLength(0);
  });

  it("is Mix-only stacked sections with no FX/Lyrics tabs", () => {
    act(() => root.render(React.createElement(MixInspector, { snapshot: snapshot() })));
    expect(host.querySelector('[data-testid="v3-inspector"]')).not.toBeNull();
    expect(host.querySelector('[role="tablist"]')).toBeNull();
    expect(inspectorHasForbiddenTabs(host)).toBe(false);
    expect(host.textContent).toMatch(/Levels/);
    expect(host.textContent).toMatch(/Re-Imagine/);
    expect(host.textContent).toMatch(/Sends/);
    expect(host.textContent).toMatch(/Plugins/);
  });

  it("Open Editor calls open_plugin_editor", () => {
    act(() => root.render(React.createElement(MixInspector, { snapshot: snapshot() })));
    const btn = host.querySelector<HTMLButtonElement>('[data-testid="v3-open-editor"]');
    expect(btn).not.toBeNull();
    act(() => btn!.click());
    expect(calls).toContainEqual({ command: "open_plugin_editor", args: { trackId: "t1", index: 0 } });
  });

  it("a native plugin's parameter rows read the engine's display text (units), not the raw 0-1 value", () => {
    const snap = snapshot();
    const eq = {
      index: 1, name: "Level", type: "volume", enabled: true, external: false, builtin: true, isInstrument: false,
      params: [
        { index: 0, name: "Level 1", value: 0.85, display: "-3.2 dB" },
        { index: 1, name: "Pan", value: 0.5 },                         // no display text: the value stays
      ],
    } as unknown as Plugin;
    snap.tracks[0]!.plugins = [...(snap.tracks[0]!.plugins ?? []), eq];
    useStore.setState({ snapshot: snap });
    act(() => root.render(React.createElement(MixInspector, { snapshot: snap })));
    const row = host.querySelector<HTMLElement>('[data-testid="v3-plugin"][data-plugin-index="1"]');
    expect(row).not.toBeNull();
    const values = [...row!.querySelectorAll(".fader .v")].map((el) => el.textContent);
    expect(values).toEqual(["-3.2 dB", "0.50"]);
    expect(row!.textContent).not.toContain("0.85");
  });

  // ── drag a plugin above or below another to reorder the chain ──
  // jsdom lays nothing out (every box is 0×0 at the origin), so a pointer at y = -1 is in
  // the upper half of a row and y = +1 in the lower half.
  function chain(): Snapshot {
    const snap = snapshot();
    const native = (index: number, name: string) => ({
      index, name, type: name.toLowerCase(), enabled: true, external: false, builtin: true, isInstrument: false, params: [],
    }) as unknown as Plugin;
    snap.tracks[0]!.plugins = [native(1, "Tune"), native(2, "Filter"), native(3, "Comp")];
    return snap;
  }
  function fire(el: Element, type: string, clientY = 0) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { clientY, dataTransfer: { setData: vi.fn(), effectAllowed: "", dropEffect: "" } });
    act(() => { el.dispatchEvent(event); });
    return event;
  }
  const row = (index: number) => host.querySelector<HTMLElement>(`[data-testid="v3-plugin"][data-plugin-index="${index}"]`)!;
  const handle = (index: number) => row(index).querySelector<HTMLElement>('[data-testid="v3-plugin-handle"]')!;
  const reorders = () => calls.filter((c) => c.command === "reorder_plugin").map((c) => c.args);

  it("dragging a plugin's header below another row moves it there", () => {
    const snap = chain();
    useStore.setState({ snapshot: snap });
    act(() => root.render(React.createElement(MixInspector, { snapshot: snap })));
    expect(handle(1).getAttribute("draggable")).toBe("true");

    fire(handle(1), "dragstart");
    const over = fire(row(3), "dragover", 1);
    expect(over.defaultPrevented).toBe(true);                 // the row accepts the drop
    expect(row(3).getAttribute("data-drop")).toBe("below");   // and shows where it will land
    fire(row(3), "drop", 1);
    expect(reorders()).toEqual([{ trackId: "t1", index: 1, toIndex: 3 }]);
    expect(row(3).hasAttribute("data-drop")).toBe(false);
  });

  it("dragging above the first row moves a plugin to the top", () => {
    const snap = chain();
    useStore.setState({ snapshot: snap });
    act(() => root.render(React.createElement(MixInspector, { snapshot: snap })));
    fire(handle(3), "dragstart");
    fire(row(1), "dragover", -1);
    expect(row(1).getAttribute("data-drop")).toBe("above");
    fire(row(1), "drop", -1);
    expect(reorders()).toEqual([{ trackId: "t1", index: 3, toIndex: 1 }]);
  });

  it("a drop that changes nothing sends nothing, and a drag that did not start here is ignored", () => {
    const snap = chain();
    useStore.setState({ snapshot: snap });
    act(() => root.render(React.createElement(MixInspector, { snapshot: snap })));

    // Something else dragged over the row (a file, a clip): not ours.
    const foreign = fire(row(2), "dragover", 1);
    expect(foreign.defaultPrevented).toBe(false);
    fire(row(2), "drop", 1);

    // Dropped on itself, and dropped just below the row already directly above it.
    fire(handle(2), "dragstart");
    fire(row(2), "drop", 1);
    fire(handle(2), "dragstart");
    fire(row(1), "drop", 1);
    fire(handle(2), "dragend");
    expect(reorders()).toEqual([]);

    // After dragend the row no longer accepts a drop.
    expect(fire(row(3), "dragover", 1).defaultPrevented).toBe(false);
  });

  it("Alt+Up and Alt+Down on a plugin's header move it without a pointer", () => {
    const snap = chain();
    useStore.setState({ snapshot: snap });
    act(() => root.render(React.createElement(MixInspector, { snapshot: snap })));
    const key = (index: number, k: string, altKey: boolean) =>
      act(() => { handle(index).dispatchEvent(new KeyboardEvent("keydown", { key: k, altKey, bubbles: true, cancelable: true })); });

    key(2, "ArrowDown", true);
    key(2, "ArrowUp", true);
    key(1, "ArrowUp", true);      // already first: nothing to move past
    key(3, "ArrowDown", true);    // already last
    key(2, "ArrowDown", false);   // without Alt it is ordinary navigation
    expect(reorders()).toEqual([
      { trackId: "t1", index: 2, toIndex: 3 },
      { trackId: "t1", index: 2, toIndex: 1 },
    ]);
  });

  it("hands a panel its track, a run() scoped to that track, and its summary the track", async () => {
    const seen: { props?: PanelProps; ctx?: SummaryContext } = {};
    const def: PanelDef = {
      Panel: (props) => { seen.props = props; return null; },
      summary: (_plugin, ctx) => { seen.ctx = ctx; return "probe summary"; },
    };
    PANELS.probeInstrument = def;
    try {
      const snap = snapshot();
      snap.tracks[0]!.plugins = [{ index: 0, name: "Probe", type: "probeInstrument", enabled: true, external: false, builtin: true, isInstrument: true, params: [] } as unknown as Plugin];
      useStore.setState({ snapshot: snap });
      act(() => root.render(React.createElement(MixInspector, { snapshot: snap })));
      expect(seen.props?.track?.id).toBe("t1");
      expect(seen.props?.trackId).toBe("t1");
      // the row adds THIS track's id to the commands that take one (a panel cannot aim
      // one elsewhere), and leaves the read-only path commands alone
      await act(async () => { await seen.props!.run!("set_drum_pad", { note: 36, gainDb: -3 }); });
      await act(async () => { await seen.props!.run!("clear_drum_pad", { note: 38, trackId: "other" } as never); });
      await act(async () => { await seen.props!.run!("file_peaks", { path: "/a.wav", buckets: 64 }); });
      await act(async () => { await seen.props!.run!("list_drum_kits", {}); });
      expect(calls.slice(-4)).toEqual([
        { command: "set_drum_pad", args: { note: 36, gainDb: -3, trackId: "t1" } },
        { command: "clear_drum_pad", args: { note: 38, trackId: "t1" } },
        { command: "file_peaks", args: { path: "/a.wav", buckets: 64 } },
        { command: "list_drum_kits", args: {} },
      ]);
      // minimized: the summary is given the track too
      const row = host.querySelector<HTMLElement>('[data-testid="v3-plugin"]')!;
      act(() => row.querySelector<HTMLButtonElement>('[data-testid="v3-plugin-minimize"]')!.click());
      expect(row.querySelector('[data-testid="v3-plugin-summary"]')!.textContent).toBe("probe summary");
      expect(seen.ctx?.track?.id).toBe("t1");
      act(() => row.querySelector<HTMLButtonElement>('[data-testid="v3-plugin-minimize"]')!.click());
    } finally {
      delete PANELS.probeInstrument;
    }
  });

  it("an instrument panel that owns its presets replaces the row's preset menu", async () => {
    const exec = vi.fn(async (command: string): Promise<CommandResult> => (command === "list_presets"
      ? { ok: true, command, data: { presets: [{ name: "mosh-bass", file: "/presets/4osc/mosh-bass.json" }] } }
      : { ok: true, command }));
    useStore.setState({ exec });
    const snap = snapshot();
    snap.tracks[0]!.plugins = [{ index: 0, name: "4OSC", type: "4osc", enabled: true, external: false, builtin: true, isInstrument: true, params: [] } as unknown as Plugin];
    useStore.setState({ snapshot: snap });
    await act(async () => { root.render(React.createElement(MixInspector, { snapshot: snap })); });
    expect(host.querySelectorAll('[data-testid="preset-pick"]')).toHaveLength(1);       // the row's own menu
    const original = PANELS["4osc"]!;
    PANELS["4osc"] = { ...original, ownsPresets: true, Panel: () => React.createElement("span", { "data-testid": "own-presets" }) };
    try {
      await act(async () => { root.render(React.createElement(MixInspector, { snapshot: { ...snap } })); });
      expect(host.querySelector('[data-testid="own-presets"]')).not.toBeNull();
      expect(host.querySelectorAll('[data-testid="preset-pick"]')).toHaveLength(0);
    } finally {
      PANELS["4osc"] = original;
    }
  });

  it("pluginDropIndex is the index a plugin ends up at once it has left its old slot", () => {
    expect(pluginDropIndex(1, 3, "below")).toBe(3);
    expect(pluginDropIndex(1, 3, "above")).toBe(2);
    expect(pluginDropIndex(3, 1, "above")).toBe(1);
    expect(pluginDropIndex(3, 1, "below")).toBe(2);
    // No change: onto itself, just below its upper neighbour, just above its lower one.
    expect(pluginDropIndex(2, 2, "above")).toBeNull();
    expect(pluginDropIndex(2, 2, "below")).toBeNull();
    expect(pluginDropIndex(2, 1, "below")).toBeNull();
    expect(pluginDropIndex(2, 3, "above")).toBeNull();
  });
});

// Track-chain presets ("Mosh Clean Lead v0") — the manual entry point in the Plugins group.
describe("v3 Mix inspector — vocal preset", () => {
  const FILE = "/presets/track-chain/mosh-clean-lead-v0.json";
  let host: HTMLDivElement;
  let root: Root;
  let calls: { command: string; args?: Record<string, unknown> }[];
  let applyResult: CommandResult;

  function vocalSnapshot(over: Partial<Track> = {}, recording = false): Snapshot {
    const track = {
      id: "vox", index: 0, name: "Vox", type: "audio", volumeDb: 0, pan: 0,
      mute: false, solo: false, clips: [], plugins: [], ...over,
    } as unknown as Track;
    const second = {
      id: "beat", index: 1, name: "Beat", type: "audio", volumeDb: 0, pan: 0,
      mute: false, solo: false, clips: [], plugins: [],
    } as unknown as Track;
    return {
      schemaVersion: 1, session: { sampleRate: 48000, tempo: 120, length: 16 },
      transport: { recording, playing: false, positionSec: 0 }, tracks: [track, second],
    } as unknown as Snapshot;
  }

  async function mount(snap: Snapshot, selectedTrackId: string | null = "vox") {
    await act(async () => {
      useStore.setState({ snapshot: snap, selectedTrackId });
      root.render(React.createElement(MixInspector, { snapshot: snap }));
    });
  }
  const picker = () => host.querySelector<HTMLSelectElement>('[data-testid="v3-track-preset"]');

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    calls = [];
    applyResult = { ok: true, command: "apply_track_preset" };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useStore.setState({
      waveInputs: null, midiInputs: null, trackOutputs: null,
      exec: vi.fn(async (command: string, args?: Record<string, unknown>): Promise<CommandResult> => {
        calls.push({ command, args });
        if (command === "list_presets")
          return { ok: true, command, data: { presets: [{ plugin: "track-chain", name: "mosh-clean-lead-v0", file: FILE, source: "bundled" }] } };
        if (command === "apply_track_preset") return applyResult;
        return { ok: true, command };
      }),
      loadRouting: vi.fn(async () => {}),
      loadMidiInputs: vi.fn(async () => {}),
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("offers the bundled preset on the selected audio track and applies it to THAT track id", async () => {
    await mount(vocalSnapshot());
    expect(calls).toContainEqual({ command: "list_presets", args: { plugin: "track-chain" } });
    const select = picker();
    expect(select).not.toBeNull();
    expect(select!.disabled).toBe(false);
    expect([...select!.options].map((o) => o.textContent)).toEqual(["Vocal preset\u2026", "Mosh Clean Lead v0"]);

    select!.value = FILE;
    await act(async () => { select!.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(calls).toContainEqual({ command: "apply_track_preset", args: { trackId: "vox", file: FILE } });
    expect(host.querySelector('[data-testid="v3-track-preset-error"]')).toBeNull();
  });

  it("is not offered when no track is selected — the inspector's first-track fallback must not carry a preset", async () => {
    await mount(vocalSnapshot(), null);
    expect(host.querySelector('[data-testid="v3-inspector"]')!.getAttribute("data-track-id")).toBe("vox"); // the fallback IS showing
    expect(picker()).toBeNull();
    await mount(vocalSnapshot(), "gone");                 // a stale selection is not a selection either
    expect(picker()).toBeNull();
  });

  it("is not offered on tracks the engine would refuse", async () => {
    const synth = { index: 0, name: "4OSC", type: "4osc", enabled: true, external: false, builtin: true, isInstrument: true, params: [] } as unknown as Plugin;
    for (const over of [{ isInstrument: true }, { plugins: [synth] }, { type: "drum" }, { isReturn: true }, { isGroup: true }, { frozen: true }] as Partial<Track>[]) {
      await mount(vocalSnapshot(over));
      expect(picker()).toBeNull();
      expect(acceptsTrackPreset(vocalSnapshot(over).tracks[0]!)).toBe(false);
    }
    expect(acceptsTrackPreset(vocalSnapshot().tracks[0]!)).toBe(true);
  });

  it("is disabled, with the reason, while recording", async () => {
    await mount(vocalSnapshot({}, true));
    const select = picker();
    expect(select).not.toBeNull();
    expect(select!.disabled).toBe(true);
    expect(select!.title).toMatch(/Stop recording/);
    expect(select!.options[0]!.textContent).toMatch(/stop recording first/);
  });

  it("shows the engine's refusal when an apply fails", async () => {
    applyResult = { ok: false, command: "apply_track_preset", error: "cannot apply a preset while recording \u2014 stop recording first" };
    await mount(vocalSnapshot());
    const select = picker()!;
    select.value = FILE;
    await act(async () => { select.dispatchEvent(new Event("change", { bubbles: true })); });
    const alert = host.querySelector('[data-testid="v3-track-preset-error"]');
    expect(alert?.getAttribute("role")).toBe("alert");
    expect(alert?.textContent).toMatch(/while recording/);
  });

  it("a preset's rows name the preset; a compressor, preset or not, gets its panel with every control reachable", async () => {
    const params = (n: number) => Array.from({ length: n }, (_, i) => ({ index: i, name: `P${i}`, value: 0.5, display: `${i} dB` }));
    const tag = (stage: number) => ({ id: "mosh.clean-lead", name: "Mosh Clean Lead v0", revision: 0, stage });
    const plugins = [
      { index: 0, name: "Compressor", type: "compressor", enabled: true, external: false, builtin: true, isInstrument: false, params: params(6) },
      { index: 1, name: "High-Pass", type: "highpass", enabled: true, external: false, builtin: true, isInstrument: false, params: params(1), preset: tag(0) },
      { index: 2, name: "Compressor", type: "compressor", enabled: true, external: false, builtin: true, isInstrument: false, params: params(6), preset: tag(1) },
    ] as unknown as Plugin[];
    await mount(vocalSnapshot({ plugins }));
    const row = (i: number) => host.querySelector<HTMLElement>(`[data-testid="v3-plugin"][data-plugin-index="${i}"]`)!;
    expect(row(0).querySelector('[data-testid="v3-plugin-preset"]')).toBeNull();
    expect(row(1).querySelector('[data-testid="v3-plugin-preset"]')!.textContent).toBe("Preset: Mosh Clean Lead v0");
    // Both compressors draw the compressor panel instead of plain sliders: the threshold is
    // a handle on the curve, then ratio, attack, release and makeup dials (the inert
    // sidechain gain sits behind "more"). So every control the preset set is on screen.
    for (const i of [0, 2]) {
      expect(row(i).querySelector('[data-testid="pp-compressor"]')).not.toBeNull();
      expect(row(i).querySelectorAll('input[type="range"]')).toHaveLength(0);
      const sliders = [...row(i).querySelectorAll('[role="slider"]')].map((el) => el.getAttribute("aria-label"));
      expect(sliders).toEqual(expect.arrayContaining(["Threshold", "Ratio", "Attack", "Release", "Makeup"]));
    }
    expect(row(2).querySelector('[data-testid="pp-compressor-more"]')).not.toBeNull();
    // A type with no panel of its own keeps the plain rows: the high-pass has one now, so
    // that rule is pinned in the panels' own tests and in pluginParams.test.ts.
    // the existing per-row bypass still drives bypass_plugin on the owned row
    await act(async () => { row(2).querySelector<HTMLButtonElement>('button[aria-label="Bypass"]')!.click(); });
    expect(calls).toContainEqual({ command: "bypass_plugin", args: { trackId: "vox", index: 2, bypassed: true } });
  });

  it("labels a library file stem as a name", () => {
    expect(trackPresetLabel("mosh-clean-lead-v0")).toBe("Mosh Clean Lead v0");
    expect(trackPresetLabel("mosh-telephone-v12")).toBe("Mosh Telephone v12");
  });
});
