// CAP-AUT-006 — the mute half. The native side gives mute an automatable parameter (a
// hidden per-track gate plugin, since the engine has none — docs/ENGINE_API_NOTES.md
// "Track mute"); this covers the two UI facts that make it usable and honest.
//
//  1. REACHABILITY. The gate and the fader are deliberately absent from the snapshot's
//     `plugins` rack — a "Mute" row in every chain would be noise, and the P6 undo
//     matrix already caught the fader leaking there. AutomationPanel's picker builds
//     itself from `plugins` alone, so before this both were unpickable: the fader's own
//     volume/pan curves had been addressable by command the whole time and no
//     mouse-only producer could reach them. The picker now also reads `mixerPlugins`.
//
//  2. STEPPED VALUES. The mute parameter is discrete: the engine snaps every applied
//     value at 0.5 (AutomatableParameter::snapToState, run over each sample taken off
//     the curve), so a point dropped at 0.37 is APPLIED as 0. Drawing it at 0.37 would
//     be a dot sitting where the audio never goes. The panel snaps on the way in, and
//     draws the connecting line as a step at the segment midpoint — which is exactly
//     where a 0->1 segment crosses the snap boundary.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationPanel, snapParamValue } from "./AutomationPanel";
import { useStore } from "../store";
import type { CommandResult, Plugin, Snapshot, Track } from "../types";

const MUTE_GATE: Plugin = {
  index: 7, name: "Mute", type: "moshTrackMute", enabled: true, external: false, isInstrument: false,
  params: [{ index: 0, name: "Mute", value: 0, discrete: true, states: 2 }],
};
const FADER: Plugin = {
  index: 6, name: "Volume & Pan Plugin", type: "volume", enabled: true, external: false, isInstrument: false,
  params: [{ index: 0, name: "Volume", value: 0.8 }, { index: 1, name: "Pan", value: 0.5 }],
};
const EQ: Plugin = {
  index: 0, name: "4-Band EQ", type: "4bandEq", enabled: true, external: false, isInstrument: false,
  params: [{ index: 0, name: "Freq", value: 0.5 }],
};

const track = (over: Partial<Track> = {}): Track => ({
  id: "t1", index: 0, name: "Keys", type: "audio", volumeDb: 0, pan: 0, mute: false, solo: false,
  clips: [], plugins: [], mixerPlugins: [FADER, MUTE_GATE], ...over,
} as unknown as Track);

const snapshot = (t: Track): Snapshot =>
  ({ schemaVersion: 1, session: { tempo: 120, length: 8 }, tracks: [t], sections: [] }) as unknown as Snapshot;

describe("AutomationPanel — mute automation (CAP-AUT-006)", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;

  const pluginSelect = () =>
    host.querySelector('[data-testid="automation-panel"] select') as HTMLSelectElement;
  const options = (sel: HTMLSelectElement) => Array.from(sel.options).map((o) => o.textContent);
  const select = (el: HTMLSelectElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
    act(() => { setter.call(el, value); el.dispatchEvent(new Event("change", { bubbles: true })); });
  };

  const mount = (t: Track) => {
    useStore.setState({ exec, snapshot: snapshot(t), automationTrackId: t.id, pxPerSec: 80 } as never);
    act(() => root.render(React.createElement(AutomationPanel)));
  };

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    exec = vi.fn(async () => ({ ok: true, command: "add_automation_point", data: {} }) as CommandResult);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState({ automationTrackId: null } as never);
  });

  it("offers the mute gate in the picker — a mouse-only producer can reach it", () => {
    mount(track({ plugins: [EQ] }));
    expect(options(pluginSelect())).toContain("Mute");
  });

  it("offers the fader too — its volume/pan curves were command-only before", () => {
    mount(track({ plugins: [EQ] }));
    expect(options(pluginSelect())).toContain("Volume & Pan Plugin");
  });

  it("a track with no rack plugins still has something to automate", () => {
    mount(track({ plugins: [] }));
    expect(options(pluginSelect())).toEqual(["Volume & Pan Plugin", "Mute"]);
    // The panel used to say "no plugins" over an empty canvas for exactly this track.
    expect(options(pluginSelect())).not.toContain("no plugins");
  });

  it("rack plugins still come first, so the default selection is unchanged", () => {
    mount(track({ plugins: [EQ] }));
    expect(options(pluginSelect())[0]).toBe("4-Band EQ");
    expect(pluginSelect().value).toBe(String(EQ.index));
  });

  it("addresses the gate by its REAL pluginList index, not its position in the picker", () => {
    mount(track({ plugins: [EQ] }));
    select(pluginSelect(), String(MUTE_GATE.index));
    const svg = host.querySelector("svg.auto-canvas") as SVGSVGElement;
    act(() => { svg.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 40, clientY: 30 })); });
    expect(exec).toHaveBeenCalledTimes(1);
    const [command, args] = exec.mock.calls[0] as [string, Record<string, unknown>];
    expect(command).toBe("add_automation_point");
    expect(args.pluginIndex, "the gate is hidden from `plugins`, so its index is not its picker position").toBe(7);
    expect(args.paramIndex).toBe(0);
  });

  it("snaps a click on a discrete parameter to a state the engine will actually apply", () => {
    mount(track({ plugins: [EQ] }));
    select(pluginSelect(), String(MUTE_GATE.index));
    const svg = host.querySelector("svg.auto-canvas") as SVGSVGElement;
    // jsdom reports a zero-size rect, so clientY IS the offset into the 220px canvas.
    // y=30 is near the top => v well above 0.5 => must land on exactly 1.
    act(() => { svg.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 40, clientY: 30 })); });
    expect((exec.mock.calls[0][1] as Record<string, number>).value).toBe(1);

    exec.mockClear();
    // y=200 is near the bottom => v well below 0.5 => exactly 0.
    act(() => { svg.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 90, clientY: 200 })); });
    expect((exec.mock.calls[0][1] as Record<string, number>).value).toBe(0);
  });

  it("does NOT snap a continuous parameter — the EQ keeps its full range", () => {
    mount(track({ plugins: [EQ] }));
    const svg = host.querySelector("svg.auto-canvas") as SVGSVGElement;
    act(() => { svg.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 40, clientY: 90 })); });
    const v = (exec.mock.calls[0][1] as Record<string, number>).value;
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(1);
  });

  it("draws a two-state curve as a step at the segment midpoint, not a diagonal fade", () => {
    const automated: Plugin = {
      ...MUTE_GATE,
      params: [{
        index: 0, name: "Mute", value: 0, discrete: true, states: 2, automated: true,
        points: [{ t: 0, v: 0 }, { t: 2, v: 1 }],
      }],
    };
    mount(track({ plugins: [], mixerPlugins: [automated] }));
    const d = (host.querySelector("path.auto-line") as SVGPathElement).getAttribute("d")!;
    // pxPerSec 80: t=0 -> x 0, midpoint t=1 -> x 80, t=2 -> x 160. The vertical move
    // happens at x=80 (both y values appear there), which a straight line never does.
    const at80 = d.match(/L 80\.0 /g) ?? [];
    expect(at80.length, `expected a vertical step at the midpoint, got "${d}"`).toBe(2);
    expect(d).toContain("L 160.0");
  });
});

describe("snapParamValue", () => {
  it("passes continuous values straight through", () => {
    expect(snapParamValue({ index: 0, name: "Freq", value: 0 }, 0.37)).toBe(0.37);
    expect(snapParamValue(null, 0.37)).toBe(0.37);
  });
  it("rounds a two-state parameter to its nearest state", () => {
    const p = { index: 0, name: "Mute", value: 0, discrete: true, states: 2 };
    expect(snapParamValue(p, 0.49)).toBe(0);
    expect(snapParamValue(p, 0.51)).toBe(1);
  });
  it("defaults a discrete parameter with no state count to two states", () => {
    expect(snapParamValue({ index: 0, name: "Mute", value: 0, discrete: true }, 0.7)).toBe(1);
  });
});
