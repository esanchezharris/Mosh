import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHORUS_BASE_MS, CHORUS_SPEC, NEEDS_ENGINE, SUMMARY_CHARS, chorusDelayMs, chorusLaneSpan, chorusSettings, chorusSummary, chorusWobbleCents, fmtDepthMs,
  fmtRate, fmtWobble, rightPhaseOffset, stateKeySteps, stateQuantizer, stateRange, stateSettable, stateStep, stateValueAt,
} from "./chorus";
import { PHASER_SPEC } from "./phaser";
import { LANE_W, MINI_H, MINI_W, chorusPanelDef } from "./ChorusPanel";
import { mkBuiltinState } from "../../mock/builtins";
import { useStore } from "../../store";
import type { Plugin } from "../../types";

function chorus(over: Partial<Record<"depthMs" | "speedHz" | "width" | "mix", number>> = {}, enabled = true): Plugin {
  const state = mkBuiltinState("chorus")!;
  for (const [k, v] of Object.entries(over)) state[k] = { ...state[k], value: v };
  return { index: 1, name: "Chorus", type: "chorus", enabled, builtin: true, params: [], state } as unknown as Plugin;
}

describe("chorus maths (tracktion_Chorus.cpp)", () => {
  it("the delay sweeps 20 ms up to 20 + depth: 20 + depth/2·(1 + sin φ)", () => {
    expect(chorusDelayMs(3, -Math.PI / 2)).toBeCloseTo(20, 9);
    expect(chorusDelayMs(3, 0)).toBeCloseTo(21.5, 9);
    expect(chorusDelayMs(3, Math.PI / 2)).toBeCloseTo(23, 9);
    expect(chorusDelayMs(20, Math.PI / 2)).toBeCloseTo(40, 9);
  });
  it("the right channel leads by π·width rad, i.e. width/2 of a cycle", () => {
    expect(rightPhaseOffset(0)).toBe(0);
    expect(rightPhaseOffset(0.5)).toBe(0.25);   // the default: 90°
    expect(rightPhaseOffset(1)).toBe(0.5);      // 180°
  });
  it("pitch wobble: about ±16 cents at the defaults, asymmetric at the extremes", () => {
    const d = chorusWobbleCents(1, 3);
    expect(d.up).toBeCloseTo(16.24, 1);
    expect(d.down).toBeCloseTo(-16.39, 1);
    expect(fmtWobble(d)).toBe("±16 ¢");
    const x = chorusWobbleCents(10, 20);       // π·10·0.02 = 0.628
    expect(x.up).toBeCloseTo(844.06, 1);
    expect(x.down).toBeCloseTo(-1713.43, 1);
    expect(fmtWobble(x)).toBe("+844/-1713 ¢");
  });
  it("the lane's axis is the smallest of 1/2/5/10/20 ms that holds the depth", () => {
    expect(chorusLaneSpan(0.5)).toBe(1);
    expect(chorusLaneSpan(3)).toBe(5);
    expect(chorusLaneSpan(5)).toBe(5);
    expect(chorusLaneSpan(7)).toBe(10);
    expect(chorusLaneSpan(20)).toBe(20);
  });
  it("state dials: linear positions, whole steps, physical values out", () => {
    const r = CHORUS_SPEC.speedHz.range;
    expect(stateValueAt(0, r, 0.01)).toBe(0.1);
    expect(stateValueAt(1, r, 0.01)).toBe(10);
    expect(stateValueAt(0.5, r, 0.01)).toBe(5.05);
    expect(stateValueAt(0.3333, r, 0.01)).toBe(3.4);        // 0.1 + 0.3333·9.9 = 3.39967
    const q = stateQuantizer(CHORUS_SPEC.depthMs.range, 0.1);
    expect(stateValueAt(q(0.1234), CHORUS_SPEC.depthMs.range, 0.1)).toBe(2.6);   // 0.1 + 0.1234·19.9 = 2.556
    // The engine's published range wins over the fallback.
    const p = chorus();
    p.state!.speedHz = { ...p.state!.speedHz, min: 0.5, max: 5 };
    expect(stateRange(p, "speedHz", r)).toEqual({ min: 0.5, max: 5 });
  });
  it("summary: rate and depth first, within the minimized row's 16 characters, no single-letter abbreviations", () => {
    expect(SUMMARY_CHARS).toBe(16);
    expect(chorusSummary(chorus())).toBe("1.00 Hz · 3.0 ms");
    // Too long exact: trailing zeros go, then the depth is rounded and marked.
    expect(chorusSummary(chorus({ speedHz: 2.5, depthMs: 20 }))).toBe("2.5 Hz · 20 ms");
    expect(chorusSummary(chorus({ speedHz: 0.25, depthMs: 12, width: 1, mix: 0.8 }))).toBe("0.25 Hz · 12 ms");
    expect(chorusSummary(chorus({ speedHz: 0.25, depthMs: 12.4 }))).toBe("0.25 Hz · ~12 ms");
    expect(chorusSummary(chorus({ speedHz: 1.5, depthMs: 12.4 }))).toBe("1.5 Hz · 12.4 ms");
    expect(chorusSummary(chorus({ speedHz: 10, depthMs: 19.9 }))).toBe("10 Hz · 19.9 ms");
    expect(fmtDepthMs(19.9)).toBe("19.9 ms");
    expect(chorusSummary(chorus({ mix: 0 }))).toBe("dry · 1.00 Hz");
    expect(fmtRate(10)).toBe("10.0 Hz");
    // The longest any setting can make: every corner of the ranges, and two-decimal values.
    const corners = [chorus(), chorus({ mix: 0 })];
    for (const speedHz of [0.1, 0.25, 9.99, 10]) for (const depthMs of [0.1, 9.9, 12.4, 19.9, 20]) for (const mix of [0, 0.01, 1]) {
      corners.push(chorus({ speedHz, depthMs, mix }));
    }
    for (const p of corners) {
      expect(chorusSummary(p).length).toBeLessThanOrEqual(SUMMARY_CHARS);
      expect(chorusSummary(p)).not.toMatch(/\b[A-Z]\b/);
    }
  });
  it("keys step whole physical steps: Shift one step, arrows 1% of the range, PageUp/Down 10%", () => {
    const d = CHORUS_SPEC.depthMs, fb = PHASER_SPEC.feedback;
    expect(stateKeySteps("ArrowUp", true, d.range, d.step)).toBe(1);
    expect(stateKeySteps("ArrowUp", false, d.range, d.step)).toBe(2);       // 0.199 ms → 2 × 0.1
    expect(stateKeySteps("ArrowLeft", true, fb.range, fb.step)).toBe(-1);
    expect(stateKeySteps("PageDown", false, fb.range, fb.step)).toBe(-19);
    expect(stateKeySteps("Home", false, d.range, d.step)).toBeNull();
    expect(stateStep(3, 1, d.range, d.step)).toBe(3.1);
    expect(stateStep(0.7, 1, fb.range, fb.step)).toBe(0.71);             // odd percentages are reachable
    expect(stateStep(0.94, 5, fb.range, fb.step)).toBe(0.95);            // clamped to the end
    expect(stateStep(Math.fround(0.7), -1, fb.range, fb.step)).toBe(0.69); // float32 from the engine
  });
  it("reads the snapshot's state, with the engine defaults when a key is missing", () => {
    expect(chorusSettings({ ...chorus(), state: undefined })).toEqual({ speedHz: 1, depthMs: 3, width: 0.5, mix: 0.5 });
    expect(chorusSettings(chorus({ depthMs: 7.5 })).depthMs).toBe(7.5);
    // ...but a key the engine does not publish cannot be set.
    expect(stateSettable(chorus(), "depthMs")).toBe(true);
    expect(stateSettable({ ...chorus(), state: undefined }, "depthMs")).toBe(false);
  });
});

describe("ChorusPanel", () => {
  let host: HTMLDivElement;
  let root: Root;
  const setState = vi.fn();
  const setParam = vi.fn();
  let reduced = false;
  const realMatchMedia = window.matchMedia;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    setState.mockReset();
    reduced = false;
    Object.defineProperty(window, "matchMedia", {
      configurable: true, writable: true,
      value: vi.fn((q: string) => ({ matches: reduced && q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} })),
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: realMatchMedia });
    setPlaying(false);
  });

  const setPlaying = (playing: boolean) =>
    act(() => useStore.setState({ transport: { ...useStore.getState().transport, playing } }));
  const render = (plugin: Plugin) =>
    act(() => root.render(React.createElement(chorusPanelDef.Panel, { plugin, trackId: "t1", sampleRate: 48000, setParam, setState })));
  const dial = (id: string) => host.querySelector<SVGSVGElement>(`[data-testid="${id}"] svg`)!;
  const key = (el: Element, k: string, mods: KeyboardEventInit = {}) =>
    act(() => { el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...mods })); });

  it("every setting is a dial with real units; End/Home send the PHYSICAL ends via set_plugin_state", () => {
    render(chorus());
    expect(dial("v3-chorus-rate").getAttribute("aria-valuetext")).toBe("1.00 Hz, one sweep every 1.00 s");
    expect(dial("v3-chorus-depth").getAttribute("aria-valuetext")).toBe("3.0 ms, the delay sweeps 20 to 23.0 ms");
    expect(dial("v3-chorus-width").getAttribute("aria-valuetext")).toBe("50%, left and right 90° apart");
    expect(dial("v3-chorus-mix").getAttribute("aria-valuetext")).toBe("50% wet");
    expect(host.querySelector('[data-testid="v3-chorus-wobble"]')!.textContent).toBe("±16 ¢");
    key(dial("v3-chorus-rate"), "End");
    key(dial("v3-chorus-depth"), "Home");
    expect(setState).toHaveBeenNthCalledWith(1, "speedHz", 10, { gesture: expect.any(String) });
    expect(setState).toHaveBeenNthCalledWith(2, "depthMs", 0.1, { gesture: expect.any(String) });
    // Shown at once: the wobble follows the new rate and depth (π·10·0.0001 → ±5 ¢).
    expect(host.querySelector('[data-testid="v3-chorus-wobble"]')!.textContent).toBe("±5 ¢");
  });

  it("a drag is one gesture and sends the stepped physical value", () => {
    render(chorus());
    const svg = dial("v3-chorus-width");
    act(() => {
      svg.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientY: 100, pointerId: 1 }));
      svg.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientY: 85, pointerId: 1 }));   // +15 px of 150
      svg.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientY: 85, pointerId: 1 }));
    });
    const sent = setState.mock.calls.filter((c) => c[0] === "width");
    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(sent.at(-1)![1]).toBe(0.6);
    expect(new Set(sent.map((c) => c[2].gesture)).size).toBe(1);
    expect(setParam).not.toHaveBeenCalled();
  });

  it("Shift+arrow moves one whole step on every dial (the framework's 0.1% would snap back)", () => {
    render(chorus());
    key(dial("v3-chorus-width"), "ArrowUp", { shiftKey: true });
    key(dial("v3-chorus-mix"), "ArrowDown", { shiftKey: true });
    key(dial("v3-chorus-depth"), "ArrowUp", { shiftKey: true });
    key(dial("v3-chorus-rate"), "ArrowUp", { shiftKey: true });
    expect(setState.mock.calls.map((c) => [c[0], c[1]])).toEqual([["width", 0.51], ["mix", 0.49], ["depthMs", 3.1], ["speedHz", 1.01]]);
    // The value is shown at once, at the dial's 0.1 ms resolution.
    expect(dial("v3-chorus-depth").getAttribute("aria-valuetext")).toBe("3.1 ms, the delay sweeps 20 to 23.1 ms");
  });

  it("repeated keys step from what is shown; nothing is sent past an end", () => {
    render(chorus({ depthMs: 12 }));
    key(dial("v3-chorus-depth"), "ArrowUp");
    key(dial("v3-chorus-depth"), "ArrowUp");
    expect(setState.mock.calls.map((c) => c[1])).toEqual([12.2, 12.4]);
    expect(host.querySelector('[data-testid="v3-chorus-depth"] .v')!.textContent).toBe("12.4 ms");
    expect(setState.mock.calls[0][2].gesture).toBe(setState.mock.calls[1][2].gesture);   // one burst, one undo step
    setState.mockReset();
    render(chorus({ mix: 1 }));
    key(dial("v3-chorus-mix"), "ArrowUp");
    expect(setState).not.toHaveBeenCalled();
  });

  it("a Depth drag previews and sends ONE set_plugin_state on release (the engine clicks on every depth change)", async () => {
    render(chorus());
    const svg = dial("v3-chorus-depth");
    const frame = () => act(async () => { await new Promise((r) => setTimeout(r, 40)); });   // let a frame flush
    act(() => { svg.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientY: 100, pointerId: 1, button: 0 })); });
    for (const y of [95, 90, 85, 80, 75, 70]) {
      act(() => { svg.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientY: y, pointerId: 1 })); });
      await frame();
    }
    expect(setState).not.toHaveBeenCalled();
    // 30 px of 150 = 0.2 of the 19.9 ms range above 3.0 ms: 6.98 → 7.0 ms, shown while dragging.
    expect(host.querySelector('[data-testid="v3-chorus-depth"] .v')!.textContent).toBe("7.0 ms");
    expect(host.querySelector('[data-testid="v3-chorus-lane"]')!.getAttribute("aria-label")).toMatch(/sweeps 20 to 27\.0 ms/);
    act(() => { svg.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientY: 70, pointerId: 1 })); });
    expect(setState.mock.calls).toEqual([["depthMs", 7, { gesture: expect.any(String) }]]);
    // A drag that ends where it started sends nothing.
    setState.mockReset();
    act(() => {
      svg.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientY: 100, pointerId: 2, button: 0 }));
      svg.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientY: 100, pointerId: 2 }));
    });
    expect(setState).not.toHaveBeenCalled();
  });

  it("L and R sit width·180° apart on the lane; the motion stops under reduced motion", () => {
    reduced = true;
    render(chorus({ width: 1 }));
    const lane = host.querySelector('[data-testid="v3-chorus-lane"]')!;
    expect(lane.hasAttribute("data-animating")).toBe(false);
    expect(lane.getAttribute("aria-label")).toMatch(/not synced to the audio/);
    expect(lane.getAttribute("aria-label")).not.toMatch(/\bin sync\b|\bsynced to the beat/);
    expect(host.querySelector('[data-testid="v3-chorus-l"]')!.getAttribute("data-u")).toBe("0.0000");
    expect(host.querySelector('[data-testid="v3-chorus-r"]')!.getAttribute("data-u")).toBe("0.5000");
    // The R dot is drawn at the bottom of the sweep (20 ms) when it is half a cycle on.
    const r = host.querySelector('[data-testid="v3-chorus-r"] circle')!;
    const l = host.querySelector('[data-testid="v3-chorus-l"] circle')!;
    expect(Number(r.getAttribute("cy"))).toBeCloseTo(Number(l.getAttribute("cy")), 6);   // sin 0 = sin π
    // The lane is drawn at its CSS width (273 px: the viewBox is not scaled, so 9 px text is
    // 9 px), inset 6 on the right so the dot at the cycle's end stays inside the frame.
    expect(LANE_W).toBe(273);
    expect(lane.getAttribute("viewBox")).toBe("0 0 273 40");
    expect(Number(r.getAttribute("cx")) - Number(l.getAttribute("cx"))).toBeCloseTo((273 - 26 - 6) / 2, 6);
    // The computed read-out (pitch wobble and period) sits in the plot's top right, clear of
    // the curve's trough and the 20 ms line, not in the dial row.
    const read = host.querySelector('[data-testid="v3-chorus-readout"]')!;
    expect(read.textContent!.replace(read.querySelector("title")!.textContent!, "")).toBe("±16 ¢ · 1.00 s cycle");
    expect(host.querySelector('[data-testid="v3-chorus-period"]')!.textContent).toBe("1.00 s");
    expect(Number(read.getAttribute("y"))).toBeLessThan(20);
    expect(read.getAttribute("x")).toBe("270");
    expect(read.getAttribute("text-anchor")).toBe("end");
    expect(lane.getAttribute("aria-label")).toMatch(/pitch wobbles ±16 ¢/);
    // The dial row holds only the four dials.
    expect([...host.querySelector(".pp-chorus-ctl")!.children].map((c) => (c.firstElementChild ?? c).getAttribute("data-testid")))
      .toEqual(["v3-chorus-rate", "v3-chorus-depth", "v3-chorus-width", "v3-chorus-mix"]);
  });

  it("free-runs only while the transport plays, the plugin is on and motion is allowed", () => {
    render(chorus());
    const animating = () => host.querySelector('[data-testid="v3-chorus-lane"]')!.hasAttribute("data-animating");
    expect(animating()).toBe(false);                   // stopped: nothing is heard, nothing moves
    setPlaying(true);
    expect(animating()).toBe(true);
    render(chorus({}, false));
    const lane = host.querySelector('[data-testid="v3-chorus-lane"]')!;
    expect(lane.hasAttribute("data-animating")).toBe(false);
    expect(lane.classList.contains("bypassed")).toBe(true);
  });

  it("the wheel steps the dial and never scrolls the inspector (the Dial cancels it)", () => {
    render(chorus());
    const svg = dial("v3-chorus-rate");
    const ev = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100 });
    act(() => { svg.dispatchEvent(ev); });
    expect(ev.defaultPrevented).toBe(true);
    // One notch = the arrow key's step: 1% of the range in whole steps (0.1 Hz).
    expect(setState.mock.calls.map((c) => [c[0], c[1]])).toEqual([["speedHz", 1.1]]);
    // Shift: one whole step.
    act(() => { svg.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100, shiftKey: true })); });
    expect(setState.mock.calls.at(-1)!.slice(0, 2)).toEqual(["speedHz", 1.11]);
  });

  it("at mix 0 Rate, Depth and Width are inert (still adjustable), and the wobble is muted", () => {
    render(chorus({ mix: 0 }));
    for (const id of ["v3-chorus-rate", "v3-chorus-depth", "v3-chorus-width"]) {
      expect(host.querySelector(`[data-testid="${id}"]`)!.classList.contains("inert")).toBe(true);
    }
    expect(host.querySelector('[data-testid="v3-chorus-mix"]')!.classList.contains("inert")).toBe(false);
    expect(host.querySelector('[data-testid="v3-chorus-lane"]')!.classList.contains("dry")).toBe(true);
    key(dial("v3-chorus-width"), "ArrowUp", { shiftKey: true });
    expect(setState).toHaveBeenCalledWith("width", 0.51, { gesture: expect.any(String) });
  });

  it("an engine without plugin.state: the dials show the defaults, disabled, with one note, and send nothing", () => {
    render({ ...chorus(), state: undefined });
    expect(host.querySelector('[data-testid="v3-chorus-engine-note"]')!.textContent).toBe(NEEDS_ENGINE);
    for (const id of ["v3-chorus-rate", "v3-chorus-depth", "v3-chorus-width", "v3-chorus-mix"]) {
      expect(host.querySelector(`[data-testid="${id}"]`)!.classList.contains("off")).toBe(true);
      expect(dial(id).getAttribute("aria-disabled")).toBe("true");
    }
    expect(host.querySelector('[data-testid="v3-chorus-rate"] .v')!.textContent).toBe("1.00 Hz");
    key(dial("v3-chorus-rate"), "ArrowUp");
    key(dial("v3-chorus-depth"), "End");
    const ev = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100 });
    act(() => { dial("v3-chorus-mix").dispatchEvent(ev); });
    expect(ev.defaultPrevented).toBe(false);           // a dead control does not eat the scroll
    const svg = dial("v3-chorus-depth");
    act(() => {
      svg.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientY: 100, pointerId: 1, button: 0 }));
      svg.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientY: 60, pointerId: 1 }));
      svg.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientY: 60, pointerId: 1 }));
      svg.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(setState).not.toHaveBeenCalled();
    // A current engine shows no note.
    render(chorus());
    expect(host.querySelector('[data-testid="v3-chorus-engine-note"]')).toBeNull();
  });
  it("the minimized thumbnail is 44×14: one static cycle on the lane's axis, L and R width·180° apart", () => {
    const renderMini = (plugin: Plugin) =>
      act(() => root.render(React.createElement(chorusPanelDef.Mini!, { plugin, trackId: "t1", sampleRate: 48000, setParam, setState })));
    setPlaying(true);                                    // static even while playing
    renderMini(chorus({ width: 1 }));
    const svg = host.querySelector('[data-testid="v3-chorus-mini"]')!;
    expect([MINI_W, MINI_H]).toEqual([44, 14]);
    expect([svg.getAttribute("width"), svg.getAttribute("height"), svg.getAttribute("viewBox")]).toEqual(["44", "14", "0 0 44 14"]);
    const c = (id: string) => { const e = host.querySelector(`[data-testid="${id}"]`)!; return [Number(e.getAttribute("cx")), Number(e.getAttribute("cy"))]; };
    const [lx, ly] = c("v3-chorus-mini-l"), [rx, ry] = c("v3-chorus-mini-r");
    expect(rx - lx).toBeCloseTo((44 - 5) / 2, 6);        // half a cycle on, at 180°
    expect(ry).toBeCloseTo(ly, 6);                       // sin 0 = sin π: both mid-sweep
    // Depth 3 ms on the 5 ms axis: mid-sweep (21.5 ms) is 0.3 of the 9 px span above the bottom.
    expect(ly).toBeCloseTo(2.5 + (1 - (21.5 - CHORUS_BASE_MS) / 5) * 9, 6);
    // Every point of the cycle stays inside the 44×14 box.
    const pts = host.querySelector('[data-testid="v3-chorus-mini"] path')!.getAttribute("d")!.match(/-?[\d.]+ -?[\d.]+/g)!.map((p) => p.split(" ").map(Number));
    for (const [x, y] of pts) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(44); expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThanOrEqual(14); }
    expect(svg.classList.contains("muted")).toBe(false);
    renderMini(chorus({ width: 0 }));
    expect(c("v3-chorus-mini-r")).toEqual(c("v3-chorus-mini-l"));   // width 0: in phase
    renderMini(chorus({ mix: 0 }));
    expect(host.querySelector('[data-testid="v3-chorus-mini"]')!.classList.contains("muted")).toBe(true);
    renderMini(chorus({}, false));
    expect(host.querySelector('[data-testid="v3-chorus-mini"]')!.classList.contains("muted")).toBe(true);
  });
});
